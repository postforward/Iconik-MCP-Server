#!/usr/bin/env npx tsx

/**
 * Fix orphaned Mortar file sets with parallelization
 * Recursively processes collections and runs multiple assets in parallel
 */

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";
import * as fs from "fs";
import * as path from "path";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const collectionId = args[0];
const mountPath = args[1] || '/Volumes/mortar';
const isLive = process.argv.includes('--live');
const CONCURRENCY = 10; // Process 10 assets at a time

if (!collectionId) {
  console.error('Usage: npx tsx scripts/fix-orphaned-with-sizes-parallel.ts <collection_id> [mount_path] --profile=name [--live]');
  process.exit(1);
}

interface FileSet {
  id: string;
  name: string;
  base_dir: string;
  storage_id: string;
  format_id: string;
  status: string;
}

interface FileRecord {
  id: string;
  file_set_id: string;
  size: number;
}

interface CollectionContent {
  id: string;
  object_type: string;
  title?: string;
}

interface Storage {
  id: string;
  name: string;
}

interface Stats {
  orphanedCount: number;
  fixedCount: number;
  sizeUpdatedCount: number;
  notFoundCount: number;
  errors: string[];
}

function getFileSize(basePath: string, fileName: string): number | null {
  const fullPath = path.join(mountPath, basePath, fileName);
  try {
    const stats = fs.statSync(fullPath);
    return stats.size;
  } catch (e) {
    return null;
  }
}

async function getAllAssets(collectionId: string, depth = 0): Promise<string[]> {
  const assets: string[] = [];
  let page = 1;

  while (page <= 100) {
    try {
      const contents = await iconikRequest<{ objects: CollectionContent[] }>(
        `assets/v1/collections/${collectionId}/contents/?per_page=100&page=${page}`
      );

      if (!contents.objects || contents.objects.length === 0) break;

      for (const item of contents.objects) {
        if (item.object_type === 'assets') {
          assets.push(item.id);
        } else if (item.object_type === 'collections' && depth < 10) {
          const subAssets = await getAllAssets(item.id, depth + 1);
          assets.push(...subAssets);
        }
      }

      if (contents.objects.length < 100) break;
      page++;
    } catch (e) {
      break;
    }
  }

  return assets;
}

async function processAsset(
  assetId: string,
  mortarStorageId: string,
  stats: Stats
): Promise<void> {
  try {
    const [fileSetsRes, filesRes] = await Promise.all([
      iconikRequest<{ objects: FileSet[] }>(`files/v1/assets/${assetId}/file_sets/`),
      iconikRequest<{ objects: FileRecord[] }>(`files/v1/assets/${assetId}/files/`)
    ]);

    const mortarFileSets = fileSetsRes.objects?.filter(fs => fs.storage_id === mortarStorageId) || [];

    for (const fs of mortarFileSets) {
      const existingFile = filesRes.objects?.find(f => f.file_set_id === fs.id);
      const fileSize = getFileSize(fs.base_dir, fs.name);

      if (!existingFile) {
        stats.orphanedCount++;

        if (fileSize === null) {
          stats.notFoundCount++;
          console.log(`⚠️  Not on disk: ${fs.name}`);
          continue;
        }

        if (isLive) {
          try {
            // Undelete if needed
            if (fs.status === 'DELETED') {
              await iconikRequest(`files/v1/assets/${assetId}/file_sets/${fs.id}/`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'ACTIVE' })
              });
            }

            // Create file record
            await iconikRequest(
              `files/v1/assets/${assetId}/files/`,
              {
                method: 'POST',
                body: JSON.stringify({
                  file_set_id: fs.id,
                  format_id: fs.format_id,
                  storage_id: fs.storage_id,
                  name: fs.name,
                  original_name: fs.name,
                  directory_path: fs.base_dir,
                  status: 'CLOSED',
                  type: 'FILE',
                  size: fileSize
                })
              }
            );
            stats.fixedCount++;
            stats.sizeUpdatedCount++;
            console.log(`✅ Fixed: ${fs.name} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            stats.errors.push(`${fs.name}: ${msg}`);
            console.log(`❌ Error: ${fs.name} - ${msg}`);
          }
        } else {
          stats.fixedCount++;
          stats.sizeUpdatedCount++;
        }
      } else if (existingFile.size === 0 && fileSize !== null && fileSize > 0) {
        // Has file record but size is 0 - update it
        if (isLive) {
          try {
            await iconikRequest(`files/v1/assets/${assetId}/files/${existingFile.id}/`, {
              method: 'PATCH',
              body: JSON.stringify({ size: fileSize })
            });
            stats.sizeUpdatedCount++;
            console.log(`✅ Updated size: ${fs.name} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            stats.errors.push(`${fs.name}: ${msg}`);
          }
        } else {
          stats.sizeUpdatedCount++;
        }
      }
    }
  } catch (e) {
    // Skip assets that error
  }
}

async function processInBatches<T>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(processor));

    // Progress update
    const processed = Math.min(i + batchSize, items.length);
    process.stdout.write(`\rProcessed ${processed}/${items.length} assets...`);
  }
  console.log('');
}

async function main() {
  if (!fs.existsSync(mountPath)) {
    console.error(`Mount path not found: ${mountPath}`);
    process.exit(1);
  }

  const collection = await iconikRequest<{ title: string }>(`assets/v1/collections/${collectionId}/`);
  console.log('Collection:', collection.title);
  console.log('Mount path:', mountPath);
  console.log('Concurrency:', CONCURRENCY);
  console.log('Mode:', isLive ? '🔴 LIVE' : '🟡 DRY RUN');
  console.log('');

  const storages = await iconikRequest<{ objects: Storage[] }>('files/v1/storages/');
  const mortarStorage = storages.objects.find(s => s.name === 'Mortar');

  if (!mortarStorage) {
    console.error('Mortar storage not found');
    process.exit(1);
  }

  console.log('Fetching all assets recursively...');
  const assetIds = await getAllAssets(collectionId);
  console.log(`Found ${assetIds.length} assets\n`);

  const stats: Stats = {
    orphanedCount: 0,
    fixedCount: 0,
    sizeUpdatedCount: 0,
    notFoundCount: 0,
    errors: []
  };

  await processInBatches(assetIds, CONCURRENCY, async (assetId) => {
    await processAsset(assetId, mortarStorage.id, stats);
  });

  console.log('\n' + '═'.repeat(50));
  console.log('SUMMARY');
  console.log('═'.repeat(50));
  console.log(`Total assets processed: ${assetIds.length}`);
  console.log(`Orphaned file sets found: ${stats.orphanedCount}`);
  console.log(`Files not found on disk: ${stats.notFoundCount}`);

  if (isLive) {
    console.log(`Fixed (created file records): ${stats.fixedCount}`);
    console.log(`Sizes updated: ${stats.sizeUpdatedCount}`);
    if (stats.errors.length > 0) {
      console.log(`Errors: ${stats.errors.length}`);
    }
  } else {
    console.log(`\n🟡 DRY RUN - Run with --live to fix ${stats.fixedCount} file sets`);
  }
}

main().catch(console.error);
