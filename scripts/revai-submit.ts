#!/usr/bin/env npx tsx
/**
 * SUBMIT ICONIK ASSET(S) TO REV.AI (async, webhook) — human or machine transcriber
 *
 *   npx tsx scripts/revai-submit.ts --profile=<profile> --asset=<uuid>[,<uuid>...] \
 *       [--transcriber=human|machine] [--keyterms="Paradisus Palma Real, McKenzie"] [--language=en|auto] \
 *       [--speaker-names="Ben Higgins, McKenzie"] [--verbatim] [--rush] [--test-mode] \
 *       [--notes="..."] [--user-id=<uuid>] [--webhook-url=<url>] [--no-webhook] [--wait] [--live] [--json]
 *
 * Per asset: resolveActiveVersion -> freshProxyUrl(asset, "audio") (error if none) -> buildJobBody
 * -> POST /jobs. Rev.ai's completion callback POSTs { job: { id, status, ... } } with our
 * Authorization: Bearer <secret> header (no other metadata), so this script writes a pending file
 * inbox/revai-pending-<job id>.json that the n8n webhook receiver reads to map job id -> asset.
 *
 * Keyterms feed custom_vocabularies; speaker_names only from --speaker-names (or --names-from-keyterms, which
 * speaker_names — every keyterm of 1-3 words with no digits is treated as a plausible person name
 * (kept simple on purpose: no place-name filtering).
 *
 * Dry-run (default) resolves everything and prints the submit body (redacted: proxy URL signature,
 * notification_config Bearer secret) without calling Rev.ai.
 * --live submits for real. Human jobs can take up to a day: with a webhook, the pending file is all
 * that's written and the script returns immediately. With --no-webhook --live, the job id is printed
 * and the script returns unless --wait is also given, in which case it polls (waitForJob) and saves
 * the raw transcript to inbox/revai-<id>.json.
 *
 * Env: REVAI_ACCESS_TOKEN (required for --live), REVAI_WEBHOOK_URL, REVAI_WEBHOOK_SECRET.
 * Prints one JSON line per asset {ok, asset_id, job_id, status, transcriber, test_mode, dry_run, pending_file}.
 * Exit code 1 if any asset failed.
 */
import * as fs from "fs";
import * as path from "path";
import { initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs, getProfile } from "../src/config.ts";
import { fetchAsset, resolveActiveVersion, freshProxyUrl } from "../src/lib/iconik-transcripts.ts";
import { submitJob, buildJobBody, waitForJob, type RevSubmitOpts } from "../src/lib/revai.ts";
import { parseKeyterms } from "../src/lib/elevenlabs.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);
const profile = getProfile(profileName);

const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const has = (n: string) => args.includes(`--${n}`);
const assetIds = (arg("asset") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const transcriber = arg("transcriber") === "machine" ? "machine" as const : "human" as const;
const keyterms = parseKeyterms(arg("keyterms"));
const languageArg = arg("language") ?? "en";
const language = languageArg === "auto" ? undefined : languageArg;
const explicitSpeakerNames = (arg("speaker-names") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
/** Simple heuristic: a keyterm of 1-3 words with no digits is a plausible person name (no place filtering). */
function looksLikeName(k: string): boolean {
  if (/\d/.test(k)) return false;
  const words = k.trim().split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 3;
}
// Speaker names go to the human transcriber verbatim, so only explicit --speaker-names (or --names-from-keyterms,
// which guesses person names from the keyterm list) are used; keyterms alone are vocabulary only.
const speakerNames = explicitSpeakerNames.length ? explicitSpeakerNames : (has("names-from-keyterms") ? keyterms.filter(looksLikeName) : []);
const verbatim = has("verbatim") ? true : undefined;
const rush = has("rush");
const testMode = has("test-mode");
const notes = arg("notes");
const userId = arg("user-id");
const live = has("live");
const useWebhook = !has("no-webhook");
const wait = has("wait");
const jsonOut = has("json");
if (assetIds.length === 0) {
  console.error("Usage: --profile=<p> --asset=<uuid>[,<uuid>] [--transcriber=human|machine] [--keyterms=..] [--language=en|auto] [--speaker-names=..] [--verbatim] [--rush] [--test-mode] [--notes=..] [--user-id=<uuid>] [--webhook-url=<url>] [--no-webhook] [--wait] [--live] [--json]");
  process.exit(1);
}

const log = (...a: unknown[]) => { if (!jsonOut) console.log(...a); else console.error(...a); };

/** Redact the presigned media URL signature and the notification_config Bearer secret before logging. */
function redactBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const sc = out.source_config as { url?: string } | undefined;
  if (sc?.url) out.source_config = { ...sc, url: sc.url.replace(/\?.*$/, "?<signed>") };
  const nc = out.notification_config as { url?: string; auth_headers?: Record<string, string> } | undefined;
  if (nc?.auth_headers?.Authorization) out.notification_config = { ...nc, auth_headers: { ...nc.auth_headers, Authorization: "<redacted>" } };
  return out;
}

async function one(assetId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ok: false, asset_id: assetId, transcriber, test_mode: testMode, dry_run: !live };
  const asset = await fetchAsset(assetId);
  const versionId = await resolveActiveVersion(assetId, asset);
  out.version_id = versionId;
  out.title = asset.title ?? assetId;
  log(`\n▶ ${out.title} (${assetId}) version ${versionId}`);

  const proxy = await freshProxyUrl(assetId, "audio");
  if (!proxy) throw new Error("no CLOSED proxy on asset (originals are not used; generate a proxy first)");
  const sizeMb = proxy.size ? `${(proxy.size / 1e6).toFixed(1)} MB` : "size unknown";
  log(`  proxy ${proxy.filename} ${proxy.mime_type} ${sizeMb}`);
  out.audio_filename = proxy.filename;

  const webhookUrl = useWebhook ? (arg("webhook-url") ?? process.env.REVAI_WEBHOOK_URL) : undefined;
  if (useWebhook && !webhookUrl) throw new Error("no webhook URL: pass --webhook-url=<n8n receiver url> or set REVAI_WEBHOOK_URL in .env (or use --no-webhook)");
  const webhookSecret = useWebhook ? process.env.REVAI_WEBHOOK_SECRET : undefined;
  const metadata = `asset=${assetId} version=${versionId} profile=${profileName ?? ""}`;
  const opts: RevSubmitOpts = {
    mediaUrl: proxy.url,
    transcriber,
    verbatim,
    rush,
    testMode,
    speakerNames: speakerNames.length ? speakerNames : undefined,
    vocabulary: keyterms.length ? keyterms : undefined,
    language,
    metadata,
    callbackUrl: webhookUrl,
    callbackSecret: webhookSecret,
  };
  const body = buildJobBody(opts);
  log(`  request: ${JSON.stringify(redactBody(body))}`);

  if (!live) { log("  DRY-RUN — not submitted"); out.ok = true; out.request = redactBody(body); return out; }

  const res = await submitJob(opts);
  out.job_id = res.id;
  out.status = res.status;
  out.ok = true;

  if (useWebhook) {
    fs.mkdirSync("inbox", { recursive: true });
    const pending = {
      job_id: res.id,
      asset_id: assetId,
      version_id: versionId,
      profile: profileName ?? "",
      user_id: userId ?? "",
      notes: notes ?? "",
      keyterms,
      title: out.title,
      transcriber,
      test_mode: testMode,
      submitted_at: new Date().toISOString(),
      audio_filename: proxy.filename,
    };
    const f = path.join("inbox", `revai-pending-${res.id}.json`);
    fs.writeFileSync(f, JSON.stringify(pending, null, 2));
    out.pending_file = f;
    log(`  ✓ submitted: job_id=${res.id} status=${res.status} (${transcriber}${testMode ? ", test mode" : ""}) → pending file ${f}`);
  } else {
    log(`  ✓ submitted: job_id=${res.id} status=${res.status} (no webhook — ${wait ? "polling until done, human jobs can take a day" : "not polling, pass --wait to poll"})`);
    if (wait) {
      const j = await waitForJob(res.id);
      fs.mkdirSync("inbox", { recursive: true });
      const f = path.join("inbox", `revai-${res.id}.json`);
      fs.writeFileSync(f, JSON.stringify(j, null, 2));
      out.job_file = f;
      out.final_status = j.status;
      log(`  ✓ final status ${j.status} → saved ${f}`);
    }
  }
  return out;
}

async function main() {
  log(`Profile: ${getCurrentProfileInfo().name} | ${live ? "LIVE" : "DRY-RUN"} | assets: ${assetIds.length} | transcriber=${transcriber} language=${language ?? "auto"} keyterms=${keyterms.length} speakerNames=${speakerNames.length}${testMode ? " test-mode" : ""}${useWebhook ? "" : wait ? " (no webhook — will poll)" : " (no webhook — will not poll)"}`);
  void profile;
  const results: Record<string, unknown>[] = [];
  let failed = 0;
  for (const id of assetIds) {
    try { results.push(await one(id)); }
    catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      log(`  ✗ ${id}: ${msg}`);
      results.push({ ok: false, asset_id: id, dry_run: !live, error: msg });
    }
  }
  if (jsonOut) for (const r of results) console.log(JSON.stringify(r));
  else log(`\nDone: ${results.length - failed} ok, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
