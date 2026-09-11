#!/usr/bin/env npx tsx
/**
 * Fetch an ElevenLabs transcript by id (Phase 0 probe + ad-hoc inspection).
 *
 *   npx tsx scripts/elevenlabs-get.ts --transcription-id=<id> [--out=file.json] [--preview]
 *
 * Requires ELEVENLABS_API_KEY in .env. --preview prints the converted iconik segments
 * (first/last 5) so you can eyeball grouping without touching iconik.
 */
import "dotenv/config";
import * as fs from "fs";
import { getTranscript } from "../src/lib/elevenlabs.ts";
import { convertElevenLabsToSegments, deriveSpeakerLabels } from "../src/lib/elevenlabs-to-iconik.ts";

const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const id = arg("transcription-id");
const out = arg("out");
if (!id) { console.error("Usage: --transcription-id=<id> [--out=file] [--preview]"); process.exit(1); }

const t = await getTranscript(id);
const words = t.words?.length ?? 0;
const speakers = [...new Set(t.words?.map((w) => w.speaker_id).filter(Boolean))];
console.log(`transcription ${id}: language=${t.language_code} (${t.language_probability ?? "?"}) words=${words} speakers=${speakers.length} duration=${t.audio_duration_secs ?? "?"}s`);
console.log(`top-level keys: ${Object.keys(t).join(", ")}`);
const labels = deriveSpeakerLabels(t);
if (labels) console.log(`speaker names present: ${JSON.stringify(labels)}`);
if (out) { fs.writeFileSync(out, JSON.stringify(t, null, 2)); console.log(`saved to ${out}`); }
if (args.includes("--preview")) {
  const { segments } = convertElevenLabsToSegments(t);
  console.log(`\n${segments.length} iconik segments would be created:`);
  const show = (s: (typeof segments)[number], i: number) => console.log(`[${i}] spk${s.transcription.speaker} ${s.time_start_milliseconds}-${s.time_end_milliseconds}ms (${s.transcription.words.length}w): ${s.segment_text}`);
  segments.slice(0, 5).forEach(show);
  if (segments.length > 10) console.log("   ...");
  segments.slice(-5).forEach((s, k) => show(s, segments.length - 5 + k));
}
