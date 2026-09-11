/**
 * Pure converter: ElevenLabs Scribe transcript → iconik TRANSCRIPTION segments.
 *
 * No I/O. Unit-tested in test/elevenlabs-to-iconik.test.ts.
 *
 * iconik segment facts (verified live on TM, 2026-09-10):
 *  - segment.transcription.words[].start_ms/end_ms are RELATIVE to the segment start.
 *  - word `value` carries its punctuation ("together.").
 *  - speaker is a 0-based int; the UI displays N+1.
 *  - rev.ai used tokens like <laugh>, <affirmative>, <inaudible> for non-speech.
 */

import type { ElTranscript, ElWord } from "./elevenlabs.js";

export interface IkWord {
  value: string;
  start_ms: number;
  end_ms: number;
  score: number;
}

export interface IkSegmentDraft {
  segment_text: string;
  time_start_milliseconds: number;
  time_end_milliseconds: number;
  transcription: { speaker: number; words: IkWord[] };
}

export interface ConvertOptions {
  /** Hard cap on one segment's duration (ms). Default 10000. */
  maxSegMs?: number;
  /** Hard cap on words per segment. Default 40. */
  maxWords?: number;
  /** Silence between consecutive words that forces a new segment (ms). Default 1000. */
  gapSplitMs?: number;
  /** Minimum words before a sentence-final punctuation mark may close a segment. Default 3. */
  minWordsBeforePunctSplit?: number;
  /** Audio events: "speech" keeps only speech-adjacent ones (<laugh>, <applause>, <inaudible>) as rev.ai-style tokens,
   *  "all" keeps every event (music beds, cheers…), "drop" removes all. Default "speech". */
  audioEvents?: "speech" | "all" | "drop";
}

const DEFAULTS: Required<ConvertOptions> = {
  maxSegMs: 10_000,
  maxWords: 40,
  gapSplitMs: 1_000,
  minWordsBeforePunctSplit: 3,
  audioEvents: "speech",
};

const SPEECH_EVENT_TOKENS = new Set(["<laugh>", "<applause>", "<inaudible>"]);
const SENTENCE_END = /[.?!…]["'”’)]*$/;
const CLAUSE_END = /[,;:]["'”’)]*$/;

/** "speaker_3" → 3; "3" → 3; anything else → null. */
export function speakerIdToInt(id: string | null | undefined): number | null {
  if (id == null) return null;
  const m = /(\d+)\s*$/.exec(String(id));
  return m ? parseInt(m[1], 10) : null;
}

/** logprob → 0..1 confidence, 2dp. Missing → 0.99 (ElevenLabs is high-confidence by default). */
export function logprobToScore(logprob: number | null | undefined): number {
  if (logprob == null || !Number.isFinite(logprob)) return 0.99;
  const s = Math.exp(logprob);
  return Math.round(Math.min(1, Math.max(0, s)) * 100) / 100;
}

/** "(laughter)" → "<laugh>", "(applause)" → "<applause>", "music" → "<music>". */
export function audioEventToken(text: string): string {
  const inner = text.replace(/[()\[\]]/g, "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!inner) return "<audio_event>";
  if (/laugh|chuckl|giggl/.test(inner)) return "<laugh>";
  if (/music|song|singing/.test(inner)) return "<music>";
  if (/applau|clap/.test(inner)) return "<applause>";
  if (/inaudible|unintelligible/.test(inner)) return "<inaudible>";
  return `<${inner}>`;
}

interface Tok {
  value: string;
  start_ms: number;
  end_ms: number;
  score: number;
  speaker: number | null;
  isEvent: boolean;
  /** Human-chosen segment start (editor export) — always honoured as a split. */
  brk: boolean;
}

function toTokens(words: ElWord[], opts: Required<ConvertOptions>): Tok[] {
  const out: Tok[] = [];
  let lastEnd = 0;
  for (const w of words) {
    if (w.type === "spacing") continue;
    const isEvent = w.type === "audio_event";
    if (isEvent && opts.audioEvents === "drop") continue;
    const value = isEvent ? audioEventToken(w.text) : w.text.trim();
    if (isEvent && opts.audioEvents === "speech" && !SPEECH_EVENT_TOKENS.has(value)) continue;
    if (!value) continue;
    const start = w.start != null && Number.isFinite(w.start) ? Math.round(w.start * 1000) : lastEnd;
    const end = w.end != null && Number.isFinite(w.end) ? Math.round(w.end * 1000) : start;
    out.push({
      value,
      start_ms: Math.max(start, lastEnd),
      end_ms: Math.max(end, Math.max(start, lastEnd)),
      score: isEvent ? 0.5 : logprobToScore(w.logprob),
      speaker: speakerIdToInt(w.speaker_id),
      isEvent,
      brk: !!w.segment_break,
    });
    lastEnd = out[out.length - 1].end_ms;
  }
  return out;
}

function finalize(toks: Tok[], speaker: number): IkSegmentDraft {
  const t0 = toks[0].start_ms;
  const t1 = toks[toks.length - 1].end_ms;
  return {
    segment_text: toks.map((t) => t.value).join(" "),
    time_start_milliseconds: t0,
    time_end_milliseconds: Math.max(t1, t0),
    transcription: {
      speaker,
      words: toks.map((t) => ({
        value: t.value,
        start_ms: t.start_ms - t0,
        end_ms: Math.max(t.end_ms - t0, t.start_ms - t0),
        score: t.score,
      })),
    },
  };
}

/**
 * Group words into segments. A new segment starts when:
 *  1. the speaker changes,
 *  2. the previous word ended a sentence and the segment has ≥ minWordsBeforePunctSplit words,
 *  3. the silence since the previous word exceeds gapSplitMs,
 *  4. adding the word would exceed maxSegMs or maxWords — in that case the segment is first
 *     split back at its last clause boundary (comma etc.) if one exists in the trailing 40%.
 */
export function convertElevenLabsToSegments(
  t: ElTranscript,
  options: ConvertOptions = {},
): { segments: IkSegmentDraft[]; speakers: number[] } {
  const opts = { ...DEFAULTS, ...options };
  const toks = toTokens(t.words ?? [], opts);
  const segments: IkSegmentDraft[] = [];
  let cur: Tok[] = [];
  let curSpeaker = 0;
  let lastKnownSpeaker = 0;

  const wordCount = (arr: Tok[]) => arr.filter((x) => !x.isEvent).length;
  const flush = () => {
    if (cur.length) segments.push(finalize(cur, curSpeaker));
    cur = [];
  };

  for (const tok of toks) {
    const spk = tok.speaker ?? lastKnownSpeaker;
    if (tok.speaker != null) lastKnownSpeaker = tok.speaker;

    if (cur.length === 0) {
      cur.push(tok);
      curSpeaker = spk;
      continue;
    }
    const prev = cur[cur.length - 1];
    const gap = tok.start_ms - prev.end_ms;
    const speakerChange = spk !== curSpeaker;
    const sentenceDone = !prev.isEvent && SENTENCE_END.test(prev.value) && wordCount(cur) >= opts.minWordsBeforePunctSplit;
    const gapSplit = gap > opts.gapSplitMs;

    if (tok.brk || speakerChange || sentenceDone || gapSplit) {
      flush();
      cur.push(tok);
      curSpeaker = spk;
      continue;
    }

    // Duration is measured from the first real word so a leading audio event (music bed) doesn't inflate it.
    const firstWord = cur.find((x) => !x.isEvent) ?? cur[0];
    const durIfAdded = tok.end_ms - firstWord.start_ms;
    const wordsIfAdded = wordCount(cur) + (tok.isEvent ? 0 : 1);
    const wouldExceed = durIfAdded > opts.maxSegMs || wordsIfAdded > opts.maxWords;
    if (wouldExceed) {
      // Prefer splitting at the last clause boundary in the trailing 40% of the segment;
      // failing that, at the widest pause in that region (never mid-phrase on a tiny gap).
      const from = Math.floor(cur.length * 0.6);
      let cut = -1;
      for (let i = cur.length - 1; i >= from; i--) {
        if (!cur[i].isEvent && (CLAUSE_END.test(cur[i].value) || SENTENCE_END.test(cur[i].value))) { cut = i; break; }
      }
      if (cut < 0) {
        let best = -1, bestGap = 250; // require at least a 250 ms pause to split on
        for (let i = Math.max(from, 1); i < cur.length; i++) {
          const g = cur[i].start_ms - cur[i - 1].end_ms;
          if (g > bestGap) { bestGap = g; best = i - 1; }
        }
        cut = best;
      }
      // No natural cut point: tolerate a modest overflow rather than orphaning a word or two.
      if (cut < 0 && durIfAdded <= opts.maxSegMs * 1.5 && wordsIfAdded <= Math.ceil(opts.maxWords * 1.25)) {
        cur.push(tok);
        continue;
      }
      if (cut >= 0 && cut < cur.length - 1) {
        const head = cur.slice(0, cut + 1);
        const tail = cur.slice(cut + 1);
        segments.push(finalize(head, curSpeaker));
        cur = tail;
      } else {
        flush();
      }
      cur.push(tok);
      continue;
    }

    cur.push(tok);
  }
  flush();

  const speakers = [...new Set(segments.map((s) => s.transcription.speaker))].sort((a, b) => a - b);
  return { segments, speakers };
}

/** Attach the iconik envelope fields for POST /segments/bulk/. */
export function toBulkObjects(segs: IkSegmentDraft[], versionId: string, transcriptionId: string) {
  return segs.map((s) => ({
    segment_type: "TRANSCRIPTION",
    version_id: versionId,
    transcription_id: transcriptionId,
    segment_text: s.segment_text,
    time_start_milliseconds: s.time_start_milliseconds,
    time_end_milliseconds: s.time_end_milliseconds,
    transcription: s.transcription,
  }));
}

/**
 * Speaker names, if the payload carries any. The public STT response has only speaker_id;
 * the editor export format is confirmed in Phase 0 — extend the probes here when known.
 * Returns undefined when nothing usable is present.
 */
export function deriveSpeakerLabels(payload: unknown): Record<string, string> | undefined {
  const p = payload as any;
  const candidates: unknown[] = [p?.speakers, p?.speaker_labels, p?.transcription?.speakers, p?.data?.speakers];
  for (const c of candidates) {
    if (!c) continue;
    if (Array.isArray(c)) {
      const out: Record<string, string> = {};
      for (const s of c) {
        const id = speakerIdToInt(s?.id ?? s?.speaker_id);
        const name = s?.name ?? s?.label;
        if (id != null && typeof name === "string" && name.trim() && !/^speaker[_ ]?\d+$/i.test(name.trim())) out[String(id)] = name.trim();
      }
      if (Object.keys(out).length) return out;
    } else if (typeof c === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
        const id = speakerIdToInt(k);
        if (id != null && typeof v === "string" && v.trim() && !/^speaker[_ ]?\d+$/i.test(v.trim())) out[String(id)] = v.trim();
      }
      if (Object.keys(out).length) return out;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ElevenLabs dashboard editor JSON export (Export → JSON)
// Shape (verified 2026-09-10): { language_code, segments: [{ text, start_time, end_time,
//   speaker: { id: "speaker_0", name: "Ben " | "Speaker 1" }, words: [{ text, start_time, end_time }] }] }
// Words carry no type/logprob: spacing entries are whitespace-only text, audio events are
// "[instrumental music plays]"-style bracketed text. Segments can be 70 s+ so we re-chunk.
// ---------------------------------------------------------------------------

export interface EditorExportWord { text: string; start_time: number; end_time: number }
export interface EditorExportSegment { text: string; start_time: number; end_time: number; speaker?: { id?: string; name?: string } | null; words?: EditorExportWord[] }
export interface EditorExport { language_code?: string; segments: EditorExportSegment[] }

export function isEditorExport(j: unknown): j is EditorExport {
  const o = j as any;
  return !!o && Array.isArray(o.segments) && (o.segments.length === 0 || (typeof o.segments[0]?.start_time === "number" && "text" in o.segments[0]));
}

const DEFAULT_SPEAKER_NAME = /^speaker[ _]?\d+$/i;

/** Flatten an editor export into the API transcript shape so the same grouping rules apply. */
export function editorExportToTranscript(e: EditorExport): { transcript: ElTranscript; speakerLabels?: Record<string, string> } {
  const words: ElWord[] = [];
  const labels: Record<string, string> = {};
  const segs = [...e.segments].sort((a, b) => a.start_time - b.start_time);
  for (const s of segs) {
    const sid = s.speaker?.id ?? null;
    const name = (s.speaker?.name ?? "").trim();
    const sInt = speakerIdToInt(sid);
    if (sInt != null && name && !DEFAULT_SPEAKER_NAME.test(name)) labels[String(sInt)] = name;
    const ws = s.words && s.words.length ? s.words : [{ text: s.text, start_time: s.start_time, end_time: s.end_time }];
    let first = true;
    for (const w of ws) {
      const raw = w.text ?? "";
      const trimmed = raw.trim();
      if (!trimmed) { words.push({ text: " ", type: "spacing", start: w.start_time, end: w.end_time, speaker_id: sid }); continue; }
      const isEvent = /^[\[(].*[\])]$/.test(trimmed);
      words.push({ text: trimmed, type: isEvent ? "audio_event" : "word", start: w.start_time, end: w.end_time, speaker_id: sid, segment_break: first });
      first = false;
    }
  }
  const transcript: ElTranscript = { language_code: e.language_code ?? "", text: segs.map((s) => s.text.trim()).join(" "), words };
  return { transcript, speakerLabels: Object.keys(labels).length ? labels : undefined };
}

// ---------------------------------------------------------------------------
// SRT / VTT fallback (Branch 2: editor export without word timing)
// ---------------------------------------------------------------------------

function parseTimestamp(s: string): number {
  // 00:01:02,345 | 00:01:02.345 | 01:02.345
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) throw new Error(`bad timestamp: ${s}`);
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const ms = parseInt(m[4].padEnd(3, "0"), 10);
  return ((h * 60 + parseInt(m[2], 10)) * 60 + parseInt(m[3], 10)) * 1000 + ms;
}

export interface CueSpeakerMap { [name: string]: number }

/**
 * Convert SRT or WebVTT text to segments. Speaker is parsed from a leading "Name:" or a
 * WebVTT <v Name> tag; names are assigned ints in order of first appearance. Word timings are
 * synthesized evenly across the cue span (score 0.5) — iconik word highlighting will be approximate.
 */
export function convertSrtOrVtt(text: string): { segments: IkSegmentDraft[]; speakerNames: Record<string, string> } {
  const lines = text.replace(/\r/g, "").split("\n");
  const segments: IkSegmentDraft[] = [];
  const speakerMap: CueSpeakerMap = {};
  const nextSpeaker = () => Object.keys(speakerMap).length;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const tm = /^(\S+)\s+-->\s+(\S+)/.exec(line);
    if (!tm) { i++; continue; }
    const start = parseTimestamp(tm[1]);
    const end = parseTimestamp(tm[2]);
    i++;
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") { body.push(lines[i]); i++; }
    let raw = body.join(" ").replace(/\s+/g, " ").trim();
    let speakerName: string | undefined;
    const v = /^<v\s+([^>]+)>\s*(.*)$/.exec(raw);
    if (v) { speakerName = v[1].trim(); raw = v[2].replace(/<\/v>/g, "").trim(); }
    else {
      const c = /^([A-Z][\w .'-]{0,40}?):\s+(.*)$/.exec(raw);
      if (c) { speakerName = c[1].trim(); raw = c[2].trim(); }
    }
    raw = raw.replace(/<[^>]+>/g, "").trim();
    if (!raw) continue;
    if (speakerName && !(speakerName in speakerMap)) speakerMap[speakerName] = nextSpeaker();
    const speaker = speakerName ? speakerMap[speakerName] : 0;
    const values = raw.split(" ");
    const span = Math.max(end - start, values.length * 40);
    const step = span / values.length;
    const words: IkWord[] = values.map((w, k) => ({ value: w, start_ms: Math.round(k * step), end_ms: Math.round((k + 1) * step), score: 0.5 }));
    segments.push({ segment_text: raw, time_start_milliseconds: start, time_end_milliseconds: start + span, transcription: { speaker, words } });
  }
  const speakerNames: Record<string, string> = {};
  for (const [name, id] of Object.entries(speakerMap)) speakerNames[String(id)] = name;
  return { segments, speakerNames };
}
