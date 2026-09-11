/**
 * Pure converters: iconik TRANSCRIPTION segments ⇄ Hyperaudio Lite Editor project JSON (formatVersion 1.3).
 *
 * No I/O. Unit-tested in test/hyperaudio.test.ts.
 *
 * Hyperaudio facts (read from upstream v1.3.15, js/hyperaudio-save.js + js/html-json-converter.js):
 *  - project = { format:"hyperaudio", formatVersion:"1.3", media:{kind:"link"|"none"|"original",…},
 *               texts:{title,language,…}, provenance?, transcript:{ words:[{start,end,text,space?,struck?}],
 *               paragraphs:[{speaker?,start,end}] } } — times in SECONDS.
 *  - validateProjectJson: format must be "hyperaudio", formatVersion major 1, media.kind "link" needs an
 *    http(s) url, every word needs finite 0 ≤ start ≤ end. provenance survives a save only if it has
 *    engine or model.
 *  - A word belongs to the LAST paragraph whose start ≤ word.start (words before the first go to the first).
 *  - Speaker labels are free text in [brackets]; unnamed iconik speakers are shown as "Speaker N" with
 *    N = iconik int + 1 (the iconik UI numbers them the same way).
 *  - Struck words (struck:true) are redactions → dropped on the way back. space:false = glued token.
 *
 * iconik facts: word times are ms RELATIVE to the segment start; speaker is a 0-based int (null = unknown);
 * rev.ai-style non-speech tokens look like <laugh>.
 */
import type { ElTranscript, ElWord } from "./elevenlabs.js";
import type { IkTranscriptionSegment, IkTranscriptionProps } from "./iconik-transcripts.js";

export interface HaWord { start: number; end: number; text: string; space?: boolean; struck?: boolean }
export interface HaParagraph { speaker?: string | null; start: number; end: number }
export interface HaMedia { kind: "link" | "none" | "original"; url?: string; mimeType?: string; filename?: string; sizeBytes?: number; durationSeconds?: number; path?: string }
export interface HaProvenance {
  engine: string;              // "iconik" — keeps the block through an editor save
  model?: string;              // original engine name (e.g. "ElevenLabs scribe_v2")
  assetId: string;
  versionId: string;
  transcriptionId: string | null;
  exportedAt: string;
  /** iconik speaker int → name at export time; used to map names back to ints on save. */
  speakerLabels: Record<string, string>;
  /** Ints that existed at export time even when unnamed (so "Speaker 3" round-trips to 2). */
  speakerInts: number[];
  /** [paragraph start seconds, iconik speaker int] per exported paragraph — lets a RENAMED speaker
   *  ("[Speaker 2]" → "[McKenzie]") keep its int on the way back. */
  paragraphs: [number, number][];
  segments: number;
  revision?: number;
  [k: string]: unknown;
}
export interface HaProject {
  format: "hyperaudio";
  formatVersion: string;
  generator?: { name: string; version: string };
  created?: string;
  modified?: string;
  media: HaMedia;
  options?: Record<string, unknown>;
  texts: { title: string; language: string; summary?: string; topics?: string[] };
  provenance?: HaProvenance;
  transcript: { words: HaWord[]; paragraphs: HaParagraph[] };
}
/** Sidecar: `${absStartMs}|${normalizedText}` → iconik confidence score. */
export type ScoreMap = Record<string, number>;

export interface ExportMeta { assetId: string; versionId: string; title: string; transcriptionId?: string | null; engine?: string | null; revision?: number; exportedAt?: string; generatorVersion?: string }
export interface ExportOptions {
  /** "speaker": merge consecutive same-speaker segments (break on gap ≥ paragraphGapMs). "segment": one paragraph per iconik segment. */
  paragraphs?: "speaker" | "segment";
  paragraphGapMs?: number;
  media?: HaMedia | null;
  language?: string | null;
}

export const DEFAULT_SPEAKER_RE = /^speaker\s*(\d+)$/i;
export const speakerDisplayName = (int: number, labels: Record<string, string> | null | undefined) => labels?.[String(int)]?.trim() || `Speaker ${int + 1}`;
export const normText = (t: string) => t.normalize("NFC").trim().toLowerCase();
export const scoreKey = (absMs: number, text: string) => `${Math.round(absMs)}|${normText(text)}`;
const sec = (ms: number) => Math.round(ms) / 1000;

export function isHyperaudioProject(j: unknown): j is HaProject {
  const o = j as any;
  return !!o && o.format === "hyperaudio" && !!o.transcript && Array.isArray(o.transcript.words);
}

/**
 * iconik segments (one transcription_id group, any order) → Hyperaudio project + score sidecar.
 * Word text keeps its punctuation; times become absolute seconds (3 dp). Speaker null → 0.
 */
export function iconikToHyperaudio(
  segments: IkTranscriptionSegment[],
  props: IkTranscriptionProps | null,
  meta: ExportMeta,
  opts: ExportOptions = {},
): { project: HaProject; scores: ScoreMap } {
  const mode = opts.paragraphs ?? "speaker";
  const gapMs = opts.paragraphGapMs ?? 2000;
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(props?.speaker_labels ?? {})) if (typeof v === "string" && v.trim()) labels[k] = v.trim();
  const segs = [...segments].sort((a, b) => a.time_start_milliseconds - b.time_start_milliseconds || a.time_end_milliseconds - b.time_end_milliseconds);

  const words: HaWord[] = [];
  const paragraphs: HaParagraph[] = [];
  const scores: ScoreMap = {};
  const ints = new Set<number>();
  let cur: HaParagraph | null = null;
  let curSpeaker = -1;
  const paraInts: number[] = [];
  let lastEndMs = 0;
  let lastAbsMs = -1;

  for (const s of segs) {
    const spk = s.transcription?.speaker ?? 0;
    ints.add(spk);
    const segWords = (s.transcription?.words ?? []).filter((w) => w && typeof w.value === "string" && w.value.trim() !== "");
    if (!segWords.length) continue;
    const newPara = mode === "segment" || cur === null || spk !== curSpeaker || s.time_start_milliseconds - lastEndMs >= gapMs;
    if (newPara) {
      cur = { speaker: speakerDisplayName(spk, labels), start: 0, end: 0 };
      paragraphs.push(cur);
      paraInts.push(spk);
      curSpeaker = spk;
    }
    let first = true;
    for (const w of segWords) {
      let absStart = s.time_start_milliseconds + Math.max(0, w.start_ms ?? 0);
      let absEnd = s.time_start_milliseconds + Math.max(w.end_ms ?? w.start_ms ?? 0, w.start_ms ?? 0);
      if (absStart < lastAbsMs) absStart = lastAbsMs; // keep monotonic (the editor sorts by start)
      if (absEnd < absStart) absEnd = absStart;
      lastAbsMs = absStart;
      const text = w.value.trim();
      words.push({ start: sec(absStart), end: sec(absEnd), text });
      if (typeof w.score === "number") scores[scoreKey(absStart, text)] = w.score;
      if (first && newPara) cur!.start = sec(absStart);
      if (first && !newPara && cur) cur.start = Math.min(cur.start, sec(absStart));
      cur!.end = Math.max(cur!.end, sec(absEnd));
      first = false;
    }
    lastEndMs = Math.max(lastEndMs, s.time_end_milliseconds);
  }

  const exportedAt = meta.exportedAt ?? new Date().toISOString();
  const project: HaProject = {
    format: "hyperaudio",
    formatVersion: "1.3",
    generator: { name: "mcp-iconik/transcript-export-hyperaudio", version: meta.generatorVersion ?? "1" },
    created: exportedAt,
    modified: exportedAt,
    media: opts.media ?? { kind: "none" },
    options: { view: { showSpeakers: true, showTimecodes: true } },
    texts: { title: meta.title, language: (opts.language ?? props?.language ?? "") || "", summary: "", topics: [] },
    provenance: {
      engine: "iconik",
      model: meta.engine ?? ([props?.engine_info?.name, props?.engine_info?.model].filter(Boolean).join(" ") || undefined),
      assetId: meta.assetId,
      versionId: meta.versionId,
      transcriptionId: meta.transcriptionId ?? props?.id ?? null,
      exportedAt,
      speakerLabels: labels,
      speakerInts: [...ints].sort((a, b) => a - b),
      paragraphs: paragraphs.map((p, i) => [p.start, paraInts[i]] as [number, number]),
      segments: segs.length,
      ...(meta.revision != null ? { revision: meta.revision } : {}),
    },
    transcript: { words, paragraphs },
  };
  return { project, scores };
}

export interface ImportOptions {
  scores?: ScoreMap | null;
  /** iconik int → name currently on the asset (properties.speaker_labels); merged with provenance.speakerLabels. */
  knownLabels?: Record<string, string> | null;
  /** Confidence for words not found in the sidecar (edited/inserted). Default 0.99. */
  editedScore?: number;
}
export interface ImportResult {
  transcript: ElTranscript;
  /** int → name for every speaker whose label is not the default "Speaker N". undefined when none. */
  speakerLabels?: Record<string, string>;
  /** name → int as resolved for this document. */
  speakerMap: Record<string, number>;
  stats: { words: number; struck: number; inserted: number; paragraphs: number; unknownSpeakerParagraphs: number };
}

/**
 * Hyperaudio project (after editing) → ElevenLabs-shaped transcript for convertElevenLabsToSegments.
 * Each paragraph becomes a hard segment break (first word flagged), then the usual 10 s / 40-word
 * re-chunk applies. Speaker names map back to iconik ints: "Speaker N" → N-1, a known name → its int,
 * a new name → the next unused int. Struck words are dropped; multi-word spans are split evenly.
 */
export function hyperaudioToTranscript(project: HaProject, options: ImportOptions = {}): ImportResult {
  const scores = options.scores ?? {};
  const editedScore = options.editedScore ?? 0.99;
  const prov = project.provenance;
  // name(lower) → int, from provenance first, then live labels (live wins on conflict)
  const nameToInt = new Map<string, number>();
  const usedInts = new Set<number>((prov?.speakerInts ?? []).filter((n) => Number.isInteger(n)));
  const addLabels = (labels?: Record<string, string> | null) => {
    for (const [k, v] of Object.entries(labels ?? {})) {
      const n = parseInt(k, 10);
      if (!Number.isInteger(n) || typeof v !== "string" || !v.trim()) continue;
      nameToInt.set(normText(v), n);
      usedInts.add(n);
    }
  };
  addLabels(prov?.speakerLabels);
  addLabels(options.knownLabels);
  const speakerMap: Record<string, number> = {};
  const claimed = new Set<number>();
  const claim = (name: string, n: number) => { speakerMap[name] = n; claimed.add(n); usedInts.add(n); return n; };
  const provParas = [...(prov?.paragraphs ?? [])].filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isInteger(x[1])).sort((a, b) => a[0] - b[0]);
  /** iconik int of the exported paragraph that contained this time, or undefined. */
  const intAt = (t: number): number | undefined => {
    let hit: number | undefined;
    for (const [start, n] of provParas) { if (start <= t + 0.0005) hit = n; else break; }
    return hit;
  };
  /** Pass 1 (default names + known names) claims ints deterministically; pass 2 places new names:
   *  the int of the paragraph they replaced when nobody else claims it, else the next unused int. */
  const resolvePass1 = (name: string): number | undefined => {
    if (speakerMap[name] != null) return speakerMap[name];
    const m = DEFAULT_SPEAKER_RE.exec(name.trim());
    if (m) return claim(name, Math.max(0, parseInt(m[1], 10) - 1));
    const key = normText(name);
    if (nameToInt.has(key)) return claim(name, nameToInt.get(key)!);
    return undefined;
  };
  const resolvePass2 = (name: string, anchorSec: number): number => {
    if (speakerMap[name] != null) return speakerMap[name];
    const cand = intAt(anchorSec);
    if (cand != null && !claimed.has(cand)) return claim(name, cand);
    let n = 0;
    while (usedInts.has(n) || claimed.has(n)) n++;
    return claim(name, n);
  };

  const paragraphs = [...(project.transcript.paragraphs ?? [])].sort((a, b) => a.start - b.start);
  const wordsIn = [...(project.transcript.words ?? [])].filter((w) => w && typeof w.text === "string").sort((a, b) => a.start - b.start);
  // assign words to paragraphs: last paragraph with start ≤ word.start; words before the first → first
  const buckets: HaWord[][] = paragraphs.map(() => []);
  if (paragraphs.length === 0) { paragraphs.push({ speaker: null, start: 0, end: 0 }); buckets.push([]); }
  let pi = 0;
  for (const w of wordsIn) {
    while (pi + 1 < paragraphs.length && paragraphs[pi + 1].start <= w.start) pi++;
    buckets[pi].push(w);
  }

  const names = paragraphs.map((p) => (p.speaker ?? "").trim());
  names.forEach((name) => { if (name) resolvePass1(name); });
  names.forEach((name, i) => { if (name && speakerMap[name] == null) resolvePass2(name, buckets[i][0]?.start ?? paragraphs[i].start); });

  const out: ElWord[] = [];
  let struck = 0, inserted = 0, unknownSpeakerParagraphs = 0;
  let lastSpeakerInt = 0;
  paragraphs.forEach((p, i) => {
    const name = names[i];
    let spk: number;
    if (name) spk = speakerMap[name];
    else { spk = lastSpeakerInt; unknownSpeakerParagraphs++; }
    lastSpeakerInt = spk;
    let first = true;
    for (const w of buckets[i]) {
      if (w.struck) { struck++; continue; }
      const raw = w.text.trim();
      if (!raw) continue;
      const pieces = raw.split(/\s+/);
      const span = Math.max(0, (w.end ?? w.start) - w.start);
      const step = pieces.length > 1 ? span / pieces.length : span;
      pieces.forEach((piece, k) => {
        const start = pieces.length > 1 ? w.start + k * step : w.start;
        const end = pieces.length > 1 ? w.start + (k + 1) * step : w.start + span;
        const legacyEvent = /^<[\w_]+>$/.exec(piece);
        const bracketEvent = /^[\[(]([^\])]+)[\])]$/.exec(piece);
        const isEvent = !!legacyEvent || !!bracketEvent;
        const text = legacyEvent ? piece.slice(1, -1) : piece;
        const key = scoreKey(start * 1000, piece);
        let score: number;
        if (Object.prototype.hasOwnProperty.call(scores, key)) score = scores[key];
        else { score = editedScore; if (!isEvent) inserted++; }
        out.push({
          text: isEvent && bracketEvent ? bracketEvent[0] : text,
          type: isEvent ? "audio_event" : "word",
          start: round3(start), end: round3(Math.max(end, start)),
          speaker_id: `speaker_${spk}`,
          segment_break: first,
          score,
        });
        first = false;
      });
    }
  });

  const speakerLabels: Record<string, string> = {};
  for (const [name, n] of Object.entries(speakerMap)) if (!DEFAULT_SPEAKER_RE.test(name)) speakerLabels[String(n)] = name;
  const transcript: ElTranscript = { language_code: project.texts?.language ?? "", text: out.filter((w) => w.type === "word").map((w) => w.text).join(" "), words: out };
  return {
    transcript,
    speakerLabels: Object.keys(speakerLabels).length ? speakerLabels : undefined,
    speakerMap,
    stats: { words: out.length, struck, inserted, paragraphs: paragraphs.length, unknownSpeakerParagraphs },
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Human-readable one-liner for logs/Slack: "202 segments · 1,896 words · speakers Ben, Speaker 2". */
export function describeProject(p: HaProject): string {
  const names = [...new Set((p.transcript.paragraphs ?? []).map((x) => (x.speaker ?? "").trim()).filter(Boolean))];
  return `${p.transcript.words.length.toLocaleString()} words · ${p.transcript.paragraphs.length} paragraphs · speakers ${names.join(", ") || "-"}`;
}
