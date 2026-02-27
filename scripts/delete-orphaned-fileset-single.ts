#!/usr/bin/env npx tsx

/**
 * Delete orphaned Mortar file set for a single asset to test reindex
 */

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const assetId = args[0];

if (!assetId) {
  console.error('Usage: npx tsx scripts/delete-orphaned-fileset-single.ts <asset_id> --profile=name');
  process.exit(1);
}

async function main() {
  // Get storages
  const storages = await iconikRequest<{ objects: Array<{ id: string; name: string }> }>('files/v1/storages/');
  const mortarStorage = storages.objects.find(s => s.name === 'Mortar');

  if (!mortarStorage) {
    console.error('Mortar storage not found');
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

  // Find and delete orphaned Mortar file sets
  for (const fs of fileSets.objects || []) {
    if (fs.storage_id === mortarStorage.id) {
      const hasFiles = files.objects?.some(f => f.file_set_id === fs.id);

      console.log('\nMortar FileSet:', fs.id);
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
    const storageName = fs.storage_id === mortarStorage.id ? 'Mortar' : 'Other';
    console.log(`  - ${fs.name} (${storageName}) - Status: ${fs.status}`);
  }

  console.log('\nNow reindex the directory in Storage Gateway.');
  console.log('Path:', fileSets.objects?.find(fs => fs.storage_id === mortarStorage.id)?.base_dir);
}

main().catch(console.error);
