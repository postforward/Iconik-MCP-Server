#!/usr/bin/env npx tsx
/**
 * EXPORT AN ICONIK TRANSCRIPT TO A HYPERAUDIO LITE EDITOR PROJECT (read-only)
 *
 *   npx tsx scripts/transcript-export-hyperaudio.ts --profile=<profile> --asset=<uuid>
 *       [--media=audio|video|none]      # default audio: proxy kind put in project.media (kind "link"); none -> media.kind "none"
 *       [--paragraphs=speaker|segment]  # default speaker
 *       [--revision=<int>]              # optional, copied into provenance.revision
 *       [--out=<file>]                  # writes ONLY the project JSON (pretty) to this file
 *       [--scores-out=<file>]           # writes the scores sidecar JSON to this file
 *       [--summary]                     # counts only: no words/project in the output (skips the proxy call)
 *       [--json]                        # last stdout line is one JSON object; human log goes to stderr
 *
 * Reads the asset's TRANSCRIPTION segments + properties, picks the winning transcription group
 * (dedupes duplicates), converts to a Hyperaudio Lite Editor project (formatVersion 1.3) + a
 * confidence-score sidecar, and (unless --media=none / --summary) fetches a fresh presigned proxy
 * URL to embed as project.media. Every iconik call here is a GET — this script never writes.
 */
import * as fs from "fs";
import * as path from "path";
import { initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";
import {
  fetchAsset,
  resolveActiveVersion,
  fetchAllTranscription,
  fetchTranscriptionProperties,
  pickTranscription,
  freshProxyUrl,
  normLang,
  type ProxyLink,
} from "../src/lib/iconik-transcripts.ts";
import { iconikToHyperaudio, describeProject, type HaMedia } from "../src/lib/hyperaudio.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const has = (n: string) => args.includes(`--${n}`);
const jsonOut = has("json");
const summary = has("summary");
const log = (...a: unknown[]) => { if (!jsonOut) console.log(...a); else console.error(...a); };

const assetId = arg("asset");
const mediaMode = (arg("media") ?? "audio") as "audio" | "video" | "none";
const paragraphMode = (arg("paragraphs") ?? "speaker") as "speaker" | "segment";
const revisionArg = arg("revision");
const revision = revisionArg !== undefined ? parseInt(revisionArg, 10) : undefined;
const outFile = arg("out");
const scoresOutFile = arg("scores-out");

if (!["audio", "video", "none"].includes(mediaMode)) { console.error(`invalid --media=${mediaMode} (want audio|video|none)`); process.exit(1); }
if (!["speaker", "segment"].includes(paragraphMode)) { console.error(`invalid --paragraphs=${paragraphMode} (want speaker|segment)`); process.exit(1); }
if (revisionArg !== undefined && !Number.isFinite(revision)) { console.error(`invalid --revision=${revisionArg} (want an integer)`); process.exit(1); }

function mkdirFor(file: string) {
  const dir = path.dirname(file);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
}

/**
 * Best-effort asset-level duration in ms. iconik's asset GET does not (as of 2026-09) carry a
 * dedicated duration field for most assets; we probe a few candidate shapes defensively and fall
 * back to the transcript's own extent when none are present.
 */
function assetDurationMs(asset: any): number | null {
  const candidates = [asset?.duration, asset?.media_duration, asset?.duration_milliseconds];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  }
  const start = asset?.time_start_milliseconds;
  const end = asset?.time_end_milliseconds;
  if (typeof start === "number" && typeof end === "number" && end > start) return end - start;
  return null;
}

async function main() {
  if (!assetId) throw new Error("--asset is required");

  log(`Profile: ${getCurrentProfileInfo().name}`);
  log(`Asset: ${assetId}`);

  const asset = await fetchAsset(assetId);
  const versionId = await resolveActiveVersion(assetId, asset);
  const title = asset.title ?? assetId;
  log(`Title: ${title}`);
  log(`Version: ${versionId}`);

  const [segments, props] = await Promise.all([
    fetchAllTranscription(assetId),
    fetchTranscriptionProperties(assetId, versionId),
  ]);
  const picked = pickTranscription(segments, props);

  if (picked.groups.length > 1) {
    log(`Transcription groups found: ${picked.groups.length} (${picked.groups.map((g) => `${g.transcriptionId ?? "null"}:${g.count}`).join(", ")})`);
  }
  if (picked.duplicatesDropped > 0) {
    log(`Duplicates dropped: ${picked.duplicatesDropped} segment(s) from non-winning groups`);
  }

  if (picked.segments.length === 0) {
    console.error(`No TRANSCRIPTION segments found on asset ${assetId} (${title})`);
    if (jsonOut) {
      console.log(JSON.stringify({ ok: false, error: "no transcript", asset: { id: assetId, title, version_id: versionId } }));
    }
    process.exit(3);
  }

  log(`Transcription id: ${picked.transcriptionId ?? "(none)"}`);

  // Duration
  const assetMs = assetDurationMs(asset);
  let durationMs: number;
  let durationSource: "asset" | "segments";
  if (assetMs !== null) {
    durationMs = assetMs;
    durationSource = "asset";
  } else {
    durationMs = picked.segments.reduce((m, s) => Math.max(m, s.time_end_milliseconds ?? 0), 0);
    durationSource = "segments";
  }
  log(`Duration: ${durationMs} ms (source: ${durationSource})`);

  // Media proxy
  let link: ProxyLink | null = null;
  let media: HaMedia | null = null;
  if (summary) {
    media = null; // proxy call skipped entirely with --summary
  } else if (mediaMode === "none") {
    media = { kind: "none" };
  } else {
    link = await freshProxyUrl(assetId, mediaMode);
    if (link) {
      media = { kind: "link", url: link.url, mimeType: link.mime_type, filename: link.filename };
      log(`Media: ${link.filename} (${link.mime_type}) expires ${link.expires_at ?? "unknown"}`);
    } else {
      media = { kind: "none" };
      log(`Media: no CLOSED ${mediaMode} proxy found — falling back to media.kind "none"`);
    }
  }

  const language = normLang(picked.props?.language);
  const { project, scores } = iconikToHyperaudio(picked.segments, picked.props, {
    assetId,
    versionId,
    title,
    transcriptionId: picked.transcriptionId,
    revision,
  }, {
    paragraphs: paragraphMode,
    media,
    language,
  });

  log(describeProject(project));

  const speakers = [...new Set((project.transcript.paragraphs ?? []).map((p) => (p.speaker ?? "").trim()).filter(Boolean))];

  if (outFile) {
    mkdirFor(outFile);
    fs.writeFileSync(outFile, JSON.stringify(project, null, 2));
    log(`Wrote project: ${outFile}`);
  }
  if (scoresOutFile) {
    mkdirFor(scoresOutFile);
    fs.writeFileSync(scoresOutFile, JSON.stringify(scores, null, 2));
    log(`Wrote scores: ${scoresOutFile}`);
  }

  if (jsonOut) {
    const engine = picked.props?.engine_info
      ? [picked.props.engine_info.name, picked.props.engine_info.model].filter(Boolean).join(" ") || null
      : null;
    const out = {
      ok: true,
      asset: {
        id: assetId,
        title,
        version_id: versionId,
        duration_ms: durationMs,
        duration_source: durationSource,
        url: `https://app.iconik.io/asset/${assetId}`,
      },
      iconik: {
        transcription_id: picked.transcriptionId,
        language: language ?? null,
        speaker_labels: picked.props?.speaker_labels ?? null,
        engine,
        segments: picked.segments.length,
        words: project.transcript.words.length,
        duplicates_dropped: picked.duplicatesDropped,
        groups: picked.groups,
      },
      media: media
        ? { kind: media.kind, url: media.url ?? null, mime_type: media.mimeType ?? null, filename: media.filename ?? null, expires_at: link?.expires_at ?? null }
        : null,
      speakers,
      paragraphs: project.transcript.paragraphs.length,
      ...(summary ? {} : { scores, project }),
    };
    console.log(JSON.stringify(out));
  }
}

main().catch((e) => {
  console.error("Fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
