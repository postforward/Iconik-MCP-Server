#!/usr/bin/env npx tsx
/**
 * Diagnose transcode/proxy failures for assets in a collection.
 * Pulls technical metadata, proxy info, format details, and recent job history.
 *
 * Usage: npx tsx scripts/diagnose-transcode-issues.ts --profile=privcap --collection=<id>
 */

import { initializeProfile, iconikRequest } from "../src/client.js";
import type { PaginatedResponse } from "../src/types/iconik.js";

// --- Parse args ---
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=")[1];
}

const profile = getArg("profile") || "privcap";
const collectionId = getArg("collection");
if (!collectionId) {
  console.error("Usage: --collection=<uuid> [--profile=<name>]");
  process.exit(1);
}

initializeProfile(profile);

// --- Helpers ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AssetSummary {
  id: string;
  title: string;
  analyze_status: string;
  archive_status: string;
  is_online: boolean;
}

async function getCollectionAssets(collId: string): Promise<AssetSummary[]> {
  const assets: AssetSummary[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const resp = await iconikRequest<PaginatedResponse<any>>(
      `assets/v1/collections/${collId}/contents/?page=${page}&per_page=100`
    );
    for (const item of resp.objects || []) {
      if (item.object_type === "assets") {
        assets.push({
          id: item.id,
          title: item.title,
          analyze_status: item.analyze_status || "N/A",
          archive_status: item.archive_status || "N/A",
          is_online: item.is_online ?? false,
        });
      }
    }
    hasMore = resp.pages > page;
    page++;
  }
  return assets;
}

async function getAssetMediaInfo(assetId: string): Promise<any> {
  // Technical metadata lives in the metadata view — try the "media_info" or technical segment
  try {
    const resp = await iconikRequest<any>(
      `metadata/v1/assets/${assetId}/views/technical_metadata/`
    );
    return resp;
  } catch {
    // Fallback: try the default metadata view
    try {
      const resp = await iconikRequest<any>(
        `metadata/v1/assets/${assetId}/`
      );
      return resp;
    } catch {
      return null;
    }
  }
}

async function getAssetProxies(assetId: string): Promise<any[]> {
  try {
    const resp = await iconikRequest<PaginatedResponse<any>>(
      `assets/v1/assets/${assetId}/proxies/`
    );
    return resp.objects || [];
  } catch {
    return [];
  }
}

async function getAssetFormats(assetId: string): Promise<any[]> {
  try {
    const resp = await iconikRequest<PaginatedResponse<any>>(
      `files/v1/assets/${assetId}/formats/`
    );
    return resp.objects || [];
  } catch {
    return [];
  }
}

async function getAssetFiles(assetId: string): Promise<any[]> {
  try {
    const resp = await iconikRequest<PaginatedResponse<any>>(
      `files/v1/assets/${assetId}/files/`
    );
    return resp.objects || [];
  } catch {
    return [];
  }
}

async function getAssetHistory(assetId: string): Promise<any[]> {
  try {
    const resp = await iconikRequest<PaginatedResponse<any>>(
      `assets/v1/assets/${assetId}/history/?per_page=20`
    );
    return resp.objects || [];
  } catch {
    return [];
  }
}

async function getJobDetails(jobId: string): Promise<any> {
  try {
    return await iconikRequest<any>(`jobs/v1/jobs/${jobId}/`);
  } catch {
    return null;
  }
}

// --- Main ---
async function main() {
  console.log(`\n=== Diagnosing transcode issues in collection ${collectionId} (${profile}) ===\n`);

  const assets = await getCollectionAssets(collectionId);
  console.log(`Found ${assets.length} assets in collection.\n`);

  for (const asset of assets) {
    console.log("─".repeat(80));
    console.log(`ASSET: ${asset.title}`);
    console.log(`  ID: ${asset.id}`);
    console.log(`  Analyze: ${asset.analyze_status} | Archive: ${asset.archive_status} | Online: ${asset.is_online}`);

    // Get technical metadata
    const techMeta = await getAssetMediaInfo(asset.id);
    if (techMeta?.metadata_values) {
      const mv = techMeta.metadata_values;
      const extract = (key: string) => {
        const val = mv[key];
        if (!val) return undefined;
        return val.field_values?.[0]?.value ?? val;
      };

      const codec = extract("mediaCodec") || extract("video_codec") || extract("codec");
      const videoCodec = extract("mediaVideoCodec") || extract("video_codec_name");
      const audioCodec = extract("mediaAudioCodec") || extract("audio_codec_name");
      const container = extract("mediaContainer") || extract("format_name") || extract("container");
      const resolution = extract("mediaResolution") || extract("resolution");
      const frameRate = extract("mediaFrameRate") || extract("frame_rate");
      const bitRate = extract("mediaBitRate") || extract("bit_rate");
      const duration = extract("mediaDuration") || extract("duration");
      const colorSpace = extract("mediaColorSpace") || extract("color_space");
      const bitDepth = extract("mediaBitDepth") || extract("bit_depth");
      const pixelFormat = extract("pixel_format");

      console.log(`  --- Technical Metadata ---`);
      if (codec) console.log(`  Codec: ${codec}`);
      if (videoCodec) console.log(`  Video Codec: ${videoCodec}`);
      if (audioCodec) console.log(`  Audio Codec: ${audioCodec}`);
      if (container) console.log(`  Container: ${container}`);
      if (resolution) console.log(`  Resolution: ${resolution}`);
      if (frameRate) console.log(`  Frame Rate: ${frameRate}`);
      if (bitRate) console.log(`  Bit Rate: ${bitRate}`);
      if (duration) console.log(`  Duration: ${duration}`);
      if (colorSpace) console.log(`  Color Space: ${colorSpace}`);
      if (bitDepth) console.log(`  Bit Depth: ${bitDepth}`);
      if (pixelFormat) console.log(`  Pixel Format: ${pixelFormat}`);

      // Dump ALL metadata keys for visibility
      const allKeys = Object.keys(mv);
      const mediaKeys = allKeys.filter(
        (k) =>
          k.toLowerCase().includes("codec") ||
          k.toLowerCase().includes("video") ||
          k.toLowerCase().includes("audio") ||
          k.toLowerCase().includes("format") ||
          k.toLowerCase().includes("resolution") ||
          k.toLowerCase().includes("frame") ||
          k.toLowerCase().includes("bit") ||
          k.toLowerCase().includes("duration") ||
          k.toLowerCase().includes("color") ||
          k.toLowerCase().includes("pixel") ||
          k.toLowerCase().includes("media") ||
          k.toLowerCase().includes("width") ||
          k.toLowerCase().includes("height") ||
          k.toLowerCase().includes("container") ||
          k.toLowerCase().includes("encoder") ||
          k.toLowerCase().includes("profile") ||
          k.toLowerCase().includes("level") ||
          k.toLowerCase().includes("scan") ||
          k.toLowerCase().includes("chroma") ||
          k.toLowerCase().includes("transfer") ||
          k.toLowerCase().includes("hdr") ||
          k.toLowerCase().includes("dolby")
      );
      if (mediaKeys.length > 0) {
        console.log(`  --- All Media-Related Metadata ---`);
        for (const k of mediaKeys) {
          const v = mv[k]?.field_values?.[0]?.value ?? JSON.stringify(mv[k]?.field_values);
          console.log(`    ${k}: ${v}`);
        }
      }
    } else {
      console.log(`  (No technical metadata found)`);
    }

    // Get proxies
    const proxies = await getAssetProxies(asset.id);
    console.log(`  --- Proxies (${proxies.length}) ---`);
    for (const p of proxies) {
      console.log(`    ${p.name || p.id}: status=${p.status}, codec=${p.codec || "?"}, res=${p.resolution || "?"}, size=${p.size || 0}`);
    }

    // Get formats
    const formats = await getAssetFormats(asset.id);
    console.log(`  --- Formats (${formats.length}) ---`);
    for (const f of formats) {
      console.log(`    ${f.name || f.id}: status=${f.status}, storage=${f.storage_id || "none"}, archive=${f.archive_status || "N/A"}`);
      if (f.metadata) {
        const fmeta = f.metadata;
        if (Object.keys(fmeta).length > 0) {
          console.log(`      format metadata: ${JSON.stringify(fmeta).slice(0, 300)}`);
        }
      }
    }

    // Get files
    const files = await getAssetFiles(asset.id);
    console.log(`  --- Files (${files.length}) ---`);
    for (const f of files) {
      console.log(`    ${f.name}: status=${f.status}, size=${f.size || 0}, storage=${f.storage_id}, dir=${f.directory_path || ""}`);
    }

    // Get recent history — look for TRANSCODE operations
    const history = await getAssetHistory(asset.id);
    const transcodeOps = history.filter(
      (h: any) => h.operation_type === "TRANSCODE" || h.operation_type === "ANALYZE"
    );
    console.log(`  --- Recent Transcode/Analyze History (${transcodeOps.length} ops) ---`);
    for (const h of transcodeOps) {
      console.log(`    ${h.operation_type}: ${h.operation_description || "no desc"} (${h.date_created})`);
      if (h.job_id) {
        const job = await getJobDetails(h.job_id);
        if (job) {
          console.log(`      Job ${h.job_id}: status=${job.status}, type=${job.type || "?"}`);
          if (job.error_message) console.log(`      ERROR: ${job.error_message}`);
          if (job.progress_message) console.log(`      Progress: ${job.progress_message}`);
          if (job.metadata) {
            const jm = JSON.stringify(job.metadata).slice(0, 500);
            console.log(`      Job metadata: ${jm}`);
          }
          // Check job steps if available
          if (job.steps && Array.isArray(job.steps)) {
            for (const step of job.steps) {
              if (step.status === "FAILED" || step.error_message) {
                console.log(`      FAILED STEP: ${step.name || step.type}: ${step.error_message || step.status}`);
              }
            }
          }
        }
      }
    }

    console.log();
    await sleep(200); // gentle rate limiting
  }

  console.log("─".repeat(80));
  console.log("Diagnosis complete.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
