#!/usr/bin/env npx tsx

/**
 * ANALYZE STORAGE - Deep dive into storage contents
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const storageId = args[0];

interface StorageFile {
  id: string;
  name: string;
  size: number;
  original_name?: string;
  format_id?: string;
  file_set_id?: string;
  asset_id?: string;
  date_created: string;
  file_type?: string;
}

interface PaginatedResponse<T> {
  objects: T[];
  total?: number;
  page?: number;
  pages?: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

async function main() {
  const profile = getCurrentProfileInfo();

  console.log(`\n${"═".repeat(70)}`);
  console.log(`STORAGE ANALYSIS`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Profile: ${profile.name}`);

  // Get all storages if no specific one provided
  const storages = await iconikRequest<PaginatedResponse<{ id: string; name: string; purpose: string }>>(
    'files/v1/storages/'
  );

  const targetStorages = storageId
    ? storages.objects.filter(s => s.id === storageId)
    : storages.objects;

  for (const storage of targetStorages) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`${storage.name} (${storage.purpose})`);
    console.log(`${"─".repeat(70)}`);

    // Sample files from this storage
    let totalSize = 0;
    let fileCount = 0;
    const fileTypes: Record<string, { count: number; size: number }> = {};
    const extensions: Record<string, { count: number; size: number }> = {};
    const formatTypes: Record<string, { count: number; size: number }> = {};
    const dateRanges: Record<string, number> = {};
    const sampleFiles: StorageFile[] = [];

    let page = 1;
    const maxPages = 20; // Sample up to 2000 files

    while (page <= maxPages) {
      try {
        const files = await iconikRequest<PaginatedResponse<StorageFile>>(
          `files/v1/storages/${storage.id}/files/?per_page=100&page=${page}`
        );

        if (!files.objects || files.objects.length === 0) break;

        for (const file of files.objects) {
          fileCount++;
          totalSize += file.size || 0;

          // Track by extension
          const ext = (file.name || file.original_name || '').split('.').pop()?.toLowerCase() || 'unknown';
          if (!extensions[ext]) extensions[ext] = { count: 0, size: 0 };
          extensions[ext].count++;
          extensions[ext].size += file.size || 0;

          // Track by file_type if available
          const ftype = file.file_type || 'unknown';
          if (!fileTypes[ftype]) fileTypes[ftype] = { count: 0, size: 0 };
          fileTypes[ftype].count++;
          fileTypes[ftype].size += file.size || 0;

          // Track by date (month)
          const month = file.date_created?.substring(0, 7) || 'unknown';
          dateRanges[month] = (dateRanges[month] || 0) + 1;

          // Keep some samples
          if (sampleFiles.length < 10) {
            sampleFiles.push(file);
          }
        }

        if (page === 1) {
          console.log(`Total files in storage: ${files.total?.toLocaleString() || 'unknown'}`);
        }

        if (!files.pages || page >= files.pages) break;
        page++;
      } catch (e) {
        console.log(`Error on page ${page}: ${e instanceof Error ? e.message : e}`);
        break;
      }
    }

    console.log(`\nSampled: ${fileCount.toLocaleString()} files`);
    console.log(`Sampled size: ${formatBytes(totalSize)}`);

    // Show breakdown by extension
    console.log(`\nBy Extension:`);
    const sortedExt = Object.entries(extensions)
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 15);
    for (const [ext, data] of sortedExt) {
      const pct = ((data.size / totalSize) * 100).toFixed(1);
      console.log(`  .${ext.padEnd(10)} ${data.count.toString().padStart(6)} files  ${formatBytes(data.size).padStart(12)}  (${pct}%)`);
    }

    // Show breakdown by file_type
    if (Object.keys(fileTypes).length > 1 || !fileTypes['unknown']) {
      console.log(`\nBy File Type:`);
      const sortedTypes = Object.entries(fileTypes)
        .sort((a, b) => b[1].size - a[1].size)
        .slice(0, 10);
      for (const [ftype, data] of sortedTypes) {
        console.log(`  ${ftype.padEnd(15)} ${data.count.toString().padStart(6)} files  ${formatBytes(data.size).padStart(12)}`);
      }
    }

    // Show by date
    console.log(`\nBy Month Created:`);
    const sortedDates = Object.entries(dateRanges).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12);
    for (const [month, count] of sortedDates) {
      console.log(`  ${month}: ${count.toLocaleString()} files`);
    }

    // Sample files
    console.log(`\nSample Files:`);
    for (const file of sampleFiles.slice(0, 5)) {
      console.log(`  - ${file.name || file.original_name}`);
      console.log(`    Size: ${formatBytes(file.size)} | Created: ${file.date_created?.substring(0, 10)}`);
      if (file.asset_id) console.log(`    Asset: ${file.asset_id}`);
    }
  }

  console.log('');
}

main().catch(console.error);
