#!/usr/bin/env npx tsx

/**
 * TEST: Delete orphaned file set for a single asset
 *
 * This deletes the Mortar file set that has no file records,
 * so reindex can recreate it properly with file records.
 */

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const assetId = 'ef036206-a256-11f0-9fd9-4a7c5209f9ad';

async function main() {
  // Get storages
  const storages = await iconikRequest<{ objects: Array<{ id: string; name: string }> }>('files/v1/storages/');
  const mortarStorage = storages.objects.find(s => s.name === 'Mortar');

  if (!mortarStorage) {
    console.error('Mortar storage not found');
    process.exit(1);
  }

  console.log('Asset ID:', assetId);
  console.log('Mortar Storage ID:', mortarStorage.id);

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
    if (fs.storage_id === mortarStorage.id) {
      const hasFiles = files.objects?.some(f => f.file_set_id === fs.id);
      console.log('\nMortar FileSet:', fs.id);
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
    const storageName = fs.storage_id === mortarStorage.id ? 'Mortar' : 'Other';
    console.log('  -', fs.name, '(' + storageName + ')');
  }

  console.log('\nNow reindex the directory in Storage Gateway to recreate the file set with proper file records.');
}

main().catch(console.error);
