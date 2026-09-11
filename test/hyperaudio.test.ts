import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { iconikToHyperaudio, hyperaudioToTranscript, isHyperaudioProject, scoreKey, describeProject, type HaProject } from "../src/lib/hyperaudio.ts";
import { pickTranscription, parsePresignedExpiry, mimeForFilename, normLang, type IkTranscriptionSegment, type IkTranscriptionProps } from "../src/lib/iconik-transcripts.ts";
import { convertElevenLabsToSegments, isEditorExport } from "../src/lib/elevenlabs-to-iconik.ts";

const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "iconik-transcription.sample.json"), "utf8")) as { segments: IkTranscriptionSegment[]; properties: IkTranscriptionProps[] };
const webhook = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "elevenlabs-webhook.sample.json"), "utf8"));
const META = { assetId: "asset-1", versionId: "ver-1", title: "IDO_101", transcriptionId: "tid-new", exportedAt: "2026-09-11T12:00:00.000Z" };
const MEDIA = { kind: "link" as const, url: "https://example.s3.amazonaws.com/x.mp3?X-Amz-Date=20260911T120000Z&X-Amz-Expires=43200", mimeType: "audio/mpeg", filename: "x.mp3" };

function exportFixture() {
  const picked = pickTranscription(fx.segments, fx.properties);
  return { picked, ...iconikToHyperaudio(picked.segments, picked.props, META, { media: MEDIA }) };
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

test("pickTranscription: keeps the group with a properties record, drops the duplicate", () => {
  const p = pickTranscription(fx.segments, fx.properties);
  assert.equal(p.transcriptionId, "tid-new");
  assert.equal(p.segments.length, 6);
  assert.equal(p.duplicatesDropped, 2);
  assert.equal(p.props?.speaker_labels?.["0"], "Ben");
  // no props at all → newest group wins
  const q = pickTranscription(fx.segments, []);
  assert.equal(q.transcriptionId, "tid-new");
});

test("export: project shape, absolute seconds, paragraph merge, speaker names, score sidecar", () => {
  const { project, scores } = exportFixture();
  assert.equal(project.format, "hyperaudio");
  assert.equal(project.formatVersion, "1.3");
  assert.equal(project.media.kind, "link");
  assert.equal(project.texts.language, "en");
  assert.equal(project.provenance?.engine, "iconik");
  assert.equal(project.provenance?.assetId, "asset-1");
  assert.equal(project.provenance?.transcriptionId, "tid-new");
  assert.deepEqual(project.provenance?.speakerLabels, { "0": "Ben" });
  assert.deepEqual(project.provenance?.speakerInts, [0, 1, 2]);
  // words: sorted, absolute, 3 dp
  const w = project.transcript.words;
  assert.equal(w[0].text, "A");
  assert.equal(w[0].start, 7.53);
  assert.ok(w.every((x, i) => i === 0 || x.start >= w[i - 1].start), "monotonic starts");
  assert.ok(w.every((x) => x.end >= x.start));
  assert.equal(w.filter((x) => x.text === "<laugh>").length, 1);
  // paragraphs: seg0+seg1 merged (same speaker, gap 120 ms); seg4→seg5 split (gap 3 s ≥ 2 s)
  const paras = project.transcript.paragraphs;
  assert.deepEqual(paras.map((p) => p.speaker), ["Ben", "Speaker 2", "Speaker 3", "Ben", "Ben"]);
  assert.equal(paras[0].start, 7.53);
  assert.equal(paras[0].end, 12.98);
  // segment mode: one paragraph per segment
  const seg = iconikToHyperaudio(fx.segments.filter((s) => s.transcription_id === "tid-new"), fx.properties[0], META, { paragraphs: "segment" });
  assert.equal(seg.project.transcript.paragraphs.length, 6);
  // sidecar carries every word's score
  assert.equal(Object.keys(scores).length, w.length);
  assert.equal(scores[scoreKey(7530, "A")], 1);
  assert.equal(scores[scoreKey(7530 + Math.round(2850 / 9), "destination")], 0.87);
  assert.match(describeProject(project), /\d+ words · 5 paragraphs · speakers Ben, Speaker 2, Speaker 3/);
});

test("round trip: unedited project reproduces the iconik segments (text, times, speakers, scores)", () => {
  const { picked, project, scores } = exportFixture();
  const r = hyperaudioToTranscript(clone(project), { scores, knownLabels: { "0": "Ben" } });
  assert.deepEqual(r.speakerLabels, { "0": "Ben" });
  assert.equal(r.stats.struck, 0);
  assert.equal(r.stats.inserted, 0);
  const { segments } = convertElevenLabsToSegments(r.transcript);
  const orig = [...picked.segments].sort((a, b) => a.time_start_milliseconds - b.time_start_milliseconds);
  assert.deepEqual(segments.map((s) => s.segment_text), orig.map((s) => s.segment_text));
  assert.deepEqual(segments.map((s) => s.transcription.speaker), orig.map((s) => s.transcription.speaker));
  assert.deepEqual(segments.map((s) => s.time_start_milliseconds), orig.map((s) => s.time_start_milliseconds));
  for (let i = 0; i < orig.length; i++) {
    const a = segments[i].transcription.words, b = orig[i].transcription.words;
    assert.deepEqual(a.map((x) => x.value), b.map((x) => x.value), `words of segment ${i}`);
    assert.deepEqual(a.map((x) => x.start_ms), b.map((x) => x.start_ms), `relative starts of segment ${i}`);
    assert.deepEqual(a.map((x) => x.score), b.map((x) => x.score), `scores of segment ${i}`);
  }
});

test("edits: rename speaker, new speaker, struck word dropped, inserted word kept, split paragraph", () => {
  const { project, scores } = exportFixture();
  const p: HaProject = clone(project);
  const paras = p.transcript.paragraphs;
  paras[1].speaker = "McKenzie";           // was Speaker 2 (iconik int 1)
  paras[2].speaker = "Producer";           // was Speaker 3 → new name takes over that paragraph's int (2)
  // strike "But" (first word of the second sentence in paragraph 0)
  const but = p.transcript.words.find((w) => w.text === "But")!; but.struck = true;
  // insert a word after "Okay." with an interpolated timing (as the editor's aligner would)
  const okay = p.transcript.words.findIndex((w) => w.text === "Okay.");
  p.transcript.words.splice(okay + 1, 0, { start: p.transcript.words[okay].end, end: p.transcript.words[okay].end + 0.05, text: "Right." });
  // split paragraph 0 before "But": a new paragraph starting at that word, same speaker
  paras.splice(1, 0, { speaker: "Ben", start: but.start, end: paras[0].end });
  paras[0].end = but.start;

  const r = hyperaudioToTranscript(p, { scores, knownLabels: { "0": "Ben" } });
  assert.deepEqual(r.speakerLabels, { "0": "Ben", "1": "McKenzie", "2": "Producer" });
  assert.deepEqual(r.speakerMap, { Ben: 0, McKenzie: 1, Producer: 2 });
  assert.equal(r.stats.struck, 1);
  assert.equal(r.stats.inserted, 1);
  const { segments } = convertElevenLabsToSegments(r.transcript);
  const texts = segments.map((s) => s.segment_text);
  assert.ok(!texts.some((t) => /\bBut\b/.test(t)), "struck word gone");
  assert.ok(texts.some((t) => t.includes("Okay. Right.")), "inserted word kept");
  assert.equal(segments.find((s) => s.segment_text.startsWith("We have"))!.transcription.speaker, 1);
  assert.equal(segments.find((s) => s.segment_text.startsWith("You guys"))!.transcription.speaker, 2);
  // the split paragraph yields separate segments starting at the split point
  assert.ok(texts.some((t) => t.startsWith("behind every dream")), "paragraph split honoured");
  const ins = segments.flatMap((s) => s.transcription.words).find((w) => w.value === "Right.")!;
  assert.equal(ins.score, 0.99);
  const kept = segments.flatMap((s) => s.transcription.words).find((w) => w.value === "destination")!;
  assert.equal(kept.score, 0.87);
});

test("speaker mapping: a paragraph re-attributed to a NEW person gets a fresh int, the old speaker keeps theirs", () => {
  const { project } = exportFixture();
  const p: HaProject = clone(project);
  // paragraph 3 was Ben (int 0); the editor decides it was really McKenzie speaking — Ben still owns paragraphs 0 and 4
  p.transcript.paragraphs[3].speaker = "McKenzie";
  const r = hyperaudioToTranscript(p, { knownLabels: { "0": "Ben" } });
  assert.deepEqual(r.speakerMap, { Ben: 0, "Speaker 2": 1, "Speaker 3": 2, McKenzie: 3 });
  assert.deepEqual(r.speakerLabels, { "0": "Ben", "3": "McKenzie" });
  // and without provenance at all, a new name simply takes the next unused int
  const q: HaProject = clone(project); delete q.provenance;
  q.transcript.paragraphs[1].speaker = "McKenzie";
  const s = hyperaudioToTranscript(q, { knownLabels: { "0": "Ben" } });
  assert.deepEqual(s.speakerMap, { Ben: 0, McKenzie: 1, "Speaker 3": 2 });
});

test("speaker mapping edge cases: Speaker N → N-1, unnamed paragraph inherits, no labels when all default", () => {
  const p: HaProject = { format: "hyperaudio", formatVersion: "1.3", media: { kind: "none" }, texts: { title: "t", language: "en" },
    transcript: { words: [{ start: 0, end: 0.5, text: "Hi" }, { start: 1, end: 1.5, text: "there." }, { start: 2, end: 2.5, text: "Yes" }],
      paragraphs: [{ speaker: "Speaker 4", start: 0, end: 0.5 }, { start: 1, end: 1.5 }, { speaker: "speaker 1", start: 2, end: 2.5 }] } };
  const r = hyperaudioToTranscript(p);
  assert.deepEqual(r.transcript.words.map((w) => w.speaker_id), ["speaker_3", "speaker_3", "speaker_0"]);
  assert.equal(r.speakerLabels, undefined);
  assert.equal(r.stats.unknownSpeakerParagraphs, 1);
  // multi-word span is split evenly; bracketed text becomes an audio event
  const q: HaProject = { ...p, transcript: { words: [{ start: 0, end: 1, text: "hello big world" }, { start: 2, end: 2.4, text: "[laughter]" }], paragraphs: [{ speaker: "Ben", start: 0, end: 3 }] } };
  const s = hyperaudioToTranscript(q);
  assert.deepEqual(s.transcript.words.map((w) => [w.text, w.type, w.start, w.end]), [["hello", "word", 0, 0.333], ["big", "word", 0.333, 0.667], ["world", "word", 0.667, 1], ["[laughter]", "audio_event", 2, 2.4]]);
  assert.equal(convertElevenLabsToSegments(s.transcript).segments[0].segment_text, "hello big world <laugh>");
});

test("format sniffing: hyperaudio vs ElevenLabs shapes never collide", () => {
  const { project } = exportFixture();
  assert.equal(isHyperaudioProject(project), true);
  assert.equal(isEditorExport(project), false);
  assert.equal(isHyperaudioProject(webhook), false);
  assert.equal(isHyperaudioProject(webhook.data.transcription), false);
  assert.equal(isHyperaudioProject({ format: "hyperaudio" }), false);
});

test("helpers: presigned expiry, mime, language", () => {
  assert.equal(parsePresignedExpiry(MEDIA.url), "2026-09-12T00:00:00.000Z");
  assert.equal(parsePresignedExpiry("https://x/y.mp3"), null);
  assert.equal(mimeForFilename("a.mp3"), "audio/mpeg");
  assert.equal(mimeForFilename("a.bin", "MPEG Audio"), "audio/mpeg");
  assert.equal(mimeForFilename("a.mov"), "video/quicktime");
  assert.equal(normLang("eng"), "en");
  assert.equal(normLang("en-US"), "en");
});
