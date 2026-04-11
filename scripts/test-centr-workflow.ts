#!/usr/bin/env npx tsx

/**
 * TEST ARCHIVE WORKFLOW
 *
 * Runs the full archive pipeline against a hand-picked set of test assets:
 *   1. Generate keyframes (KEYFRAME_MAP) on cold-tagged videos
 *   2. Wait for keyframe jobs to finish
 *   3. Delete viewing proxies on cold assets
 *   4. Archive (transfer) format ORIGINAL to destination cold/archive storage
 *
 * Reports results at every phase. Dry-run by default.
 *
 * Usage:
 *   npx tsx scripts/test-centr-workflow.ts --profile=<name> --config=<json> [--live] [--poll-interval=15]
 *
 * Config JSON shape:
 *   {
 *     "source_storage_id": "<uuid>",
 *     "cold_storage_id": "<uuid>",
 *     "assets": [
 *       { "tier": "cold", "type": "video", "id": "<uuid>", "title": "..." },
 *       ...
 *     ]
 *   }
 */

import { readFileSync } from "fs";
import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2);
const dryRun = !args.includes("--live");
const pollInterval = parseInt(args.find(a => a.startsWith("--poll-interval="))?.split("=")[1] || "15");
const configArg = args.find(a => a.startsWith("--config="))?.split("=").slice(1).join("=");

if (!configArg) {
  console.error("Required: --config=<path to JSON config file>");
  process.exit(1);
}

interface TestAsset {
  tier: "cold" | "warm";
  type: "video" | "image";
  id: string;
  title: string;
}

interface TestConfig {
  source_storage_id: string;
  cold_storage_id: string;
  assets: TestAsset[];
}

const config: TestConfig = JSON.parse(readFileSync(configArg, "utf-8"));
const STORAGE_SOURCE = config.source_storage_id;
const STORAGE_COLD = config.cold_storage_id;
const TEST_ASSETS: TestAsset[] = config.assets;

interface PaginatedResponse<T> {
  objects: T[];
  total: number;
  page: number;
  pages: number;
}

interface AssetFile { id: string; name: string; status: string; }
interface AssetFormat { id: string; name: string; status: string; }
interface FileSet { id: string; name: string; status: string; storage_id: string; format_id: string; }
interface Keyframe { id: string; type: string; }
interface Proxy { id: string; name: string; }
interface Job { id: string; status: string; progress: number; error_message: string | null; }

async function apiRequest<T = unknown>(
  endpoint: string,
  options: Parameters<typeof iconikRequest>[1] = {}
): Promise<T> {
  const maxRetries = 5;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await iconikRequest<T>(endpoint, options);
    } catch (e: any) {
      if (e.message?.includes("429") && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Max retries exceeded");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Get the ORIGINAL format ID for an asset (used for archive endpoint) */
async function getOriginalFormatId(assetId: string): Promise<string | null> {
  const formats = await apiRequest<PaginatedResponse<AssetFormat>>(
    `files/v1/assets/${assetId}/formats/?per_page=50`
  );
  const original = formats.objects?.find(f => f.name === "ORIGINAL" && f.status === "ACTIVE");
  return original?.id || null;
}

/** Get the ORIGINAL file ID for an asset */
async function getOriginalFileId(assetId: string): Promise<string | null> {
  const formats = await apiRequest<PaginatedResponse<AssetFormat>>(
    `files/v1/assets/${assetId}/formats/?per_page=50`
  );
  const original = formats.objects?.find(f => f.name === "ORIGINAL" && f.status === "ACTIVE");
  if (!original) return null;

  const fileSets = await apiRequest<PaginatedResponse<FileSet>>(
    `files/v1/assets/${assetId}/formats/${original.id}/file_sets/?per_page=10`
  );
  for (const fs of fileSets.objects || []) {
    const files = await apiRequest<PaginatedResponse<AssetFile>>(
      `files/v1/assets/${assetId}/file_sets/${fs.id}/files/?per_page=10`
    );
    const closed = files.objects?.find(f => f.status === "CLOSED");
    if (closed) return closed.id;
  }
  return null;
}

/** Get the ORIGINAL file_set on the source storage */
async function getOriginalFileSet(assetId: string): Promise<FileSet | null> {
  const formats = await apiRequest<PaginatedResponse<AssetFormat>>(
    `files/v1/assets/${assetId}/formats/?per_page=50`
  );
  const original = formats.objects?.find(f => f.name === "ORIGINAL" && f.status === "ACTIVE");
  if (!original) return null;

  const fileSets = await apiRequest<PaginatedResponse<FileSet>>(
    `files/v1/assets/${assetId}/formats/${original.id}/file_sets/?per_page=10`
  );
  // Prefer file_set on the configured source storage
  const onSource = fileSets.objects?.find(fs => fs.storage_id === STORAGE_SOURCE && fs.status === "ACTIVE");
  return onSource || fileSets.objects?.[0] || null;
}

/** Check if asset already has a KEYFRAME_MAP */
async function hasKeyframeMap(assetId: string): Promise<boolean> {
  try {
    const kfs = await apiRequest<PaginatedResponse<Keyframe>>(
      `files/v1/assets/${assetId}/keyframes/`
    );
    return (kfs.objects || []).some(k => k.type === "KEYFRAME_MAP");
  } catch {
    return false;
  }
}

/** Submit keyframe generation, returns job_id */
async function submitKeyframes(assetId: string, fileId: string): Promise<string> {
  const result = await apiRequest<{ job_id: string }>(
    `files/v1/assets/${assetId}/files/${fileId}/keyframes/`,
    { method: "POST" }
  );
  return result.job_id;
}

/** Poll job status, return final state. SKIPPED counts as a terminal/successful state. */
async function waitForJob(jobId: string, label: string): Promise<"FINISHED" | "FAILED" | "SKIPPED"> {
  while (true) {
    await sleep(pollInterval * 1000);
    try {
      const status = await apiRequest<Job>(`jobs/v1/jobs/${jobId}/`);
      if (status.status === "FINISHED") return "FINISHED";
      if (status.status === "SKIPPED") return "SKIPPED";
      if (status.status === "FAILED" || status.status === "ABORTED") {
        console.log(`    [${label}] FAILED: ${status.error_message || status.status}`);
        return "FAILED";
      }
      process.stderr.write(`    [${label}] ${status.status} ${status.progress || 0}%\r`);
    } catch (e) {
      // Job API may be inaccessible — assume done after one cycle
      console.log(`    [${label}] (job API unreachable, continuing)`);
      return "FINISHED";
    }
  }
}

/** Delete all viewing proxies on an asset */
async function deleteProxies(assetId: string): Promise<number> {
  const proxies = await apiRequest<PaginatedResponse<Proxy>>(
    `files/v1/assets/${assetId}/proxies/`
  );
  let deleted = 0;
  for (const proxy of proxies.objects || []) {
    try {
      await apiRequest(`files/v1/assets/${assetId}/proxies/${proxy.id}/`, { method: "DELETE" });
      deleted++;
    } catch (e) {
      console.log(`    [PROXY] failed to delete ${proxy.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return deleted;
}

/** Archive a format (ORIGINAL) to an archive storage. Returns job_id. */
async function archiveFormat(assetId: string, formatId: string, destStorageId: string): Promise<string> {
  const result = await apiRequest<{ job_id: string; success?: string }>(
    `files/v1/assets/${assetId}/formats/${formatId}/archive/`,
    {
      method: "POST",
      body: JSON.stringify({ storage_id: destStorageId }),
    }
  );
  return result.job_id;
}

interface PhaseResult {
  asset: TestAsset;
  fileId?: string;
  fileSetId?: string;
  formatId?: string;
  hadKeyframes?: boolean;
  keyframeJobId?: string;
  keyframeStatus?: "FINISHED" | "FAILED" | "SKIPPED" | "SKIPPED_PRECHECK";
  proxiesDeleted?: number;
  archiveJobId?: string;
  archiveTriggered?: boolean;
  errors: string[];
}

async function main() {
  const profile = getCurrentProfileInfo();
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("ARCHIVE WORKFLOW — TEST RUN");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`Profile:   ${profile.name}`);
  console.log(`Mode:      ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Assets:    ${TEST_ASSETS.length} cold videos`);
  console.log("");

  const results = new Map<string, PhaseResult>();
  for (const asset of TEST_ASSETS) {
    results.set(asset.id, { asset, errors: [] });
  }

  // ─── Phase 0: Discover file IDs and format IDs ──────────────────────────
  console.log("─── Phase 0: Discover files ────────────────────────────────────────");
  for (const asset of TEST_ASSETS) {
    const r = results.get(asset.id)!;
    try {
      const [fileId, fileSet, formatId] = await Promise.all([
        getOriginalFileId(asset.id),
        getOriginalFileSet(asset.id),
        getOriginalFormatId(asset.id),
      ]);
      r.fileId = fileId || undefined;
      r.fileSetId = fileSet?.id;
      r.formatId = formatId || undefined;
      const sourceMark = fileSet?.storage_id === STORAGE_SOURCE ? "✓ source" : `(storage ${fileSet?.storage_id?.slice(0, 8)}...)`;
      console.log(`  [${asset.tier.padEnd(4)} ${asset.type.padEnd(5)}] ${asset.title.slice(0, 40).padEnd(40)} fmt=${formatId?.slice(0, 8) || "?"} file=${fileId?.slice(0, 8) || "?"} ${sourceMark}`);
      if (!fileId) r.errors.push("no original file");
      if (!formatId) r.errors.push("no format id");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      r.errors.push(`discover: ${msg}`);
      console.log(`  [${asset.tier.padEnd(4)} ${asset.type.padEnd(5)}] ${asset.title.slice(0, 40).padEnd(40)} ERROR: ${msg}`);
    }
  }
  console.log("");

  // ─── Phase 1: Submit keyframe jobs (cold videos only) ───────────────────
  console.log("─── Phase 1: Submit keyframes (cold videos) ────────────────────────");
  const coldVideos = TEST_ASSETS.filter(a => a.tier === "cold" && a.type === "video");
  for (const asset of coldVideos) {
    const r = results.get(asset.id)!;
    if (!r.fileId) {
      r.keyframeStatus = "SKIPPED";
      console.log(`  [SKIP] ${asset.title} — no file id`);
      continue;
    }

    const had = await hasKeyframeMap(asset.id);
    r.hadKeyframes = had;
    if (had) {
      r.keyframeStatus = "SKIPPED";
      console.log(`  [SKIP] ${asset.title} — already has KEYFRAME_MAP`);
      continue;
    }

    if (dryRun) {
      console.log(`  [DRY] ${asset.title} — would submit keyframes`);
      continue;
    }

    try {
      const jobId = await submitKeyframes(asset.id, r.fileId);
      r.keyframeJobId = jobId;
      console.log(`  [SUBMIT] ${asset.title} → ${jobId.slice(0, 12)}...`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      r.errors.push(`keyframes: ${msg}`);
      console.log(`  [ERROR] ${asset.title}: ${msg}`);
    }
  }
  console.log("");

  // ─── Phase 2: Wait for keyframe jobs ────────────────────────────────────
  if (!dryRun) {
    const pendingJobs = coldVideos
      .map(a => results.get(a.id)!)
      .filter(r => r.keyframeJobId);

    if (pendingJobs.length > 0) {
      console.log(`─── Phase 2: Wait for ${pendingJobs.length} keyframe jobs ──────────────────`);
      for (const r of pendingJobs) {
        const status = await waitForJob(r.keyframeJobId!, r.asset.title.slice(0, 30));
        r.keyframeStatus = status;
        console.log(`  [${status === "FINISHED" ? "DONE" : "FAIL"}] ${r.asset.title}`);
      }
      console.log("");
    }
  }

  // ─── Phase 3: Delete viewing proxies on cold ────────────────────────────
  console.log("─── Phase 3: Delete viewing proxies (cold only) ────────────────────");
  const coldAssets = TEST_ASSETS.filter(a => a.tier === "cold");
  for (const asset of coldAssets) {
    const r = results.get(asset.id)!;
    if (dryRun) {
      console.log(`  [DRY] ${asset.title} — would delete viewing proxies`);
      continue;
    }
    try {
      const deleted = await deleteProxies(asset.id);
      r.proxiesDeleted = deleted;
      console.log(`  [${deleted > 0 ? "DELETED" : "NONE"}] ${asset.title} — ${deleted} proxies`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      r.errors.push(`proxies: ${msg}`);
      console.log(`  [ERROR] ${asset.title}: ${msg}`);
    }
  }
  console.log("");

  // ─── Phase 4: Archive ORIGINAL format to cold storage ──────────────────
  console.log("─── Phase 4: Archive to cold storage ───────────────────────────────");
  for (const asset of TEST_ASSETS) {
    const r = results.get(asset.id)!;
    if (!r.formatId) {
      console.log(`  [SKIP] ${asset.title} — no format id`);
      continue;
    }

    if (dryRun) {
      console.log(`  [DRY] ${asset.title} → cold storage`);
      continue;
    }

    try {
      const jobId = await archiveFormat(asset.id, r.formatId, STORAGE_COLD);
      r.archiveJobId = jobId;
      r.archiveTriggered = true;
      console.log(`  [ARCHIVE] ${asset.title} → ${jobId.slice(0, 12)}...`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      r.errors.push(`archive: ${msg}`);
      console.log(`  [ERROR] ${asset.title}: ${msg}`);
    }
  }
  console.log("");

  // ─── Summary ────────────────────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("══════════════════════════════════════════════════════════════════════");
  for (const r of results.values()) {
    const status = r.errors.length === 0 ? "OK" : "ERR";
    console.log(`  [${status}] [${r.asset.tier.padEnd(4)} ${r.asset.type.padEnd(5)}] ${r.asset.title}`);
    if (r.keyframeStatus) console.log(`         keyframes: ${r.keyframeStatus}${r.hadKeyframes ? " (already had)" : ""}`);
    if (r.proxiesDeleted !== undefined) console.log(`         proxies deleted: ${r.proxiesDeleted}`);
    if (r.archiveTriggered) console.log(`         archive: queued (job ${r.archiveJobId?.slice(0, 12)}...)`);
    if (r.errors.length > 0) {
      for (const err of r.errors) console.log(`         ! ${err}`);
    }
  }

  const okCount = [...results.values()].filter(r => r.errors.length === 0).length;
  console.log("");
  console.log(`Total: ${TEST_ASSETS.length}, OK: ${okCount}, with errors: ${TEST_ASSETS.length - okCount}`);
  console.log("══════════════════════════════════════════════════════════════════════");
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
