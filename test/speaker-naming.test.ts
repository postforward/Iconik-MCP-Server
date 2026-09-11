import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { renderTranscript, buildPrompt, mergeLabels, type SpeakerProposal } from "../src/lib/speaker-naming.ts";
import type { IkTranscriptionSegment } from "../src/lib/iconik-transcripts.ts";

const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "iconik-transcription.sample.json"), "utf8")) as { segments: IkTranscriptionSegment[] };
const segs = fx.segments.filter((s) => s.transcription_id === "tid-new");

test("renderTranscript: sorted timed lines with per-speaker counts", () => {
  const { text, perSpeaker } = renderTranscript(segs);
  assert.ok(text.startsWith("[00:07] S0: A destination wedding"));
  assert.deepEqual(Object.keys(perSpeaker).map(Number), [0, 1, 2]);
  assert.equal(perSpeaker[0].paragraphs, 4);
});

test("buildPrompt: hints and known labels are passed, default names are not treated as known", () => {
  const p = buildPrompt({ title: "IDO_101", keyterms: ["Ben Higgins"], notes: "wedding episode", knownLabels: { "0": "Ben", "1": "Speaker 2" } }, [0, 1, 2]);
  assert.match(p.user, /Asset title: IDO_101/);
  assert.match(p.user, /Ben Higgins/);
  assert.match(p.user, /S0 = Ben/);
  assert.doesNotMatch(p.user, /S1 = Speaker 2/);
  assert.match(p.user, /S0, S1, S2/);
});

test("mergeLabels: threshold, keep existing, no duplicate names, overwrite", () => {
  const props: SpeakerProposal[] = [
    { speaker: 0, name: "Ben Higgins", confidence: 0.95, evidence: "self intro", paragraphs: 4, words: 40 },
    { speaker: 1, name: "McKenzie", confidence: 0.6, evidence: "addressed once", paragraphs: 1, words: 8 },
    { speaker: 2, name: "Ben Higgins", confidence: 0.8, evidence: "?", paragraphs: 1, words: 6 },
    { speaker: 3, name: null, confidence: 0.2, evidence: "mixed", paragraphs: 2, words: 10 },
  ];
  const m = mergeLabels({ "0": "Ben" }, props, 0.7);
  assert.deepEqual(m.labels, { "0": "Ben" });               // existing kept, duplicate Ben Higgins for S2 refused
  assert.equal(m.applied.length, 0);
  const o = mergeLabels({ "0": "Ben" }, props, 0.7, true);
  assert.deepEqual(o.labels, { "0": "Ben Higgins" });        // overwrite wins for S0; S2 duplicate still refused; S1 below threshold
  const low = mergeLabels(null, props, 0.5);
  assert.deepEqual(low.labels, { "0": "Ben Higgins", "1": "McKenzie" });
});
