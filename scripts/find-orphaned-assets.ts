#!/usr/bin/env npx tsx

/**
 * FIND ORPHANED ASSETS - Find assets with no files on any storage
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

interface Asset {
  id: string;
  title: string;
  status: string;
  archive_status?: string;
  date_created: string;
  date_modified: string;
}

interface FileSet {
  id: string;
  name: string;
  storage_id: string;
}

interface PaginatedResponse<T> {
  objects: T[];
  total?: number;
  pages?: number;
}

async function main() {
  const profile = getCurrentProfileInfo();

  console.log(`\n${"═".repeat(70)}`);
  console.log(`FIND ORPHANED ASSETS (no files on any storage)`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Profile: ${profile.name}\n`);

  const orphanedAssets: Asset[] = [];
  let totalAssets = 0;
  let checkedAssets = 0;

  let page = 1;
  const maxPages = 100; // Check up to 10,000 assets

  console.log('Scanning assets...\n');

  while (page <= maxPages) {
    try {
      const assets = await iconikRequest<PaginatedResponse<Asset>>(
        `assets/v1/assets/?per_page=100&page=${page}`
      );

      if (!assets.objects || assets.objects.length === 0) break;

      if (page === 1) {
        totalAssets = assets.total || 0;
        console.log(`Total assets in system: ${totalAssets.toLocaleString()}\n`);
      }

      for (const asset of assets.objects) {
        checkedAssets++;

        if (checkedAssets % 100 === 0) {
          process.stdout.write(`  Checked ${checkedAssets} assets, found ${orphanedAssets.length} orphaned...\r`);
        }

        try {
          // Get file sets for this asset
          const fileSets = await iconikRequest<PaginatedResponse<FileSet>>(
            `files/v1/assets/${asset.id}/file_sets/`
          );

          // If no file sets, it's orphaned
          if (!fileSets.objects || fileSets.objects.length === 0) {
            orphanedAssets.push(asset);
          }
        } catch {
          // Error fetching file sets - might be orphaned
          orphanedAssets.push(asset);
        }
      }

      if (!assets.pages || page >= assets.pages) break;
      page++;
    } catch (e) {
      console.log(`\nError on page ${page}: ${e instanceof Error ? e.message : e}`);
      break;
    }
  }

  console.log(`\n\n${"═".repeat(70)}`);
  console.log(`RESULTS`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Assets checked: ${checkedAssets.toLocaleString()}`);
  console.log(`Orphaned assets (no file sets): ${orphanedAssets.length}`);

  if (orphanedAssets.length > 0) {
    console.log(`\nOrphaned Assets:`);
    console.log(`${"─".repeat(70)}`);

    for (const asset of orphanedAssets.slice(0, 50)) {
      console.log(`\n  ${asset.title}`);
      console.log(`    ID: ${asset.id}`);
      console.log(`    Status: ${asset.status} | Archive: ${asset.archive_status || 'N/A'}`);
      console.log(`    Created: ${asset.date_created?.substring(0, 10)}`);
      console.log(`    https://app.iconik.io/asset/${asset.id}`);
    }

    if (orphanedAssets.length > 50) {
      console.log(`\n  ... and ${orphanedAssets.length - 50} more`);
    }
  } else {
    console.log(`\n✅ No orphaned assets found!`);
  }

  console.log('');
}

main().catch(console.error);
