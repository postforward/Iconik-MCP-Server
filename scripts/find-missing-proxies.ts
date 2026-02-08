#!/usr/bin/env npx tsx

/**
 * FIND MISSING PROXIES - Find assets with missing PPRO_PROXY files
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const collectionId = args[0];

if (!collectionId) {
  console.error('Usage: npx tsx scripts/find-missing-proxies.ts <collection_id> --profile=name');
  process.exit(1);
}

interface Asset {
  id: string;
  title: string;
}

interface Format {
  id: string;
  name: string;
  status: string;
}

interface FileSet {
  id: string;
  name: string;
  storage_id: string;
  format_id: string;
}

interface File {
  id: string;
  name: string;
  original_name: string;
  directory_path: string;
  status: string;
  storage_id: string;
}

interface Storage {
  id: string;
  name: string;
}

interface CollectionContent {
  id: string;
  object_type: string;
  title?: string;
}

interface PaginatedResponse<T> {
  objects: T[];
}

async function main() {
  const profile = getCurrentProfileInfo();

  console.log(`\n${"═".repeat(70)}`);
  console.log(`FIND MISSING PROXIES`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Collection: ${collectionId}\n`);

  // Get storages
  const storages = await iconikRequest<PaginatedResponse<Storage>>('files/v1/storages/');
  const storageMap = new Map(storages.objects.map(s => [s.id, s.name]));
  const trickStorageId = storages.objects.find(s => s.name === 'Trick')?.id;

  console.log(`Trick storage ID: ${trickStorageId}\n`);

  // Get collection info
  const collection = await iconikRequest<{ title: string }>(`assets/v1/collections/${collectionId}/`);
  console.log(`Collection: ${collection.title}\n`);

  // Recursively get all assets
  const allAssets: CollectionContent[] = [];

  async function scanCollection(colId: string): Promise<void> {
    let page = 1;
    while (true) {
      const contents = await iconikRequest<PaginatedResponse<CollectionContent>>(
        `assets/v1/collections/${colId}/contents/?per_page=100&page=${page}`
      );

      if (!contents.objects || contents.objects.length === 0) break;

      for (const item of contents.objects) {
        if (item.object_type === 'assets') {
          allAssets.push(item);
        } else if (item.object_type === 'collections') {
          await scanCollection(item.id);
        }
      }

      page++;
      if (contents.objects.length < 100) break;
    }
  }

  console.log('Scanning collection recursively...');
  await scanCollection(collectionId);
  console.log(`Found ${allAssets.length} assets\n`);

  const missingProxies: Array<{
    asset: Asset;
    proxyFormat?: Format;
    proxyFile?: File;
    originalPath?: string;
  }> = [];

  for (const item of allAssets) {
    const asset = await iconikRequest<Asset>(`assets/v1/assets/${item.id}/`);

    // Get formats
    const formats = await iconikRequest<PaginatedResponse<Format>>(
      `files/v1/assets/${asset.id}/formats/`
    );

    const proxyFormat = formats.objects?.find(f => f.name === 'PPRO_PROXY');

    if (!proxyFormat) {
      // No proxy format at all - might be non-video
      continue;
    }

    // Get file sets for proxy format
    const fileSets = await iconikRequest<PaginatedResponse<FileSet>>(
      `files/v1/assets/${asset.id}/file_sets/?format_id=${proxyFormat.id}`
    );

    // Look for file sets on Trick storage
    const trickFileSet = fileSets.objects?.find(fs => fs.storage_id === trickStorageId);

    if (!trickFileSet) {
      continue;
    }

    // Get files in this file set
    const files = await iconikRequest<PaginatedResponse<File>>(
      `files/v1/assets/${asset.id}/files/?file_set_id=${trickFileSet.id}`
    );

    const proxyFile = files.objects?.[0];

    if (proxyFile && proxyFile.status === 'MISSING') {
      // Get original file path for context
      const originalFormat = formats.objects?.find(f => f.name === 'ORIGINAL');
      let originalPath = '';

      if (originalFormat) {
        const origFileSets = await iconikRequest<PaginatedResponse<FileSet>>(
          `files/v1/assets/${asset.id}/file_sets/?format_id=${originalFormat.id}`
        );
        const origTrickFileSet = origFileSets.objects?.find(fs => fs.storage_id === trickStorageId);
        if (origTrickFileSet) {
          const origFiles = await iconikRequest<PaginatedResponse<File>>(
            `files/v1/assets/${asset.id}/files/?file_set_id=${origTrickFileSet.id}`
          );
          if (origFiles.objects?.[0]) {
            originalPath = origFiles.objects[0].directory_path + origFiles.objects[0].original_name;
          }
        }
      }

      missingProxies.push({
        asset,
        proxyFormat,
        proxyFile,
        originalPath
      });
    }
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`MISSING PROXIES: ${missingProxies.length}`);
  console.log(`${"═".repeat(70)}\n`);

  for (const mp of missingProxies.slice(0, 20)) {
    console.log(`Asset: ${mp.asset.title}`);
    console.log(`  Asset ID: ${mp.asset.id}`);
    console.log(`  Original: ${mp.originalPath}`);
    console.log(`  Proxy file: ${mp.proxyFile?.directory_path}${mp.proxyFile?.original_name}`);
    console.log(`  Proxy file ID: ${mp.proxyFile?.id}`);

    // Calculate expected new path
    if (mp.proxyFile) {
      const oldPath = mp.proxyFile.directory_path + mp.proxyFile.original_name;
      // Pattern: project/path/file_editproxy.ext -> project/_Proxies/path/file_Proxy.ext
      const parts = oldPath.split('/');
      const project = parts[0];
      const rest = parts.slice(1).join('/');
      const newPath = `${project}/_Proxies/${rest}`.replace('_editproxy', '_Proxy');
      console.log(`  Expected new path: ${newPath}`);
    }
    console.log('');
  }

  if (missingProxies.length > 20) {
    console.log(`... and ${missingProxies.length - 20} more`);
  }
}

main().catch(console.error);
