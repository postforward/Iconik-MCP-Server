#!/usr/bin/env npx tsx
/**
 * SUBMIT ICONIK ASSET(S) TO ASSEMBLYAI (async, webhook)
 *
 *   npx tsx scripts/assemblyai-submit.ts --profile=<profile> --asset=<uuid>[,<uuid>...] \
 *       [--keyterms="Paradisus Palma Real, McKenzie"] [--language=auto|en|es] [--num-speakers=N] \
 *       [--speaker-names="Ben Higgins, McKenzie"] [--notes="..."] [--user-id=<uuid>] \
 *       [--no-webhook] [--live] [--json]
 *
 * Per asset: resolveActiveVersion -> freshProxyUrl(asset, "audio") (error if none) -> buildSubmitBody
 * -> POST /v2/transcript. webhook_url comes from --webhook-url=<url> or ASSEMBLYAI_WEBHOOK_URL (required unless --no-webhook);
 * webhook_auth_header_value comes from ASSEMBLYAI_WEBHOOK_SECRET — both are skipped with --no-webhook.
 * AssemblyAI's webhook body carries no metadata (just {transcript_id, status}), so this script writes
 * a pending file inbox/assemblyai-pending-<transcript_id>.json that the n8n webhook receiver reads
 * to map transcript_id -> asset.
 *
 * Dry-run (default) resolves everything and prints the submit body (redacted: audio URL signature,
 * webhook_auth_header_value) without calling AssemblyAI.
 * --live submits for real. Combined with --no-webhook it polls synchronously (waitForTranscript) and
 * saves the raw transcript to inbox/assemblyai-<id>.json instead of writing a pending file.
 *
 * Env: ASSEMBLYAI_API_KEY (required for --live), ASSEMBLYAI_WEBHOOK_URL, ASSEMBLYAI_WEBHOOK_SECRET.
 * Prints one JSON line per asset {ok, asset_id, transcript_id, dry_run, pending_file, ...}.
 * Exit code 1 if any asset failed.
 */
import * as fs from "fs";
import * as path from "path";
import { initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs, getProfile } from "../src/config.ts";
import { fetchAsset, resolveActiveVersion, freshProxyUrl } from "../src/lib/iconik-transcripts.ts";
import { submitTranscript, buildSubmitBody, waitForTranscript, type AaiSubmitOpts } from "../src/lib/assemblyai.ts";
import { parseKeyterms } from "../src/lib/elevenlabs.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);
const profile = getProfile(profileName);

const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const has = (n: string) => args.includes(`--${n}`);
const assetIds = (arg("asset") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const keyterms = parseKeyterms(arg("keyterms"));
const language = arg("language") ?? "auto";
const numSpeakers = arg("num-speakers") ? parseInt(arg("num-speakers")!, 10) : undefined;
const speakerNames = (arg("speaker-names") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const notes = arg("notes");
const userId = arg("user-id");
const live = has("live");
const useWebhook = !has("no-webhook");
const jsonOut = has("json");
if (assetIds.length === 0) {
  console.error("Usage: --profile=<p> --asset=<uuid>[,<uuid>] [--keyterms=..] [--language=auto|en|es] [--num-speakers=N] [--speaker-names=..] [--notes=..] [--user-id=<uuid>] [--no-webhook] [--live] [--json]");
  process.exit(1);
}

const log = (...a: unknown[]) => { if (!jsonOut) console.log(...a); else console.error(...a); };

/** Redact the presigned audio URL signature and the webhook auth secret before logging. */
function redactBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (typeof out.audio_url === "string") out.audio_url = out.audio_url.replace(/\?.*$/, "?<signed>");
  if (out.webhook_auth_header_value) out.webhook_auth_header_value = "<redacted>";
  return out;
}

async function one(assetId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ok: false, asset_id: assetId, dry_run: !live };
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

  const webhookUrl = useWebhook ? (arg("webhook-url") ?? process.env.ASSEMBLYAI_WEBHOOK_URL) : undefined;
  if (useWebhook && !webhookUrl) throw new Error("no webhook URL: pass --webhook-url=<n8n receiver url> or set ASSEMBLYAI_WEBHOOK_URL in .env (or use --no-webhook)");
  const webhookSecret = useWebhook ? process.env.ASSEMBLYAI_WEBHOOK_SECRET : undefined;
  const opts: AaiSubmitOpts = {
    audioUrl: proxy.url,
    keyterms,
    language,
    speakersExpected: numSpeakers,
    speakerNames: speakerNames.length ? speakerNames : undefined,
    webhookUrl,
    webhookSecret,
  };
  const body = buildSubmitBody(opts);
  log(`  request: ${JSON.stringify(redactBody(body))}`);

  if (!live) { log("  DRY-RUN — not submitted"); out.ok = true; out.request = redactBody(body); return out; }

  const res = await submitTranscript(opts);
  out.transcript_id = res.id;
  out.status = res.status;
  out.ok = true;

  if (useWebhook) {
    fs.mkdirSync("inbox", { recursive: true });
    const pending = {
      transcript_id: res.id,
      asset_id: assetId,
      title: out.title,
      version_id: versionId,
      profile: profileName ?? "",
      user_id: userId ?? "",
      notes: notes ?? "",
      keyterms,
      submitted_at: new Date().toISOString(),
      audio_filename: proxy.filename,
    };
    const f = path.join("inbox", `assemblyai-pending-${res.id}.json`);
    fs.writeFileSync(f, JSON.stringify(pending, null, 2));
    out.pending_file = f;
    log(`  ✓ submitted: transcript_id=${res.id} status=${res.status} → pending file ${f}`);
  } else {
    log(`  ✓ submitted: transcript_id=${res.id} status=${res.status} (no webhook — polling until done)`);
    const t = await waitForTranscript(res.id);
    fs.mkdirSync("inbox", { recursive: true });
    const f = path.join("inbox", `assemblyai-${res.id}.json`);
    fs.writeFileSync(f, JSON.stringify(t, null, 2));
    out.transcript_file = f;
    out.final_status = t.status;
    log(`  ✓ final status ${t.status} → saved ${f}`);
  }
  return out;
}

async function main() {
  log(`Profile: ${getCurrentProfileInfo().name} | ${live ? "LIVE" : "DRY-RUN"} | assets: ${assetIds.length} | language=${language} keyterms=${keyterms.length}${numSpeakers ? ` speakers=${numSpeakers}` : ""}${useWebhook ? "" : " (no webhook — will poll)"}`);
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
