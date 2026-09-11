#!/usr/bin/env npx tsx
/**
 * NAME the speakers of an asset's iconik transcript with Claude's best guess from context.
 *
 *   npx tsx scripts/name-speakers.ts --profile=<profile> --asset=<uuid> [--keyterms="Ben Higgins, McKenzie"] [--notes="..."]
 *       [--min-confidence=0.7] [--overwrite] [--model=claude-opus-5] [--live] [--json]
 *
 * Reads the current transcription (segments + properties), asks Claude for one name per speaker number
 * with a confidence, and (live) PATCHes speaker_labels on the transcription properties. Existing names are
 * kept unless --overwrite; guesses under --min-confidence stay "Speaker N" for the team to fix in the editor.
 * Dry-run prints the guesses. Env: ANTHROPIC_API_KEY.
 */
import { initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";
import { fetchAsset, resolveActiveVersion, fetchAllTranscription, fetchTranscriptionProperties, pickTranscription } from "../src/lib/iconik-transcripts.ts";
import { parseKeyterms } from "../src/lib/elevenlabs.ts";
import { proposeSpeakerNames, mergeLabels, writeSpeakerLabels } from "../src/lib/speaker-naming.ts";

initializeProfile(getProfileFromArgs());
const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const has = (n: string) => args.includes(`--${n}`);
const assetId = arg("asset"); const live = has("live"); const jsonOut = has("json"); const overwrite = has("overwrite");
const minConfidence = arg("min-confidence") ? parseFloat(arg("min-confidence")!) : 0.7;
if (!assetId) { console.error("--asset is required"); process.exit(1); }
const log = (...a: unknown[]) => { if (!jsonOut) console.log(...a); else console.error(...a); };

(async () => {
  log(`Profile: ${getCurrentProfileInfo().name} | ${live ? "LIVE" : "DRY-RUN"}`);
  const asset = await fetchAsset(assetId);
  const versionId = await resolveActiveVersion(assetId, asset);
  const picked = pickTranscription(await fetchAllTranscription(assetId), await fetchTranscriptionProperties(assetId, versionId));
  if (!picked.segments.length || !picked.transcriptionId) { log("no transcript on asset"); if (jsonOut) console.log(JSON.stringify({ ok: false, error: "no transcript", asset_id: assetId })); process.exit(3); }
  const existing = picked.props?.speaker_labels ?? null;
  const hints = { title: asset.title, keyterms: parseKeyterms(arg("keyterms")), notes: arg("notes") ?? null, knownLabels: overwrite ? null : existing };
  log(`Transcript ${picked.transcriptionId}: ${picked.segments.length} segments, existing labels ${JSON.stringify(existing ?? {})}`);
  const r = await proposeSpeakerNames(picked.segments, hints, { model: arg("model") });
  for (const p of r.proposals) log(`  S${p.speaker} (${p.paragraphs} paragraphs, ${p.words} words) → ${p.name ?? "—"}  conf ${p.confidence.toFixed(2)}  ${p.evidence.slice(0, 120)}`);
  const m = mergeLabels(existing, r.proposals, minConfidence, overwrite);
  log(`Would write speaker_labels: ${JSON.stringify(m.labels)} (${m.applied.length} new/changed, ${m.skipped.length} skipped)${r.usage ? ` · tokens in/out ${r.usage.input_tokens}/${r.usage.output_tokens}` : ""}`);
  if (live && m.applied.length) { await writeSpeakerLabels(assetId, versionId, picked.transcriptionId, m.labels); log("Written."); }
  else if (live) log("Nothing to write.");
  else log("DRY-RUN — nothing written. Re-run with --live.");
  if (jsonOut) console.log(JSON.stringify({ ok: true, dry_run: !live, written: live && m.applied.length > 0, asset_id: assetId, transcription_id: picked.transcriptionId, model: r.model, labels: m.labels, applied: m.applied.map((p) => ({ speaker: p.speaker, name: p.name, confidence: p.confidence })), skipped: m.skipped.map((p) => ({ speaker: p.speaker, name: p.name, confidence: p.confidence, evidence: p.evidence.slice(0, 160) })), usage: r.usage ?? null }));
})().catch((e) => { console.error("Fatal:", e instanceof Error ? e.message : e); if (jsonOut) console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), asset_id: assetId })); process.exit(1); });
