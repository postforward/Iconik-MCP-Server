#!/usr/bin/env npx tsx

/**
 * FIND ICONIK-ONLY FILES - Find files that only exist on Iconik-managed storage
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

interface Storage {
  id: string;
  name: string;
  purpose: string;
}

interface StorageFile {
  id: string;
  name: string;
  size: number;
  asset_id?: string;
  storage_id: string;
  date_created: string;
}

interface FileSet {
  id: string;
  name: string;
  storage_id: string;
}

interface PaginatedResponse<T> {
  objects: T[];
  total?: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

async function main() {
  const profile = getCurrentProfileInfo();

  console.log(`\n${"═".repeat(70)}`);
  console.log(`FIND ICONIK-ONLY FILES`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Profile: ${profile.name}\n`);

  // Get all storages
  const storages = await iconikRequest<PaginatedResponse<Storage>>('files/v1/storages/');

  const iconikStorageIds = new Set<string>();
  const customerStorageIds = new Set<string>();

  console.log('Storages:');
  for (const s of storages.objects) {
    const isIconik = s.name.toLowerCase().includes('iconik-');
    if (isIconik) {
      iconikStorageIds.add(s.id);
      console.log(`  [ICONIK] ${s.name} (${s.id})`);
    } else {
      customerStorageIds.add(s.id);
      console.log(`  [CUSTOMER] ${s.name} (${s.id})`);
    }
  }

  console.log(`\nScanning Iconik-managed storages for files...\n`);

  const iconikOnlyAssets: Map<string, {
    assetId: string;
    title?: string;
    files: StorageFile[];
    totalSize: number;
    hasCustomerCopy: boolean;
  }> = new Map();

  // Scan each Iconik storage
  for (const storageId of iconikStorageIds) {
    const storage = storages.objects.find(s => s.id === storageId);
    console.log(`Scanning: ${storage?.name}...`);

    let page = 1;
    const maxPages = 50; // Sample first 5000 files

    while (page <= maxPages) {
      try {
        const files = await iconikRequest<PaginatedResponse<StorageFile>>(
          `files/v1/storages/${storageId}/files/?per_page=100&page=${page}`
        );

        if (!files.objects || files.objects.length === 0) break;

        for (const file of files.objects) {
          if (!file.asset_id) continue;

          if (!iconikOnlyAssets.has(file.asset_id)) {
            iconikOnlyAssets.set(file.asset_id, {
              assetId: file.asset_id,
              files: [],
              totalSize: 0,
              hasCustomerCopy: false
            });
          }

          const entry = iconikOnlyAssets.get(file.asset_id)!;
          entry.files.push(file);
          entry.totalSize += file.size || 0;
        }

        if (!files.total || page * 100 >= files.total) break;
        page++;
      } catch {
        break;
      }
    }
  }

  console.log(`\nFound ${iconikOnlyAssets.size} assets with files on Iconik storage`);
  console.log(`Checking if they have copies on customer storage...\n`);

  // Check each asset to see if it has files on customer storage
  let checked = 0;
  for (const [assetId, entry] of iconikOnlyAssets) {
    checked++;
    if (checked % 50 === 0) {
      process.stdout.write(`  Checked ${checked}/${iconikOnlyAssets.size}...\r`);
    }

    try {
      // Get all file sets for this asset
      const fileSets = await iconikRequest<PaginatedResponse<FileSet>>(
        `files/v1/assets/${assetId}/file_sets/`
      );

      for (const fs of fileSets.objects || []) {
        if (customerStorageIds.has(fs.storage_id)) {
          entry.hasCustomerCopy = true;
          break;
        }
      }

      // Get asset title
      try {
        const asset = await iconikRequest<{ title: string }>(`assets/v1/assets/${assetId}/`);
        entry.title = asset.title;
      } catch {
        entry.title = 'Unknown';
      }
    } catch {
      // Asset might not exist anymore
    }
  }

  // Filter to only Iconik-only files
  const iconikOnly = Array.from(iconikOnlyAssets.values())
    .filter(e => !e.hasCustomerCopy)
    .sort((a, b) => b.totalSize - a.totalSize);

  const totalSize = iconikOnly.reduce((sum, e) => sum + e.totalSize, 0);
  const totalFiles = iconikOnly.reduce((sum, e) => sum + e.files.length, 0);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`ICONIK-ONLY FILES (no copy on customer storage)`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Assets: ${iconikOnly.length}`);
  console.log(`Files: ${totalFiles}`);
  console.log(`Total size: ${formatBytes(totalSize)}\n`);

  if (iconikOnly.length > 0) {
    console.log(`Top 20 by size:`);
    for (const entry of iconikOnly.slice(0, 20)) {
      console.log(`\n  ${entry.title || entry.assetId}`);
      console.log(`    Size: ${formatBytes(entry.totalSize)} | Files: ${entry.files.length}`);
      console.log(`    https://app.iconik.io/asset/${entry.assetId}`);
      for (const f of entry.files.slice(0, 3)) {
        console.log(`      - ${f.name}`);
      }
      if (entry.files.length > 3) {
        console.log(`      ... and ${entry.files.length - 3} more`);
      }
    }
  } else {
    console.log('No assets found with files ONLY on Iconik storage.');
  }

  console.log('');
}

main().catch(console.error);
