#!/usr/bin/env npx tsx
/**
 * IMPORT AN ELEVENLABS TRANSCRIPT INTO ICONIK (replace the asset's TRANSCRIPTION track)
 *
 *   npx tsx scripts/elevenlabs-import.ts --profile=<profile> --asset=<uuid> [SOURCE] [--live] [--json]
 *
 * SOURCE (one of):
 *   --from-webhook-payload=<file>   file written by the n8n webhook: {signature, raw_body_b64, received_at}
 *                                   or a raw ElevenLabs webhook JSON body (then --skip-verify is required)
 *   --transcription-id=<id>         GET /v1/speech-to-text/transcripts/{id}
 *   --from-revai=<job id>           Rev.ai GET /jobs/{id}/transcript (human or machine); --from-json sniffs a saved Rev.ai JSON too
 *   --from-assemblyai=<id>          AssemblyAI GET /v2/transcript/{id} (names from speaker identification); --from-json
 *                                   also sniffs a saved AssemblyAI transcript JSON
 *   --from-json=<file> [--format=webhook|transcript|srt|vtt]   editor export / saved transcript (format by extension)
 *                                   also sniffs a Hyperaudio Lite Editor project (format:"hyperaudio") → kind hyperaudio-json;
 *                                   pair with --scores=<sidecar.json> (from transcript-export-hyperaudio.ts) to keep confidences
 *   (none)                          read ElevenLabsTranscriptionId from the asset's tracking view, then GET
 *   --restore-from=<backup.jsonl>   ROLLBACK: re-create the segments saved by a previous run
 *
 * Options: --speaker-labels='{"0":"Ben Higgins"}'  --language=en  --skip-verify  --version-id=<uuid>
 *          --engine="Hyperaudio Lite Editor" (engine_info.name written to the properties record; default ElevenLabs)
 *          --keep-existing (do NOT delete the current TRANSCRIPTION segments; adds a second track)
 *
 * Steps (live): backup existing segments+properties → delete ALL TRANSCRIPTION segments on the version
 * (there may be duplicate transcriptions) → bulk create (≤500/chunk, noRetry5xx) → transcription
 * properties (language, speaker_labels, engine_info EXTERNAL) → reindex → verify count → tracking.
 * Dry-run stops before any write and prints a preview.
 */
import * as fs from "fs";
import * as path from "path";
import { v1 as uuidv1 } from "uuid";
import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs, getProfile } from "../src/config.ts";
import { getTranscript, verifyWebhook, parseWebhookMetadata, editorUrl, type ElTranscript, type ElWebhookPayload } from "../src/lib/elevenlabs.ts";
import { convertElevenLabsToSegments, convertSrtOrVtt, toBulkObjects, deriveSpeakerLabels, isEditorExport, editorExportToTranscript, type IkSegmentDraft } from "../src/lib/elevenlabs-to-iconik.ts";
import { readTracking, writeTracking, TrackingNotConfigured } from "../src/lib/elevenlabs-tracking.ts";
import { isHyperaudioProject, hyperaudioToTranscript, type ScoreMap } from "../src/lib/hyperaudio.ts";
import { getTranscript as getAaiTranscript, assemblyaiToTranscript, isAssemblyAiTranscript } from "../src/lib/assemblyai.ts";
import { getJob as getRevJob, getTranscript as getRevTranscript, revToTranscript, isRevTranscript } from "../src/lib/revai.ts";
import { fetchAllTranscription as libFetchAllTranscription, countTranscription, resolveActiveVersion, fetchTranscriptionProperties, freshProxyUrl as libFreshProxyUrl, normLang, type IkTranscriptionSegment } from "../src/lib/iconik-transcripts.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);
const profile = getProfile(profileName);

const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const has = (n: string) => args.includes(`--${n}`);
const assetArg = arg("asset");
const live = has("live");
const jsonOut = has("json");
const keepExisting = has("keep-existing");
const skipVerify = has("skip-verify");
const log = (...a: unknown[]) => { if (!jsonOut) console.log(...a); else console.error(...a); };

type Seg = IkTranscriptionSegment;
const fetchAllTranscription = libFetchAllTranscription;
async function pollCount(assetId: string, want: (n: number) => boolean, maxMs = 60_000): Promise<number> {
  const t0 = Date.now(); let n = await countTranscription(assetId);
  while (!want(n) && Date.now() - t0 < maxMs) { await new Promise((r) => setTimeout(r, 2000)); n = await countTranscription(assetId); }
  return n;
}
const resolveVersion = (assetId: string) => resolveActiveVersion(assetId);
const freshProxyUrl = async (assetId: string) => (await libFreshProxyUrl(assetId, "audio"))?.url ?? null;
const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------
interface Source { kind: string; transcript?: ElTranscript; segments?: IkSegmentDraft[]; speakerLabels?: Record<string, string>; language?: string; assetId?: string; versionId?: string; transcriptionId?: string; description: string; extra?: Record<string, unknown> }

async function resolveSource(): Promise<Source> {
  const wh = arg("from-webhook-payload");
  if (wh) {
    const raw = fs.readFileSync(wh, "utf8");
    let parsed: any = JSON.parse(raw);
    let payload: ElWebhookPayload;
    if (parsed.raw_body_b64) {
      const body = Buffer.from(parsed.raw_body_b64, "base64").toString("utf8");
      if (skipVerify) payload = JSON.parse(body);
      else payload = verifyWebhook(body, parsed.signature, process.env.ELEVENLABS_WEBHOOK_SECRET, { toleranceSec: 60 * 60 * 24 * 14 });
    } else if (parsed.type && parsed.data) {
      if (!skipVerify) throw new Error("raw webhook body has no signature envelope — pass --skip-verify to import it unverified");
      payload = parsed;
    } else throw new Error("unrecognised webhook payload file");
    const md = parseWebhookMetadata(payload.data.webhook_metadata);
    return { kind: "webhook", transcript: payload.data.transcription, assetId: md.asset_id, versionId: md.version_id, transcriptionId: payload.data.transcription.transcription_id ?? payload.data.request_id, speakerLabels: deriveSpeakerLabels(payload), description: `webhook payload ${wh} (request ${payload.data.request_id})` };
  }
  const tid = arg("transcription-id");
  if (tid) { const t = await getTranscript(tid); return { kind: "api", transcript: t, transcriptionId: tid, speakerLabels: deriveSpeakerLabels(t), description: `ElevenLabs GET transcript ${tid}` }; }
  const rev = arg("from-revai");
  if (rev) {
    const job = await getRevJob(rev);
    if (job.status !== "transcribed") throw new Error(`Rev.ai job ${rev} is ${job.status}${job.failure_detail ? ": " + job.failure_detail : ""}`);
    const r = revToTranscript(await getRevTranscript(rev));
    return { kind: "revai", transcript: r.transcript, transcriptionId: rev, language: arg("language"), description: `Rev.ai ${job.type ?? ""} job ${rev} (${r.transcript.words.length} words, speakers ${r.speakers.join(",")})`, extra: { engine: "Rev.ai", job_type: job.type ?? null } };
  }
  const aai = arg("from-assemblyai");
  if (aai) {
    const t = await getAaiTranscript(aai);
    if (t.status !== "completed") throw new Error(`AssemblyAI transcript ${aai} is ${t.status}${t.error ? ": " + t.error : ""}`);
    const r = assemblyaiToTranscript(t);
    return { kind: "assemblyai", transcript: r.transcript, transcriptionId: aai, speakerLabels: r.speakerLabels, language: r.transcript.language_code || undefined, description: `AssemblyAI transcript ${aai} (${r.transcript.words.length} words, speakers ${Object.entries(r.speakerMap).map(([n, i]) => `${n}=${i}`).join(", ")}${r.speakerLabels ? ", names " + Object.values(r.speakerLabels).join(", ") : ""})`, extra: { engine: "AssemblyAI", speaker_map: r.speakerMap } };
  }
  const fj = arg("from-json");
  if (fj) {
    const ext = (arg("format") ?? path.extname(fj).slice(1)).toLowerCase();
    const text = fs.readFileSync(fj, "utf8");
    if (ext === "srt" || ext === "vtt") { const { segments, speakerNames } = convertSrtOrVtt(text); return { kind: ext, segments, speakerLabels: Object.keys(speakerNames).length ? speakerNames : undefined, description: `${ext.toUpperCase()} file ${fj}` }; }
    const j: any = JSON.parse(text);
    if (isHyperaudioProject(j)) {
      const prov: any = j.provenance ?? {};
      const scoresFile = arg("scores");
      const scores: ScoreMap | null = scoresFile ? JSON.parse(fs.readFileSync(scoresFile, "utf8")) : null;
      // current labels on the asset let a name typed in the editor map back to the int it already has
      let knownLabels: Record<string, string> | null = null;
      const aid = assetArg ?? prov.assetId;
      if (aid) { try { const vid = prov.versionId ?? (await resolveVersion(aid)); const props = await fetchTranscriptionProperties(aid, vid); knownLabels = props.find((p) => p.id === prov.transcriptionId)?.speaker_labels ?? props[0]?.speaker_labels ?? null; } catch { /* dry-run without access: fall back to provenance labels */ } }
      const r = hyperaudioToTranscript(j, { scores, knownLabels });
      const st = r.stats;
      return { kind: "hyperaudio-json", transcript: r.transcript, speakerLabels: r.speakerLabels, language: j.texts?.language || undefined, assetId: prov.assetId, versionId: prov.versionId, transcriptionId: prov.transcriptionId ?? undefined,
        description: `Hyperaudio project ${fj} (${st.words} words, ${st.paragraphs} paragraphs, ${st.struck} struck, ${st.inserted} edited/inserted${scores ? "" : ", NO score sidecar"}; speakers ${Object.entries(r.speakerMap).map(([n, i]) => `${n}=${i}`).join(", ")})`,
        extra: { hyperaudio_stats: st, speaker_map: r.speakerMap, exported_at: prov.exportedAt ?? null, revision: prov.revision ?? null } };
    }
    if (isRevTranscript(j)) { const r = revToTranscript(j); return { kind: "revai-json", transcript: r.transcript, language: arg("language"), description: `Rev.ai transcript JSON ${fj} (${r.transcript.words.length} words, speakers ${r.speakers.join(",")})`, extra: { engine: "Rev.ai" } }; }
    if (isAssemblyAiTranscript(j)) { const r = assemblyaiToTranscript(j); return { kind: "assemblyai-json", transcript: r.transcript, transcriptionId: j.id, speakerLabels: r.speakerLabels, language: r.transcript.language_code || undefined, description: `AssemblyAI JSON ${fj} (${r.transcript.words.length} words${r.speakerLabels ? ", names " + Object.values(r.speakerLabels).join(", ") : ""})`, extra: { engine: "AssemblyAI", speaker_map: r.speakerMap } }; }
    if (j?.data?.transcription) { const md = parseWebhookMetadata(j.data.webhook_metadata); return { kind: "webhook-json", transcript: j.data.transcription, assetId: md.asset_id, versionId: md.version_id, transcriptionId: j.data.transcription.transcription_id ?? j.data.request_id, speakerLabels: deriveSpeakerLabels(j), description: `webhook JSON ${fj}` }; }
    if (Array.isArray(j?.words)) return { kind: "transcript-json", transcript: j, transcriptionId: j.transcription_id ?? undefined, speakerLabels: deriveSpeakerLabels(j), language: j.language_code, description: `transcript JSON ${fj}` };
    if (isEditorExport(j)) { const { transcript, speakerLabels } = editorExportToTranscript(j); return { kind: "editor-json", transcript, speakerLabels, language: j.language_code, description: `ElevenLabs editor export ${fj} (${j.segments.length} editor segments${speakerLabels ? ", named speakers: " + Object.values(speakerLabels).join(", ") : ""})` }; }
    throw new Error(`unrecognised JSON shape in ${fj} (keys: ${Object.keys(j).join(", ")})`);
  }
  if (!assetArg) throw new Error("--asset is required when no explicit source is given");
  const tr = await readTracking(profile, assetArg);
  if (!tr.transcription_id) throw new Error(`asset has no ElevenLabsTranscriptionId in its tracking view (status=${tr.status ?? "-"})`);
  const t = await getTranscript(tr.transcription_id);
  return { kind: "tracked", transcript: t, transcriptionId: tr.transcription_id, speakerLabels: deriveSpeakerLabels(t), description: `tracked transcript ${tr.transcription_id} (status ${tr.status})` };
}

// ---------------------------------------------------------------------------
// Backup / delete / create / properties
// ---------------------------------------------------------------------------
async function backup(assetId: string, versionId: string): Promise<{ file: string; segments: Seg[]; transcriptionIds: string[] }> {
  const segments = await fetchAllTranscription(assetId);
  let props: any[] = [];
  try { props = (await iconikRequest<any>(`assets/v1/assets/${assetId}/versions/${versionId}/transcriptions/properties/`)).objects ?? []; } catch { /* ignore */ }
  fs.mkdirSync("backups", { recursive: true });
  const file = path.join("backups", `elevenlabs-import-backup-${assetId}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const lines = [JSON.stringify({ __properties: props, asset_id: assetId, version_id: versionId, count: segments.length }), ...segments.map((s) => JSON.stringify(s))];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const transcriptionIds = [...new Set(segments.map((s) => s.transcription_id).filter(Boolean))] as string[];
  return { file, segments, transcriptionIds };
}

async function deleteAllTranscription(assetId: string, versionIds: string[]): Promise<number> {
  for (const v of versionIds) {
    await iconikRequest(`assets/v1/assets/${assetId}/segments/bulk/?immediately=true`, { method: "DELETE", body: JSON.stringify({ segment_type: "TRANSCRIPTION", version_id: v }) });
  }
  let n = await pollCount(assetId, (c) => c === 0, 60_000);
  if (n > 0) {
    // leftovers on other versions / no version: delete by explicit ids in 500s
    const left = await fetchAllTranscription(assetId);
    for (const ids of chunk(left.map((s) => s.id), 500)) {
      await iconikRequest(`assets/v1/assets/${assetId}/segments/bulk/?immediately=true`, { method: "DELETE", body: JSON.stringify({ segment_type: "TRANSCRIPTION", segment_ids: ids }) });
    }
    n = await pollCount(assetId, (c) => c === 0, 60_000);
  }
  return n;
}

async function bulkCreate(assetId: string, objects: object[]): Promise<{ ok: number; uncertain: number }> {
  let ok = 0, uncertain = 0;
  for (const part of chunk(objects, 500)) {
    try { await iconikRequest(`assets/v1/assets/${assetId}/segments/bulk/`, { method: "POST", body: JSON.stringify({ objects: part }), noRetry5xx: true } as any); ok += part.length; }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); if (/\b5\d\d\b/.test(msg)) { uncertain += part.length; log(`  ⚠ chunk of ${part.length} returned 5xx (may still have been created): ${msg.slice(0, 160)}`); } else throw e; }
  }
  return { ok, uncertain };
}

async function createProperties(assetId: string, versionId: string, body: Record<string, unknown>): Promise<string> {
  // The record's own id becomes the transcription_id that segments must reference (verified: the UI joins on it).
  const res = await iconikRequest<any>(`assets/v1/assets/${assetId}/versions/${versionId}/transcriptions/properties/`, { method: "POST", body: JSON.stringify(body), noRetry5xx: true } as any);
  if (!res?.id) throw new Error("transcription properties POST returned no id");
  return res.id;
}
async function deleteProperties(assetId: string, versionId: string, ids: string[]): Promise<void> {
  for (const id of ids) { try { await iconikRequest(`assets/v1/assets/${assetId}/versions/${versionId}/transcriptions/${id}/properties/`, { method: "DELETE" }); } catch (e) { log(`  ⚠ could not delete transcription properties ${id}: ${e instanceof Error ? e.message.slice(0, 120) : e}`); } }
}

// ---------------------------------------------------------------------------
async function main() {
  log(`Profile: ${getCurrentProfileInfo().name} | ${live ? "LIVE" : "DRY-RUN"}`);
  const restore = arg("restore-from");
  let assetId = assetArg;
  let segments: IkSegmentDraft[] | undefined;
  let bulkObjects: object[];
  let versionId: string | undefined = arg("version-id");
  let transcriptionId: string;
  let speakerLabels: Record<string, string> | undefined;
  let language: string | undefined = arg("language");
  let sourceDesc: string;
  let restoredProps: any[] = [];
  let statusOnSuccess: "IMPORTED" | "EDIT_IMPORTED" = "IMPORTED";

  if (restore) {
    const lines = fs.readFileSync(restore, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const header = lines.shift();
    assetId = assetId ?? header.asset_id; versionId = versionId ?? header.version_id; restoredProps = header.__properties ?? [];
    const segs: Seg[] = lines;
    if (segs.length === 0) throw new Error("backup contains no segments");
    transcriptionId = segs[0].transcription_id ?? uuidv1();
    bulkObjects = segs.map((s) => ({ segment_type: "TRANSCRIPTION", version_id: s.version_id ?? versionId, transcription_id: s.transcription_id ?? transcriptionId, segment_text: s.segment_text, time_start_milliseconds: s.time_start_milliseconds, time_end_milliseconds: s.time_end_milliseconds, transcription: s.transcription }));
    sourceDesc = `RESTORE from ${restore} (${segs.length} segments, ${new Set(segs.map((s) => s.transcription_id)).size} transcription id(s))`;
    const p = restoredProps.find((x) => x.id === transcriptionId);
    if (p) { speakerLabels = p.speaker_labels ?? undefined; language = language ?? p.language; }
  } else {
    const src = await resolveSource();
    sourceDesc = src.description;
    assetId = assetId ?? src.assetId;
    if (!assetId) throw new Error("--asset is required (source carries no asset_id)");
    if (src.assetId && src.assetId !== assetId) throw new Error(`source is for asset ${src.assetId} but --asset=${assetId}`);
    versionId = versionId ?? src.versionId ?? (await resolveVersion(assetId));
    if (src.transcript) {
      const c = convertElevenLabsToSegments(src.transcript);
      segments = c.segments; language = language ?? src.transcript.language_code;
    } else segments = src.segments!;
    if (!segments.length) throw new Error("source produced zero segments");
    transcriptionId = "(assigned by iconik when properties are created)";
    bulkObjects = toBulkObjects(segments, versionId, transcriptionId);
    speakerLabels = arg("speaker-labels") ? JSON.parse(arg("speaker-labels")!) : src.speakerLabels;
    if (["api", "tracked", "srt", "vtt", "transcript-json", "editor-json", "hyperaudio-json"].includes(src.kind)) statusOnSuccess = "EDIT_IMPORTED";
    (main as any).sourceTranscriptionId = ["hyperaudio-json", "assemblyai", "assemblyai-json", "revai", "revai-json"].includes(src.kind) ? undefined : src.transcriptionId;
    (main as any).sourceExtra = src.extra ?? null;
  }

  const speakers = [...new Set(bulkObjects.map((o: any) => o.transcription?.speaker))].sort((a: any, b: any) => a - b);
  log(`Asset ${assetId} version ${versionId}\nSource: ${sourceDesc}\nNew transcription_id: ${transcriptionId}\nSegments: ${bulkObjects.length} | speakers: ${speakers.join(",")} | language: ${language ?? "-"} | speaker_labels: ${speakerLabels ? JSON.stringify(speakerLabels) : "none"}`);
  const show = (o: any, i: number) => log(`  [${i}] spk${o.transcription?.speaker} ${o.time_start_milliseconds}-${o.time_end_milliseconds}ms (${o.transcription?.words?.length}w): ${String(o.segment_text).slice(0, 110)}`);
  if (bulkObjects.length <= 10) bulkObjects.forEach(show);
  else { bulkObjects.slice(0, 5).forEach(show); log("  ..."); bulkObjects.slice(-5).forEach((o, k) => show(o, bulkObjects.length - 5 + k)); }

  const existing = await countTranscription(assetId);
  log(`Existing TRANSCRIPTION segments on asset: ${existing}${keepExisting ? " (kept)" : " (will be deleted)"}`);
  if (!live) {
    log("\nDRY-RUN — no changes made. Re-run with --live.");
    if (jsonOut) console.log(JSON.stringify({ dry_run: true, asset_id: assetId, version_id: versionId, source: sourceDesc, segments: bulkObjects.length, speakers, existing_segments: existing, speaker_labels: speakerLabels ?? null, language: normLang(language) ?? null, engine: arg("engine") ?? ((main as any).sourceExtra?.engine as string | undefined) ?? "ElevenLabs", first_text: (bulkObjects[0] as any)?.segment_text ?? null, last_text: (bulkObjects[bulkObjects.length - 1] as any)?.segment_text ?? null, extra: (main as any).sourceExtra ?? null }));
    return;
  }

  // 1. backup
  const b = await backup(assetId, versionId!);
  log(`Backup: ${b.file} (${b.segments.length} segments, transcription ids: ${b.transcriptionIds.join(",") || "-"})`);
  // 2. delete
  if (!keepExisting && b.segments.length) {
    const vids = [...new Set([versionId!, ...b.segments.map((s) => s.version_id).filter(Boolean) as string[]])];
    const left = await deleteAllTranscription(assetId, vids);
    log(`Deleted existing segments → remaining ${left}`);
    if (left > 0) throw new Error(`could not clear existing TRANSCRIPTION segments (${left} left) — aborting before create; backup at ${b.file}`);
  }
  if (!keepExisting) {
    const oldProps: string[] = ((JSON.parse(fs.readFileSync(b.file, "utf8").split("\n")[0]).__properties) ?? []).map((p: any) => p.id).filter(Boolean);
    if (oldProps.length) { await deleteProperties(assetId, versionId!, oldProps); log(`Deleted ${oldProps.length} old transcription properties record(s)`); }
  }
  // 3. transcription properties FIRST — iconik assigns the id that segments must carry as transcription_id
  const srcEngine = ((main as any).sourceExtra?.engine as string | undefined);
  const engineName = arg("engine") ?? srcEngine ?? "ElevenLabs";
  const engineModel = engineName === "ElevenLabs" ? "scribe_v2" : engineName === "AssemblyAI" ? "universal-3-5-pro" : engineName === "Rev.ai" ? (((main as any).sourceExtra?.job_type as string | undefined) ?? "human") : "edited";
  const propsBody: Record<string, unknown> = { engine_info: { name: engineName, model: engineModel, version: new Date().toISOString().slice(0, 10), type: "EXTERNAL" } };
  const lang = normLang(language); if (lang) propsBody.language = lang;
  if (speakerLabels) propsBody.speaker_labels = speakerLabels;
  if (!restore) {
    transcriptionId = await createProperties(assetId, versionId!, propsBody);
    for (const o of bulkObjects as any[]) o.transcription_id = transcriptionId;
    log(`Transcription properties created → transcription_id ${transcriptionId} (language ${lang ?? "-"})`);
  } else {
    // restore: re-create the properties record(s) from the backup header so ids line up with the restored segments
    for (const p of restoredProps) { try { await iconikRequest(`assets/v1/assets/${assetId}/versions/${versionId}/transcriptions/properties/`, { method: "POST", body: JSON.stringify({ language: p.language, speaker_labels: p.speaker_labels, engine_info: p.engine_info, id: p.id }), noRetry5xx: true } as any); } catch (e) { log(`  ⚠ restore properties ${p.id}: ${e instanceof Error ? e.message.slice(0, 120) : e}`); } }
  }
  // 4. segments
  const { ok, uncertain } = await bulkCreate(assetId, bulkObjects);
  log(`Bulk create: ${ok} sent ok, ${uncertain} uncertain`);
  // 5. reindex
  try { await iconikRequest(`assets/v1/assets/${assetId}/segments/reindex/`, { method: "POST", body: "{}" }); } catch (e) { log(`  ⚠ reindex failed: ${e instanceof Error ? e.message : e}`); }
  // 6. verify
  const want = (keepExisting ? existing : 0) + bulkObjects.length;
  const n = await pollCount(assetId, (c) => c >= want, 90_000);
  const verified = n === want;
  log(`Verify: ${n} segments on asset (expected ${want}) → ${verified ? "OK" : "MISMATCH"}`);
  if (verified) {
    const after = await fetchAllTranscription(assetId);
    const mine = after.filter((s) => s.transcription_id === transcriptionId);
    const sample = [0, Math.floor(mine.length / 2), mine.length - 1].map((i) => mine[i]).filter(Boolean);
    for (const s of sample) { const exp = (bulkObjects as any[]).find((o) => o.time_start_milliseconds === s.time_start_milliseconds); if (!exp || exp.segment_text !== s.segment_text) log(`  ⚠ spot-check mismatch at ${s.time_start_milliseconds}ms`); }
  }
  // 7. tracking
  try {
    const tid = restore ? undefined : ((main as any).sourceTranscriptionId as string | undefined);
    await writeTracking(profile, assetId, { transcription_id: tid, status: verified ? statusOnSuccess : "FAILED" });
    log(`Tracking: ${verified ? statusOnSuccess : "FAILED"}`);
  } catch (e) { if (!(e instanceof TrackingNotConfigured)) log(`  ⚠ tracking write failed: ${e instanceof Error ? e.message : e}`); else log("  (tracking view not configured — skipped)"); }

  const summary = { asset_id: assetId, version_id: versionId, transcription_id: transcriptionId, source: sourceDesc, segments: bulkObjects.length, created_ok: ok, uncertain, verified, backup: b.file, speaker_labels: speakerLabels ?? null, editor_url: (main as any).sourceTranscriptionId ? editorUrl((main as any).sourceTranscriptionId) : null, asset_url: `https://app.iconik.io/asset/${assetId}`, proxy_url: await freshProxyUrl(assetId), language: normLang(language) ?? null, engine: arg("engine") ?? ((main as any).sourceExtra?.engine as string | undefined) ?? "ElevenLabs", extra: (main as any).sourceExtra ?? null };
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync(path.join("reports", `elevenlabs-import-${assetId}-${Date.now()}.json`), JSON.stringify(summary, null, 2));
  if (jsonOut) console.log(JSON.stringify(summary));
  if (!verified) process.exit(2);
}
main().catch((e) => { console.error("Fatal:", e instanceof Error ? e.message : e); process.exit(1); });
