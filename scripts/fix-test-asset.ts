#!/usr/bin/env npx tsx

/**
 * Fix a single test asset by creating a file record with a specified file size
 */

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const assetId = args[0];
const storageArg = process.argv.find(a => a.startsWith('--storage='));
const storageName = storageArg?.split('=')[1];
const sizeArg = process.argv.find(a => a.startsWith('--size='));
const fileSize = sizeArg ? parseInt(sizeArg.split('=')[1], 10) : 0;

if (!assetId || !storageName) {
  console.error('Usage: npx tsx scripts/fix-test-asset.ts <asset_id> --storage=NAME --profile=<name> [--size=BYTES]');
  console.error('');
  console.error('Options:');
  console.error('  --storage=NAME   Storage to target (REQUIRED)');
  console.error('  --size=BYTES     File size in bytes (default: 0)');
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

  // Get file sets
  const fileSets = await iconikRequest<{ objects: Array<{ id: string; name: string; base_dir: string; storage_id: string; format_id: string; status: string }> }>(
    `files/v1/assets/${assetId}/file_sets/`
  );

  // Undelete file sets on target storage if needed
  for (const fs of fileSets.objects || []) {
    if (fs.storage_id === targetStorage.id && fs.status === 'DELETED') {
      console.log(`Undeleting ${storageName} file set:`, fs.id);
      await iconikRequest(`files/v1/assets/${assetId}/file_sets/${fs.id}/`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'ACTIVE' })
      });
    }
  }

  // Find the target file set
  const targetFileSet = fileSets.objects?.find(fs => fs.storage_id === targetStorage.id);

  if (!targetFileSet) {
    console.log(`No ${storageName} file set found`);
    return;
  }

  console.log(`\n${storageName} file set:`, targetFileSet.id);
  console.log('  Name:', targetFileSet.name);
  console.log('  Base Dir:', targetFileSet.base_dir);
  console.log('  Format ID:', targetFileSet.format_id);

  // Check if file record already exists
  const existingFiles = await iconikRequest<{ objects: Array<{ id: string; file_set_id: string }> }>(
    `files/v1/assets/${assetId}/files/`
  );

  const hasFileRecord = existingFiles.objects?.some(f => f.file_set_id === targetFileSet.id);

  if (hasFileRecord) {
    console.log('\nFile record already exists for this file set');
    return;
  }

  // Create a file record
  const sizeLabel = fileSize > 0 ? `${(fileSize / 1024 / 1024 / 1024).toFixed(2)} GB` : '0';
  console.log(`\nCreating file record with size ${sizeLabel}...`);

  try {
    const fileRecord = await iconikRequest<{ id: string; size: number; status: string }>(
      `files/v1/assets/${assetId}/files/`,
      {
        method: 'POST',
        body: JSON.stringify({
          file_set_id: targetFileSet.id,
          format_id: targetFileSet.format_id,
          storage_id: targetFileSet.storage_id,
          name: targetFileSet.name,
          original_name: targetFileSet.name,
          directory_path: targetFileSet.base_dir,
          status: 'CLOSED',
          type: 'FILE',
          size: fileSize
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
