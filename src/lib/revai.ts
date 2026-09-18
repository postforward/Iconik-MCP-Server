/**
 * Rev.ai asynchronous speech-to-text client (human or machine transcriber) + converter into the
 * engine-agnostic transcript shape, so the importer / editor / naming pass work unchanged.
 *
 * API (docs read 2026-09-17): POST https://api.rev.ai/speechtotext/v1/jobs
 *   { source_config:{url}, transcriber:"human"|"machine", verbatim?, rush?, test_mode?, speaker_names?:[{display_name}],
 *     custom_vocabularies?:[{phrases:[]}], language?, metadata?, notification_config?:{url, auth_headers:{Authorization:"Bearer …"}} }
 *   → { id, status:"in_progress"|"transcribed"|"failed", type:"human_tc"|…, created_on, completed_on?, failure_detail?, duration_seconds? }
 * GET /jobs/{id}; GET /jobs/{id}/transcript with Accept: application/vnd.rev.transcript.v1.0+json →
 *   { monologues:[{ speaker:int, elements:[{ type:"text"|"punct"|"unknown", value, ts?, end_ts?, confidence? }] }] }
 * The completion callback POSTs { job:{ id, status, … } } to notification_config.url with our Authorization header.
 * test_mode jobs are free and skip the transcriber (mock transcript) — used for integration tests.
 */
import type { ElTranscript, ElWord } from "./elevenlabs.js";

export const REVAI_BASE = process.env.REVAI_BASE_URL ?? "https://api.rev.ai/speechtotext/v1";

export interface RevSubmitOpts {
  mediaUrl: string;
  transcriber?: "human" | "machine";
  verbatim?: boolean;
  rush?: boolean;
  testMode?: boolean;
  speakerNames?: string[];
  vocabulary?: string[];
  /** Hint for how many speakers to expect (Rev.ai `speakers_count`). */
  speakersCount?: number;
  language?: string;       // ISO 639-1; omit for auto (machine) / English default
  metadata?: string;       // ≤ 500 chars, echoed back
  callbackUrl?: string;
  callbackSecret?: string; // sent back as Authorization: Bearer <secret>
}
export interface RevJob { id: string; status: "in_progress" | "transcribed" | "failed"; type?: string; created_on?: string; completed_on?: string | null; failure_detail?: string | null; duration_seconds?: number | null; metadata?: string | null; [k: string]: unknown }
export interface RevElement { type: "text" | "punct" | "unknown"; value: string; ts?: number; end_ts?: number; confidence?: number }
export interface RevMonologue { speaker: number; elements: RevElement[] }
export interface RevTranscript { monologues: RevMonologue[]; [k: string]: unknown }

export function buildJobBody(o: RevSubmitOpts): Record<string, unknown> {
  const body: Record<string, unknown> = { source_config: { url: o.mediaUrl }, transcriber: o.transcriber ?? "human" };
  if (o.verbatim != null) body.verbatim = o.verbatim;
  if (o.rush) body.rush = true;
  if (o.testMode) body.test_mode = true;
  if (o.language) body.language = o.language;
  if (o.metadata) body.metadata = o.metadata.slice(0, 500);
  if (o.speakerNames && o.speakerNames.length) body.speaker_names = o.speakerNames.slice(0, 100).map((n) => ({ display_name: n.slice(0, 50) }));
  if (o.vocabulary && o.vocabulary.length) body.custom_vocabularies = [{ phrases: [...new Set(o.vocabulary.map((v) => v.trim()).filter(Boolean))].slice(0, 6000) }];
  // speakers_count is a machine-transcriber hint only ("not allowed for human transcription jobs")
  if (o.speakersCount && o.speakersCount > 0 && (o.transcriber ?? "human") === "machine") body.speakers_count = Math.floor(o.speakersCount);
  if (o.callbackUrl) body.notification_config = o.callbackSecret ? { url: o.callbackUrl, auth_headers: { Authorization: `Bearer ${o.callbackSecret}` } } : { url: o.callbackUrl };
  return body;
}

function token(): string {
  const t = process.env.REVAI_ACCESS_TOKEN;
  if (!t) throw new Error("REVAI_ACCESS_TOKEN is not set in .env");
  return t;
}
async function rev<T>(path: string, init: RequestInit = {}, accept = "application/json"): Promise<T> {
  const res = await fetch(`${REVAI_BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", Accept: accept, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Rev.ai ${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}
export const submitJob = (o: RevSubmitOpts) => rev<RevJob>("/jobs", { method: "POST", body: JSON.stringify(buildJobBody(o)) });
export const getJob = (id: string) => rev<RevJob>(`/jobs/${encodeURIComponent(id)}`);
export const getTranscript = (id: string) => rev<RevTranscript>(`/jobs/${encodeURIComponent(id)}/transcript`, {}, "application/vnd.rev.transcript.v1.0+json");
export const getAccount = () => rev<{ email: string; free_balance?: number; purchased_balance?: number; balance_seconds?: number }>("/account");

export async function waitForJob(id: string, { intervalMs = 15_000, maxMs = 36 * 3600_000 } = {}): Promise<RevJob> {
  const t0 = Date.now();
  for (;;) {
    const j = await getJob(id);
    if (j.status !== "in_progress") return j;
    if (Date.now() - t0 > maxMs) throw new Error(`Rev.ai job ${id} still in progress after ${Math.round(maxMs / 3600_000)} h`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Constant-time check of the callback's Authorization header against our secret. */
export function verifyCallbackAuth(headerValue: string | undefined, secret: string | undefined): boolean {
  if (!headerValue || !secret) return false;
  const expected = `Bearer ${secret}`;
  if (headerValue.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= headerValue.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function isRevTranscript(j: unknown): j is RevTranscript {
  const o = j as any;
  return !!o && Array.isArray(o.monologues) && (o.monologues.length === 0 || Array.isArray(o.monologues[0]?.elements));
}

/**
 * Rev.ai transcript → engine-agnostic transcript. Monologues are speaker turns (hard segment breaks);
 * "punct" elements are glued onto the preceding word ("together" + "." → "together."); "unknown" =
 * inaudible → "<inaudible>" audio event; confidence → score (human transcripts usually carry none → 1.0).
 * Rev.ai speaker ints are 0-based already; names are not in the transcript (speaker_names only guides the
 * transcriber), so speaker labels come from the LLM naming pass or the editor.
 */
export function revToTranscript(t: RevTranscript): { transcript: ElTranscript; speakers: number[] } {
  const words: ElWord[] = [];
  const speakers = new Set<number>();
  let lastEnd = 0;
  for (const m of t.monologues ?? []) {
    const spk = Number.isInteger(m.speaker) ? m.speaker : 0;
    speakers.add(spk);
    let first = true;
    for (const el of m.elements ?? []) {
      if (el.type === "punct") {
        const v = (el.value ?? "");
        if (!v.trim()) continue;                       // spaces
        if (words.length) words[words.length - 1].text += v.trim(); // "." "," "?" → append to previous word
        continue;
      }
      const raw = (el.value ?? "").trim();
      if (!raw) continue;
      const start = typeof el.ts === "number" ? el.ts : lastEnd;
      const end = typeof el.end_ts === "number" ? Math.max(el.end_ts, start) : start;
      lastEnd = end;
      const isUnknown = el.type === "unknown";
      words.push({ text: isUnknown ? "<inaudible>" : raw, type: isUnknown ? "audio_event" : "word", start, end, speaker_id: `speaker_${spk}`, score: typeof el.confidence === "number" ? el.confidence : 1, segment_break: first });
      first = false;
    }
  }
  const transcript: ElTranscript = { language_code: "", text: words.filter((w) => w.type === "word").map((w) => w.text).join(" "), words };
  return { transcript, speakers: [...speakers].sort((a, b) => a - b) };
}
