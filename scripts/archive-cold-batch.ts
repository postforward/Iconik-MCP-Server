#!/usr/bin/env npx tsx

/**
 * BATCH ARCHIVE COLD-TAGGED ASSETS
 *
 * Production-grade batch script that:
 *   1. Discovers all video assets under tagged-cold collections
 *   2. Processes them in parallel batches:
 *      a. Generate KEYFRAME_MAP via /files/v1/.../keyframes/
 *      b. Wait for keyframe jobs
 *      c. Delete viewing proxies (cold = browse-only via thumbnails)
 *      d. Archive ORIGINAL format to destination cold storage
 *      e. Wait for archive jobs
 *   3. Persists state per asset so the run is resumable
 *   4. Posts progress to Google Chat webhook
 *   5. Skips already-processed assets on re-run
 *
 * Usage:
 *   npx tsx scripts/archive-cold-batch.ts \
 *     --profile=<name> \
 *     --config=<json> \
 *     --state=<json> \
 *     [--live] [--concurrency=10] [--poll-interval=15] [--rediscover] [--reset]
 *
 * Config JSON shape:
 *   {
 *     "source_storage_id": "<uuid>",
 *     "cold_storage_id": "<uuid>",
 *     "tagged_collections": [{ "id": "<uuid>", "title": "..." }],
 *     "video_extensions": [".mov", ".mp4", ...]   // optional
 *   }
 *
 * Environment:
 *   GCHAT_WEBHOOK_URL  Google Chat webhook for progress notifications (optional)
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

// ─── Args ───────────────────────────────────────────────────────────────
const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2);
const dryRun = !args.includes("--live");
const rediscover = args.includes("--rediscover");
const reset = args.includes("--reset");
const retryFailed = args.includes("--retry-failed");
const concurrency = parseInt(args.find(a => a.startsWith("--concurrency="))?.split("=")[1] || "10");
const pollInterval = parseInt(args.find(a => a.startsWith("--poll-interval="))?.split("=")[1] || "15");
const configArg = args.find(a => a.startsWith("--config="))?.split("=").slice(1).join("=");
const stateArg = args.find(a => a.startsWith("--state="))?.split("=").slice(1).join("=") || "./archive-state.json";

if (!configArg) {
  console.error("Required: --config=<path to JSON config file>");
  process.exit(1);
}

const GCHAT_WEBHOOK_URL = process.env.GCHAT_WEBHOOK_URL;

// ─── Types ──────────────────────────────────────────────────────────────
interface TaggedCollection { id: string; title: string; }
interface BatchConfig {
  source_storage_id: string;
  cold_storage_id: string;
  tagged_collections: TaggedCollection[];
  video_extensions?: string[];
}

const config: BatchConfig = JSON.parse(readFileSync(configArg, "utf-8"));
const VIDEO_EXTS = config.video_extensions || [".mov", ".mp4", ".mxf", ".m4v", ".avi", ".mkv", ".prores", ".braw", ".r3d"];

type AssetStatus =
  | "PENDING"
  | "KEYFRAMES_DONE"
  | "PROXY_DELETED"
  | "ARCHIVED"
  | "FAILED";

interface AssetState {
  id: string;
  title: string;
  collection_title: string;
  format_id?: string;
  file_id?: string;
  status: AssetStatus;
  keyframe_job_id?: string;
  archive_job_id?: string;
  error?: string;
  updated_at: string;
}

interface BatchState {
  started_at: string;
  last_updated: string;
  config_path: string;
  /** Collection IDs that have been fully walked (recursively). Used to skip on resume. */
  visited_collections: string[];
  stats: {
    discovered: number;
    pending: number;
    keyframes_done: number;
    proxy_deleted: number;
    archived: number;
    failed: number;
  };
  assets: Record<string, AssetState>;
}

// ─── State management ──────────────────────────────────────────────────
function loadState(): BatchState | null {
  if (!existsSync(stateArg)) return null;
  try {
    return JSON.parse(readFileSync(stateArg, "utf-8"));
  } catch {
    return null;
  }
}

function saveState(state: BatchState): void {
  state.last_updated = new Date().toISOString();
  recomputeStats(state);
  const tmp = stateArg + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateArg);
}

function recomputeStats(state: BatchState): void {
  const stats = { discovered: 0, pending: 0, keyframes_done: 0, proxy_deleted: 0, archived: 0, failed: 0 };
  for (const a of Object.values(state.assets)) {
    stats.discovered++;
    if (a.status === "PENDING") stats.pending++;
    else if (a.status === "KEYFRAMES_DONE") stats.keyframes_done++;
    else if (a.status === "PROXY_DELETED") stats.proxy_deleted++;
    else if (a.status === "ARCHIVED") stats.archived++;
    else if (a.status === "FAILED") stats.failed++;
  }
  state.stats = stats;
}

function newState(): BatchState {
  return {
    started_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    config_path: configArg!,
    visited_collections: [],
    stats: { discovered: 0, pending: 0, keyframes_done: 0, proxy_deleted: 0, archived: 0, failed: 0 },
    assets: {},
  };
}

// ─── Graceful shutdown flag (defined early so discovery can check it) ──
let shouldStop = false;
process.on("SIGINT", () => {
  console.log("\n\nReceived SIGINT — finishing current batch then stopping...");
  shouldStop = true;
});
process.on("SIGTERM", () => {
  console.log("\n\nReceived SIGTERM — finishing current batch then stopping...");
  shouldStop = true;
});

// ─── Iconik API helpers ────────────────────────────────────────────────
interface PaginatedResponse<T> { objects: T[]; total: number; page: number; pages: number; }
interface CollectionContent { id: string; title: string; object_type: string; }
interface AssetFile { id: string; name: string; status: string; }
interface AssetFormat { id: string; name: string; status: string; }
interface FileSet { id: string; status: string; storage_id: string; format_id: string; }
interface Keyframe { id: string; type: string; }
interface Proxy { id: string; }
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
      const msg = e.message || String(e);
      const isRetriable =
        msg.includes("429") ||
        msg.includes("fetch failed") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ENOTFOUND") ||
        /\b5\d\d\b/.test(msg); // any 5xx
      if (isRetriable && attempt < maxRetries) {
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
  return new Promise(r => setTimeout(r, ms));
}

async function parallelMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit: number): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function getCollectionContents(colId: string): Promise<CollectionContent[]> {
  const all: CollectionContent[] = [];
  let page = 1;
  while (true) {
    const res = await apiRequest<PaginatedResponse<CollectionContent>>(
      `assets/v1/collections/${colId}/contents/?per_page=100&page=${page}`
    );
    all.push(...(res.objects || []));
    if (res.pages <= page) break;
    page++;
  }
  return all;
}

/**
 * Incrementally walk a collection tree, adding video assets to state and marking
 * each subcollection as visited as soon as it's done. Saves state periodically so
 * the discovery is resumable. Returns the count of newly added assets.
 */
async function walkAndCollect(
  rootColId: string,
  rootTitle: string,
  state: BatchState,
): Promise<number> {
  const visitedSet = new Set(state.visited_collections);
  let added = 0;
  let walkedSinceSave = 0;
  const SAVE_EVERY = 50; // save state every 50 sub-collections walked

  async function walk(colId: string): Promise<void> {
    if (visitedSet.has(colId)) return;
    if (shouldStop) return;

    const contents = await getCollectionContents(colId);
    const subcols = contents.filter(c => c.object_type === "collections");
    const assets = contents.filter(c => c.object_type === "assets");

    // Add video assets immediately
    const now = new Date().toISOString();
    for (const asset of assets) {
      if (state.assets[asset.id]) continue; // already known
      if (!asset.title) continue; // skip assets with no title
      const lower = asset.title.toLowerCase();
      if (VIDEO_EXTS.some(ext => lower.endsWith(ext))) {
        state.assets[asset.id] = {
          id: asset.id,
          title: asset.title,
          collection_title: rootTitle,
          status: "PENDING",
          updated_at: now,
        };
        added++;
      }
    }

    // Walk children depth-first
    for (const sub of subcols) {
      if (shouldStop) return;
      await walk(sub.id);
    }

    // Mark this collection as fully walked
    visitedSet.add(colId);
    walkedSinceSave++;

    if (walkedSinceSave >= SAVE_EVERY) {
      state.visited_collections = [...visitedSet];
      saveState(state);
      process.stderr.write(`    [discovery] saved state (visited ${visitedSet.size} folders, ${added} new assets)\r`);
      walkedSinceSave = 0;
    }
  }

  await walk(rootColId);

  // Final save for this root
  state.visited_collections = [...visitedSet];
  saveState(state);
  return added;
}

async function getOriginalFormatAndFile(assetId: string): Promise<{ formatId: string; fileId: string } | null> {
  const formats = await apiRequest<PaginatedResponse<AssetFormat>>(
    `files/v1/assets/${assetId}/formats/?per_page=50`
  );
  const original = formats.objects?.find(f => f.name === "ORIGINAL" && f.status === "ACTIVE");
  if (!original) return null;

  const fileSets = await apiRequest<PaginatedResponse<FileSet>>(
    `files/v1/assets/${assetId}/formats/${original.id}/file_sets/?per_page=10`
  );
  const onSource = fileSets.objects?.find(fs =>
    fs.storage_id === config.source_storage_id && fs.status === "ACTIVE"
  );
  const fileSet = onSource || fileSets.objects?.[0];
  if (!fileSet) return null;

  const files = await apiRequest<PaginatedResponse<AssetFile>>(
    `files/v1/assets/${assetId}/file_sets/${fileSet.id}/files/?per_page=10`
  );
  const closed = files.objects?.find(f => f.status === "CLOSED");
  if (!closed) return null;

  return { formatId: original.id, fileId: closed.id };
}

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

async function submitKeyframes(assetId: string, fileId: string): Promise<string> {
  const result = await apiRequest<{ job_id: string }>(
    `files/v1/assets/${assetId}/files/${fileId}/keyframes/`,
    { method: "POST" }
  );
  return result.job_id;
}

async function waitForJob(jobId: string): Promise<"FINISHED" | "FAILED" | "SKIPPED"> {
  while (true) {
    await sleep(pollInterval * 1000);
    try {
      const status = await apiRequest<Job>(`jobs/v1/jobs/${jobId}/`);
      if (status.status === "FINISHED") return "FINISHED";
      if (status.status === "SKIPPED") return "SKIPPED";
      if (status.status === "FAILED" || status.status === "ABORTED") return "FAILED";
    } catch {
      return "FINISHED"; // job API unreachable, assume done
    }
  }
}

async function deleteProxies(assetId: string): Promise<number> {
  const proxies = await apiRequest<PaginatedResponse<Proxy>>(
    `files/v1/assets/${assetId}/proxies/`
  );
  let deleted = 0;
  for (const proxy of proxies.objects || []) {
    try {
      await apiRequest(`files/v1/assets/${assetId}/proxies/${proxy.id}/`, { method: "DELETE" });
      deleted++;
    } catch { /* ignore */ }
  }
  return deleted;
}

async function archiveFormat(assetId: string, formatId: string, destStorageId: string): Promise<string> {
  const result = await apiRequest<{ job_id: string }>(
    `files/v1/assets/${assetId}/formats/${formatId}/archive/`,
    {
      method: "POST",
      body: JSON.stringify({ storage_id: destStorageId }),
    }
  );
  return result.job_id;
}

// ─── Google Chat notifications ─────────────────────────────────────────
async function notify(text: string): Promise<void> {
  if (!GCHAT_WEBHOOK_URL) return;
  try {
    await fetch(GCHAT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error(`  [gchat] failed: ${e instanceof Error ? e.message : e}`);
  }
}

function statsLine(state: BatchState): string {
  const s = state.stats;
  return `discovered: ${s.discovered} | archived: ${s.archived} | pending: ${s.pending} | failed: ${s.failed}`;
}

// ─── Discovery phase ───────────────────────────────────────────────────
async function discover(state: BatchState): Promise<void> {
  console.log("─── Discovery: walking tagged-cold collections ─────────────────────");
  const visitedSet = new Set(state.visited_collections);

  for (const col of config.tagged_collections) {
    if (shouldStop) {
      console.log("\n[discovery] interrupted, will resume on next run");
      return;
    }

    if (visitedSet.has(col.id)) {
      console.log(`  ${col.title} ... already walked (skipping)`);
      continue;
    }

    process.stdout.write(`  walking ${col.title} ... `);
    const startCount = Object.keys(state.assets).length;
    const added = await walkAndCollect(col.id, col.title, state);
    process.stderr.write("\r" + " ".repeat(80) + "\r");
    const totalNow = Object.keys(state.assets).length;
    console.log(`  ${col.title} ... ${added} new videos (total in state: ${totalNow})`);
  }

  console.log(`\nDiscovery complete: ${Object.keys(state.assets).length} total assets in state.`);
  saveState(state);
}

// ─── Per-asset processing pipeline ─────────────────────────────────────
async function processAsset(asset: AssetState, state: BatchState): Promise<void> {
  const now = () => { asset.updated_at = new Date().toISOString(); };

  try {
    // Step 1: discover format/file (if not already known)
    if (!asset.format_id || !asset.file_id) {
      const ff = await getOriginalFormatAndFile(asset.id);
      if (!ff) {
        asset.status = "FAILED";
        asset.error = "no original file/format";
        now();
        return;
      }
      asset.format_id = ff.formatId;
      asset.file_id = ff.fileId;
    }

    // Step 2: keyframes (skip if already done)
    if (asset.status === "PENDING") {
      const had = await hasKeyframeMap(asset.id);
      if (had) {
        asset.status = "KEYFRAMES_DONE";
        now();
      } else {
        if (dryRun) {
          asset.status = "KEYFRAMES_DONE";
          now();
        } else {
          const jobId = await submitKeyframes(asset.id, asset.file_id);
          asset.keyframe_job_id = jobId;
          now();
          const result = await waitForJob(jobId);
          if (result === "FAILED") {
            asset.status = "FAILED";
            asset.error = "keyframe job failed";
            now();
            return;
          }
          asset.status = "KEYFRAMES_DONE";
          now();
        }
      }
    }

    // Step 3: delete viewing proxies
    if (asset.status === "KEYFRAMES_DONE") {
      if (!dryRun) {
        await deleteProxies(asset.id);
      }
      asset.status = "PROXY_DELETED";
      now();
    }

    // Step 4: archive ORIGINAL format → cold storage
    if (asset.status === "PROXY_DELETED") {
      if (dryRun) {
        asset.status = "ARCHIVED";
        now();
      } else {
        const jobId = await archiveFormat(asset.id, asset.format_id, config.cold_storage_id);
        asset.archive_job_id = jobId;
        now();
        const result = await waitForJob(jobId);
        if (result === "FAILED") {
          asset.status = "FAILED";
          asset.error = "archive job failed";
          now();
          return;
        }
        asset.status = "ARCHIVED";
        now();
      }
    }
  } catch (e) {
    asset.status = "FAILED";
    asset.error = e instanceof Error ? e.message : String(e);
    now();
  }
}

// ─── Main loop ─────────────────────────────────────────────────────────
async function main() {
  const profile = getCurrentProfileInfo();

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("BATCH ARCHIVE COLD ASSETS");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`Profile:     ${profile.name}`);
  console.log(`Mode:        ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`State file:  ${stateArg}`);
  console.log(`gchat:       ${GCHAT_WEBHOOK_URL ? "enabled" : "disabled (set GCHAT_WEBHOOK_URL)"}`);
  console.log("");

  // Load or create state
  let state = loadState();
  if (reset || !state) {
    if (state && reset) console.log("Resetting state (--reset)\n");
    state = newState();
  } else {
    console.log(`Resuming from state file. Stats: ${statsLine(state)}\n`);
  }

  // Reset FAILED assets back to PENDING so they get retried
  if (retryFailed) {
    let resetCount = 0;
    for (const a of Object.values(state.assets)) {
      if (a.status === "FAILED") {
        a.status = "PENDING";
        a.error = undefined;
        a.updated_at = new Date().toISOString();
        resetCount++;
      }
    }
    if (resetCount > 0) {
      console.log(`--retry-failed: reset ${resetCount} FAILED assets back to PENDING\n`);
      saveState(state);
    }
  }

  // Discovery (always run; it skips already-walked collections via visited_collections)
  // Use --rediscover to clear visited list and re-walk everything
  if (rediscover) {
    console.log("--rediscover: clearing visited collection list\n");
    state.visited_collections = [];
  }

  const remainingTopLevels = config.tagged_collections.filter(
    c => !state.visited_collections.includes(c.id)
  );
  if (remainingTopLevels.length > 0) {
    await discover(state);
  } else {
    console.log(`All ${config.tagged_collections.length} top-level collections already walked. ${Object.keys(state.assets).length} assets in state.\n`);
  }

  if (shouldStop) {
    console.log("Stopped during discovery. Re-run to resume.");
    return;
  }

  // Get pending work
  const pending = Object.values(state.assets).filter(a =>
    a.status !== "ARCHIVED" && a.status !== "FAILED"
  );

  if (pending.length === 0) {
    console.log("No pending work — all assets are archived or failed.");
    await notify(`Cold archive batch: nothing to do. ${statsLine(state)}`);
    return;
  }

  console.log(`Pending: ${pending.length} assets, processing in batches of ${concurrency}`);
  console.log("");

  await notify(
    `🚀 Cold archive batch ${dryRun ? "(DRY RUN)" : "STARTED"}\n` +
    `Profile: ${profile.name} | Concurrency: ${concurrency}\n` +
    `${statsLine(state)}`
  );

  let batchNumber = 0;
  while (pending.length > 0 && !shouldStop) {
    batchNumber++;
    const batch = pending.splice(0, concurrency);

    const batchStart = Date.now();
    console.log(`─── Batch ${batchNumber} (${batch.length} assets) ──────────────────────────────`);

    await parallelMap(
      batch,
      async (asset) => {
        process.stdout.write(`  [${asset.status.padEnd(15)}] ${asset.title.slice(0, 50)}\n`);
        await processAsset(asset, state);
        const icon = asset.status === "ARCHIVED" ? "✓"
          : asset.status === "FAILED" ? "✗"
          : "·";
        process.stdout.write(`  ${icon} ${asset.status.padEnd(15)} ${asset.title.slice(0, 50)}\n`);
      },
      concurrency,
    );

    saveState(state);
    const elapsed = ((Date.now() - batchStart) / 1000).toFixed(1);

    console.log(`  Batch ${batchNumber} done in ${elapsed}s. ${statsLine(state)}\n`);

    // Check for failures in this batch
    const batchFailed = batch.filter(a => a.status === "FAILED");
    if (batchFailed.length > 0) {
      const failedList = batchFailed.map(a => `  • ${a.title}: ${a.error}`).join("\n");
      await notify(
        `⚠️ Batch ${batchNumber}: ${batchFailed.length} failed\n${failedList}\n${statsLine(state)}`
      );
    } else {
      await notify(
        `📦 Batch ${batchNumber} done in ${elapsed}s\n${statsLine(state)}`
      );
    }
  }

  // Final summary
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("FINAL");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`Discovered:    ${state.stats.discovered}`);
  console.log(`Archived:      ${state.stats.archived}`);
  console.log(`Pending:       ${state.stats.pending}`);
  console.log(`Failed:        ${state.stats.failed}`);
  console.log("");

  if (shouldStop) {
    console.log("Stopped by signal. Re-run to resume.");
    await notify(`⏸️ Cold archive batch STOPPED. ${statsLine(state)}`);
  } else if (state.stats.pending > 0) {
    console.log("Some assets still pending (shouldn't happen — check logs).");
  } else {
    console.log("All done!");
    await notify(`✅ Cold archive batch COMPLETE.\n${statsLine(state)}`);
  }
}

main().catch(async (e) => {
  console.error("Fatal error:", e);
  await notify(`💥 Cold archive batch CRASHED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
