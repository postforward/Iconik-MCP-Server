#!/usr/bin/env npx tsx

/**
 * Fix orphaned file sets by:
 * 1. Undeleting the file set if needed
 * 2. Creating a file record
 * 3. Reading actual file size from mounted volume and updating
 */

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";
import * as fs from "fs";
import * as path from "path";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const collectionId = args[0];
const mountPath = args[1] || '/mnt/storage';
const isLive = process.argv.includes('--live');
const storageArg = process.argv.find(a => a.startsWith('--storage='));
const storageName = storageArg?.split('=')[1];

if (!collectionId || !storageName) {
  console.error('Usage: npx tsx scripts/fix-orphaned-with-sizes.ts <collection_id> [mount_path] --storage=NAME --profile=<name> [--live]');
  console.error('  mount_path defaults to /mnt/storage');
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

function getFileSize(basePath: string, fileName: string): number | null {
  const fullPath = path.join(mountPath, basePath, fileName);
  try {
    const stats = fs.statSync(fullPath);
    return stats.size;
  } catch (e) {
    return null;
  }
}

async function main() {
  // Check mount
  if (!fs.existsSync(mountPath)) {
    console.error(`Mount path not found: ${mountPath}`);
    console.error('Make sure the storage volume is mounted.');
    process.exit(1);
  }

  const collection = await iconikRequest<{ title: string }>(`assets/v1/collections/${collectionId}/`);
  console.log('Collection:', collection.title);
  console.log('Storage:', storageName);
  console.log('Mount path:', mountPath);
  console.log('Mode:', isLive ? '🔴 LIVE' : '🟡 DRY RUN');
  console.log('');

  const storages = await iconikRequest<{ objects: Storage[] }>('files/v1/storages/');
  const targetStorage = storages.objects.find(s => s.name === storageName);

  if (!targetStorage) {
    console.error(`Storage "${storageName}" not found`);
    console.error('Available storages:');
    storages.objects.forEach(s => console.error(`  - ${s.name}`));
    process.exit(1);
  }

  const contents = await iconikRequest<{ objects: CollectionContent[] }>(
    `assets/v1/collections/${collectionId}/contents/?per_page=100`
  );

  let orphanedCount = 0;
  let fixedCount = 0;
  let sizeUpdatedCount = 0;
  let notFoundCount = 0;
  const errors: string[] = [];

  for (const item of contents.objects || []) {
    if (item.object_type !== 'assets') continue;

    const fileSets = await iconikRequest<{ objects: FileSet[] }>(
      `files/v1/assets/${item.id}/file_sets/`
    );
    const files = await iconikRequest<{ objects: FileRecord[] }>(
      `files/v1/assets/${item.id}/files/`
    );

    const targetFileSets = fileSets.objects?.filter(fs => fs.storage_id === targetStorage.id) || [];

    for (const fs of targetFileSets) {
      const existingFile = files.objects?.find(f => f.file_set_id === fs.id);
      const fileSize = getFileSize(fs.base_dir, fs.name);

      if (!existingFile) {
        orphanedCount++;
        console.log(`\nOrphaned: ${item.title}`);
        console.log(`  FileSet: ${fs.name} (status: ${fs.status})`);
        console.log(`  Path: ${fs.base_dir}`);

        if (fileSize !== null) {
          console.log(`  Disk size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
        } else {
          console.log(`  ⚠️  File not found on disk`);
          notFoundCount++;
        }

        if (isLive) {
          try {
            // Undelete if needed
            if (fs.status === 'DELETED') {
              await iconikRequest(`files/v1/assets/${item.id}/file_sets/${fs.id}/`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'ACTIVE' })
              });
              console.log(`  ✅ Undeleted file set`);
            }

            // Create file record
            const newFile = await iconikRequest<{ id: string }>(
              `files/v1/assets/${item.id}/files/`,
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
                  size: fileSize || 0
                })
              }
            );
            console.log(`  ✅ Created file record: ${newFile.id}`);
            fixedCount++;

            if (fileSize !== null) {
              sizeUpdatedCount++;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`  ❌ Error: ${msg}`);
            errors.push(`${item.title}: ${msg}`);
          }
        } else {
          console.log(`  [DRY RUN] Would create file record with size ${fileSize || 0}`);
          fixedCount++;
          if (fileSize !== null) sizeUpdatedCount++;
        }
      } else if (existingFile.size === 0 && fileSize !== null && fileSize > 0) {
        // Has file record but size is 0 - update it
        console.log(`\nZero-size file: ${item.title}`);
        console.log(`  Disk size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

        if (isLive) {
          try {
            await iconikRequest(`files/v1/assets/${item.id}/files/${existingFile.id}/`, {
              method: 'PATCH',
              body: JSON.stringify({ size: fileSize })
            });
            console.log(`  ✅ Updated size`);
            sizeUpdatedCount++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`  ❌ Error: ${msg}`);
            errors.push(`${item.title}: ${msg}`);
          }
        } else {
          console.log(`  [DRY RUN] Would update size to ${fileSize}`);
          sizeUpdatedCount++;
        }
      }
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log('SUMMARY');
  console.log('═'.repeat(50));
  console.log(`Orphaned file sets found: ${orphanedCount}`);
  console.log(`Files not found on disk: ${notFoundCount}`);

  if (isLive) {
    console.log(`Fixed (created file records): ${fixedCount}`);
    console.log(`Sizes updated: ${sizeUpdatedCount}`);
    if (errors.length > 0) {
      console.log(`Errors: ${errors.length}`);
    }
  } else {
    console.log(`\n🟡 DRY RUN - Run with --live to fix ${fixedCount} file sets`);
  }
}

main().catch(console.error);
