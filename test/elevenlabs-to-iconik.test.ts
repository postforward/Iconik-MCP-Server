import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { convertElevenLabsToSegments, toBulkObjects, convertSrtOrVtt, speakerIdToInt, logprobToScore, audioEventToken, deriveSpeakerLabels, isEditorExport, editorExportToTranscript } from "../src/lib/elevenlabs-to-iconik.ts";
import { parseKeyterms, verifyWebhook, signWebhook, parseWebhookMetadata, buildSttForm, describeForm } from "../src/lib/elevenlabs.ts";
import type { ElWebhookPayload } from "../src/lib/elevenlabs.ts";

const fixturePath = path.join(import.meta.dirname, "fixtures", "elevenlabs-webhook.sample.json");
const raw = fs.readFileSync(fixturePath, "utf8");
const payload = JSON.parse(raw) as ElWebhookPayload;

test("helpers", () => {
  assert.equal(speakerIdToInt("speaker_3"), 3);
  assert.equal(speakerIdToInt("7"), 7);
  assert.equal(speakerIdToInt(null), null);
  assert.equal(logprobToScore(0), 1);
  assert.equal(logprobToScore(-0.69), 0.5);
  assert.equal(logprobToScore(undefined), 0.99);
  assert.equal(audioEventToken("(laughter)"), "<laugh>");
  assert.equal(audioEventToken("(applause)"), "<applause>");
  assert.equal(audioEventToken("door slam"), "<door_slam>");
});

test("convert: grouping rules on the fixture", () => {
  const { segments, speakers } = convertElevenLabsToSegments(payload.data.transcription);
  const texts = segments.map((s) => s.segment_text);
  // 0: narrator sentence; 1: spk1 sentence; 2: "Yeah." + laugh (sentence split needs ≥3 words so "Yeah." stays with the laugh);
  // 3: spk2 first clause up to the >1s gap; 4: rest of spk2; 5: null-speaker tail (carries speaker 2, split by gap).
  assert.deepEqual(texts, [
    "A destination wedding is part vacation and part love story.",
    "We have a great opportunity for them.",
    "Yeah. <laugh>",
    "So I've dreamt about it since I was old enough to dream, you know, about getting married,",
    "and honestly, it still feels surreal.",
    "We are about to leave for the airport.",
  ]);
  assert.deepEqual(segments.map((s) => s.transcription.speaker), [0, 1, 1, 2, 2, 2]);
  assert.deepEqual(speakers, [0, 1, 2]);
  // absolute segment times from first/last word
  assert.equal(segments[0].time_start_milliseconds, 0);
  assert.equal(segments[0].time_end_milliseconds, 2700);
  assert.equal(segments[3].time_start_milliseconds, 7000);
  // word times are relative to the segment and monotonic, within bounds
  for (const s of segments) {
    const dur = s.time_end_milliseconds - s.time_start_milliseconds;
    let prevEnd = 0;
    for (const w of s.transcription.words) {
      assert.ok(w.start_ms >= prevEnd, `non-monotonic in "${s.segment_text}"`);
      assert.ok(w.end_ms >= w.start_ms);
      assert.ok(w.end_ms <= dur, `word beyond segment in "${s.segment_text}"`);
      assert.ok(w.score >= 0 && w.score <= 1);
      prevEnd = w.end_ms;
    }
    assert.equal(s.transcription.words.map((w) => w.value).join(" "), s.segment_text);
  }
  // spacing tokens dropped, missing logprob → 0.99
  const last = segments[5].transcription.words.at(-1)!;
  assert.equal(last.value, "airport.");
  assert.equal(last.score, 0.99);
});

test("convert: audio events can be dropped", () => {
  const { segments } = convertElevenLabsToSegments(payload.data.transcription, { audioEvents: "drop" });
  assert.equal(segments[2].segment_text, "Yeah.");
});

test("convert: long runs split at ≤maxWords, preferring a clause boundary", () => {
  const words: any[] = [];
  let t = 0;
  for (let i = 0; i < 100; i++) {
    const v = i % 17 === 16 ? `w${i},` : `w${i}`;
    words.push({ text: v, type: "word", logprob: -0.01, start: t, end: t + 0.2, speaker_id: "speaker_0" });
    t += 0.25;
  }
  const { segments } = convertElevenLabsToSegments({ language_code: "en", text: "", words }, { maxSegMs: 60_000, maxWords: 40 });
  assert.ok(segments.length >= 3);
  for (const s of segments) assert.ok(s.transcription.words.length <= 40, `segment too long: ${s.transcription.words.length}`);
  // first split lands on a comma word
  assert.ok(/,$/.test(segments[0].transcription.words.at(-1)!.value));
  assert.equal(segments.reduce((n, s) => n + s.transcription.words.length, 0), 100);
});

test("convert: max duration split", () => {
  const words: any[] = [];
  for (let i = 0; i < 20; i++) words.push({ text: `w${i}`, type: "word", logprob: -0.01, start: i, end: i + 0.5, speaker_id: "speaker_0" });
  const { segments } = convertElevenLabsToSegments({ language_code: "en", text: "", words }, { maxSegMs: 10_000, gapSplitMs: 5_000 });
  for (const s of segments) assert.ok(s.time_end_milliseconds - s.time_start_milliseconds <= 10_000);
  assert.equal(segments.reduce((n, s) => n + s.transcription.words.length, 0), 20);
});

test("toBulkObjects envelope", () => {
  const { segments } = convertElevenLabsToSegments(payload.data.transcription);
  const objs = toBulkObjects(segments, "v1", "t1");
  assert.equal(objs.length, segments.length);
  assert.deepEqual(Object.keys(objs[0]).sort(), ["segment_text", "segment_type", "time_end_milliseconds", "time_start_milliseconds", "transcription", "transcription_id", "version_id"]);
  assert.equal(objs[0].segment_type, "TRANSCRIPTION");
});

test("deriveSpeakerLabels", () => {
  assert.equal(deriveSpeakerLabels(payload), undefined);
  assert.deepEqual(deriveSpeakerLabels({ speakers: [{ id: "speaker_0", name: "Ben" }, { id: "speaker_1", name: "Speaker 2" }] }), { "0": "Ben" });
  assert.deepEqual(deriveSpeakerLabels({ speaker_labels: { speaker_2: "Savannah" } }), { "2": "Savannah" });
});

test("SRT/VTT fallback", () => {
  const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Ben Higgins>Welcome to the show.\n\n00:00:03.500 --> 00:00:05.000\nSavannah: I can't believe it.\n\n00:00:05.100 --> 00:00:06.000\nno speaker here\n`;
  const { segments, speakerNames } = convertSrtOrVtt(vtt);
  assert.equal(segments.length, 3);
  assert.deepEqual(speakerNames, { "0": "Ben Higgins", "1": "Savannah" });
  assert.equal(segments[0].segment_text, "Welcome to the show.");
  assert.equal(segments[0].transcription.speaker, 0);
  assert.equal(segments[1].transcription.speaker, 1);
  assert.equal(segments[2].transcription.speaker, 0);
  assert.equal(segments[0].time_start_milliseconds, 1000);
  assert.equal(segments[0].transcription.words.at(-1)!.end_ms, 2000);
  const srt = `1\n00:00:01,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:02,500 --> 00:00:03,000\nBye.\n`;
  assert.equal(convertSrtOrVtt(srt).segments.length, 2);
});

test("parseKeyterms", () => {
  assert.deepEqual(parseKeyterms(" Paradisus Palma Real, Punta Cana;McKenzie\nJace, mckenzie ,, "), ["Paradisus Palma Real", "Punta Cana", "McKenzie", "Jace"]);
  assert.deepEqual(parseKeyterms(""), []);
  assert.deepEqual(parseKeyterms("x".repeat(51) + ", ok"), ["ok"]);
});

test("webhook signature verify + metadata parse", () => {
  const secret = "whsec_test";
  const now = 1_800_000_000;
  const sig = signWebhook(raw, secret, now);
  const ev = verifyWebhook(raw, sig, secret, { nowMs: now * 1000 });
  assert.equal(ev.data.request_id, "req_sample_001");
  assert.deepEqual(parseWebhookMetadata(ev.data.webhook_metadata), { asset_id: "00000000-0000-0000-0000-000000000001", version_id: "00000000-0000-0000-0000-000000000002", profile: "tm" });
  assert.throws(() => verifyWebhook(raw + " ", sig, secret, { nowMs: now * 1000 }), /mismatch/);
  assert.throws(() => verifyWebhook(raw, sig, "other", { nowMs: now * 1000 }), /mismatch/);
  assert.throws(() => verifyWebhook(raw, sig, secret, { nowMs: (now + 3600) * 1000 }), /tolerance/);
  assert.throws(() => verifyWebhook(raw, undefined, secret), /missing/);
});

test("buildSttForm shape", async () => {
  const fd = await buildSttForm({ sourceUrl: "https://x/y.mp4?sig=1", keyterms: ["A", "B"], webhook: true, webhookMetadata: { asset_id: "a" }, numSpeakers: 40, languageCode: "auto" });
  const d = describeForm(fd);
  assert.equal(d.model_id, "scribe_v2");
  assert.equal(d.source_url, "https://x/y.mp4?<signed>");
  assert.deepEqual(d.keyterms, ["A", "B"]);
  assert.equal(d.webhook, "true");
  assert.equal(d.num_speakers, "32");
  assert.equal(d.diarize, "true");
  assert.equal("language_code" in d, false);
  assert.equal(d.webhook_metadata, '{"asset_id":"a"}');
});

test("editor export → transcript → segments, names kept", () => {
  const e = {
    language_code: "eng",
    segments: [
      { text: " [music] Hello there everyone. ", start_time: 1.0, end_time: 4.0, speaker: { id: "speaker_0", name: "Ben " },
        words: [{ text: " [music]", start_time: 1.0, end_time: 1.5 }, { text: " ", start_time: 1.5, end_time: 1.5 }, { text: "Hello", start_time: 1.6, end_time: 1.9 }, { text: " ", start_time: 1.9, end_time: 1.9 }, { text: "there", start_time: 1.9, end_time: 2.2 }, { text: " ", start_time: 2.2, end_time: 2.2 }, { text: "everyone.", start_time: 2.3, end_time: 2.9 }] },
      { text: "Thanks. ", start_time: 4.2, end_time: 4.8, speaker: { id: "speaker_1", name: "Speaker 2" }, words: [{ text: "Thanks.", start_time: 4.2, end_time: 4.8 }] },
      { text: "No words array here", start_time: 5.0, end_time: 6.0, speaker: { id: "speaker_1", name: "Speaker 2" } },
    ],
  };
  assert.ok(isEditorExport(e));
  assert.ok(!isEditorExport(payload.data.transcription));
  const { transcript, speakerLabels } = editorExportToTranscript(e);
  assert.deepEqual(speakerLabels, { "0": "Ben" });
  assert.equal(transcript.words.filter((w) => w.type === "spacing").length, 3);
  assert.equal(transcript.words.find((w) => w.type === "audio_event")!.text, "[music]");
  const { segments } = convertElevenLabsToSegments(transcript);
  assert.deepEqual(segments.map((s) => s.segment_text), ["Hello there everyone.", "Thanks.", "No words array here"]);
  assert.equal(convertElevenLabsToSegments(transcript, { audioEvents: "all" }).segments[0].segment_text, "<music> Hello there everyone.");
  assert.deepEqual(segments.map((s) => s.transcription.speaker), [0, 1, 1]);
  assert.equal(segments[0].time_start_milliseconds, 1600); // music bed dropped by default, so the first word anchors the segment
});
