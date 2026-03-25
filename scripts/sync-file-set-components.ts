#!/usr/bin/env npx tsx

/**
 * sync-file-set-components.ts
 *
 * Proactive maintenance script that finds and fixes file sets whose
 * component_ids are out of sync with their format's current components.
 * This mismatch is the #1 cause of "Files components differ between source
 * and destination" errors during Iconik archive jobs.
 *
 * By default, only checks assets modified in the last 48 hours (fast mode).
 * Use --full to scan all files on the storage (slow but thorough).
 *
 * Usage:
 *   # Fast: only recently modified assets (~1-2 min)
 *   npx tsx scripts/sync-file-set-components.ts --profile=<name> --storage=<name>
 *
 *   # Full: scan entire storage (~30+ min)
 *   npx tsx scripts/sync-file-set-components.ts --profile=<name> --storage=<name> --full
 *
 *   # Nightly automation
 *   npx tsx scripts/sync-file-set-components.ts --profile=<name> --storage=<name> --live --json
 *
 *   # Custom lookback window (hours)
 *   npx tsx scripts/sync-file-set-components.ts --profile=<name> --storage=<name> --hours=72
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.js";
import { getProfileFromArgs } from "../src/config.js";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const rawArgs = process.argv.slice(2);
const isLive = rawArgs.includes("--live");
const jsonOutput = rawArgs.includes("--json");
const fullScan = rawArgs.includes("--full");
const CONCURRENCY = 10;

function getArgValue(prefix: string): string | undefined {
  const arg = rawArgs.find((a) => a.startsWith(prefix));
  return arg?.split("=")[1];
}

const storageName = getArgValue("--storage=");
const lookbackHours = parseInt(getArgValue("--hours=") || "48", 10);

if (!storageName) {
  console.error("Usage: npx tsx scripts/sync-file-set-components.ts --profile=<name> --storage=<name> [options]");
  console.error("");
  console.error("Options:");
  console.error("  --storage=NAME   Storage to check file sets against (REQUIRED)");
  console.error("  --live           Apply fixes (default: dry-run)");
  console.error("  --json           Output results as JSON");
  console.error("  --full           Scan all files on storage (slow, use for first run)");
  console.error("  --hours=N        Lookback window in hours (default: 48)");
  process.exit(1);
}

// --- Types ---

interface PaginatedResponse<T> {
  objects: T[];
  total?: number;
  pages?: number;
}

interface SearchResponse {
  objects: Array<{ id: string; title?: string }>;
  total?: number;
  pages?: number;
}

interface FileRecord {
  id: string;
  name: string;
  asset_id: string;
  storage_id: string;
  status: string;
}

interface FileSet {
  id: string;
  name: string;
  storage_id: string;
  format_id: string;
  component_ids: string[];
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
    const fileSets = await getAllPages<FileSet>(
      `files/v1/assets/${assetId}/file_sets/?storage_id=${storageId}`
    );

    if (fileSets.length === 0) return results;

    for (const fileSet of fileSets) {
      if (!fileSet.format_id) continue;

      let currentComponents: Component[];
      try {
        const compsResp = await iconikRequest<PaginatedResponse<Component>>(
          `files/v1/assets/${assetId}/formats/${fileSet.format_id}/components/`
        );
        currentComponents = compsResp.objects || [];
      } catch {
        continue;
      }

      const currentIds = currentComponents.map((c) => c.id).sort();
      const fileSetIds = (fileSet.component_ids || []).sort();

      const match =
        currentIds.length === fileSetIds.length &&
        currentIds.every((id, i) => id === fileSetIds[i]);

      if (match) continue;

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
  } catch {
    // Asset might have been deleted
  }

  return results;
}

// --- Asset discovery strategies ---

async function discoverRecentAssets(storageId: string, hours: number): Promise<string[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  if (!jsonOutput) {
    console.log(`Searching for assets modified since ${since} (${hours}h window)...`);
  }

  const assetIds: string[] = [];
  let page = 1;

  while (true) {
    const resp = await iconikRequest<SearchResponse>(
      `search/v1/search/?per_page=100&page=${page}`,
      {
        method: "POST",
        body: JSON.stringify({
          filter: {
            operator: "AND",
            terms: [
              { name: "date_modified", range: { min: since } },
            ],
          },
          doc_types: ["assets"],
          sort: [{ name: "date_modified", order: "desc" }],
        }),
      }
    );

    if (!resp.objects || resp.objects.length === 0) break;

    for (const obj of resp.objects) {
      if (obj.id) assetIds.push(obj.id);
    }

    if (page === 1 && !jsonOutput) {
      console.log(`Found ${resp.total || 0} recently modified assets`);
    }

    if (page >= (resp.pages || 1)) break;
    page++;
  }

  return assetIds;
}

async function discoverAllAssetsOnStorage(storageId: string): Promise<string[]> {
  if (!jsonOutput) {
    const firstPage = await iconikRequest<PaginatedResponse<FileRecord>>(
      `files/v1/storages/${storageId}/files/?per_page=1&status=CLOSED`
    );
    console.log(`Full scan: ${(firstPage.total || 0).toLocaleString()} CLOSED files on storage`);
  }

  const assetIds = new Set<string>();
  let page = 1;
  const maxPages = 10000;

  while (page <= maxPages) {
    let files: PaginatedResponse<FileRecord>;
    try {
      files = await iconikRequest<PaginatedResponse<FileRecord>>(
        `files/v1/storages/${storageId}/files/?per_page=100&page=${page}&status=CLOSED`
      );
    } catch {
      break;
    }

    if (!files.objects || files.objects.length === 0) break;

    for (const file of files.objects) {
      if (file.asset_id) assetIds.add(file.asset_id);
    }

    if (!jsonOutput && page % 50 === 0) {
      console.log(`  Scanned ${page * 100} files, ${assetIds.size} unique assets...`);
    }

    page++;
  }

  return Array.from(assetIds);
}

// --- Main ---

async function main() {
  const profile = getCurrentProfileInfo();
  const startTime = Date.now();
  const mode = fullScan ? "FULL SCAN" : `RECENT (${lookbackHours}h)`;

  if (!jsonOutput) {
    console.log(`\n${"=".repeat(60)}`);
    console.log("SYNC FILE SET COMPONENTS");
    console.log(`${"=".repeat(60)}`);
    console.log(`Profile: ${profile.name}`);
    console.log(`Storage: ${storageName}`);
    console.log(`Mode: ${isLive ? "LIVE" : "DRY RUN"} | Scope: ${mode}`);
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

  // Discover assets to check
  const assetIds = fullScan
    ? await discoverAllAssetsOnStorage(storage.id)
    : await discoverRecentAssets(storage.id, lookbackHours);

  if (!jsonOutput) {
    console.log(`\nChecking ${assetIds.length.toLocaleString()} assets for component mismatches...\n`);
  }

  // Process assets in parallel batches
  const allResults: FixResult[] = [];
  let assetsChecked = 0;

  for (let i = 0; i < assetIds.length; i += CONCURRENCY) {
    const batch = assetIds.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((id) => processAsset(id, storage.id, isLive))
    );
    for (const results of batchResults) {
      allResults.push(...results);
    }
    assetsChecked += batch.length;

    if (!jsonOutput && assetsChecked % 200 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(
        `  Checked ${assetsChecked}/${assetIds.length} assets | ` +
        `Mismatches: ${allResults.length} | ${elapsed}s`
      );
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const fixed = allResults.filter((r) => r.fixed).length;
  const errors = allResults.filter((r) => r.error).length;

  if (jsonOutput) {
    console.log(
      JSON.stringify({
        status: allResults.length === 0 ? "clean" : isLive ? "fixed" : "dry_run",
        scope: fullScan ? "full" : "recent",
        lookbackHours: fullScan ? null : lookbackHours,
        storage: storageName,
        assetsChecked,
        mismatchesFound: allResults.length,
        fixed,
        errors,
        durationSeconds: elapsed,
        details: allResults.slice(0, 50),
      }, null, 2)
    );
  } else {
    console.log(`\n${"=".repeat(60)}`);
    console.log("SUMMARY");
    console.log(`${"=".repeat(60)}`);
    console.log(`Duration: ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
    console.log(`Scope: ${mode}`);
    console.log(`Assets checked: ${assetsChecked.toLocaleString()}`);
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
