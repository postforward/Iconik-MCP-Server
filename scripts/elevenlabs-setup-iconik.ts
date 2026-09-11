#!/usr/bin/env npx tsx
/**
 * Create the iconik metadata fields + views used by the ElevenLabs pipeline (idempotent).
 *
 *   npx tsx scripts/elevenlabs-setup-iconik.ts --profile=<profile> [--live] [--write-config]
 *
 * Fields (create-if-missing; existing fields are left untouched):
 *   ElevenLabsKeyterms        text       proper nouns for keyterm prompting (comma/newline separated)
 *   ElevenLabsLanguage        drop_down  auto | en | es
 *   ElevenLabsNumSpeakers     integer    optional hint (1-32)
 *   ElevenLabsNotes           string     free text, echoed in Slack
 *   ElevenLabsTranscriptionId string     tracking
 *   ElevenLabsStatus          drop_down  SUBMITTED | IMPORT_PENDING | IMPORTED | EDIT_IMPORTED | FAILED
 *   ElevenLabsUpdated         date_time  tracking
 * Views:
 *   "ElevenLabs — Send"      → the custom-action form (Keyterms, Language, NumSpeakers, Notes)
 *   "ElevenLabs — Tracking"  → TranscriptionId, Status, Updated (add to the asset page)
 *
 * --write-config stores the two view ids into iconik-config.json → profiles.<p>.elevenlabs.
 */
import * as fs from "fs";
import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";
import { TRACKING_FIELDS, SEND_FIELDS } from "../src/lib/elevenlabs-tracking.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);
const args = process.argv.slice(2);
const live = args.includes("--live");
const writeConfig = args.includes("--write-config");

interface FieldDef { name: string; label: string; field_type: string; fallback_type?: string; description: string; options?: { label: string; value: string }[]; read_only?: boolean; multi?: boolean }

const FIELDS: FieldDef[] = [
  { name: SEND_FIELDS.keyterms, label: "Keyterms (names, places)", field_type: "text", description: "ElevenLabs keyterm prompting: proper nouns to spell correctly, separated by commas or new lines. Optional." },
  { name: SEND_FIELDS.language, label: "Language", field_type: "drop_down", description: "Spoken language hint for ElevenLabs. Auto-detect if blank.", options: [{ label: "Auto-detect", value: "auto" }, { label: "English", value: "en" }, { label: "Spanish", value: "es" }], multi: false },
  { name: SEND_FIELDS.numSpeakers, label: "Speakers (at least) — AssemblyAI only", field_type: "integer", fallback_type: "string", description: "AssemblyAI: minimum number of speakers (exact when 'Max speakers' equals it). Ignored by ElevenLabs." },
  { name: SEND_FIELDS.maxSpeakers, label: "Max speakers (optional)", field_type: "integer", fallback_type: "string", description: "Upper bound on speakers. AssemblyAI: with 'Speakers' this makes a range. ElevenLabs: its only speaker setting (a maximum) — leave blank to let it decide." },
  { name: SEND_FIELDS.notes, label: "Notes", field_type: "string", description: "Free text, shown in the Slack notification." },
  { name: TRACKING_FIELDS.id, label: "ElevenLabs transcription ID", field_type: "string", description: "Set by the pipeline. Used to pull the edited transcript back.", read_only: true },
  { name: TRACKING_FIELDS.status, label: "ElevenLabs status", field_type: "drop_down", description: "Set by the pipeline.", options: ["SUBMITTED", "IMPORT_PENDING", "IMPORTED", "EDIT_IMPORTED", "FAILED"].map((v) => ({ label: v, value: v })), multi: false },
  { name: TRACKING_FIELDS.updated, label: "ElevenLabs updated", field_type: "date_time", fallback_type: "string", description: "Set by the pipeline." },
];

const VIEWS = [
  { name: "ElevenLabs — Send", description: "Form shown by the 'Send to ElevenLabs' custom action.", fields: [SEND_FIELDS.keyterms, SEND_FIELDS.language, SEND_FIELDS.numSpeakers, SEND_FIELDS.notes], key: "send_view_id" as const },
  { name: "ElevenLabs — Tracking", description: "ElevenLabs transcription status for this asset (set by the pipeline).", fields: [TRACKING_FIELDS.id, TRACKING_FIELDS.status, TRACKING_FIELDS.updated], key: "tracking_view_id" as const },
];

async function ensureField(f: FieldDef): Promise<"exists" | "created" | "would-create"> {
  try { await iconikRequest(`metadata/v1/fields/${f.name}/`); return "exists"; }
  catch (e) { if (!/404/.test(String(e))) throw e; }
  if (!live) return "would-create";
  const body: Record<string, unknown> = { name: f.name, label: f.label, field_type: f.field_type, description: f.description };
  if (f.options) body.options = f.options;
  if (f.multi !== undefined) body.multi = f.multi;
  if (f.read_only) body.read_only = true;
  try { await iconikRequest(`metadata/v1/fields/`, { method: "POST", body: JSON.stringify(body), noRetry5xx: true } as any); }
  catch (e) {
    if (!f.fallback_type) throw e;
    console.log(`   ⚠ ${f.field_type} rejected (${String(e).slice(0, 100)}), retrying as ${f.fallback_type}`);
    await iconikRequest(`metadata/v1/fields/`, { method: "POST", body: JSON.stringify({ ...body, field_type: f.fallback_type }), noRetry5xx: true } as any);
  }
  return "created";
}

async function ensureView(v: (typeof VIEWS)[number]): Promise<{ id?: string; state: string }> {
  const list = await iconikRequest<any>(`metadata/v1/views/?per_page=200`);
  const existing = (list.objects ?? []).find((x: any) => x.name === v.name);
  if (existing) return { id: existing.id, state: "exists" };
  if (!live) return { state: "would-create" };
  const res = await iconikRequest<any>(`metadata/v1/views/`, { method: "POST", body: JSON.stringify({ name: v.name, description: v.description, view_fields: v.fields.map((name) => ({ name })) }), noRetry5xx: true } as any);
  return { id: res.id, state: "created" };
}

async function main() {
  console.log(`Profile: ${getCurrentProfileInfo().name} | ${live ? "LIVE" : "DRY-RUN"}`);
  console.log("\nFields:");
  for (const f of FIELDS) console.log(`  ${(await ensureField(f)).padEnd(13)} ${f.name} (${f.field_type})`);
  console.log("\nViews:");
  const ids: Record<string, string> = {};
  for (const v of VIEWS) { const r = await ensureView(v); console.log(`  ${r.state.padEnd(13)} ${v.name} ${r.id ?? ""}`); if (r.id) ids[v.key] = r.id; }
  if (Object.keys(ids).length) {
    console.log(`\niconik-config.json → profiles.${profileName ?? "<default>"}.elevenlabs = ${JSON.stringify(ids)}`);
    if (writeConfig && profileName) {
      const cfg = JSON.parse(fs.readFileSync("iconik-config.json", "utf8"));
      cfg.profiles[profileName].elevenlabs = { ...(cfg.profiles[profileName].elevenlabs ?? {}), ...ids };
      fs.writeFileSync("iconik-config.json", JSON.stringify(cfg, null, 2) + "\n");
      console.log("written to iconik-config.json");
    }
  }
  if (!live) console.log("\nDRY-RUN — nothing created. Re-run with --live.");
  console.log("\nManual follow-ups: add 'ElevenLabs — Tracking' to the asset page views (Admin → Metadata → Views), and register the custom action with --metadata-view=<send_view_id>.");
}
main().catch((e) => { console.error("Fatal:", e instanceof Error ? e.message : e); process.exit(1); });
