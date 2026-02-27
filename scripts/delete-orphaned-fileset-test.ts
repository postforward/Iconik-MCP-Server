#!/usr/bin/env npx tsx

/**
 * TEST: Delete orphaned file set for a single asset
 *
 * This deletes the file set on the target storage that has no file records,
 * so reindex can recreate it properly with file records.
 */

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const assetId = args[0];
const storageArg = process.argv.find(a => a.startsWith('--storage='));
const storageName = storageArg?.split('=')[1];

if (!assetId || !storageName) {
  console.error('Usage: npx tsx scripts/delete-orphaned-fileset-test.ts <asset_id> --storage=NAME --profile=<name>');
  process.exit(1);
}

async function main() {
  // Get storages
  const storages = await iconikRequest<{ objects: Array<{ id: string; name: string }> }>('files/v1/storages/');
  const targetStorage = storages.objects.find(s => s.name === storageName);

  if (!targetStorage) {
    console.error(`Storage "${storageName}" not found`);
    console.error('Available storages:');
    storages.objects.forEach(s => console.error(`  - ${s.name}`));
    process.exit(1);
  }

  console.log('Asset ID:', assetId);
  console.log('Storage:', storageName, '(' + targetStorage.id + ')');

  // Get file sets
  const fileSets = await iconikRequest<{ objects: Array<{ id: string; name: string; base_dir: string; storage_id: string }> }>(
    `files/v1/assets/${assetId}/file_sets/`
  );
  console.log('\nFile sets before:', fileSets.objects?.length);

  // Get files
  const files = await iconikRequest<{ objects: Array<{ id: string; file_set_id: string }> }>(
    `files/v1/assets/${assetId}/files/`
  );
  console.log('Files:', files.objects?.length);

  for (const fs of fileSets.objects || []) {
    if (fs.storage_id === targetStorage.id) {
      const hasFiles = files.objects?.some(f => f.file_set_id === fs.id);
      console.log(`\n${storageName} FileSet:`, fs.id);
      console.log('  Name:', fs.name);
      console.log('  Base Dir:', fs.base_dir);
      console.log('  Has Files:', hasFiles);

      if (!hasFiles) {
        console.log('  -> Deleting orphaned file set...');
        await iconikRequest(`files/v1/assets/${assetId}/file_sets/${fs.id}/`, {
          method: 'DELETE'
        });
        console.log('  -> Deleted!');
      }
    }
  }

  // Verify
  const fileSetsAfter = await iconikRequest<{ objects: Array<{ id: string; name: string; storage_id: string }> }>(
    `files/v1/assets/${assetId}/file_sets/`
  );
  console.log('\nFile sets after:', fileSetsAfter.objects?.length);
  for (const fs of fileSetsAfter.objects || []) {
    const storName = fs.storage_id === targetStorage.id ? storageName : 'Other';
    console.log('  -', fs.name, '(' + storName + ')');
  }

  console.log('\nNow reindex the directory in Storage Gateway to recreate the file set with proper file records.');
}

main().catch(console.error);
