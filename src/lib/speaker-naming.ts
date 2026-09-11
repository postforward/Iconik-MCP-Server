/**
 * Best-guess speaker NAMES for an iconik transcript, inferred by Claude from context
 * (self-introductions, being addressed, narrator hand-offs, keyterms/notes). Writes only the
 * transcription properties' speaker_labels map (see reference: PATCH .../transcriptions/{id}/properties/),
 * never the segments — so it is cheap, reversible, and works for any engine's draft.
 */
import { iconikRequest } from "../client.js";
import type { IkTranscriptionSegment } from "./iconik-transcripts.js";

export interface NameHints { title?: string | null; keyterms?: string[]; notes?: string | null; knownLabels?: Record<string, string> | null }
export interface SpeakerProposal { speaker: number; name: string | null; confidence: number; evidence: string; paragraphs: number; words: number }
export interface NamingResult { proposals: SpeakerProposal[]; model: string; usage?: { input_tokens: number; output_tokens: number } }

const DEFAULT_MODEL = process.env.SPEAKER_NAMING_MODEL ?? "claude-opus-5";
const DEFAULT_SPEAKER = /^speaker[ _]?\d+$/i;

/** Transcript rendered as "[t] S<n>: text" lines, capped so the request stays small. */
export function renderTranscript(segments: IkTranscriptionSegment[], maxChars = 120_000): { text: string; perSpeaker: Record<number, { paragraphs: number; words: number }> } {
  const sorted = [...segments].sort((a, b) => a.time_start_milliseconds - b.time_start_milliseconds);
  const perSpeaker: Record<number, { paragraphs: number; words: number }> = {};
  const lines: string[] = [];
  for (const s of sorted) {
    const spk = s.transcription?.speaker ?? 0;
    const ps = (perSpeaker[spk] ??= { paragraphs: 0, words: 0 });
    ps.paragraphs++; ps.words += (s.transcription?.words?.length ?? s.segment_text.split(/\s+/).length);
    const t = Math.floor(s.time_start_milliseconds / 1000);
    lines.push(`[${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}] S${spk}: ${s.segment_text.trim()}`);
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n… (transcript truncated)";
  return { text, perSpeaker };
}

export function buildPrompt(hints: NameHints, speakerIds: number[]): { system: string; user: string } {
  const known = Object.entries(hints.knownLabels ?? {}).filter(([, v]) => v && !DEFAULT_SPEAKER.test(v));
  const system = `You identify who each numbered speaker is in a TV/video transcript. Speakers are labelled S0, S1, … (diarization output; the numbers carry no meaning).
Use only evidence in the transcript and the hints: self-introductions ("I'm Ben Higgins"), being addressed by name, a narrator or host naming who speaks next, on-screen role cues (bride, groom, host, resort staff). Prefer the spelling given in the hints.
Rules: name only (no role suffix like "(host)"); a first name alone is fine when that is all the transcript supports; if a speaker cannot be named with reasonable confidence return null with confidence below 0.5 rather than guessing; a diarization bucket that clearly mixes several people gets null and evidence "mixed"; never assign the same person to two speaker numbers unless the transcript really shows the same person under two numbers (then say so in the evidence). Return one entry per speaker number listed.`;
  const hintLines = [
    hints.title ? `Asset title: ${hints.title}` : null,
    hints.keyterms && hints.keyterms.length ? `Names/terms supplied by the producer (correct spellings): ${hints.keyterms.join(", ")}` : null,
    hints.notes ? `Producer notes: ${hints.notes}` : null,
    known.length ? `Already known: ${known.map(([k, v]) => `S${k} = ${v}`).join(", ")} (keep these unless the transcript contradicts them)` : null,
  ].filter(Boolean).join("\n");
  return { system, user: `${hintLines ? hintLines + "\n\n" : ""}Speaker numbers to name: ${speakerIds.map((n) => "S" + n).join(", ")}.\n\nTranscript:\n` };
}

/** Ask Claude. Pure I/O wrapper around the prompt above; segments are rendered once. */
export async function proposeSpeakerNames(segments: IkTranscriptionSegment[], hints: NameHints, opts: { model?: string } = {}): Promise<NamingResult> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const { z } = await import("zod");
  const Schema = z.object({ speakers: z.array(z.object({ speaker: z.number(), name: z.string().nullable(), confidence: z.number(), evidence: z.string() })) });
  const { text, perSpeaker } = renderTranscript(segments);
  const ids = Object.keys(perSpeaker).map(Number).sort((a, b) => a - b);
  if (!ids.length) return { proposals: [], model: opts.model ?? DEFAULT_MODEL };
  const { system, user } = buildPrompt(hints, ids);
  const client = new Anthropic();
  const model = opts.model ?? DEFAULT_MODEL;
  // max_tokens covers the model's thinking too; 4000 truncated the JSON on an 870-segment transcript
  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user + text }],
    output_config: { format: zodOutputFormat(Schema) },
  });
  if (response.stop_reason === "max_tokens") throw new Error("the model ran out of output tokens (raise max_tokens)");
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error(`no usable output (stop_reason=${response.stop_reason})`);
  const byId = new Map(response.parsed_output.speakers.map((s) => [s.speaker, s]));
  const proposals: SpeakerProposal[] = ids.map((id) => {
    const p = byId.get(id);
    const name = p?.name?.trim().replace(/\s+/g, " ") || null;
    return { speaker: id, name: name && !DEFAULT_SPEAKER.test(name) ? name : null, confidence: p ? Math.max(0, Math.min(1, p.confidence)) : 0, evidence: p?.evidence ?? "no answer", paragraphs: perSpeaker[id].paragraphs, words: perSpeaker[id].words };
  });
  return { proposals, model, usage: response.usage ? { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens } : undefined };
}

/** Merge accepted proposals into the existing labels. Existing names win unless overwrite; below-threshold proposals are ignored;
 *  a name already used by another speaker is not duplicated. */
export function mergeLabels(existing: Record<string, string> | null | undefined, proposals: SpeakerProposal[], minConfidence: number, overwrite = false): { labels: Record<string, string>; applied: SpeakerProposal[]; skipped: SpeakerProposal[] } {
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing ?? {})) if (v && v.trim() && !DEFAULT_SPEAKER.test(v)) labels[k] = v.trim();
  const applied: SpeakerProposal[] = [], skipped: SpeakerProposal[] = [];
  // "Ben" and "Ben Higgins" are the same person for our purposes: a bare first name matches a full name's first token
  const samePerson = (a: string, b: string) => { const x = a.toLowerCase().split(/\s+/), y = b.toLowerCase().split(/\s+/); return a.toLowerCase() === b.toLowerCase() || ((x.length === 1 || y.length === 1) && x[0] === y[0]); };
  const takenBy = (name: string, exceptKey: string) => Object.entries(labels).some(([k, v]) => k !== exceptKey && samePerson(v, name));
  for (const p of [...proposals].sort((a, b) => b.confidence - a.confidence)) {
    const key = String(p.speaker);
    if (!p.name || p.confidence < minConfidence) { skipped.push(p); continue; }
    if (labels[key] && !overwrite) { skipped.push(p); continue; }
    if (takenBy(p.name, key)) { skipped.push(p); continue; }
    labels[key] = p.name; applied.push(p);
  }
  return { labels, applied, skipped };
}

export async function writeSpeakerLabels(assetId: string, versionId: string, transcriptionId: string, labels: Record<string, string>): Promise<void> {
  await iconikRequest(`assets/v1/assets/${assetId}/versions/${versionId}/transcriptions/${transcriptionId}/properties/`, { method: "PATCH", body: JSON.stringify({ speaker_labels: labels }) });
}
