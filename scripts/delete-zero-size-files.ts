#!/usr/bin/env npx tsx

/**
 * Delete file records with size=0 for a collection
 * This does NOT delete actual files on disk - only the Iconik metadata records
 * After running, reindex the directory to create proper file records with sizes
 */

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const collectionId = args[0];
const isLive = process.argv.includes('--live');

if (!collectionId) {
  console.error('Usage: npx tsx scripts/delete-zero-size-files.ts <collection_id> --profile=name [--live]');
  process.exit(1);
}

interface FileRecord {
  id: string;
  name: string;
  size: number;
  status: string;
  storage_id: string;
  file_set_id: string;
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

async function main() {
  const collection = await iconikRequest<{ title: string }>(`assets/v1/collections/${collectionId}/`);
  console.log('Collection:', collection.title);
  console.log('Mode:', isLive ? '🔴 LIVE - WILL DELETE FILE RECORDS' : '🟡 DRY RUN');
  console.log('');

  const storages = await iconikRequest<{ objects: Storage[] }>('files/v1/storages/');
  const mortarStorage = storages.objects.find(s => s.name === 'Mortar');

  if (!mortarStorage) {
    console.error('Mortar storage not found');
    process.exit(1);
  }

  const contents = await iconikRequest<{ objects: CollectionContent[] }>(
    `assets/v1/collections/${collectionId}/contents/?per_page=100`
  );

  let zeroSizeCount = 0;
  let deletedCount = 0;
  const errors: string[] = [];

  for (const item of contents.objects || []) {
    if (item.object_type !== 'assets') continue;

    const files = await iconikRequest<{ objects: FileRecord[] }>(`files/v1/assets/${item.id}/files/`);

    for (const f of files.objects || []) {
      // Only delete Mortar files with size 0
      if (f.storage_id === mortarStorage.id && f.size === 0) {
        zeroSizeCount++;
        console.log(`Zero-size file: ${item.title}`);
        console.log(`  File ID: ${f.id}`);
        console.log(`  Name: ${f.name}`);

        if (isLive) {
          try {
            await iconikRequest(`files/v1/assets/${item.id}/files/${f.id}/`, {
              method: 'DELETE'
            });
            console.log(`  ✅ Deleted file record`);
            deletedCount++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`  ❌ Error: ${msg}`);
            errors.push(`${item.title}: ${msg}`);
          }
        } else {
          console.log(`  [DRY RUN] Would delete file record`);
          deletedCount++;
        }
      }
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log('SUMMARY');
  console.log('═'.repeat(50));
  console.log(`Zero-size Mortar file records found: ${zeroSizeCount}`);

  if (isLive) {
    console.log(`Deleted: ${deletedCount}`);
    if (errors.length > 0) {
      console.log(`Errors: ${errors.length}`);
    }
    console.log('\nNow reindex the directory in Storage Gateway to create proper file records.');
  } else {
    console.log(`\n🟡 DRY RUN - Run with --live to delete ${deletedCount} file records`);
  }
}

main().catch(console.error);
