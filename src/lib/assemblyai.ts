/**
 * AssemblyAI (Universal) speech-to-text client + converter into the engine-agnostic transcript
 * shape used by convertElevenLabsToSegments — so iconik import, the Hyperaudio editor and the
 * tracking all work unchanged whichever engine produced the draft.
 *
 * API facts (docs read 2026-09-11):
 *  - POST https://api.assemblyai.com/v2/transcript { audio_url, speech_models:["universal-3-5-pro"],
 *    speaker_labels:true, speakers_expected?, disfluencies:true, keyterms_prompt?[],
 *    language_code? | language_detection:true, speech_understanding:{request:{speaker_identification:
 *    {speaker_type:"name", speakers?:[{name}], effort?:"low"|"medium"}}}, webhook_url,
 *    webhook_auth_header_name, webhook_auth_header_value } → { id, status:"queued" }
 *  - GET /v2/transcript/{id} → { status:"queued"|"processing"|"completed"|"error", words:[{text,start,end
 *    (ms),confidence,speaker}], utterances:[{speaker,start,end,text,words}], language_code, audio_duration (s),
 *    speech_understanding:{response:{speaker_identification:{mapping:{A:"Name"}}}} }
 *  - Webhook POST body is only { transcript_id, status:"completed"|"error" } plus our auth header;
 *    retried up to 10× unless we answer 2xx within 10 s. No custom metadata → the submit step keeps a
 *    pending file (inbox/assemblyai-pending-<id>.json) mapping transcript_id → asset.
 */
import type { ElTranscript, ElWord } from "./elevenlabs.js";

export const AAI_BASE = process.env.ASSEMBLYAI_BASE_URL ?? "https://api.assemblyai.com";
export const AAI_WEBHOOK_HEADER = "x-aai-secret";

export interface AaiWord { text: string; start: number; end: number; confidence?: number | null; speaker?: string | null }
export interface AaiUtterance { speaker?: string | null; start: number; end: number; text: string; confidence?: number; words?: AaiWord[] }
export interface AaiTranscript {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  error?: string | null;
  audio_url?: string;
  audio_duration?: number | null;
  language_code?: string | null;
  text?: string | null;
  words?: AaiWord[] | null;
  utterances?: AaiUtterance[] | null;
  speech_understanding?: { response?: { speaker_identification?: { mapping?: Record<string, string> } } } | null;
  webhook_status_code?: number | null;
  [k: string]: unknown;
}

export interface AaiSubmitOpts {
  audioUrl: string;
  keyterms?: string[];
  /** "auto" (default) → language_detection; else ISO code such as "en" / "es". */
  language?: string;
  speakersExpected?: number;
  /** Known speaker names to bias identification (optional). */
  speakerNames?: string[];
  /** Default true — AssemblyAI infers real names from the audio. */
  identifySpeakers?: boolean;
  disfluencies?: boolean; // default true (verbatim drafts, like Scribe)
  webhookUrl?: string;
  webhookSecret?: string;
  model?: "universal-3-5-pro" | "universal-2";
}

export function buildSubmitBody(o: AaiSubmitOpts): Record<string, unknown> {
  const body: Record<string, unknown> = {
    audio_url: o.audioUrl,
    speech_models: [o.model ?? "universal-3-5-pro"],
    speaker_labels: true,
    disfluencies: o.disfluencies !== false,
    punctuate: true,
    format_text: true,
  };
  if (o.speakersExpected && o.speakersExpected > 1) body.speakers_expected = o.speakersExpected;
  if (o.keyterms && o.keyterms.length) body.keyterms_prompt = o.keyterms.slice(0, 1000);
  if (!o.language || o.language === "auto") body.language_detection = true; else body.language_code = o.language;
  if (o.identifySpeakers !== false) {
    const si: Record<string, unknown> = { speaker_type: "name" };
    if (o.speakerNames && o.speakerNames.length) si.speakers = o.speakerNames.map((name) => ({ name }));
    body.speech_understanding = { request: { speaker_identification: si } };
  }
  if (o.webhookUrl) {
    body.webhook_url = o.webhookUrl;
    if (o.webhookSecret) { body.webhook_auth_header_name = AAI_WEBHOOK_HEADER; body.webhook_auth_header_value = o.webhookSecret; }
  }
  return body;
}

function apiKey(): string {
  const k = process.env.ASSEMBLYAI_API_KEY;
  if (!k) throw new Error("ASSEMBLYAI_API_KEY is not set in .env");
  return k;
}

async function aai<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${AAI_BASE}${path}`, { ...init, headers: { authorization: apiKey(), "content-type": "application/json", ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`AssemblyAI ${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export async function submitTranscript(o: AaiSubmitOpts): Promise<{ id: string; status: string }> {
  return aai<{ id: string; status: string }>("/v2/transcript", { method: "POST", body: JSON.stringify(buildSubmitBody(o)) });
}

export async function getTranscript(id: string): Promise<AaiTranscript> {
  return aai<AaiTranscript>(`/v2/transcript/${encodeURIComponent(id)}`);
}

/** Poll until completed/error (local testing without a webhook). */
export async function waitForTranscript(id: string, { intervalMs = 5000, maxMs = 30 * 60_000 } = {}): Promise<AaiTranscript> {
  const t0 = Date.now();
  for (;;) {
    const t = await getTranscript(id);
    if (t.status === "completed" || t.status === "error") return t;
    if (Date.now() - t0 > maxMs) throw new Error(`AssemblyAI transcript ${id} still ${t.status} after ${Math.round(maxMs / 60000)} min`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Constant-time check of the webhook auth header we asked AssemblyAI to send. */
export function verifyWebhookHeader(headerValue: string | undefined, secret: string | undefined): boolean {
  if (!headerValue || !secret || headerValue.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= headerValue.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export function isAssemblyAiTranscript(j: unknown): j is AaiTranscript {
  const o = j as any;
  return !!o && typeof o.id === "string" && typeof o.status === "string" && Array.isArray(o.words) && ("audio_duration" in o || "audio_url" in o || Array.isArray(o.utterances));
}

const LETTER_LABEL = /^[A-Z]{1,2}$/;
const DEFAULT_NAME = /^speaker[ _]?[A-Z0-9]+$/i;

/**
 * AssemblyAI transcript → engine-agnostic transcript (seconds, speaker_id "speaker_N", score) +
 * speaker names. Speakers get ints in order of first appearance. A speaker string that is a real
 * name (from speaker identification, either inline or via the mapping) becomes the label for that int.
 * Utterance boundaries become hard segment breaks so AssemblyAI's turn detection is honoured.
 */
export function assemblyaiToTranscript(t: AaiTranscript): { transcript: ElTranscript; speakerLabels?: Record<string, string>; speakerMap: Record<string, number> } {
  if (t.status === "error") throw new Error(`AssemblyAI transcript ${t.id} failed: ${t.error ?? "unknown error"}`);
  const mapping = t.speech_understanding?.response?.speaker_identification?.mapping ?? {};
  const words: AaiWord[] = (t.words && t.words.length ? t.words : (t.utterances ?? []).flatMap((u) => (u.words ?? []).map((w) => ({ ...w, speaker: w.speaker ?? u.speaker })))) ?? [];
  const breaks = new Set<number>();
  for (const u of t.utterances ?? []) breaks.add(u.start);
  const speakerMap: Record<string, number> = {};
  const labels: Record<string, string> = {};
  const intFor = (raw: string | null | undefined): number => {
    const key = (raw ?? "").trim() || "?";
    if (speakerMap[key] == null) {
      speakerMap[key] = Object.keys(speakerMap).length;
      const name = mapping[key] ?? (LETTER_LABEL.test(key) || DEFAULT_NAME.test(key) || key === "?" ? null : key);
      if (name && !DEFAULT_NAME.test(name)) labels[String(speakerMap[key])] = name.trim();
    }
    return speakerMap[key];
  };
  const out: ElWord[] = [];
  let lastSpeaker: number | null = null;
  for (const w of words) {
    const text = (w.text ?? "").trim();
    if (!text) continue;
    const spk = intFor(w.speaker);
    const brk = breaks.has(w.start) || (lastSpeaker !== null && spk !== lastSpeaker);
    lastSpeaker = spk;
    out.push({ text, type: "word", start: w.start / 1000, end: Math.max(w.end, w.start) / 1000, speaker_id: `speaker_${spk}`, score: typeof w.confidence === "number" ? w.confidence : undefined, segment_break: brk });
  }
  if (out.length) out[0].segment_break = true;
  const lang = (t.language_code ?? "").toLowerCase().split(/[-_]/)[0];
  const transcript: ElTranscript = { language_code: lang, text: t.text ?? out.map((w) => w.text).join(" "), words: out, transcription_id: t.id, audio_duration_secs: t.audio_duration ?? null };
  return { transcript, speakerLabels: Object.keys(labels).length ? labels : undefined, speakerMap };
}
