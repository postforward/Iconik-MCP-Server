#!/usr/bin/env npx tsx

/**
 * FIX PROXY PATHS - Update missing proxy file paths to their new locations
 *
 * This script fixes proxy files that were moved by a server-side script.
 * It transforms file paths based on configurable patterns.
 *
 * Default pattern (can be customized via --old-pattern and --new-pattern):
 * - Original: {project}/{path}/filename_editproxy.ext
 * - New:      {project}/_Proxies/{path}/filename_Proxy.ext
 *
 * Safety:
 * - Dry run by default (use --live to actually update)
 * - Only updates files with status MISSING
 * - Only updates files matching the old pattern
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const collectionId = args[0];
const isLive = process.argv.includes('--live');

// Parse optional flags
const storageArg = process.argv.find(a => a.startsWith('--storage='));
const formatArg = process.argv.find(a => a.startsWith('--format='));
const oldPatternArg = process.argv.find(a => a.startsWith('--old-pattern='));
const newPatternArg = process.argv.find(a => a.startsWith('--new-pattern='));
const newDirArg = process.argv.find(a => a.startsWith('--new-dir='));

const storageName = storageArg?.split('=')[1];
const formatName = formatArg?.split('=')[1] || 'PROXY';
const oldPattern = oldPatternArg?.split('=')[1] || '_editproxy';
const newPattern = newPatternArg?.split('=')[1] || '_Proxy';
const newProxyDir = newDirArg?.split('=')[1] || '_Proxies';

if (!collectionId) {
  console.error('Usage: npx tsx scripts/fix-proxy-paths.ts <collection_id> --profile=name [options]');
  console.error('');
  console.error('Options:');
  console.error('  --live              Actually update files (default is dry run)');
  console.error('  --storage=NAME      Storage to check for missing files');
  console.error('  --format=NAME       Proxy format name to look for (default: PROXY)');
  console.error('  --old-pattern=STR   Pattern to match in filenames (default: _editproxy)');
  console.error('  --new-pattern=STR   Replacement pattern for filenames (default: _Proxy)');
  console.error('  --new-dir=NAME      New subdirectory for proxies (default: _Proxies)');
  console.error('');
  console.error('Example:');
  console.error('  npx tsx scripts/fix-proxy-paths.ts abc123 --profile=myprofile --storage=MyStorage --live');
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
  // Only transform files matching the old pattern
  if (!oldName.toLowerCase().includes(oldPattern.toLowerCase())) {
    return null;
  }

  // Transform filename: replace old pattern with new pattern
  const newName = oldName.replace(new RegExp(oldPattern, 'gi'), newPattern);

  // Transform path: {project}/{rest} -> {project}/{newProxyDir}/{rest}
  const pathParts = oldPath.split('/');
  if (pathParts.length < 1) {
    return null;
  }

  const project = pathParts[0];
  const rest = pathParts.slice(1).join('/');

  // New path: project/newProxyDir/rest (or just project/newProxyDir if no rest)
  const newPath = rest ? `${project}/${newProxyDir}/${rest}` : `${project}/${newProxyDir}`;

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
  console.log(`Storage: ${storageName || '(all storages)'}`);
  console.log(`Format: ${formatName}`);
  console.log(`Pattern: ${oldPattern} → ${newPattern}`);
  console.log(`New directory: ${newProxyDir}`);
  console.log(`${"═".repeat(70)}\n`);

  // Get storages
  const storages = await iconikRequest<PaginatedResponse<Storage>>('files/v1/storages/');

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

      // Find file sets matching the old pattern (these need fixing)
      const matchingFileSets = fileSets.objects?.filter(fs => {
        if (targetStorageId && fs.storage_id !== targetStorageId) return false;
        return fs.name?.toLowerCase().includes(oldPattern.toLowerCase());
      }) || [];

      for (const fileSet of matchingFileSets) {
        // Get files in this file set
        const files = await iconikRequest<PaginatedResponse<File>>(
          `files/v1/assets/${asset.id}/files/?file_set_id=${fileSet.id}`
        );

        // Find the proxy file matching the old pattern
        const proxyFile = files.objects?.find(f =>
          f.original_name?.toLowerCase().includes(oldPattern.toLowerCase())
        );

        if (!proxyFile) {
          continue;
        }

        // Count all missing files
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
  console.log(`Fixable (matching '${oldPattern}' pattern): ${fixable}`);

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
