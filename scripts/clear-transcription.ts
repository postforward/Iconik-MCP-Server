#!/usr/bin/env npx tsx
/**
 * CLEAR every TRANSCRIPTION segment (and transcription properties record) from an asset, with a backup.
 *
 *   npx tsx scripts/clear-transcription.ts --profile=<profile> --asset=<uuid> [--live] [--json]
 *
 * Dry-run lists what would go. Live: backup → bulk delete per version → delete properties → reindex → verify 0.
 * The backup is the same JSONL the importer writes, so `elevenlabs-import.ts --restore-from=<file> --live` undoes it.
 */
import * as fs from "fs";
import * as path from "path";
import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";
import { fetchAllTranscription, countTranscription, resolveActiveVersion, fetchTranscriptionProperties } from "../src/lib/iconik-transcripts.ts";

initializeProfile(getProfileFromArgs());
const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const live = args.includes("--live"), jsonOut = args.includes("--json");
const assetId = arg("asset");
if (!assetId) { console.error("--asset is required"); process.exit(1); }
const log = (...a: unknown[]) => { if (!jsonOut) console.log(...a); else console.error(...a); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  log(`Profile: ${getCurrentProfileInfo().name} | ${live ? "LIVE" : "DRY-RUN"}`);
  const versionId = await resolveActiveVersion(assetId);
  const segments = await fetchAllTranscription(assetId);
  const props = await fetchTranscriptionProperties(assetId, versionId);
  const groups = [...new Set(segments.map((s) => s.transcription_id ?? "null"))];
  log(`Asset ${assetId} version ${versionId}: ${segments.length} TRANSCRIPTION segments in ${groups.length} group(s) [${groups.join(", ")}], ${props.length} properties record(s) [${props.map((p) => `${p.id} ${p.engine_info?.name ?? ""} labels=${JSON.stringify(p.speaker_labels ?? null)}`).join("; ")}]`);
  if (!live) { log("DRY-RUN — nothing deleted. Re-run with --live."); if (jsonOut) console.log(JSON.stringify({ dry_run: true, asset_id: assetId, segments: segments.length, properties: props.length })); return; }
  fs.mkdirSync("backups", { recursive: true });
  const file = path.join("backups", `clear-transcription-backup-${assetId}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  fs.writeFileSync(file, [JSON.stringify({ __properties: props, asset_id: assetId, version_id: versionId, count: segments.length }), ...segments.map((s) => JSON.stringify(s))].join("\n") + "\n");
  log(`Backup: ${file}`);
  const versions = [...new Set([versionId, ...segments.map((s) => s.version_id).filter(Boolean) as string[]])];
  for (const v of versions) await iconikRequest(`assets/v1/assets/${assetId}/segments/bulk/?immediately=true`, { method: "DELETE", body: JSON.stringify({ segment_type: "TRANSCRIPTION", version_id: v }) });
  let left = await countTranscription(assetId); const t0 = Date.now();
  while (left > 0 && Date.now() - t0 < 60_000) { await sleep(2000); left = await countTranscription(assetId); }
  if (left > 0) {
    const rest = await fetchAllTranscription(assetId);
    for (let i = 0; i < rest.length; i += 500) await iconikRequest(`assets/v1/assets/${assetId}/segments/bulk/?immediately=true`, { method: "DELETE", body: JSON.stringify({ segment_type: "TRANSCRIPTION", segment_ids: rest.slice(i, i + 500).map((s) => s.id) }) });
    await sleep(3000); left = await countTranscription(assetId);
  }
  for (const p of props) { try { await iconikRequest(`assets/v1/assets/${assetId}/versions/${versionId}/transcriptions/${p.id}/properties/`, { method: "DELETE" }); } catch (e) { log(`  ⚠ properties ${p.id}: ${e instanceof Error ? e.message.slice(0, 120) : e}`); } }
  try { await iconikRequest(`assets/v1/assets/${assetId}/segments/reindex/`, { method: "POST", body: "{}" }); } catch { /* ignore */ }
  const propsAfter = await fetchTranscriptionProperties(assetId, versionId);
  log(`Cleared → ${left} segments left, ${propsAfter.length} properties records left`);
  if (jsonOut) console.log(JSON.stringify({ dry_run: false, asset_id: assetId, deleted_segments: segments.length - left, segments_left: left, properties_deleted: props.length - propsAfter.length, backup: file }));
  if (left > 0) process.exit(2);
})().catch((e) => { console.error("Fatal:", e instanceof Error ? e.message : e); process.exit(1); });
