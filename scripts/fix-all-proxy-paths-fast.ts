#!/usr/bin/env npx tsx

/**
 * FIX ALL PROXY PATHS (FAST) - Parallel processing version
 *
 * This script fixes proxy files that were moved by a server-side script:
 * - Original: {project}/{path}/filename_editproxy.ext
 * - New:      {project}/_Proxies/{path}/filename_Proxy.ext
 *
 * Uses parallel processing for ~10x speedup
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const isLive = process.argv.includes('--live');
const CONCURRENCY = 10; // Process 10 files at a time

interface Asset {
  id: string;
  title: string;
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
  asset_id: string;
}

interface Storage {
  id: string;
  name: string;
}

interface PaginatedResponse<T> {
  objects: T[];
  total?: number;
  pages?: number;
}

function transformPath(oldPath: string, oldName: string): { newPath: string; newName: string } | null {
  if (!oldName.toLowerCase().includes('_editproxy')) {
    return null;
  }

  const newName = oldName.replace(/_editproxy/gi, '_Proxy');
  const pathParts = oldPath.split('/');
  if (pathParts.length < 1) {
    return null;
  }

  const project = pathParts[0];
  const rest = pathParts.slice(1).join('/');
  const newPath = rest ? `${project}/_Proxies/${rest}` : `${project}/_Proxies`;

  return { newPath, newName };
}

async function processFile(file: File, trickStorageId: string): Promise<{ success: boolean; error?: string }> {
  const fileName = file.original_name || file.name;
  const transform = transformPath(file.directory_path, fileName);

  if (!transform) {
    return { success: false, error: 'No transform needed' };
  }

  try {
    // Find the file set with _editproxy in the name
    const fileSets = await iconikRequest<PaginatedResponse<FileSet>>(
      `files/v1/assets/${file.asset_id}/file_sets/?storage_id=${trickStorageId}`
    );

    const editProxyFileSet = fileSets.objects?.find(fs =>
      fs.name?.toLowerCase().includes('_editproxy')
    );

    // Update the file
    await iconikRequest(`files/v1/assets/${file.asset_id}/files/${file.id}/`, {
      method: 'PATCH',
      body: JSON.stringify({
        directory_path: transform.newPath,
        name: transform.newName,
        original_name: transform.newName,
        status: 'CLOSED'
      })
    });

    // Update the file set if found
    if (editProxyFileSet) {
      await iconikRequest(`files/v1/assets/${file.asset_id}/file_sets/${editProxyFileSet.id}/`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: transform.newName,
          base_dir: transform.newPath
        })
      });
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function processBatch(files: File[], trickStorageId: string, isLive: boolean): Promise<{ fixed: number; errors: number }> {
  if (!isLive) {
    return { fixed: files.length, errors: 0 };
  }

  const results = await Promise.all(
    files.map(file => processFile(file, trickStorageId))
  );

  const fixed = results.filter(r => r.success).length;
  const errors = results.filter(r => !r.success && r.error !== 'No transform needed').length;

  return { fixed, errors };
}

async function main() {
  const profile = getCurrentProfileInfo();
  const startTime = new Date();

  console.log(`\n${"═".repeat(70)}`);
  console.log(`FIX ALL PROXY PATHS - FAST PARALLEL VERSION`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Started: ${startTime.toISOString()}`);
  console.log(`Mode: ${isLive ? '🔴 LIVE - WILL UPDATE FILES' : '🟡 DRY RUN - No files will be updated'}`);
  console.log(`Concurrency: ${CONCURRENCY} parallel requests`);
  console.log(`${"═".repeat(70)}\n`);

  // Get storages
  const storages = await iconikRequest<PaginatedResponse<Storage>>('files/v1/storages/');
  const trickStorage = storages.objects.find(s => s.name === 'Trick');

  if (!trickStorage) {
    console.error('Could not find Trick storage');
    process.exit(1);
  }

  console.log(`Trick storage ID: ${trickStorage.id}\n`);

  let totalScanned = 0;
  let totalFound = 0;
  let totalFixed = 0;
  let totalErrors = 0;
  let consecutiveNoEditProxy = 0;
  const processedAssets = new Set<string>();
  const processedFileIds = new Set<string>(); // Track file IDs we've seen to detect when we've looped

  console.log('Scanning Trick storage for MISSING editproxy files...\n');

  // First, get total count
  const firstPage = await iconikRequest<PaginatedResponse<File>>(
    `files/v1/storages/${trickStorage.id}/files/?per_page=100&page=1&status=MISSING`
  );

  const initialTotal = firstPage.total || 0;
  console.log(`Total MISSING files on Trick storage: ${initialTotal.toLocaleString()}\n`);

  let page = 1;
  const maxPages = Math.ceil(initialTotal / 100) + 10;

  while (page <= maxPages) {
    try {
      const files = await iconikRequest<PaginatedResponse<File>>(
        `files/v1/storages/${trickStorage.id}/files/?per_page=100&page=${page}&status=MISSING`
      );

      if (!files.objects || files.objects.length === 0) {
        console.log(`Page ${page} is empty - finished scanning`);
        break;
      }

      // Check if we've seen these files before (means we've looped around)
      const firstFileId = files.objects[0]?.id;
      if (firstFileId && processedFileIds.has(firstFileId)) {
        console.log('Detected loop in pagination - restarting from page 1');
        page = 1;
        processedFileIds.clear();
        continue;
      }

      // Track file IDs we've seen
      for (const file of files.objects) {
        if (file.id) processedFileIds.add(file.id);
      }

      totalScanned += files.objects.length;

      // Filter to only editproxy files we haven't processed
      const editProxyFiles = files.objects.filter(file => {
        if (!file.asset_id || processedAssets.has(file.asset_id)) return false;
        const name = file.original_name || file.name || '';
        if (!name.toLowerCase().includes('_editproxy')) return false;
        processedAssets.add(file.asset_id);
        return true;
      });

      if (editProxyFiles.length === 0) {
        consecutiveNoEditProxy++;
        // If we've gone through 50 pages (5000 files) without finding any editproxy files, we're probably done
        if (consecutiveNoEditProxy >= 50) {
          console.log('No editproxy files found in last 50 pages - assuming complete');
          break;
        }
      } else {
        consecutiveNoEditProxy = 0;
        totalFound += editProxyFiles.length;

        // Process in batches of CONCURRENCY
        for (let i = 0; i < editProxyFiles.length; i += CONCURRENCY) {
          const batch = editProxyFiles.slice(i, i + CONCURRENCY);
          const result = await processBatch(batch, trickStorage.id, isLive);
          totalFixed += result.fixed;
          totalErrors += result.errors;
        }
      }

      // Progress update every 10 pages
      if (page % 10 === 0) {
        const elapsed = Math.round((Date.now() - startTime.getTime()) / 1000);
        const rate = totalFixed > 0 ? totalFixed / (elapsed / 60) : 0;
        const currentTotal = files.total || 0;
        console.log(`[Page ${page}] Scanned: ${totalScanned.toLocaleString()} | Found: ${totalFound} | Fixed: ${totalFixed} | Errors: ${totalErrors} | MISSING remaining: ${currentTotal} | ${elapsed}s | ${rate.toFixed(1)}/min`);
      }

      page++;

    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      if (errorMsg.includes('Page') && errorMsg.includes('does not exist')) {
        // Page doesn't exist anymore - files were fixed, restart from page 1
        console.log(`Page ${page} no longer exists - restarting from page 1`);
        page = 1;
        processedFileIds.clear();
        consecutiveNoEditProxy = 0;
      } else {
        console.log(`Error on page ${page}: ${errorMsg}`);
        page++;
      }
      // Small delay before retry
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  const endTime = new Date();
  const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Started: ${startTime.toISOString()}`);
  console.log(`Finished: ${endTime.toISOString()}`);
  console.log(`Duration: ${Math.floor(duration / 60)}m ${duration % 60}s`);
  console.log(`Files scanned: ${totalScanned.toLocaleString()}`);
  console.log(`Editproxy files found: ${totalFound}`);

  if (isLive) {
    console.log(`Files fixed: ${totalFixed}`);
    console.log(`Errors: ${totalErrors}`);
  } else {
    console.log(`\n🟡 DRY RUN - No files were updated`);
    console.log(`Run with --live to apply these changes`);
  }

  console.log('');
}

main().catch(console.error);
