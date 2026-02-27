#!/usr/bin/env npx tsx

/**
 * Fix test asset by creating a file record with the actual file size
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
  const trickStorage = storages.objects.find(s => s.name === 'Trick');

  if (!mortarStorage || !trickStorage) {
    console.error('Storage not found');
    process.exit(1);
  }

  // Get file sets
  const fileSets = await iconikRequest<{ objects: Array<{ id: string; name: string; base_dir: string; storage_id: string; format_id: string; status: string }> }>(
    `files/v1/assets/${assetId}/file_sets/`
  );

  // First, undelete Trick file set if needed
  for (const fs of fileSets.objects || []) {
    if (fs.storage_id === trickStorage.id && fs.status === 'DELETED') {
      console.log('Undeleting Trick file set:', fs.id);
      await iconikRequest(`files/v1/assets/${assetId}/file_sets/${fs.id}/`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'ACTIVE' })
      });
    }
  }

  // Find the Mortar file set
  const mortarFileSet = fileSets.objects?.find(fs => fs.storage_id === mortarStorage.id);

  if (!mortarFileSet) {
    console.log('No Mortar file set found');
    return;
  }

  console.log('\nMortar file set:', mortarFileSet.id);
  console.log('  Name:', mortarFileSet.name);
  console.log('  Base Dir:', mortarFileSet.base_dir);
  console.log('  Format ID:', mortarFileSet.format_id);

  // Check if file record already exists
  const existingFiles = await iconikRequest<{ objects: Array<{ id: string; file_set_id: string }> }>(
    `files/v1/assets/${assetId}/files/`
  );

  const hasFileRecord = existingFiles.objects?.some(f => f.file_set_id === mortarFileSet.id);

  if (hasFileRecord) {
    console.log('\nFile record already exists for this file set');
    return;
  }

  // Create a file record for it with the actual size (40.96 GB)
  console.log('\nCreating file record with actual size (40.96 GB)...');

  try {
    const fileRecord = await iconikRequest<{ id: string; size: number; status: string }>(
      `files/v1/assets/${assetId}/files/`,
      {
        method: 'POST',
        body: JSON.stringify({
          file_set_id: mortarFileSet.id,
          format_id: mortarFileSet.format_id,
          storage_id: mortarFileSet.storage_id,
          name: mortarFileSet.name,
          original_name: mortarFileSet.name,
          directory_path: mortarFileSet.base_dir,
          status: 'CLOSED',
          type: 'FILE',
          size: 43980465766  // 40.96 GB in bytes
        })
      }
    );
    console.log('Created file record:', fileRecord.id);
    console.log('  Size:', fileRecord.size);
    console.log('  Status:', fileRecord.status);
  } catch (e) {
    console.log('Error creating file:', e instanceof Error ? e.message : String(e));
  }

  // Check final state
  const filesAfter = await iconikRequest<{ objects: Array<{ id: string; name: string; size: number; status: string }> }>(
    `files/v1/assets/${assetId}/files/`
  );
  console.log('\nFiles after:', filesAfter.objects?.length);
  for (const f of filesAfter.objects || []) {
    console.log('  -', f.name, '| Size:', f.size, '| Status:', f.status);
  }

  console.log('\nRefresh the asset page to see the changes.');
}

main().catch(console.error);
