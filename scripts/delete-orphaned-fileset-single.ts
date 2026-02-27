#!/usr/bin/env npx tsx

/**
 * Delete orphaned file set for a single asset on a specific storage
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
  console.error('Usage: npx tsx scripts/delete-orphaned-fileset-single.ts <asset_id> --storage=NAME --profile=<name>');
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

  // Get asset info
  const asset = await iconikRequest<{ title: string }>(`assets/v1/assets/${assetId}/`);
  console.log('Asset:', asset.title);
  console.log('Asset ID:', assetId);

  // Get file sets
  const fileSets = await iconikRequest<{ objects: Array<{ id: string; name: string; storage_id: string; base_dir: string }> }>(
    `files/v1/assets/${assetId}/file_sets/`
  );

  // Get files
  const files = await iconikRequest<{ objects: Array<{ id: string; file_set_id: string }> }>(
    `files/v1/assets/${assetId}/files/`
  );

  console.log('\nBefore deletion:');
  console.log('  File sets:', fileSets.objects?.length || 0);
  console.log('  Files:', files.objects?.length || 0);

  // Find and delete orphaned file sets on target storage
  for (const fs of fileSets.objects || []) {
    if (fs.storage_id === targetStorage.id) {
      const hasFiles = files.objects?.some(f => f.file_set_id === fs.id);

      console.log(`\n${storageName} FileSet:`, fs.id);
      console.log('  Name:', fs.name);
      console.log('  Path:', fs.base_dir);
      console.log('  Has files:', hasFiles);

      if (!hasFiles) {
        console.log('  -> Deleting orphaned file set...');
        try {
          await iconikRequest(`files/v1/assets/${assetId}/file_sets/${fs.id}/`, {
            method: 'DELETE'
          });
          console.log('  -> Deleted (soft delete)');
        } catch (e) {
          console.log('  -> Error:', e instanceof Error ? e.message : String(e));
        }
      }
    }
  }

  // Check state after
  const fileSetsAfter = await iconikRequest<{ objects: Array<{ id: string; name: string; storage_id: string; status: string }> }>(
    `files/v1/assets/${assetId}/file_sets/`
  );

  console.log('\nAfter deletion:');
  for (const fs of fileSetsAfter.objects || []) {
    const storName = fs.storage_id === targetStorage.id ? storageName : 'Other';
    console.log(`  - ${fs.name} (${storName}) - Status: ${fs.status}`);
  }

  console.log('\nNow reindex the directory in Storage Gateway.');
  console.log('Path:', fileSets.objects?.find(fs => fs.storage_id === targetStorage.id)?.base_dir);
}

main().catch(console.error);
