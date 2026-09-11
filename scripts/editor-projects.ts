#!/usr/bin/env npx tsx
/**
 * TRANSCRIPT EDITOR PROJECT INDEX (local, read-only against iconik)
 *
 * One JSON file per asset under editor-projects/<asset_id>.json is the list the team's editor
 * platform reads. editor-history/<asset_id>/ holds saved snapshots (Hyperaudio project JSON +
 * confidence-score sidecars) referenced from each entry's history. This script never writes to
 * iconik — only reads (fetchAsset / segments / transcription properties) — so there is no --live
 * flag; all commands take effect immediately on the local index.
 *
 *   npx tsx scripts/editor-projects.ts --profile=<profile> --register=<asset> [--by=<user>] [--json]
 *   npx tsx scripts/editor-projects.ts --profile=<profile> --list [--json]
 *   npx tsx scripts/editor-projects.ts --profile=<profile> --get=<asset> [--json]
 *   npx tsx scripts/editor-projects.ts --profile=<profile> --set-status=<asset>:<saved|ready|failed> \
 *       [--snapshot=<file>] [--scores=<file>] [--summary=<json string>] [--by=<user>] [--note=<text>] [--json]
 *   npx tsx scripts/editor-projects.ts --profile=<profile> --history=<asset> [--json]
 *   npx tsx scripts/editor-projects.ts --profile=<profile> --remove=<asset> [--json]
 *
 * --register: fetches the asset + its picked TRANSCRIPTION track (pickTranscription drops
 * duplicate transcription_id groups) and writes/refreshes editor-projects/<asset>.json. Re-running
 * on an existing entry bumps `revision`, sets status back to "ready", and keeps history/added_at.
 * An asset with no transcript is NOT registered — prints {ok:false, error:"no transcript"} and
 * exits 3.
 *
 * --set-status=saved optionally copies a --snapshot (Hyperaudio project JSON) and/or --scores
 * (confidence sidecar) file into editor-history/<asset>/ under a revision-stamped name, and can
 * parse a --summary JSON string (e.g. the elevenlabs-import summary) to refresh transcription_id
 * / segments on the entry. Unknown asset exits 4.
 */
import * as fs from "fs";
import * as path from "path";
import { initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs, getProfile } from "../src/config.ts";
import { fetchAsset, resolveActiveVersion, fetchAllTranscription, fetchTranscriptionProperties, pickTranscription, normLang, type IkTranscriptionSegment } from "../src/lib/iconik-transcripts.ts";
import { speakerDisplayName } from "../src/lib/hyperaudio.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);
const profile = getProfile(profileName);

const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const has = (n: string) => args.includes(`--${n}`);
const jsonOut = has("json");
const log = (...a: unknown[]) => { if (!jsonOut) console.log(...a); else console.error(...a); };

const PROJECTS_DIR = "editor-projects";
const HISTORY_DIR = "editor-history";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface HistoryEvent {
  at: string;
  event: "sent" | "saved" | "failed" | "status";
  by?: string;
  revision: number;
  transcription_id?: string | null;
  segments?: number;
  words?: number;
  speakers?: string[];
  snapshot?: string;
  scores?: string;
  summary?: unknown;
  note?: string;
}
interface ProjectEntry {
  asset_id: string;
  title: string;
  version_id: string;
  added_at: string;
  added_by?: string;
  resent_at?: string;
  status: "ready" | "saved" | "failed";
  saved_at?: string;
  saved_by?: string;
  transcription_id: string | null;
  language?: string;
  segments: number;
  words: number;
  speakers: string[];
  duration_ms: number;
  revision: number;
  updated_at: string;
  history: HistoryEvent[];
}

// ---------------------------------------------------------------------------
// Local index I/O
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();
const projectPath = (assetId: string) => path.join(PROJECTS_DIR, `${assetId}.json`);
const historyAssetDir = (assetId: string) => path.join(HISTORY_DIR, assetId);

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function readProject(assetId: string): ProjectEntry | null {
  const p = projectPath(assetId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function listProjects(): ProjectEntry[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), "utf8")) as ProjectEntry);
}

// ---------------------------------------------------------------------------
// --register
// ---------------------------------------------------------------------------
function assetDurationMs(asset: any): number | null {
  for (const c of [asset?.duration_milliseconds, asset?.duration_ms, asset?.duration]) {
    if (typeof c === "number" && isFinite(c) && c > 0) return c;
  }
  return null;
}

function orderedSpeakers(segments: IkTranscriptionSegment[], labels: Record<string, string> | null | undefined): string[] {
  const sorted = [...segments].sort((a, b) => a.time_start_milliseconds - b.time_start_milliseconds);
  const seen = new Set<number>();
  const names: string[] = [];
  for (const s of sorted) {
    const spk = s.transcription?.speaker ?? 0;
    if (seen.has(spk)) continue;
    seen.add(spk);
    names.push(speakerDisplayName(spk, labels));
  }
  return names;
}

function countWords(segments: IkTranscriptionSegment[]): number {
  return segments.reduce((n, s) => n + (s.transcription?.words?.length ?? 0), 0);
}

async function doRegister(assetId: string, by: string | undefined): Promise<void> {
  const asset = await fetchAsset(assetId);
  const versionId = await resolveActiveVersion(assetId, asset);
  const allSegments = await fetchAllTranscription(assetId);
  const props = await fetchTranscriptionProperties(assetId, versionId);
  const picked = pickTranscription(allSegments, props);

  if (picked.segments.length === 0) {
    const out = { ok: false, error: "no transcript", asset_id: assetId, version_id: versionId };
    if (jsonOut) console.log(JSON.stringify(out)); else log(`No transcript on asset ${assetId} (version ${versionId}) — not registered.`);
    process.exit(3);
  }

  const title: string = asset.title ?? assetId;
  const language = normLang(picked.props?.language) ?? undefined;
  const words = countWords(picked.segments);
  const speakers = orderedSpeakers(picked.segments, picked.props?.speaker_labels);
  const durationMs = assetDurationMs(asset) ?? Math.max(0, ...picked.segments.map((s) => s.time_end_milliseconds));
  const updatedAt = nowIso();

  const existing = readProject(assetId);
  const revision = (existing?.revision ?? 0) + 1;
  const historyEvent: HistoryEvent = {
    at: updatedAt,
    event: "sent",
    by,
    revision,
    transcription_id: picked.transcriptionId,
    segments: picked.segments.length,
    words,
    speakers,
  };

  const entry: ProjectEntry = {
    asset_id: assetId,
    title,
    version_id: versionId,
    added_at: existing?.added_at ?? updatedAt,
    added_by: existing?.added_by ?? by,
    ...(existing ? { resent_at: updatedAt } : {}),
    status: "ready",
    ...(existing?.saved_at ? { saved_at: existing.saved_at } : {}),
    ...(existing?.saved_by ? { saved_by: existing.saved_by } : {}),
    transcription_id: picked.transcriptionId,
    language,
    segments: picked.segments.length,
    words,
    speakers,
    duration_ms: durationMs,
    revision,
    updated_at: updatedAt,
    history: [...(existing?.history ?? []), historyEvent],
  };

  writeJsonAtomic(projectPath(assetId), entry);
  log(`Registered ${assetId} "${title}" rev${revision}: ${picked.segments.length} segments, ${words} words, speakers: ${speakers.join(", ") || "-"}${picked.duplicatesDropped ? ` (dropped ${picked.duplicatesDropped} duplicate segment(s) from other transcription_id groups)` : ""}`);
  if (jsonOut) console.log(JSON.stringify({ ok: true, project: entry }));
}

// ---------------------------------------------------------------------------
// --set-status
// ---------------------------------------------------------------------------
function tsForFilename(): string {
  return nowIso().replace(/[:.]/g, "-");
}

function copySnapshotFile(assetId: string, src: string, revision: number, suffix: string): string {
  const dir = historyAssetDir(assetId);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${tsForFilename()}-r${revision}.${suffix}`);
  fs.copyFileSync(src, dest);
  return dest;
}

async function doSetStatus(spec: string, by: string | undefined, snapshotFile: string | undefined, scoresFile: string | undefined, summaryStr: string | undefined, note: string | undefined): Promise<void> {
  const sep = spec.lastIndexOf(":");
  if (sep < 0) throw new Error(`--set-status expects <asset>:<saved|ready|failed>, got "${spec}"`);
  const assetId = spec.slice(0, sep);
  const status = spec.slice(sep + 1) as ProjectEntry["status"];
  if (!["saved", "ready", "failed"].includes(status)) throw new Error(`unknown status "${status}" (expected saved|ready|failed)`);

  const entry = readProject(assetId);
  if (!entry) {
    const out = { ok: false, error: "not found", asset_id: assetId };
    if (jsonOut) console.log(JSON.stringify(out)); else log(`No editor-projects entry for ${assetId}.`);
    process.exit(4);
  }

  const revision = entry.revision + 1;
  const updatedAt = nowIso();
  let summary: any;
  if (summaryStr) {
    try { summary = JSON.parse(summaryStr); } catch (e) { throw new Error(`--summary is not valid JSON: ${e instanceof Error ? e.message : e}`); }
  }

  const event: HistoryEvent = {
    at: updatedAt,
    event: status === "saved" ? "saved" : status === "failed" ? "failed" : "status",
    by,
    revision,
  };
  if (note) event.note = note;
  if (summary !== undefined) event.summary = summary;

  entry.status = status;
  entry.revision = revision;
  entry.updated_at = updatedAt;

  if (status === "saved") {
    entry.saved_at = updatedAt;
    if (by) entry.saved_by = by;
    if (snapshotFile) {
      if (!fs.existsSync(snapshotFile)) throw new Error(`--snapshot file not found: ${snapshotFile}`);
      event.snapshot = copySnapshotFile(assetId, snapshotFile, revision, "hyperaudio.json");
    }
    if (scoresFile) {
      if (!fs.existsSync(scoresFile)) throw new Error(`--scores file not found: ${scoresFile}`);
      event.scores = copySnapshotFile(assetId, scoresFile, revision, "scores.json");
    }
    if (summary && typeof summary === "object") {
      if (summary.transcription_id) entry.transcription_id = summary.transcription_id;
      if (summary.segments != null) entry.segments = summary.segments;
    }
  }

  entry.history = [...(entry.history ?? []), event];
  writeJsonAtomic(projectPath(assetId), entry);
  log(`${assetId} → status=${status} rev${revision}${event.snapshot ? ` snapshot=${event.snapshot}` : ""}${event.scores ? ` scores=${event.scores}` : ""}`);
  if (jsonOut) console.log(JSON.stringify({ ok: true, project: entry }));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  log(`Profile: ${getCurrentProfileInfo().name}`);

  const registerArg = arg("register");
  const setStatusArg = arg("set-status");
  const getArg = arg("get");
  const historyArg = arg("history");
  const removeArg = arg("remove");
  const by = arg("by");

  if (registerArg) {
    await doRegister(registerArg, by);
    return;
  }

  if (setStatusArg) {
    await doSetStatus(setStatusArg, by, arg("snapshot"), arg("scores"), arg("summary"), arg("note"));
    return;
  }

  if (has("list")) {
    const projects = listProjects().sort((a, b) => (b.updated_at ?? b.added_at ?? "").localeCompare(a.updated_at ?? a.added_at ?? ""));
    if (jsonOut) {
      console.log(JSON.stringify({ ok: true, projects: projects.map(({ history, ...rest }) => ({ ...rest, history_count: history?.length ?? 0 })) }));
    } else {
      if (!projects.length) log("(no editor projects)");
      for (const p of projects) log(`${p.title}  [${p.status}] rev${p.revision}  segs=${p.segments} words=${p.words}  speakers: ${p.speakers?.join(", ") || "-"}  by=${p.added_by ?? "-"}  added=${p.added_at}`);
    }
    return;
  }

  if (getArg) {
    const entry = readProject(getArg);
    if (!entry) {
      const out = { ok: false, error: "not found", asset_id: getArg };
      if (jsonOut) console.log(JSON.stringify(out)); else log(`No editor-projects entry for ${getArg}.`);
      process.exit(1);
    }
    if (jsonOut) console.log(JSON.stringify({ ok: true, project: entry }));
    else log(JSON.stringify(entry, null, 2));
    return;
  }

  if (historyArg) {
    const entry = readProject(historyArg);
    if (!entry) {
      const out = { ok: false, error: "not found", asset_id: historyArg };
      if (jsonOut) console.log(JSON.stringify(out)); else log(`No editor-projects entry for ${historyArg}.`);
      process.exit(1);
    }
    if (jsonOut) console.log(JSON.stringify({ ok: true, asset_id: historyArg, history: entry.history ?? [] }));
    else (entry.history ?? []).forEach((h, i) => log(`[${i}] ${h.at} ${h.event} rev${h.revision}${h.by ? ` by=${h.by}` : ""}${h.note ? ` note="${h.note}"` : ""}`));
    return;
  }

  if (removeArg) {
    const p = projectPath(removeArg);
    const removed = fs.existsSync(p);
    if (removed) fs.unlinkSync(p);
    log(removed ? `Removed ${removeArg} from editor-projects.` : `No editor-projects entry for ${removeArg} (nothing to remove).`);
    if (jsonOut) console.log(JSON.stringify({ ok: true, removed }));
    return;
  }

  throw new Error("no command given — use one of --register / --list / --get / --set-status / --history / --remove");
}

main().catch((e) => { console.error("Fatal:", e instanceof Error ? e.message : e); process.exit(1); });
