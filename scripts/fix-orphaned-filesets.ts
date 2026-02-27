#!/usr/bin/env npx tsx

/**
 * FIX ORPHANED FILE SETS
 *
 * This script finds file sets that have no associated file records and creates
 * file records for them. This fixes the issue where files show 0 bytes and
 * don't appear in the storage file tree.
 *
 * The file set contains name and base_dir, which we use to create the file record.
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const collectionId = args[0];
const isLive = process.argv.includes('--live');

// Parse optional flags
const storageArg = process.argv.find(a => a.startsWith('--storage='));
const storageName = storageArg?.split('=')[1];

if (!collectionId || !storageName) {
  console.error('Usage: npx tsx scripts/fix-orphaned-filesets.ts <collection_id> --storage=NAME --profile=name [--live]');
  console.error('');
  console.error('Creates file records for file sets that are missing them.');
  console.error('');
  console.error('Options:');
  console.error('  --storage=NAME   Storage to check for orphaned file sets (REQUIRED)');
  console.error('  --live           Actually create files (default is dry run)');
  console.error('');
  console.error('Example:');
  console.error('  npx tsx scripts/fix-orphaned-filesets.ts abc123 --storage=MyStorage --profile=myprofile --live');
  process.exit(1);
}

interface Storage {
  id: string;
  name: string;
}

interface Collection {
  title: string;
}

interface CollectionContent {
  id: string;
  object_type: string;
}

interface FileSet {
  id: string;
  name: string;
  base_dir: string;
  storage_id: string;
  format_id: string;
}

interface File {
  id: string;
  name: string;
  original_name: string;
  directory_path: string;
  status: string;
  file_set_id: string;
}

interface PaginatedResponse<T> {
  objects: T[];
}

async function getAssetsRecursive(colId: string, depth = 0): Promise<string[]> {
  const assets: string[] = [];
  let page = 1;

  while (page <= 100) {
    try {
      const contents = await iconikRequest<PaginatedResponse<CollectionContent>>(
        `assets/v1/collections/${colId}/contents/?per_page=100&page=${page}`
      );

      if (!contents.objects || contents.objects.length === 0) break;

      for (const item of contents.objects) {
        if (item.object_type === 'assets') {
          assets.push(item.id);
        } else if (item.object_type === 'collections' && depth < 10) {
          const subAssets = await getAssetsRecursive(item.id, depth + 1);
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

async function main() {
  const profile = getCurrentProfileInfo();
  const startTime = new Date();

  console.log(`\n${"═".repeat(70)}`);
  console.log(`FIX ORPHANED FILE SETS`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Collection: ${collectionId}`);
  console.log(`Storage: ${storageName}`);
  console.log(`Mode: ${isLive ? '🔴 LIVE - WILL CREATE FILES' : '🟡 DRY RUN - No files will be created'}`);
  console.log(`${"═".repeat(70)}\n`);

  // Get storages
  const storages = await iconikRequest<PaginatedResponse<Storage>>('files/v1/storages/');
  const targetStorage = storages.objects.find(s => s.name === storageName);

  if (!targetStorage) {
    console.error(`Storage '${storageName}' not found. Available storages:`);
    for (const s of storages.objects) {
      console.error(`  - ${s.name}`);
    }
    process.exit(1);
  }

  console.log(`Target storage ID: ${targetStorage.id}\n`);

  // Get collection info
  const collection = await iconikRequest<Collection>(`assets/v1/collections/${collectionId}/`);
  console.log(`Collection: ${collection.title}\n`);

  // Get all assets recursively
  console.log('Scanning collection recursively...');
  const assetIds = await getAssetsRecursive(collectionId);
  console.log(`Found ${assetIds.length} assets\n`);

  let orphanedFileSets = 0;
  let fixedFileSets = 0;
  let errors: string[] = [];

  console.log('Checking assets for orphaned file sets...\n');

  for (let i = 0; i < assetIds.length; i++) {
    const assetId = assetIds[i];

    if ((i + 1) % 100 === 0) {
      process.stdout.write(`  Checked ${i + 1}/${assetIds.length} assets... (Fixed: ${fixedFileSets})\r`);
    }

    try {
      // Get file sets for this asset on target storage
      const fileSets = await iconikRequest<PaginatedResponse<FileSet>>(
        `files/v1/assets/${assetId}/file_sets/?storage_id=${targetStorage.id}`
      );

      if (!fileSets.objects || fileSets.objects.length === 0) continue;

      // Get all files for this asset
      const files = await iconikRequest<PaginatedResponse<File>>(
        `files/v1/assets/${assetId}/files/`
      );

      // Check each file set
      for (const fileSet of fileSets.objects) {
        // Check if this file set has any files
        const hasFiles = files.objects?.some(f => f.file_set_id === fileSet.id);

        if (!hasFiles) {
          orphanedFileSets++;

          if (isLive) {
            try {
              // Create a file record for this file set
              await iconikRequest(`files/v1/assets/${assetId}/files/`, {
                method: 'POST',
                body: JSON.stringify({
                  file_set_id: fileSet.id,
                  format_id: fileSet.format_id,
                  storage_id: fileSet.storage_id,
                  name: fileSet.name,
                  original_name: fileSet.name,
                  directory_path: fileSet.base_dir,
                  status: 'CLOSED',
                  type: 'FILE',
                  size: 0  // Size unknown, but file will appear in tree
                })
              });
              fixedFileSets++;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              errors.push(`Asset ${assetId}: ${msg}`);
            }
          } else {
            fixedFileSets++; // Count as "would fix" in dry run
          }
        }
      }
    } catch (e) {
      // Skip errors
    }
  }

  const endTime = new Date();
  const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000);

  console.log(`\n\n${"═".repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Duration: ${Math.floor(duration / 60)}m ${duration % 60}s`);
  console.log(`Assets checked: ${assetIds.length}`);
  console.log(`Orphaned file sets found: ${orphanedFileSets}`);

  if (isLive) {
    console.log(`File sets fixed: ${fixedFileSets}`);
    if (errors.length > 0) {
      console.log(`Errors: ${errors.length}`);
      for (const err of errors.slice(0, 10)) {
        console.log(`  - ${err}`);
      }
      if (errors.length > 10) {
        console.log(`  ... and ${errors.length - 10} more`);
      }
    }
  } else {
    console.log(`\n🟡 DRY RUN - No files created`);
    console.log(`Run with --live to create ${fixedFileSets} file records`);
  }

  console.log('');
}

main().catch(console.error);
