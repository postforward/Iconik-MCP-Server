#!/usr/bin/env npx tsx

/**
 * verify-collection-archive-health.ts
 *
 * Scans one or more collections recursively and reports archive health.
 * For each non-ARCHIVED asset, classifies it as:
 *   - fix_metadata:  File exists on archive storage + disk, just needs status update
 *   - reset_failed:  FAILED_TO_ARCHIVE or stuck ARCHIVING, not on archive storage
 *   - stale_cache:   Collection view says non-archived but individual API says ARCHIVED
 *   - skip:          Unable to classify
 *
 * With --fix, applies automatic remediation:
 *   - fix_metadata assets: sets archive_status -> ARCHIVED, file status -> CLOSED
 *   - reset_failed assets: resets archive_status -> NOT_ARCHIVED (so they can be re-archived)
 *
 * Dry-run by default. Add --live to apply changes.
 *
 * Usage:
 *   npx tsx scripts/verify-collection-archive-health.ts --profile=tm --mount=/Volumes/mortar <collection_id> [...]
 *   npx tsx scripts/verify-collection-archive-health.ts --profile=tm --mount=/Volumes/mortar --fix --live <collection_id> [...]
 *   npx tsx scripts/verify-collection-archive-health.ts --profile=tm --mount=/Volumes/mortar --storage=MyArchive <collection_id> [...]
 */

import { iconikRequest, initializeProfile } from "../src/client.js";
import { getProfileFromArgs } from "../src/config.js";
import { existsSync } from "fs";
import { join } from "path";

// --- CLI args ---
const profileName = getProfileFromArgs();
initializeProfile(profileName);

const rawArgs = process.argv.slice(2);
const live = rawArgs.includes("--live");
const fix = rawArgs.includes("--fix");
const mountArg = rawArgs.find((a) => a.startsWith("--mount="));
const storageArg = rawArgs.find((a) => a.startsWith("--storage="));
const mountPath = mountArg?.split("=")[1];
const storageNameFilter = storageArg?.split("=")[1];
const collectionArgs = rawArgs.filter((a) => !a.startsWith("--"));

if (!mountPath || collectionArgs.length === 0) {
  console.error(
    "Usage: npx tsx scripts/verify-collection-archive-health.ts --profile=<name> --mount=<path> [--storage=<name>] [--fix] [--live] <collection_id> [...]"
  );
  console.error("");
  console.error("Options:");
  console.error("  --profile=<name>   Iconik profile to use");
  console.error("  --mount=<path>     Local mount point for archive storage");
  console.error("  --storage=<name>   Filter to a specific archive storage name (optional)");
  console.error("  --fix              Apply remediation (default: report only)");
  console.error("  --live             Execute changes when --fix is set (default: dry-run)");
  process.exit(1);
}

interface PaginatedResponse<T> {
  objects: T[];
  page: number;
  pages: number;
  per_page: number;
  total: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Storage helpers ---

const storageCache = new Map<string, any>();

async function getStorage(id: string) {
  if (storageCache.has(id)) return storageCache.get(id);
  try {
    const s = await iconikRequest<any>(`files/v1/storages/${id}/`);
    storageCache.set(id, s);
    return s;
  } catch {
    storageCache.set(id, null);
    return null;
  }
}

function isTargetArchiveStorage(storage: any): boolean {
  if (!storage || storage.purpose !== "ARCHIVE") return false;
  if (storageNameFilter && storage.name !== storageNameFilter) return false;
  return true;
}

// --- Phase 1: Scan collections ---

interface NonArchivedAsset {
  id: string;
  title: string;
  collectionStatus: string;
  collectionTitle: string;
}

async function scanCollection(
  collectionId: string,
  results: NonArchivedAsset[],
  statusCounts: Record<string, number>,
  collTitle: string,
) {
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    let resp: PaginatedResponse<any>;
    try {
      resp = await iconikRequest<PaginatedResponse<any>>(
        `assets/v1/collections/${collectionId}/contents/?page=${page}&per_page=100`
      );
    } catch {
      return;
    }
    for (const item of resp.objects || []) {
      if (item.object_type === "collections") {
        await scanCollection(item.id, results, statusCounts, collTitle);
      } else if (item.object_type === "assets") {
        const status = item.archive_status || "UNKNOWN";
        statusCounts[status] = (statusCounts[status] || 0) + 1;
        if (status !== "ARCHIVED") {
          results.push({
            id: item.id,
            title: item.title || "(no title)",
            collectionStatus: status,
            collectionTitle: collTitle,
          });
        }
      }
    }
    hasMore = resp.pages > page;
    page++;
    if (page % 5 === 0) await sleep(100);
  }
}

// --- Phase 2: Classify assets ---

interface AssetClassification {
  id: string;
  title: string;
  collectionTitle: string;
  collectionStatus: string;
  realStatus: string;
  onArchive: boolean;
  archiveFileExists: boolean;
  storages: string[];
  action: "fix_metadata" | "reset_failed" | "stale_cache" | "skip";
  formatIds: string[];
  fileUpdates: { fileId: string; name: string }[];
}

async function classifyAsset(asset: NonArchivedAsset): Promise<AssetClassification> {
  const result: AssetClassification = {
    ...asset,
    realStatus: "FETCH_ERROR",
    onArchive: false,
    archiveFileExists: false,
    storages: [],
    action: "skip",
    formatIds: [],
    fileUpdates: [],
  };

  // Get real status from individual asset fetch
  try {
    const a = await iconikRequest<any>(`assets/v1/assets/${asset.id}/`);
    result.realStatus = a.archive_status || "UNKNOWN";
  } catch {
    return result;
  }

  // If individual API says ARCHIVED, it's just stale collection cache
  if (result.realStatus === "ARCHIVED") {
    result.action = "stale_cache";
    return result;
  }

  // Get files and check storages
  try {
    const filesResp = await iconikRequest<PaginatedResponse<any>>(
      `files/v1/assets/${asset.id}/files/`
    );
    for (const f of filesResp.objects || []) {
      const storage = await getStorage(f.storage_id);
      const storageName = storage?.name || f.storage_id;
      const storagePurpose = storage?.purpose || "UNKNOWN";
      result.storages.push(`${storageName}(${storagePurpose}):${f.status}`);

      if (isTargetArchiveStorage(storage)) {
        result.onArchive = true;
        const localPath = join(mountPath, f.directory_path || "", f.name);
        if (existsSync(localPath)) {
          result.archiveFileExists = true;
        }
        if (f.status === "MISSING") {
          result.fileUpdates.push({ fileId: f.id, name: f.name });
        }
      }
    }
  } catch {}

  // Get formats
  try {
    const formatsResp = await iconikRequest<PaginatedResponse<any>>(
      `files/v1/assets/${asset.id}/formats/`
    );
    result.formatIds = (formatsResp.objects || [])
      .filter((fmt: any) => fmt.archive_status !== "ARCHIVED")
      .map((fmt: any) => fmt.id);
  } catch {}

  // Classify
  if (result.onArchive && result.archiveFileExists) {
    result.action = "fix_metadata";
  } else if (
    result.realStatus === "FAILED_TO_ARCHIVE" ||
    result.realStatus === "ARCHIVING"
  ) {
    result.action = "reset_failed";
  }

  return result;
}

// --- Phase 3: Remediate ---

async function applyFixes(classified: AssetClassification[]) {
  const prefix = live ? "" : "[DRY RUN] ";
  let totalFixed = 0;
  let totalReset = 0;
  let totalErrors = 0;

  const fixMetadata = classified.filter((a) => a.action === "fix_metadata");
  const resetFailed = classified.filter((a) => a.action === "reset_failed");

  if (fixMetadata.length > 0) {
    console.log(
      `\n--- ${prefix}Fixing metadata for ${fixMetadata.length} assets on archive storage ---\n`
    );
    for (const asset of fixMetadata) {
      try {
        if (live) {
          await iconikRequest(`assets/v1/assets/${asset.id}/`, {
            method: "PATCH",
            body: JSON.stringify({ archive_status: "ARCHIVED" }),
          });
        }
        console.log(`${prefix}Asset ${asset.id} "${asset.title}" -> ARCHIVED`);
        for (const fmtId of asset.formatIds) {
          try {
            if (live) {
              await iconikRequest(`files/v1/assets/${asset.id}/formats/${fmtId}/`, {
                method: "PATCH",
                body: JSON.stringify({ archive_status: "ARCHIVED" }),
              });
            }
            console.log(`${prefix}  Format ${fmtId} -> ARCHIVED`);
          } catch (err) {
            console.log(`  ERROR format ${fmtId}: ${err instanceof Error ? err.message : err}`);
            totalErrors++;
          }
        }
        for (const file of asset.fileUpdates) {
          try {
            if (live) {
              await iconikRequest(`files/v1/assets/${asset.id}/files/${file.fileId}/`, {
                method: "PATCH",
                body: JSON.stringify({ status: "CLOSED" }),
              });
            }
            console.log(`${prefix}  File ${file.fileId} "${file.name}" -> CLOSED`);
          } catch (err) {
            console.log(`  ERROR file ${file.fileId}: ${err instanceof Error ? err.message : err}`);
            totalErrors++;
          }
        }
        totalFixed++;
      } catch (err) {
        console.log(`  ERROR asset ${asset.id}: ${err instanceof Error ? err.message : err}`);
        totalErrors++;
      }
    }
  }

  if (resetFailed.length > 0) {
    console.log(
      `\n--- ${prefix}Resetting ${resetFailed.length} failed/stuck archives ---\n`
    );
    for (const asset of resetFailed) {
      try {
        if (live) {
          await iconikRequest(`assets/v1/assets/${asset.id}/`, {
            method: "PATCH",
            body: JSON.stringify({ archive_status: "NOT_ARCHIVED" }),
          });
        }
        console.log(
          `${prefix}Asset ${asset.id} "${asset.title}" [${asset.realStatus}] -> NOT_ARCHIVED`
        );
        console.log(`${prefix}  Storages: ${asset.storages.join(", ")}`);
        for (const fmtId of asset.formatIds) {
          try {
            if (live) {
              await iconikRequest(`files/v1/assets/${asset.id}/formats/${fmtId}/`, {
                method: "PATCH",
                body: JSON.stringify({ archive_status: "NOT_ARCHIVED" }),
              });
            }
          } catch (err) {
            console.log(`  ERROR format ${fmtId}: ${err instanceof Error ? err.message : err}`);
            totalErrors++;
          }
        }
        totalReset++;
      } catch (err) {
        console.log(`  ERROR asset ${asset.id}: ${err instanceof Error ? err.message : err}`);
        totalErrors++;
      }
    }
  }

  return { totalFixed, totalReset, totalErrors };
}

async function main() {
  console.log(`Profile: ${profileName}`);
  console.log(`Mode: ${fix ? (live ? "FIX (LIVE)" : "FIX (DRY RUN)") : "REPORT ONLY"}`);
  console.log(`Archive mount: ${mountPath}`);
  if (storageNameFilter) console.log(`Storage filter: ${storageNameFilter}`);
  console.log(`Collections: ${collectionArgs.length}\n`);

  if (!existsSync(mountPath)) {
    console.error(`ERROR: Archive storage not mounted at ${mountPath}`);
    process.exit(1);
  }

  // Phase 1: Scan all collections
  console.log("=== Scanning collections ===\n");
  const allNonArchived: NonArchivedAsset[] = [];

  for (const collId of collectionArgs) {
    let title = collId;
    try {
      const coll = await iconikRequest<any>(`assets/v1/collections/${collId}/`);
      title = coll.title || collId;
    } catch {}

    const statusCounts: Record<string, number> = {};
    const results: NonArchivedAsset[] = [];
    await scanCollection(collId, results, statusCounts, title);
    allNonArchived.push(...results);

    const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const issues = total - (statusCounts["ARCHIVED"] || 0);
    const statusStr = Object.entries(statusCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([s, c]) => `${s}=${c}`)
      .join(", ");
    const icon = issues === 0 ? "OK" : "!!";
    console.log(`[${icon}] "${title}" -- ${total} assets -- ${statusStr}`);
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique: NonArchivedAsset[] = [];
  for (const a of allNonArchived) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      unique.push(a);
    }
  }

  console.log(`\nTotal non-ARCHIVED: ${unique.length} unique assets\n`);

  if (unique.length === 0) {
    console.log("All collections are clean!");
    return;
  }

  // Phase 2: Classify each asset
  console.log("=== Classifying assets ===\n");
  const classified: AssetClassification[] = [];
  for (let i = 0; i < unique.length; i++) {
    if ((i + 1) % 5 === 0) console.log(`  Classifying ${i + 1}/${unique.length}...`);
    classified.push(await classifyAsset(unique[i]));
    if (i % 10 === 0) await sleep(50);
  }

  const fixMetadata = classified.filter((a) => a.action === "fix_metadata");
  const resetFailed = classified.filter((a) => a.action === "reset_failed");
  const staleCache = classified.filter((a) => a.action === "stale_cache");
  const skipped = classified.filter((a) => a.action === "skip");

  console.log(`\nClassification:`);
  console.log(`  Fix metadata (on archive, file exists):  ${fixMetadata.length}`);
  console.log(`  Reset failed (not on archive storage):   ${resetFailed.length}`);
  console.log(`  Stale cache (already ARCHIVED):          ${staleCache.length}`);
  console.log(`  Skip (other):                            ${skipped.length}`);

  if (staleCache.length > 0) {
    console.log(`\n--- Stale cache (no action needed) ---`);
    for (const a of staleCache) {
      console.log(`  ${a.id} "${a.title}" -- collection says ${a.collectionStatus}, API says ${a.realStatus}`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\n--- Skipped ---`);
    for (const a of skipped) {
      console.log(`  ${a.id} "${a.title}" -- status=${a.realStatus}, storages=[${a.storages.join(", ")}]`);
    }
  }

  // Phase 3: Apply fixes if requested
  if (fix && (fixMetadata.length > 0 || resetFailed.length > 0)) {
    const { totalFixed, totalReset, totalErrors } = await applyFixes(classified);

    console.log(`\n${"=".repeat(60)}`);
    console.log("SUMMARY");
    console.log("=".repeat(60));
    console.log(`Mode: ${live ? "LIVE" : "DRY RUN"}`);
    console.log(`Metadata fixed (-> ARCHIVED): ${totalFixed}`);
    console.log(`Failed/stuck reset (-> NOT_ARCHIVED): ${totalReset}`);
    console.log(`Stale cache (no action): ${staleCache.length}`);
    console.log(`Skipped: ${skipped.length}`);
    console.log(`Errors: ${totalErrors}`);
  } else if (!fix && (fixMetadata.length > 0 || resetFailed.length > 0)) {
    console.log(`\nRun with --fix [--live] to apply remediation.`);
  }
}

main().catch(console.error);
