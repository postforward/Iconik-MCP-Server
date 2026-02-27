#!/usr/bin/env npx tsx

/**
 * Undelete a file set and create a file record for it
 */

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const assetId = args[0];

if (!assetId) {
  console.error('Usage: npx tsx scripts/undelete-and-create-file.ts <asset_id> --profile=name');
  process.exit(1);
}

async function main() {
  const storages = await iconikRequest<{ objects: Array<{ id: string; name: string }> }>('files/v1/storages/');
  const mortarStorage = storages.objects.find(s => s.name === 'Mortar');

  if (!mortarStorage) {
    console.error('Mortar storage not found');
    process.exit(1);
  }

  // Get asset info
  const asset = await iconikRequest<{ title: string }>(`assets/v1/assets/${assetId}/`);
  console.log('Asset:', asset.title);

  // Get file sets
  const fileSets = await iconikRequest<{ objects: Array<{ id: string; name: string; storage_id: string; base_dir: string; format_id: string; status: string }> }>(
    `files/v1/assets/${assetId}/file_sets/`
  );

  const mortarFs = fileSets.objects?.find(fs => fs.storage_id === mortarStorage.id);

  if (!mortarFs) {
    console.log('No Mortar file set found');
    return;
  }

  console.log('\nMortar file set:', mortarFs.id);
  console.log('  Status:', mortarFs.status);
  console.log('  Name:', mortarFs.name);
  console.log('  Path:', mortarFs.base_dir);

  // Undelete the file set if needed
  if (mortarFs.status === 'DELETED') {
    console.log('\nUndeleting file set...');
    await iconikRequest(`files/v1/assets/${assetId}/file_sets/${mortarFs.id}/`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ACTIVE' })
    });
    console.log('  Done');
  }

  // Check for existing files
  const files = await iconikRequest<{ objects: Array<{ id: string; file_set_id: string }> }>(
    `files/v1/assets/${assetId}/files/`
  );
  const hasFile = files.objects?.some(f => f.file_set_id === mortarFs.id);

  if (hasFile) {
    console.log('\nFile record already exists');
    return;
  }

  // Create file record (size 0 for now - remap should update it)
  console.log('\nCreating file record with size=0...');
  const newFile = await iconikRequest<{ id: string }>(`files/v1/assets/${assetId}/files/`, {
    method: 'POST',
    body: JSON.stringify({
      file_set_id: mortarFs.id,
      format_id: mortarFs.format_id,
      storage_id: mortarFs.storage_id,
      name: mortarFs.name,
      original_name: mortarFs.name,
      directory_path: mortarFs.base_dir,
      status: 'CLOSED',
      type: 'FILE',
      size: 0
    })
  });
  console.log('  Created:', newFile.id);

  // Verify
  const filesAfter = await iconikRequest<{ objects: Array<{ id: string; name: string; size: number; status: string }> }>(
    `files/v1/assets/${assetId}/files/`
  );
  console.log('\nFiles now:');
  for (const f of filesAfter.objects || []) {
    console.log('  -', f.name, '| Size:', f.size, '| Status:', f.status);
  }

  console.log('\nNow do a REMAP in Storage Gateway to update the file size.');
}

main().catch(console.error);
