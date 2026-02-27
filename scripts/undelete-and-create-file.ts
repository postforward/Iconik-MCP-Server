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
const storageArg = process.argv.find(a => a.startsWith('--storage='));
const storageName = storageArg?.split('=')[1];

if (!assetId || !storageName) {
  console.error('Usage: npx tsx scripts/undelete-and-create-file.ts <asset_id> --storage=NAME --profile=<name>');
  process.exit(1);
}

async function main() {
  const storages = await iconikRequest<{ objects: Array<{ id: string; name: string }> }>('files/v1/storages/');
  const targetStorage = storages.objects.find(s => s.name === storageName);

  if (!targetStorage) {
    console.error(`Storage "${storageName}" not found`);
    console.error('Available storages:');
    storages.objects.forEach(s => console.error(`  - ${s.name}`));
    process.exit(1);
  }

  // Get asset info
  const asset = await iconikRequest<{ title: string }>(`assets/v1/assets/${assetId}/`);
  console.log('Asset:', asset.title);

  // Get file sets
  const fileSets = await iconikRequest<{ objects: Array<{ id: string; name: string; storage_id: string; base_dir: string; format_id: string; status: string }> }>(
    `files/v1/assets/${assetId}/file_sets/`
  );

  const targetFs = fileSets.objects?.find(fs => fs.storage_id === targetStorage.id);

  if (!targetFs) {
    console.log(`No ${storageName} file set found`);
    return;
  }

  console.log(`\n${storageName} file set:`, targetFs.id);
  console.log('  Status:', targetFs.status);
  console.log('  Name:', targetFs.name);
  console.log('  Path:', targetFs.base_dir);

  // Undelete the file set if needed
  if (targetFs.status === 'DELETED') {
    console.log('\nUndeleting file set...');
    await iconikRequest(`files/v1/assets/${assetId}/file_sets/${targetFs.id}/`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ACTIVE' })
    });
    console.log('  Done');
  }

  // Check for existing files
  const files = await iconikRequest<{ objects: Array<{ id: string; file_set_id: string }> }>(
    `files/v1/assets/${assetId}/files/`
  );
  const hasFile = files.objects?.some(f => f.file_set_id === targetFs.id);

  if (hasFile) {
    console.log('\nFile record already exists');
    return;
  }

  // Create file record (size 0 for now - remap should update it)
  console.log('\nCreating file record with size=0...');
  const newFile = await iconikRequest<{ id: string }>(`files/v1/assets/${assetId}/files/`, {
    method: 'POST',
    body: JSON.stringify({
      file_set_id: targetFs.id,
      format_id: targetFs.format_id,
      storage_id: targetFs.storage_id,
      name: targetFs.name,
      original_name: targetFs.name,
      directory_path: targetFs.base_dir,
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
