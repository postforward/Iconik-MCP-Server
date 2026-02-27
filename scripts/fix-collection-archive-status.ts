#!/usr/bin/env npx tsx

/**
 * fix-collection-archive-status.ts
 *
 * Fixes assets that were physically archived but whose archive_status was
 * never updated in Iconik. For each affected asset the script:
 *   1. Sets asset archive_status → ARCHIVED
 *   2. Sets each format archive_status → ARCHIVED
 *   3. Sets file records with status MISSING → CLOSED (on archive storage only)
 *
 * The script discovers archive storages automatically (purpose=ARCHIVE) and
 * verifies files exist on a locally-mounted volume before making changes.
 *
 * Dry-run by default. Add --live to apply changes.
 *
 * Usage:
 *   npx tsx scripts/fix-collection-archive-status.ts --profile=<name> --mount=/mnt/archive <collection_id> [...]
 *   npx tsx scripts/fix-collection-archive-status.ts --profile=<name> --mount=/mnt/archive --live <collection_id> [...]
 *   npx tsx scripts/fix-collection-archive-status.ts --profile=<name> --mount=/mnt/archive --storage=MyArchive <collection_id> [...]
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
const mountArg = rawArgs.find((a) => a.startsWith("--mount="));
const storageArg = rawArgs.find((a) => a.startsWith("--storage="));
const mountPath = mountArg?.split("=")[1];
const storageNameFilter = storageArg?.split("=")[1];
const collectionArgs = rawArgs.filter((a) => !a.startsWith("--"));

if (!mountPath || collectionArgs.length === 0) {
  console.error(
    "Usage: npx tsx scripts/fix-collection-archive-status.ts --profile=<name> --mount=<path> [--storage=<name>] [--live] <collection_id> [...]"
  );
  console.error("");
  console.error("Options:");
  console.error("  --profile=<name>   Iconik profile to use");
  console.error("  --mount=<path>     Local mount point for archive storage");
  console.error("  --storage=<name>   Filter to a specific archive storage name (optional)");
  console.error("  --live             Apply changes (default: dry-run)");
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

// --- Phase 1: Collect non-ARCHIVED assets ---

const targets: { id: string; title: string }[] = [];

async function scanCollection(collectionId: string) {
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    let resp: PaginatedResponse<any>;
    try {
      resp = await iconikRequest<PaginatedResponse<any>>(
        `assets/v1/collections/${collectionId}/contents/?page=${page}&per_page=100`
      );
    } catch {
      return; // skip on error (some deeply nested collections 500)
    }
    for (const item of resp.objects || []) {
      if (item.object_type === "collections") {
        await scanCollection(item.id);
      } else if (item.object_type === "assets") {
        const status = item.archive_status || "UNKNOWN";
        if (status !== "ARCHIVED") {
          targets.push({ id: item.id, title: item.title || "(no title)" });
        }
      }
    }
    hasMore = resp.pages > page;
    page++;
    if (page % 5 === 0) await sleep(100);
  }
}

// --- Phase 2: Filter to assets on archive storage ---

interface AssetToFix {
  id: string;
  title: string;
  formatIds: string[];
  fileUpdates: { fileId: string; name: string }[];
}

async function classifyAsset(assetId: string): Promise<AssetToFix | null> {
  const filesResp = await iconikRequest<PaginatedResponse<any>>(
    `files/v1/assets/${assetId}/files/`
  );
  const files = filesResp.objects || [];
  if (files.length === 0) return null;

  let onArchive = false;
  const fileUpdates: { fileId: string; name: string }[] = [];

  for (const f of files) {
    const storage = await getStorage(f.storage_id);
    if (isTargetArchiveStorage(storage)) {
      // Verify file exists on the local mount
      const localPath = join(mountPath, f.directory_path || "", f.name);
      if (!existsSync(localPath)) {
        return null; // skip if file not actually on disk
      }
      onArchive = true;
      if (f.status === "MISSING") {
        fileUpdates.push({ fileId: f.id, name: f.name });
      }
    }
  }

  if (!onArchive) return null;

  // Get formats to update
  const formatsResp = await iconikRequest<PaginatedResponse<any>>(
    `files/v1/assets/${assetId}/formats/`
  );
  const formatIds = (formatsResp.objects || [])
    .filter((fmt: any) => fmt.archive_status !== "ARCHIVED")
    .map((fmt: any) => fmt.id);

  return { id: assetId, title: "", formatIds, fileUpdates };
}

// --- Phase 3: Apply fixes ---

async function processCollection(collectionId: string) {
  targets.length = 0;

  let collectionTitle = collectionId;
  try {
    const coll = await iconikRequest<any>(`assets/v1/collections/${collectionId}/`);
    collectionTitle = coll.title || collectionId;
  } catch {}

  console.log(`\n${"#".repeat(60)}`);
  console.log(`Collection: "${collectionTitle}" (${collectionId})`);
  console.log("#".repeat(60));

  console.log("\nPhase 1: Scanning for non-ARCHIVED assets...");
  await scanCollection(collectionId);
  console.log(`  Found ${targets.length} non-ARCHIVED assets`);

  if (targets.length === 0) {
    console.log("  Nothing to fix.");
    return { assets: 0, formats: 0, files: 0, errors: 0, skipped: 0 };
  }

  console.log("\nPhase 2: Filtering to assets on archive storage with local verification...");
  const toFix: AssetToFix[] = [];
  const skipped: { id: string; title: string; reason: string }[] = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if ((i + 1) % 20 === 0) console.log(`  Checking ${i + 1}/${targets.length}...`);
    try {
      const result = await classifyAsset(t.id);
      if (result) {
        result.title = t.title;
        toFix.push(result);
      } else {
        skipped.push({ id: t.id, title: t.title, reason: "not on archive storage or file missing on disk" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ id: t.id, title: t.title, reason: `error: ${msg}` });
    }
    if (i % 10 === 0) await sleep(50);
  }

  console.log(`  ${toFix.length} assets to fix`);
  if (skipped.length > 0) {
    console.log(`  ${skipped.length} assets skipped:`);
    for (const s of skipped) {
      console.log(`    SKIP ${s.id} "${s.title}": ${s.reason}`);
    }
  }

  if (toFix.length === 0) {
    return { assets: 0, formats: 0, files: 0, errors: 0, skipped: skipped.length };
  }

  console.log(`\nPhase 3: ${live ? "Applying" : "Would apply"} fixes...`);

  let assetsUpdated = 0;
  let formatsUpdated = 0;
  let filesUpdated = 0;
  let errors = 0;

  for (let i = 0; i < toFix.length; i++) {
    const asset = toFix[i];
    const prefix = live ? "" : "[DRY RUN] ";

    try {
      if (live) {
        await iconikRequest(`assets/v1/assets/${asset.id}/`, {
          method: "PATCH",
          body: JSON.stringify({ archive_status: "ARCHIVED" }),
        });
      }
      console.log(`${prefix}Asset ${asset.id} "${asset.title}" -> ARCHIVED`);
      assetsUpdated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ERROR updating asset ${asset.id}: ${msg}`);
      errors++;
      continue;
    }

    for (const fmtId of asset.formatIds) {
      try {
        if (live) {
          await iconikRequest(`files/v1/assets/${asset.id}/formats/${fmtId}/`, {
            method: "PATCH",
            body: JSON.stringify({ archive_status: "ARCHIVED" }),
          });
        }
        console.log(`${prefix}  Format ${fmtId} -> ARCHIVED`);
        formatsUpdated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ERROR updating format ${fmtId}: ${msg}`);
        errors++;
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
        filesUpdated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ERROR updating file ${file.fileId}: ${msg}`);
        errors++;
      }
    }

    if (i % 10 === 0) await sleep(50);
  }

  return { assets: assetsUpdated, formats: formatsUpdated, files: filesUpdated, errors, skipped: skipped.length };
}

async function main() {
  console.log(`Profile: ${profileName}`);
  console.log(`Mode: ${live ? "LIVE" : "DRY RUN"}`);
  console.log(`Archive mount: ${mountPath}`);
  if (storageNameFilter) console.log(`Storage filter: ${storageNameFilter}`);
  console.log(`Collections: ${collectionArgs.length}`);

  if (!existsSync(mountPath)) {
    console.error(`ERROR: Archive storage not mounted at ${mountPath}`);
    process.exit(1);
  }

  let totalAssets = 0;
  let totalFormats = 0;
  let totalFiles = 0;
  let totalErrors = 0;
  let totalSkipped = 0;

  for (const collId of collectionArgs) {
    const result = await processCollection(collId);
    totalAssets += result.assets;
    totalFormats += result.formats;
    totalFiles += result.files;
    totalErrors += result.errors;
    totalSkipped += result.skipped;
  }

  console.log("\n" + "=".repeat(60));
  console.log("GRAND TOTAL");
  console.log("=".repeat(60));
  console.log(`Mode: ${live ? "LIVE" : "DRY RUN"}`);
  console.log(`Collections processed: ${collectionArgs.length}`);
  console.log(`Assets updated: ${totalAssets}`);
  console.log(`Formats updated: ${totalFormats}`);
  console.log(`Files fixed (MISSING -> CLOSED): ${totalFiles}`);
  console.log(`Errors: ${totalErrors}`);
  console.log(`Skipped: ${totalSkipped}`);
}

main().catch(console.error);
