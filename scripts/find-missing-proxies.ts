#!/usr/bin/env npx tsx

/**
 * FIND MISSING PROXIES - Find assets with missing proxy files on a storage
 *
 * Scans a collection for assets with a specified proxy format that have
 * files with MISSING status on the specified storage.
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

// Parse arguments
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const collectionId = args[0];

// Parse optional flags
const storageArg = process.argv.find(a => a.startsWith('--storage='));
const formatArg = process.argv.find(a => a.startsWith('--format='));
const storageName = storageArg?.split('=')[1];
const formatName = formatArg?.split('=')[1] || 'PROXY'; // Default to common proxy format name

if (!collectionId) {
  console.error('Usage: npx tsx scripts/find-missing-proxies.ts <collection_id> --profile=name [--storage=StorageName] [--format=FormatName]');
  console.error('');
  console.error('Options:');
  console.error('  --storage=NAME   Storage to check for missing files (if not specified, checks all storages)');
  console.error('  --format=NAME    Proxy format name to look for (default: PROXY)');
  console.error('');
  console.error('Example: npx tsx scripts/find-missing-proxies.ts abc123 --profile=myprofile --storage=MyStorage --format=PROXY');
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
  console.log(`Collection: ${collectionId}`);
  console.log(`Format: ${formatName}`);
  console.log(`Storage filter: ${storageName || '(all storages)'}\n`);

  // Get storages
  const storages = await iconikRequest<PaginatedResponse<Storage>>('files/v1/storages/');
  const storageMap = new Map(storages.objects.map(s => [s.id, s.name]));

  let targetStorageId: string | undefined;
  if (storageName) {
    const storage = storages.objects.find(s => s.name === storageName);
    if (!storage) {
      console.error(`Storage '${storageName}' not found. Available storages:`);
      for (const s of storages.objects) {
        console.error(`  - ${s.name}`);
      }
      process.exit(1);
    }
    targetStorageId = storage.id;
    console.log(`Target storage ID: ${targetStorageId}\n`);
  }

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
    storageName?: string;
    originalPath?: string;
  }> = [];

  for (let i = 0; i < allAssets.length; i++) {
    const item = allAssets[i];

    if ((i + 1) % 50 === 0) {
      process.stdout.write(`  Checking asset ${i + 1}/${allAssets.length}...\r`);
    }

    try {
      const asset = await iconikRequest<Asset>(`assets/v1/assets/${item.id}/`);

      // Get formats
      const formats = await iconikRequest<PaginatedResponse<Format>>(
        `files/v1/assets/${asset.id}/formats/`
      );

      // Find proxy format (case-insensitive partial match)
      const proxyFormat = formats.objects?.find(f =>
        f.name.toUpperCase().includes(formatName.toUpperCase())
      );

      if (!proxyFormat) {
        continue;
      }

      // Get file sets for proxy format
      const fileSets = await iconikRequest<PaginatedResponse<FileSet>>(
        `files/v1/assets/${asset.id}/file_sets/?format_id=${proxyFormat.id}`
      );

      // Filter to target storage if specified
      const targetFileSets = targetStorageId
        ? fileSets.objects?.filter(fs => fs.storage_id === targetStorageId)
        : fileSets.objects;

      if (!targetFileSets || targetFileSets.length === 0) {
        continue;
      }

      for (const fileSet of targetFileSets) {
        // Get files in this file set
        const files = await iconikRequest<PaginatedResponse<File>>(
          `files/v1/assets/${asset.id}/files/?file_set_id=${fileSet.id}`
        );

        const proxyFile = files.objects?.[0];

        if (proxyFile && proxyFile.status === 'MISSING') {
          // Get original file path for context
          const originalFormat = formats.objects?.find(f => f.name === 'ORIGINAL');
          let originalPath = '';

          if (originalFormat && targetStorageId) {
            const origFileSets = await iconikRequest<PaginatedResponse<FileSet>>(
              `files/v1/assets/${asset.id}/file_sets/?format_id=${originalFormat.id}`
            );
            const origFileSet = origFileSets.objects?.find(fs => fs.storage_id === targetStorageId);
            if (origFileSet) {
              const origFiles = await iconikRequest<PaginatedResponse<File>>(
                `files/v1/assets/${asset.id}/files/?file_set_id=${origFileSet.id}`
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
            storageName: storageMap.get(fileSet.storage_id),
            originalPath
          });
        }
      }
    } catch (e) {
      // Skip assets that can't be accessed
    }
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`MISSING PROXIES: ${missingProxies.length}`);
  console.log(`${"═".repeat(70)}\n`);

  for (const mp of missingProxies.slice(0, 20)) {
    console.log(`Asset: ${mp.asset.title}`);
    console.log(`  Asset ID: ${mp.asset.id}`);
    console.log(`  Storage: ${mp.storageName}`);
    if (mp.originalPath) {
      console.log(`  Original: ${mp.originalPath}`);
    }
    console.log(`  Proxy file: ${mp.proxyFile?.directory_path}${mp.proxyFile?.original_name}`);
    console.log(`  Proxy file ID: ${mp.proxyFile?.id}`);
    console.log(`  Status: ${mp.proxyFile?.status}`);
    console.log('');
  }

  if (missingProxies.length > 20) {
    console.log(`... and ${missingProxies.length - 20} more`);
  }
}

main().catch(console.error);
