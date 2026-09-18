import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { revToTranscript, buildJobBody, isRevTranscript, verifyCallbackAuth, type RevTranscript } from "../src/lib/revai.ts";
import { convertElevenLabsToSegments } from "../src/lib/elevenlabs-to-iconik.ts";
import { isAssemblyAiTranscript } from "../src/lib/assemblyai.ts";
import { isHyperaudioProject } from "../src/lib/hyperaudio.ts";

const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "revai-transcript.sample.json"), "utf8")) as RevTranscript;

test("rev.ai → transcript → iconik segments: punctuation glued, turns = breaks, unknown = <inaudible>", () => {
  const r = revToTranscript(fx);
  assert.deepEqual(r.speakers, [0, 1]);
  assert.equal(r.transcript.words[0].start, 7.53);
  assert.equal(r.transcript.words[0].segment_break, true);
  const { segments } = convertElevenLabsToSegments(r.transcript);
  assert.deepEqual(segments.map((s) => s.segment_text), ["A destination wedding promises the trip.", "We have <inaudible> opportunity, right?", "Okay."]);
  assert.deepEqual(segments.map((s) => s.transcription.speaker), [0, 1, 0]);
  assert.equal(segments[0].time_start_milliseconds, 7530);
  assert.equal(segments[0].transcription.words[0].score, 1);
});

test("rev.ai: job body, sniffing, callback auth", () => {
  const b = buildJobBody({ mediaUrl: "https://m/x.mp3", transcriber: "human", testMode: true, speakerNames: ["Ben Higgins", "McKenzie"], vocabulary: ["Paradisus"], language: "en", callbackUrl: "https://h/w", callbackSecret: "s3cret", metadata: "asset=1" }) as any;
  assert.equal(b.transcriber, "human"); assert.equal(b.test_mode, true); assert.equal(b.rush, undefined);
  assert.deepEqual(b.speaker_names, [{ display_name: "Ben Higgins" }, { display_name: "McKenzie" }]);
  assert.deepEqual(b.custom_vocabularies, [{ phrases: ["Paradisus"] }]);
  assert.deepEqual(b.notification_config, { url: "https://h/w", auth_headers: { Authorization: "Bearer s3cret" } });
  assert.equal(isRevTranscript(fx), true);
  assert.equal(isAssemblyAiTranscript(fx), false);
  assert.equal(isHyperaudioProject(fx), false);
  assert.equal(verifyCallbackAuth("Bearer s3cret", "s3cret"), true);
  assert.equal(verifyCallbackAuth("Bearer nope!", "s3cret"), false);
  assert.equal(verifyCallbackAuth(undefined, "s3cret"), false);
});
