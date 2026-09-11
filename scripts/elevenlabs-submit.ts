#!/usr/bin/env npx tsx
/**
 * SUBMIT iconik ASSET(S) TO ELEVENLABS SCRIBE (async, webhook)
 *
 *   npx tsx scripts/elevenlabs-submit.ts --profile=<profile> --asset=<uuid>[,<uuid>...] \
 *       [--keyterms="Paradisus Palma Real, McKenzie"] [--language=auto|en|es] [--num-speakers=N] \
 *       [--notes="..."] [--user-id=<uuid>] [--force] [--no-iconik-write] [--no-webhook] [--live] [--json]
 *
 * Per asset: resolve the active version → pick the smallest CLOSED proxy (audio preferred) →
 * presigned download URL → POST /v1/speech-to-text with webhook=true and
 * webhook_metadata={asset_id, version_id, profile, user_id} → write tracking metadata
 * (ElevenLabsTranscriptionId / Status=SUBMITTED / Updated) → print one JSON line.
 *
 * Dry-run (default) resolves everything and prints the request without calling ElevenLabs.
 * --no-webhook  runs synchronously and saves the transcript to inbox/ (Phase 0 / local testing).
 * --no-iconik-write  skips the tracking metadata write (before the fields exist).
 * Guard: an asset with Status=SUBMITTED updated < 10 min ago is skipped unless --force.
 *
 * Env: ELEVENLABS_API_KEY (+ ELEVENLABS_WEBHOOK_ID optional). Exit code 1 if any asset failed.
 */
import * as fs from "fs";
import * as path from "path";
import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs, getProfile } from "../src/config.ts";
import { submitStt, buildSttForm, describeForm, editorUrl, parseKeyterms, SourceUrlRejected } from "../src/lib/elevenlabs.ts";
import { readTracking, writeTracking, type TrackingStatus } from "../src/lib/elevenlabs-tracking.ts";

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
const notes = arg("notes");
const userId = arg("user-id");
const live = has("live");
const force = has("force");
const noIconikWrite = has("no-iconik-write");
const useWebhook = !has("no-webhook");
const jsonOut = has("json");
if (assetIds.length === 0) { console.error("Usage: --profile=<p> --asset=<uuid>[,<uuid>] [--keyterms=..] [--language=auto|en|es] [--num-speakers=N] [--live]"); process.exit(1); }

const log = (...a: unknown[]) => { if (!jsonOut) console.log(...a); else console.error(...a); };

interface Proxy { id: string; status: string; format?: string; filename?: string; size?: number; is_public?: boolean }

async function pickProxy(assetId: string): Promise<Proxy | null> {
  const res = await iconikRequest<{ objects: Proxy[] }>(`files/v1/assets/${assetId}/proxies/`);
  const closed = (res.objects ?? []).filter((p) => p.status === "CLOSED");
  if (closed.length === 0) return null;
  const isAudio = (p: Proxy) => /audio|mp3|aac|wav/i.test(`${p.format ?? ""} ${p.filename ?? ""}`);
  closed.sort((a, b) => Number(isAudio(b)) - Number(isAudio(a)) || (a.size ?? 0) - (b.size ?? 0));
  return closed[0];
}

async function resolveVersion(assetId: string): Promise<{ title: string; versionId: string }> {
  const a = await iconikRequest<any>(`assets/v1/assets/${assetId}/`);
  const versions: any[] = a.versions ?? [];
  const active = versions.filter((v) => v.status === "ACTIVE").sort((x, y) => String(y.date_created).localeCompare(String(x.date_created)))[0] ?? versions[0];
  if (!active?.id) throw new Error("asset has no versions");
  return { title: a.title ?? assetId, versionId: active.id };
}

async function one(assetId: string) {
  const out: Record<string, unknown> = { asset_id: assetId, status: "DRY_RUN" };
  const { title, versionId } = await resolveVersion(assetId);
  out.title = title; out.version_id = versionId;
  log(`\n▶ ${title} (${assetId}) version ${versionId}`);

  if (!noIconikWrite && !force) {
    const tr = await readTracking(profile, assetId).catch(() => null);
    if (tr?.status === "SUBMITTED" && tr.updated && Date.now() - Date.parse(tr.updated) < 10 * 60_000) {
      log(`  ⏭ already SUBMITTED ${tr.updated} (< 10 min ago) — skipping (use --force)`);
      return { ...out, status: "SKIPPED_RECENT", transcription_id: tr.transcription_id };
    }
  }

  const proxy = await pickProxy(assetId);
  if (!proxy) throw new Error("no CLOSED proxy on asset (originals are not used; generate a proxy first)");
  const dl = await iconikRequest<{ url: string }>(`files/v1/assets/${assetId}/proxies/${proxy.id}/download_url/`);
  const sizeMb = ((proxy.size ?? 0) / 1e6).toFixed(1);
  log(`  proxy ${proxy.filename} ${proxy.format ?? ""} ${sizeMb} MB`);
  out.proxy = { id: proxy.id, filename: proxy.filename, size: proxy.size };
  out.proxy_url = dl.url; // presigned (~12 h) — pasteable into ElevenLabs dashboard → Transcribe files → URL
  out.keyterms = keyterms.join(", ");

  const webhookMetadata: Record<string, string> = { asset_id: assetId, version_id: versionId, profile: profileName ?? "" };
  if (userId) webhookMetadata.user_id = userId;
  if (notes) webhookMetadata.notes = notes.slice(0, 500);
  const opts = {
    sourceUrl: dl.url, languageCode: language, numSpeakers, keyterms, webhook: useWebhook,
    webhookId: process.env.ELEVENLABS_WEBHOOK_ID, webhookMetadata,
  };
  log(`  request: ${JSON.stringify(describeForm(await buildSttForm(opts)))}`);

  if (!live) { log("  DRY-RUN — not submitted"); return out; }

  let res;
  try {
    res = await submitStt(opts);
  } catch (e) {
    if (e instanceof SourceUrlRejected && (proxy.size ?? 0) < 2_000_000_000) {
      log(`  source_url rejected (${e.message.slice(0, 120)}); downloading and uploading as file...`);
      fs.mkdirSync("inbox", { recursive: true });
      const tmp = path.join("inbox", `upload-${assetId}-${proxy.filename ?? "proxy"}`);
      const r = await fetch(dl.url); if (!r.ok || !r.body) throw new Error(`proxy download failed: ${r.status}`);
      await fs.promises.writeFile(tmp, r.body as any);
      try { res = await submitStt({ ...opts, sourceUrl: undefined, filePath: tmp, fileName: proxy.filename }); }
      finally { fs.rmSync(tmp, { force: true }); }
    } else throw e;
  }

  out.request_id = res.request_id; out.transcription_id = res.transcription_id;
  // API transcripts are not visible in the dashboard editor (verified 2026-09-10); only emit a link if a template is configured.
  if (res.transcription_id && process.env.ELEVENLABS_EDITOR_URL_TEMPLATE) out.editor_url = editorUrl(res.transcription_id);
  if (res.transcript) {
    fs.mkdirSync("inbox", { recursive: true });
    const f = path.join("inbox", `transcript-${assetId}-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify(res.transcript, null, 2));
    out.transcript_file = f;
    log(`  synchronous transcript saved: ${f} (${res.transcript.words?.length ?? 0} words, lang ${res.transcript.language_code})`);
  }
  log(`  ✓ submitted: request_id=${res.request_id ?? "-"} transcription_id=${res.transcription_id ?? "-"}`);

  if (!noIconikWrite && res.transcription_id) {
    const status: TrackingStatus = res.transcript ? "IMPORT_PENDING" : "SUBMITTED";
    await writeTracking(profile, assetId, { transcription_id: res.transcription_id, status });
    log(`  tracking written: ${status}`);
  }
  return { ...out, status: res.transcript ? "TRANSCRIBED" : "SUBMITTED" };
}

async function main() {
  log(`Profile: ${getCurrentProfileInfo().name} | ${live ? "LIVE" : "DRY-RUN"} | assets: ${assetIds.length} | language=${language} keyterms=${keyterms.length}${numSpeakers ? ` speakers=${numSpeakers}` : ""}${useWebhook ? "" : " (sync, no webhook)"}`);
  const results: Record<string, unknown>[] = [];
  let failed = 0;
  for (const id of assetIds) {
    try { results.push(await one(id)); }
    catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      log(`  ✗ ${id}: ${msg}`);
      results.push({ asset_id: id, status: "FAILED", error: msg });
      if (live && !noIconikWrite) await writeTracking(profile, id, { status: "FAILED" }).catch(() => {});
    }
  }
  if (jsonOut) console.log(JSON.stringify({ profile: profileName, live, results }));
  else log(`\nDone: ${results.length - failed} ok, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
