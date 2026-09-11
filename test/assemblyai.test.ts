import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { assemblyaiToTranscript, buildSubmitBody, isAssemblyAiTranscript, verifyWebhookHeader, type AaiTranscript } from "../src/lib/assemblyai.ts";
import { convertElevenLabsToSegments, isEditorExport } from "../src/lib/elevenlabs-to-iconik.ts";
import { isHyperaudioProject } from "../src/lib/hyperaudio.ts";

const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "assemblyai-transcript.sample.json"), "utf8")) as AaiTranscript;
const webhook = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "elevenlabs-webhook.sample.json"), "utf8"));

test("assemblyai → transcript → iconik segments: names, ints, breaks, scores, disfluencies kept", () => {
  const r = assemblyaiToTranscript(fx);
  assert.deepEqual(r.speakerMap, { A: 0, B: 1 });
  assert.deepEqual(r.speakerLabels, { "0": "Sabina Ortiz" });
  assert.equal(r.transcript.language_code, "en");
  assert.equal(r.transcript.words[0].start, 7.53);
  assert.equal(r.transcript.words[0].segment_break, true);
  assert.ok(r.transcript.words.some((w) => w.text === "um,"), "disfluency kept verbatim");
  const { segments } = convertElevenLabsToSegments(r.transcript);
  assert.deepEqual(segments.map((s) => s.transcription.speaker), [0, 1, 0]);
  assert.equal(segments[0].segment_text, "A destination wedding promises the trip of a lifetime.");
  assert.equal(segments[0].time_start_milliseconds, 7530);
  assert.equal(segments[0].transcription.words[3].score, 0.61);
  assert.equal(segments[1].segment_text, "We have a great um, opportunity for them.");
});

test("assemblyai: inline names win, letters stay unnamed, utterances-only payload works, error throws", () => {
  const t: AaiTranscript = { id: "x", status: "completed", words: null, audio_duration: 3,
    utterances: [{ speaker: "Eric Lee", start: 0, end: 1000, text: "Hi there", words: [{ text: "Hi", start: 0, end: 400, speaker: "Eric Lee" }, { text: "there", start: 500, end: 1000, speaker: "Eric Lee" }] },
      { speaker: "C", start: 2000, end: 2500, text: "Yes", words: [{ text: "Yes", start: 2000, end: 2500, speaker: "C" }] }] };
  const r = assemblyaiToTranscript(t);
  assert.deepEqual(r.speakerMap, { "Eric Lee": 0, C: 1 });
  assert.deepEqual(r.speakerLabels, { "0": "Eric Lee" });
  assert.equal(r.transcript.words.length, 3);
  assert.throws(() => assemblyaiToTranscript({ id: "e", status: "error", error: "boom" }), /boom/);
});

test("assemblyai: submit body + sniffing + webhook header", () => {
  const b = buildSubmitBody({ audioUrl: "https://m/x.mp3", keyterms: ["McKenzie", "Paradisus"], language: "auto", speakersExpected: 6, speakerNames: ["Ben Higgins"], webhookUrl: "https://h/w", webhookSecret: "s3cret" }) as any;
  assert.equal(b.speaker_labels, true);
  assert.equal(b.disfluencies, true);
  assert.equal(b.language_detection, true);
  assert.equal(b.speakers_expected, 6);
  assert.deepEqual(b.keyterms_prompt, ["McKenzie", "Paradisus"]);
  assert.deepEqual(b.speech_understanding.request.speaker_identification, { speaker_type: "name", speakers: [{ name: "Ben Higgins" }] });
  assert.equal(b.webhook_auth_header_name, "x-aai-secret");
  assert.equal(b.webhook_auth_header_value, "s3cret");
  const es = buildSubmitBody({ audioUrl: "u", language: "es", identifySpeakers: false }) as any;
  assert.equal(es.language_code, "es"); assert.equal(es.language_detection, undefined); assert.equal(es.speech_understanding, undefined);
  assert.equal(isAssemblyAiTranscript(fx), true);
  assert.equal(isAssemblyAiTranscript(webhook.data.transcription), false);
  assert.equal(isEditorExport(fx), false);
  assert.equal(isHyperaudioProject(fx), false);
  assert.equal(verifyWebhookHeader("abc", "abc"), true);
  assert.equal(verifyWebhookHeader("abd", "abc"), false);
  assert.equal(verifyWebhookHeader(undefined, "abc"), false);
});
