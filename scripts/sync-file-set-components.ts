#!/usr/bin/env npx tsx

/**
 * sync-file-set-components.ts
 *
 * Proactive maintenance script that scans a storage for file sets whose
 * component_ids are out of sync with their format's current components.
 * This mismatch is the #1 cause of "Files components differ between source
 * and destination" errors during Iconik archive jobs.
 *
 * Scans CLOSED files on the target storage, groups by asset, then compares
 * each file set's component_ids against the format's actual components.
 * Mismatches are fixed by PATCHing the file set with current component_ids.
 *
 * Usage:
 *   npx tsx scripts/sync-file-set-components.ts --profile=<name> --storage=<name>
 *   npx tsx scripts/sync-file-set-components.ts --profile=<name> --storage=<name> --live
 *   npx tsx scripts/sync-file-set-components.ts --profile=<name> --storage=<name> --live --json
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.js";
import { getProfileFromArgs } from "../src/config.js";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const rawArgs = process.argv.slice(2);
const isLive = rawArgs.includes("--live");
const jsonOutput = rawArgs.includes("--json");
const CONCURRENCY = 10;

function getArgValue(prefix: string): string | undefined {
  const arg = rawArgs.find((a) => a.startsWith(prefix));
  return arg?.split("=")[1];
}

const storageName = getArgValue("--storage=");

if (!storageName) {
  console.error("Usage: npx tsx scripts/sync-file-set-components.ts --profile=<name> --storage=<name> [options]");
  console.error("");
  console.error("Options:");
  console.error("  --storage=NAME   Storage to scan (REQUIRED)");
  console.error("  --live           Apply fixes (default: dry-run)");
  console.error("  --json           Output results as JSON");
  process.exit(1);
}

// --- Types ---

interface PaginatedResponse<T> {
  objects: T[];
  total?: number;
  pages?: number;
}

interface FileRecord {
  id: string;
  name: string;
  asset_id: string;
  storage_id: string;
  status: string;
  file_set_id?: string;
  format_id?: string;
}

interface FileSet {
  id: string;
  name: string;
  storage_id: string;
  format_id: string;
  component_ids: string[];
  asset_id?: string;
}

interface Component {
  id: string;
  name: string;
  type: string;
}

interface Storage {
  id: string;
  name: string;
}

interface FixResult {
  assetId: string;
  fileSetId: string;
  formatId: string;
  oldComponentCount: number;
  newComponentCount: number;
  fixed: boolean;
  error?: string;
}

// --- Helpers ---

async function getAllPages<T>(baseUrl: string, perPage = 100): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  while (true) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const resp = await iconikRequest<PaginatedResponse<T>>(
      `${baseUrl}${sep}page=${page}&per_page=${perPage}`
    );
    all.push(...(resp.objects || []));
    if (page >= (resp.pages || 1)) break;
    page++;
  }
  return all;
}

async function processAsset(
  assetId: string,
  storageId: string,
  applyChanges: boolean
): Promise<FixResult[]> {
  const results: FixResult[] = [];

  try {
    // Get file sets for this asset on the target storage
    const fileSets = await getAllPages<FileSet>(
      `files/v1/assets/${assetId}/file_sets/?storage_id=${storageId}`
    );

    if (fileSets.length === 0) return results;

    for (const fileSet of fileSets) {
      if (!fileSet.format_id) continue;

      // Get current format components
      let currentComponents: Component[];
      try {
        const compsResp = await iconikRequest<PaginatedResponse<Component>>(
          `files/v1/assets/${assetId}/formats/${fileSet.format_id}/components/`
        );
        currentComponents = compsResp.objects || [];
      } catch {
        // Format might not exist anymore
        continue;
      }

      const currentIds = currentComponents.map((c) => c.id).sort();
      const fileSetIds = (fileSet.component_ids || []).sort();

      // Compare
      const match =
        currentIds.length === fileSetIds.length &&
        currentIds.every((id, i) => id === fileSetIds[i]);

      if (match) continue;

      // Mismatch found
      const result: FixResult = {
        assetId,
        fileSetId: fileSet.id,
        formatId: fileSet.format_id,
        oldComponentCount: fileSetIds.length,
        newComponentCount: currentIds.length,
        fixed: false,
      };

      if (applyChanges) {
        try {
          await iconikRequest(
            `files/v1/assets/${assetId}/file_sets/${fileSet.id}/`,
            {
              method: "PATCH",
              body: JSON.stringify({ component_ids: currentIds }),
            }
          );
          result.fixed = true;
        } catch (err) {
          result.error = err instanceof Error ? err.message : String(err);
        }
      }

      results.push(result);
    }
  } catch (err) {
    // Asset might have been deleted
  }

  return results;
}

// --- Main ---

async function main() {
  const profile = getCurrentProfileInfo();
  const startTime = Date.now();

  if (!jsonOutput) {
    console.log(`\n${"=".repeat(60)}`);
    console.log("SYNC FILE SET COMPONENTS");
    console.log(`${"=".repeat(60)}`);
    console.log(`Profile: ${profile.name}`);
    console.log(`Storage: ${storageName}`);
    console.log(`Mode: ${isLive ? "LIVE" : "DRY RUN"}`);
    console.log(`Concurrency: ${CONCURRENCY}`);
    console.log("");
  }

  // Find storage
  const storages = await iconikRequest<PaginatedResponse<Storage>>(
    "files/v1/storages/"
  );
  const storage = storages.objects.find((s) => s.name === storageName);

  if (!storage) {
    const msg = `Storage '${storageName}' not found`;
    if (jsonOutput) {
      console.log(JSON.stringify({ status: "error", message: msg }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  // Get total CLOSED files to estimate scope
  const firstPage = await iconikRequest<PaginatedResponse<FileRecord>>(
    `files/v1/storages/${storage.id}/files/?per_page=1&status=CLOSED`
  );
  const totalFiles = firstPage.total || 0;

  if (!jsonOutput) {
    console.log(`Total CLOSED files on ${storageName}: ${totalFiles.toLocaleString()}`);
    console.log("Scanning for component mismatches...\n");
  }

  // Scan files, deduplicate by asset
  const processedAssets = new Set<string>();
  const allResults: FixResult[] = [];
  let totalScanned = 0;
  let page = 1;
  const maxPages = Math.ceil(totalFiles / 100) + 5;

  while (page <= maxPages) {
    let files: PaginatedResponse<FileRecord>;
    try {
      files = await iconikRequest<PaginatedResponse<FileRecord>>(
        `files/v1/storages/${storage.id}/files/?per_page=100&page=${page}&status=CLOSED`
      );
    } catch {
      break;
    }

    if (!files.objects || files.objects.length === 0) break;

    totalScanned += files.objects.length;

    // Collect unique asset IDs from this page
    const newAssetIds: string[] = [];
    for (const file of files.objects) {
      if (file.asset_id && !processedAssets.has(file.asset_id)) {
        processedAssets.add(file.asset_id);
        newAssetIds.push(file.asset_id);
      }
    }

    // Process assets in parallel batches
    for (let i = 0; i < newAssetIds.length; i += CONCURRENCY) {
      const batch = newAssetIds.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((id) => processAsset(id, storage.id, isLive))
      );
      for (const results of batchResults) {
        allResults.push(...results);
      }
    }

    // Progress update
    if (!jsonOutput && page % 20 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(
        `  [Page ${page}/${maxPages}] Scanned: ${totalScanned.toLocaleString()} files | ` +
        `Assets checked: ${processedAssets.size} | Mismatches: ${allResults.length} | ${elapsed}s`
      );
    }

    page++;
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const fixed = allResults.filter((r) => r.fixed).length;
  const errors = allResults.filter((r) => r.error).length;

  if (jsonOutput) {
    console.log(
      JSON.stringify({
        status: allResults.length === 0 ? "clean" : isLive ? "fixed" : "dry_run",
        storage: storageName,
        filesScanned: totalScanned,
        assetsChecked: processedAssets.size,
        mismatchesFound: allResults.length,
        fixed,
        errors,
        durationSeconds: elapsed,
        details: allResults.slice(0, 50), // Cap detail output
      }, null, 2)
    );
  } else {
    console.log(`\n${"=".repeat(60)}`);
    console.log("SUMMARY");
    console.log(`${"=".repeat(60)}`);
    console.log(`Duration: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
    console.log(`Files scanned: ${totalScanned.toLocaleString()}`);
    console.log(`Assets checked: ${processedAssets.size.toLocaleString()}`);
    console.log(`Component mismatches found: ${allResults.length}`);

    if (allResults.length > 0) {
      if (isLive) {
        console.log(`Fixed: ${fixed}`);
        console.log(`Errors: ${errors}`);
      } else {
        console.log(`\nDRY RUN - No changes applied. Run with --live to fix.`);
      }

      console.log(`\nMismatch details (first 20):`);
      for (const r of allResults.slice(0, 20)) {
        console.log(
          `  Asset ${r.assetId} | FileSet ${r.fileSetId} | ` +
          `Components: ${r.oldComponentCount} -> ${r.newComponentCount} | ` +
          `${r.fixed ? "FIXED" : r.error || "DRY RUN"}`
        );
      }
    } else {
      console.log("\nAll file sets are in sync. No action needed.");
    }
    console.log("");
  }
}

main().catch(console.error);
