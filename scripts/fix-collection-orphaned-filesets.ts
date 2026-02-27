#!/usr/bin/env npx tsx

/**
 * Fix orphaned file sets in a specific collection
 * Creates file records for Mortar file sets that have no files
 */

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const collectionId = args[0];
const isLive = process.argv.includes('--live');

if (!collectionId) {
  console.error('Usage: npx tsx scripts/fix-collection-orphaned-filesets.ts <collection_id> --profile=name [--live]');
  process.exit(1);
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

interface PaginatedResponse<T> {
  objects: T[];
}

async function main() {
  // Get collection info
  const collection = await iconikRequest<{ title: string }>(`assets/v1/collections/${collectionId}/`);
  console.log('Collection:', collection.title);
  console.log('Mode:', isLive ? '🔴 LIVE' : '🟡 DRY RUN');
  console.log('');

  // Get storages
  const storages = await iconikRequest<PaginatedResponse<Storage>>('files/v1/storages/');
  const mortarStorage = storages.objects.find(s => s.name === 'Mortar');

  if (!mortarStorage) {
    console.error('Mortar storage not found');
    process.exit(1);
  }

  // Get contents
  const contents = await iconikRequest<PaginatedResponse<CollectionContent>>(
    `assets/v1/collections/${collectionId}/contents/?per_page=100`
  );
  console.log('Total items:', contents.objects?.length);

  let orphanedCount = 0;
  let fixedCount = 0;
  let alreadyFixedCount = 0;
  const errors: string[] = [];

  for (const item of contents.objects || []) {
    if (item.object_type !== 'assets') continue;

    const fileSets = await iconikRequest<PaginatedResponse<FileSet>>(
      `files/v1/assets/${item.id}/file_sets/`
    );
    const files = await iconikRequest<PaginatedResponse<File>>(
      `files/v1/assets/${item.id}/files/`
    );

    const mortarFileSets = fileSets.objects?.filter(fs => fs.storage_id === mortarStorage.id) || [];

    for (const fs of mortarFileSets) {
      const hasFiles = files.objects?.some(f => f.file_set_id === fs.id);

      if (!hasFiles) {
        orphanedCount++;
        console.log(`\nOrphaned: ${item.title}`);
        console.log(`  FileSet: ${fs.name}`);
        console.log(`  Path: ${fs.base_dir}`);

        if (isLive) {
          try {
            await iconikRequest(`files/v1/assets/${item.id}/files/`, {
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
                size: 0  // Will need reindex to get actual size
              })
            });
            console.log(`  ✅ Created file record`);
            fixedCount++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`  ❌ Error: ${msg}`);
            errors.push(`${item.title}: ${msg}`);
          }
        } else {
          console.log(`  [DRY RUN] Would create file record`);
          fixedCount++;
        }
      } else {
        alreadyFixedCount++;
      }
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log('SUMMARY');
  console.log('═'.repeat(50));
  console.log(`Orphaned file sets found: ${orphanedCount}`);
  console.log(`Already have file records: ${alreadyFixedCount}`);

  if (isLive) {
    console.log(`Fixed: ${fixedCount}`);
    if (errors.length > 0) {
      console.log(`Errors: ${errors.length}`);
    }
  } else {
    console.log(`\n🟡 DRY RUN - Run with --live to fix ${fixedCount} file sets`);
  }
}

main().catch(console.error);
