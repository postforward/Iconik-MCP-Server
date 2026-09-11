/**
 * Thin ElevenLabs Speech-to-Text (Scribe) client.
 *
 * Only what the iconik pipeline needs: submit a file/URL for async transcription,
 * fetch a transcript by id, verify a webhook signature, and parse keyterms.
 * Env: ELEVENLABS_API_KEY (required for API calls), ELEVENLABS_WEBHOOK_SECRET (webhook verify),
 *      ELEVENLABS_API_BASE (optional override), ELEVENLABS_EDITOR_URL_TEMPLATE (optional, "{id}" placeholder).
 *
 * Signature scheme (mirrors @elevenlabs/elevenlabs-js WebhooksClient.constructEvent):
 *   header "elevenlabs-signature: t=<unix seconds>,v0=<hex hmac-sha256(secret, `${t}.${rawBody}`)>"
 *   with a 30-minute timestamp tolerance.
 */

import * as fs from "fs";
import * as path from "path";
import { createHmac, timingSafeEqual } from "crypto";

export interface ElWord {
  text: string;
  type: "word" | "spacing" | "audio_event";
  logprob?: number | null;
  start?: number | null; // seconds
  end?: number | null; // seconds
  speaker_id?: string | null; // "speaker_0"
  channel_index?: number | null;
  characters?: unknown;
  /** Internal: set by the editor-export flattener on the first word of each human-edited segment. */
  segment_break?: boolean;
  /** Internal: explicit 0..1 confidence (Hyperaudio round-trip sidecar); wins over logprob when set. */
  score?: number;
}

export interface ElTranscript {
  language_code: string;
  language_probability?: number;
  text: string;
  words: ElWord[];
  transcription_id?: string | null;
  audio_duration_secs?: number | null;
  additional_formats?: unknown;
  entities?: unknown;
}

export interface ElWebhookPayload {
  type: string; // "speech_to_text_transcription"
  data: {
    request_id: string;
    webhook_metadata?: Record<string, string> | string | null;
    transcription: ElTranscript;
  };
}

export class ElevenLabsError extends Error {
  constructor(public status: number, public body: string, message?: string) {
    super(message ?? `ElevenLabs HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "ElevenLabsError";
  }
}
export class SourceUrlRejected extends ElevenLabsError {
  constructor(status: number, body: string) {
    super(status, body, `ElevenLabs rejected source_url (HTTP ${status}): ${body.slice(0, 300)}`);
    this.name = "SourceUrlRejected";
  }
}

const apiBase = () => (process.env.ELEVENLABS_API_BASE ?? "https://api.elevenlabs.io").replace(/\/$/, "");
function apiKey(): string {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error("ELEVENLABS_API_KEY is not set (put it in .env)");
  return k;
}

export interface SubmitOpts {
  sourceUrl?: string;
  filePath?: string;
  fileName?: string;
  modelId?: string; // default scribe_v2
  languageCode?: string | null; // undefined/null/"auto" → auto-detect
  diarize?: boolean; // default true
  /** ElevenLabs treats this as the MAXIMUM number of speakers (docs); omit to let the model decide. */
  numSpeakers?: number;
  /** Only when numSpeakers is unset: lower → more speakers predicted, higher → fewer (model default ≈0.22). */
  diarizationThreshold?: number;
  keyterms?: string[];
  tagAudioEvents?: boolean; // default true
  webhook?: boolean; // default false → synchronous response with the transcript
  webhookId?: string;
  webhookMetadata?: Record<string, string>;
}

export interface SubmitResult {
  request_id?: string;
  transcription_id?: string;
  message?: string;
  /** Present only for synchronous (non-webhook) calls. */
  transcript?: ElTranscript;
}

/** Build the multipart body without sending it — used by dry-runs and tests. */
export async function buildSttForm(o: SubmitOpts): Promise<FormData> {
  const fd = new FormData();
  fd.append("model_id", o.modelId ?? "scribe_v2");
  if (o.sourceUrl) fd.append("source_url", o.sourceUrl);
  else if (o.filePath) {
    // fs.openAsBlob streams the file instead of buffering it in memory (Node ≥ 20).
    const blob = await fs.openAsBlob(o.filePath);
    fd.append("file", blob, o.fileName ?? path.basename(o.filePath));
  } else throw new Error("submitStt: sourceUrl or filePath is required");
  const lang = o.languageCode && o.languageCode !== "auto" ? o.languageCode : undefined;
  if (lang) fd.append("language_code", lang);
  fd.append("diarize", String(o.diarize ?? true));
  if (o.numSpeakers && o.numSpeakers > 0) fd.append("num_speakers", String(Math.min(32, Math.floor(o.numSpeakers))));
  else if (o.diarizationThreshold != null && Number.isFinite(o.diarizationThreshold)) fd.append("diarization_threshold", String(Math.min(1, Math.max(0.01, o.diarizationThreshold))));
  fd.append("timestamps_granularity", "word");
  fd.append("tag_audio_events", String(o.tagAudioEvents ?? true));
  for (const k of o.keyterms ?? []) fd.append("keyterms", k);
  if (o.webhook) {
    fd.append("webhook", "true");
    if (o.webhookId) fd.append("webhook_id", o.webhookId);
    if (o.webhookMetadata) fd.append("webhook_metadata", JSON.stringify(o.webhookMetadata));
  }
  return fd;
}

/** Render a FormData for logs (file contents elided, URL query string masked). */
export function describeForm(fd: FormData): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of fd.entries()) {
    let s: string;
    if (typeof v === "string") s = k === "source_url" ? v.replace(/\?.*$/, "?<signed>") : v;
    else s = `<file ${(v as File).name ?? ""} ${(v as Blob).size} bytes>`;
    if (k in out) out[k] = ([] as string[]).concat(out[k], s);
    else out[k] = s;
  }
  return out;
}

export async function submitStt(o: SubmitOpts): Promise<SubmitResult> {
  const fd = await buildSttForm(o);
  const res = await fetch(`${apiBase()}/v1/speech-to-text`, { method: "POST", headers: { "xi-api-key": apiKey() }, body: fd });
  const text = await res.text();
  if (!res.ok) {
    if (o.sourceUrl && (res.status === 422 || res.status === 400) && /url/i.test(text)) throw new SourceUrlRejected(res.status, text);
    throw new ElevenLabsError(res.status, text);
  }
  const j = JSON.parse(text);
  if (o.webhook) return { request_id: j.request_id, transcription_id: j.transcription_id, message: j.message };
  return { transcription_id: j.transcription_id ?? undefined, transcript: j as ElTranscript };
}

export async function getTranscript(transcriptionId: string): Promise<ElTranscript> {
  const res = await fetch(`${apiBase()}/v1/speech-to-text/transcripts/${encodeURIComponent(transcriptionId)}`, {
    headers: { "xi-api-key": apiKey() },
  });
  const text = await res.text();
  if (!res.ok) throw new ElevenLabsError(res.status, text);
  return JSON.parse(text) as ElTranscript;
}

export interface VerifyOpts {
  /** Seconds of clock skew allowed. Default 1800 (matches the SDK). */
  toleranceSec?: number;
  /** Override "now" for tests. */
  nowMs?: number;
}

/** Compute the v0 signature for a timestamp + raw body (exported for tests and for signing fixtures). */
export function signWebhook(rawBody: string | Buffer, secret: string, timestampSec: number): string {
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const hex = createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
  return `t=${timestampSec},v0=${hex}`;
}

/**
 * Verify an ElevenLabs webhook and return the parsed payload. Throws on any mismatch.
 * rawBody MUST be the exact bytes received (not re-serialised JSON).
 */
export function verifyWebhook(rawBody: string | Buffer, sigHeader: string | undefined, secret: string | undefined, opts: VerifyOpts = {}): ElWebhookPayload {
  if (!sigHeader) throw new Error("webhook: missing elevenlabs-signature header");
  if (!secret) throw new Error("webhook: ELEVENLABS_WEBHOOK_SECRET not configured");
  const parts = sigHeader.split(",").map((s) => s.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const v0 = parts.find((p) => p.startsWith("v0="))?.slice(3);
  if (!t || !v0) throw new Error("webhook: signature header lacks t= / v0=");
  const tolerance = (opts.toleranceSec ?? 1800) * 1000;
  const now = opts.nowMs ?? Date.now();
  if (Number(t) * 1000 < now - tolerance) throw new Error("webhook: timestamp outside tolerance");
  const expected = signWebhook(rawBody, secret, Number(t)).split("v0=")[1];
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v0, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("webhook: signature mismatch");
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  return JSON.parse(body) as ElWebhookPayload;
}

/** webhook_metadata arrives as an object or a JSON string depending on how it was submitted. */
export function parseWebhookMetadata(m: ElWebhookPayload["data"]["webhook_metadata"]): Record<string, string> {
  if (!m) return {};
  if (typeof m === "string") {
    try { const j = JSON.parse(m); return j && typeof j === "object" ? j : {}; } catch { return {}; }
  }
  return m;
}

/** Dashboard editor link for a transcript. Template is confirmed in Phase 0; override via env. */
export function editorUrl(transcriptionId: string): string {
  const tpl = process.env.ELEVENLABS_EDITOR_URL_TEMPLATE ?? "https://elevenlabs.io/app/speech-to-text/{id}";
  return tpl.replace("{id}", encodeURIComponent(transcriptionId));
}

/** Split free text into ElevenLabs keyterms: comma / semicolon / newline separated, trimmed, deduped, ≤50 chars, ≤1000. */
export function parseKeyterms(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(/[,;\n]+/)) {
    const k = piece.trim().replace(/\s+/g, " ");
    if (!k || k.length > 50) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= 1000) break;
  }
  return out;
}
