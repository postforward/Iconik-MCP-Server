/**
 * iconik TRANSCRIPTION helpers shared by the ElevenLabs importer, the Hyperaudio exporter and the
 * editor-projects index. Thin I/O wrappers + one pure picker; no CLI parsing here.
 *
 * Facts (verified live on TM 2026-09-10/11):
 *  - GET /assets/v1/assets/{id}/segments/TRANSCRIPTION/ pages with per_page ≤ 150.
 *  - The transcription properties record's own `id` IS the transcription_id segments reference.
 *  - An asset can carry several transcription_id groups (duplicates); the UI joins on properties.
 *  - Proxy download URLs are presigned S3 (X-Amz-Date + X-Amz-Expires, typically 12 h).
 */
import { iconikRequest } from "../client.js";

export interface IkTranscriptionWord { value: string; start_ms: number; end_ms: number; score?: number }
export interface IkTranscriptionSegment {
  id: string;
  asset_id: string;
  version_id?: string;
  transcription_id?: string | null;
  segment_type: string;
  segment_text: string;
  time_start_milliseconds: number;
  time_end_milliseconds: number;
  date_created?: string;
  transcription: { speaker: number | null; words: IkTranscriptionWord[] };
}
export interface IkTranscriptionProps {
  id: string;
  asset_id?: string;
  version_id?: string;
  language?: string | null;
  speaker_labels?: Record<string, string> | null;
  engine_info?: { name?: string; model?: string; version?: string; type?: string } | null;
}
export interface ProxyLink { url: string; mime_type: string; filename: string; expires_at: string | null; proxy_id: string; size: number | null; is_audio: boolean }

export async function fetchAsset(assetId: string): Promise<any> {
  return iconikRequest<any>(`assets/v1/assets/${assetId}/`);
}

/** Newest ACTIVE version id (falls back to the first version). */
export async function resolveActiveVersion(assetId: string, asset?: any): Promise<string> {
  const a = asset ?? (await fetchAsset(assetId));
  const versions: any[] = a.versions ?? [];
  const active = versions.filter((v) => v.status === "ACTIVE").sort((x, y) => String(y.date_created).localeCompare(String(x.date_created)))[0] ?? versions[0];
  if (!active?.id) throw new Error("asset has no versions");
  return active.id;
}

export async function fetchAllTranscription(assetId: string): Promise<IkTranscriptionSegment[]> {
  const all: IkTranscriptionSegment[] = [];
  let page = 1, pages = 1;
  do {
    const r = await iconikRequest<any>(`assets/v1/assets/${assetId}/segments/TRANSCRIPTION/?page=${page}&per_page=150`);
    all.push(...(r.objects ?? []));
    pages = r.pages ?? 1;
    page++;
  } while (page <= pages);
  return all.sort((a, b) => a.time_start_milliseconds - b.time_start_milliseconds);
}

export async function countTranscription(assetId: string): Promise<number> {
  const r = await iconikRequest<any>(`assets/v1/assets/${assetId}/segments/TRANSCRIPTION/?page=1&per_page=1`);
  return r.total ?? r.objects?.length ?? 0;
}

export async function fetchTranscriptionProperties(assetId: string, versionId: string): Promise<IkTranscriptionProps[]> {
  try {
    const r = await iconikRequest<any>(`assets/v1/assets/${assetId}/versions/${versionId}/transcriptions/properties/`);
    return r.objects ?? [];
  } catch { return []; }
}

export interface PickedTranscription {
  segments: IkTranscriptionSegment[];
  transcriptionId: string | null;
  props: IkTranscriptionProps | null;
  duplicatesDropped: number;
  groups: { transcriptionId: string | null; count: number; newest: string }[];
}

/**
 * Pure. Split segments by transcription_id and pick ONE group: the newest group that has a matching
 * properties record; failing that, the newest group overall. Everything else is reported as dropped.
 */
export function pickTranscription(segments: IkTranscriptionSegment[], props: IkTranscriptionProps[]): PickedTranscription {
  const byId = new Map<string | null, IkTranscriptionSegment[]>();
  for (const s of segments) {
    const k = s.transcription_id ?? null;
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k)!.push(s);
  }
  const groups = [...byId.entries()].map(([transcriptionId, segs]) => ({
    transcriptionId, count: segs.length,
    newest: segs.reduce((m, s) => (String(s.date_created ?? "") > m ? String(s.date_created ?? "") : m), ""),
  }));
  if (groups.length === 0) return { segments: [], transcriptionId: null, props: null, duplicatesDropped: 0, groups };
  const propIds = new Set(props.map((p) => p.id));
  const ranked = [...groups].sort((a, b) => Number(propIds.has(b.transcriptionId ?? "")) - Number(propIds.has(a.transcriptionId ?? "")) || b.newest.localeCompare(a.newest) || b.count - a.count);
  const winner = ranked[0];
  const picked = byId.get(winner.transcriptionId)!;
  return {
    segments: picked,
    transcriptionId: winner.transcriptionId,
    props: props.find((p) => p.id === winner.transcriptionId) ?? null,
    duplicatesDropped: segments.length - picked.length,
    groups,
  };
}

/** iconik wants ISO 639-1 ("en"); ElevenLabs returns 639-3 ("eng"). */
export const ISO3TO1: Record<string, string> = { eng: "en", spa: "es", fra: "fr", fre: "fr", deu: "de", ger: "de", por: "pt", ita: "it", nld: "nl", dut: "nl", jpn: "ja", kor: "ko", zho: "zh", chi: "zh", rus: "ru", ara: "ar", hin: "hi", swe: "sv", nor: "no", dan: "da", fin: "fi", pol: "pl", tur: "tr" };
export const normLang = (l?: string | null): string | undefined => {
  if (!l) return undefined;
  const x = l.toLowerCase().split(/[-_]/)[0];
  return x.length === 3 ? (ISO3TO1[x] ?? x.slice(0, 2)) : x;
};

/** Expiry of a presigned S3 URL from X-Amz-Date + X-Amz-Expires (ISO string) or null. */
export function parsePresignedExpiry(url: string): string | null {
  try {
    const u = new URL(url);
    const d = u.searchParams.get("X-Amz-Date"); // 20260911T120000Z
    const e = u.searchParams.get("X-Amz-Expires");
    if (!d || !e) return null;
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(d);
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + parseInt(e, 10) * 1000;
    return new Date(t).toISOString();
  } catch { return null; }
}

const MIME_BY_EXT: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
export function mimeForFilename(name: string, format?: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (/audio/i.test(format ?? "")) return "audio/mpeg";
  return "video/mp4";
}

/**
 * A fresh presigned download URL for the asset's best CLOSED proxy.
 * prefer "audio": smallest audio proxy first (playback in the editor); "video": video proxies first; "any": smallest.
 */
export async function freshProxyUrl(assetId: string, prefer: "audio" | "video" | "any" = "audio"): Promise<ProxyLink | null> {
  try {
    const res = await iconikRequest<any>(`files/v1/assets/${assetId}/proxies/`);
    const closed = (res.objects ?? []).filter((p: any) => p.status === "CLOSED");
    if (!closed.length) return null;
    const isAudio = (p: any) => /audio|mp3|aac|wav|m4a/i.test(`${p.format ?? ""} ${p.filename ?? ""}`);
    closed.sort((a: any, b: any) => {
      if (prefer !== "any") { const d = Number(isAudio(b)) - Number(isAudio(a)); if (d) return prefer === "audio" ? d : -d; }
      return (a.size ?? 0) - (b.size ?? 0);
    });
    const p = closed[0];
    const dl = await iconikRequest<any>(`files/v1/assets/${assetId}/proxies/${p.id}/download_url/`);
    if (!dl?.url) return null;
    return { url: dl.url, mime_type: mimeForFilename(p.filename ?? "", p.format), filename: p.filename ?? "", expires_at: parsePresignedExpiry(dl.url), proxy_id: p.id, size: p.size ?? null, is_audio: isAudio(p) };
  } catch { return null; }
}
