/**
 * Read/write the per-asset ElevenLabs tracking fields in iconik metadata.
 *
 * Fields (created by scripts/elevenlabs-setup-iconik.ts, TM PascalCase convention):
 *   ElevenLabsTranscriptionId  string
 *   ElevenLabsStatus           drop_down  SUBMITTED | IMPORT_PENDING | IMPORTED | EDIT_IMPORTED | FAILED
 *   ElevenLabsUpdated          date_time
 * They live in the "ElevenLabs — Tracking" metadata view whose id is stored per profile in
 * iconik-config.json as profiles.<name>.elevenlabs.tracking_view_id.
 */
import { iconikRequest } from "../client.js";
import type { IconikProfile } from "../config.js";

export type TrackingStatus = "SUBMITTED" | "IMPORT_PENDING" | "IMPORTED" | "EDIT_IMPORTED" | "FAILED";

export const TRACKING_FIELDS = {
  id: "ElevenLabsTranscriptionId",
  status: "ElevenLabsStatus",
  updated: "ElevenLabsUpdated",
} as const;

export const SEND_FIELDS = {
  keyterms: "ElevenLabsKeyterms",
  language: "ElevenLabsLanguage",
  numSpeakers: "ElevenLabsNumSpeakers",
  maxSpeakers: "ElevenLabsMaxSpeakers",
  notes: "ElevenLabsNotes",
} as const;

export interface Tracking {
  transcription_id?: string;
  status?: TrackingStatus;
  updated?: string; // ISO
}

export class TrackingNotConfigured extends Error {
  constructor(profileName: string) {
    super(`profile "${profileName}" has no elevenlabs.tracking_view_id in iconik-config.json — run scripts/elevenlabs-setup-iconik.ts`);
    this.name = "TrackingNotConfigured";
  }
}

function viewId(profile: IconikProfile): string {
  const id = profile.elevenlabs?.tracking_view_id;
  if (!id) throw new TrackingNotConfigured(profile.name);
  return id;
}

/** First value of a metadata field from an asset-metadata response (`metadata_values.<Field>.field_values[0].value`). */
export function firstValue(metadataValues: any, field: string): string | undefined {
  const fv = metadataValues?.[field]?.field_values;
  const v = Array.isArray(fv) && fv.length ? fv[0]?.value : undefined;
  return v == null ? undefined : String(v);
}

export async function readTracking(profile: IconikProfile, assetId: string): Promise<Tracking> {
  const res = await iconikRequest<any>(`metadata/v1/assets/${assetId}/views/${viewId(profile)}/`);
  const mv = res?.metadata_values ?? {};
  return {
    transcription_id: firstValue(mv, TRACKING_FIELDS.id),
    status: firstValue(mv, TRACKING_FIELDS.status) as TrackingStatus | undefined,
    updated: firstValue(mv, TRACKING_FIELDS.updated),
  };
}

export async function writeTracking(profile: IconikProfile, assetId: string, t: Tracking): Promise<void> {
  const metadata_values: Record<string, { field_values: { value: string }[] }> = {};
  if (t.transcription_id !== undefined) metadata_values[TRACKING_FIELDS.id] = { field_values: [{ value: t.transcription_id }] };
  if (t.status !== undefined) metadata_values[TRACKING_FIELDS.status] = { field_values: [{ value: t.status }] };
  metadata_values[TRACKING_FIELDS.updated] = { field_values: [{ value: t.updated ?? new Date().toISOString() }] };
  // PUT on the view merges the given fields (verified pattern in scripts/metadata-bulk-update.ts).
  await iconikRequest(`metadata/v1/assets/${assetId}/views/${viewId(profile)}/`, {
    method: "PUT",
    body: JSON.stringify({ metadata_values }),
  });
}
