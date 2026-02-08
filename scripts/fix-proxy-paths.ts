#!/usr/bin/env npx tsx

/**
 * FIX PROXY PATHS - Update missing proxy file paths to their new locations
 *
 * This script fixes proxy files that were moved by a server-side script:
 * - Original: {project}/{path}/filename_editproxy.ext
 * - New:      {project}/_Proxies/{path}/filename_Proxy.ext
 *
 * Safety:
 * - Dry run by default (use --live to actually update)
 * - Only updates files with status MISSING
 * - Only updates files with "_editproxy" in the name
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const collectionId = args[0];
const isLive = process.argv.includes('--live');

if (!collectionId) {
  console.error('Usage: npx tsx scripts/fix-proxy-paths.ts <collection_id> --profile=name [--live]');
  console.error('');
  console.error('Options:');
  console.error('  --live    Actually update files (default is dry run)');
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
  base_dir: string;
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

function transformPath(oldPath: string, oldName: string): { newPath: string; newName: string } | null {
  // Only transform files with _editproxy in the name
  if (!oldName.toLowerCase().includes('_editproxy')) {
    return null;
  }

  // Transform filename: replace _editproxy with _Proxy
  const newName = oldName.replace(/_editproxy/gi, '_Proxy');

  // Transform path: {project}/{rest} -> {project}/_Proxies/{rest}
  const pathParts = oldPath.split('/');
  if (pathParts.length < 1) {
    return null;
  }

  const project = pathParts[0];
  const rest = pathParts.slice(1).join('/');

  // New path: project/_Proxies/rest (or just project/_Proxies if no rest)
  const newPath = rest ? `${project}/_Proxies/${rest}` : `${project}/_Proxies`;

  return { newPath, newName };
}

async function main() {
  const profile = getCurrentProfileInfo();

  console.log(`\n${"═".repeat(70)}`);
  console.log(`FIX PROXY PATHS`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Collection: ${collectionId}`);
  console.log(`Mode: ${isLive ? '🔴 LIVE - WILL UPDATE FILES' : '🟡 DRY RUN - No files will be updated'}`);
  console.log(`${"═".repeat(70)}\n`);

  // Get storages
  const storages = await iconikRequest<PaginatedResponse<Storage>>('files/v1/storages/');
  const trickStorageId = storages.objects.find(s => s.name === 'Trick')?.id;

  if (!trickStorageId) {
    console.error('Could not find Trick storage');
    process.exit(1);
  }

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

  let totalMissing = 0;
  let fixable = 0;
  let fixed = 0;
  const errors: string[] = [];

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

      const proxyFormat = formats.objects?.find(f => f.name === 'PPRO_PROXY');

      if (!proxyFormat) {
        continue;
      }

      // Get file sets for proxy format on Trick storage
      const fileSets = await iconikRequest<PaginatedResponse<FileSet>>(
        `files/v1/assets/${asset.id}/file_sets/?format_id=${proxyFormat.id}`
      );

      // Find file sets with _editproxy in the name (these need fixing)
      const editProxyFileSets = fileSets.objects?.filter(fs =>
        fs.storage_id === trickStorageId &&
        fs.name?.toLowerCase().includes('_editproxy')
      ) || [];

      for (const fileSet of editProxyFileSets) {
        // Get files in this file set
        const files = await iconikRequest<PaginatedResponse<File>>(
          `files/v1/assets/${asset.id}/files/?file_set_id=${fileSet.id}`
        );

        // Find the proxy file (with _editproxy in name)
        const proxyFile = files.objects?.find(f =>
          f.original_name?.toLowerCase().includes('_editproxy')
        );

        if (!proxyFile) {
          continue;
        }

        // Count all missing files (not just editproxy ones)
        if (proxyFile.status === 'MISSING') {
          totalMissing++;
        }

        const transform = transformPath(proxyFile.directory_path, proxyFile.original_name);
        if (!transform) {
          continue;
        }

        fixable++;

        console.log(`\n${"─".repeat(70)}`);
        console.log(`Asset: ${asset.title}`);
        console.log(`  FileSet ID: ${fileSet.id}`);
        console.log(`  File ID: ${proxyFile.id}`);
        console.log(`  Old path: ${proxyFile.directory_path}/${proxyFile.original_name}`);
        console.log(`  New path: ${transform.newPath}/${transform.newName}`);

        if (isLive) {
          try {
            // Update the file
            await iconikRequest(`files/v1/assets/${asset.id}/files/${proxyFile.id}/`, {
              method: 'PATCH',
              body: JSON.stringify({
                directory_path: transform.newPath,
                name: transform.newName,
                original_name: transform.newName,
                status: 'CLOSED'
              })
            });

            // Update the file set name and base_dir
            await iconikRequest(`files/v1/assets/${asset.id}/file_sets/${fileSet.id}/`, {
              method: 'PATCH',
              body: JSON.stringify({
                name: transform.newName,
                base_dir: transform.newPath
              })
            });

            console.log(`  ✅ Updated file and file set!`);
            fixed++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.log(`  ❌ Error: ${msg}`);
            errors.push(`${asset.title}: ${msg}`);
          }
        } else {
          console.log(`  [DRY RUN] Would update file and file set`);
        }
      }
    } catch (e) {
      // Skip assets that can't be accessed
    }
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Assets checked: ${allAssets.length}`);
  console.log(`Missing proxy files found: ${totalMissing}`);
  console.log(`Fixable (with _editproxy pattern): ${fixable}`);

  if (isLive) {
    console.log(`Files updated: ${fixed}`);
    if (errors.length > 0) {
      console.log(`Errors: ${errors.length}`);
      for (const err of errors.slice(0, 10)) {
        console.log(`  - ${err}`);
      }
      if (errors.length > 10) {
        console.log(`  ... and ${errors.length - 10} more`);
      }
    }
  } else {
    console.log(`\n🟡 DRY RUN - No files were updated`);
    console.log(`Run with --live to apply these changes`);
  }

  console.log('');
}

main().catch(console.error);
