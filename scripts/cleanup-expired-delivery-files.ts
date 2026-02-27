#!/usr/bin/env npx tsx

/**
 * Clean up file records older than X days from a specific storage
 * Used to remove orphaned records after GCS lifecycle deletes the actual files
 */

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const storageName = args[0];
const maxAgeDays = parseInt(args[1] || '90', 10);
const isLive = process.argv.includes('--live');

interface Storage {
  id: string;
  name: string;
}

interface FileRecord {
  id: string;
  name: string;
  asset_id: string;
  file_set_id: string;
  storage_id: string;
  date_created: string;
  status: string;
  size: number;
}

if (!storageName) {
  console.error('Usage: npx tsx scripts/cleanup-expired-delivery-files.ts <storage_name> [max_age_days] --profile=<name> [--live]');
  process.exit(1);
}

async function main() {
  console.log('Storage:', storageName);
  console.log('Max age:', maxAgeDays, 'days');
  console.log('Mode:', isLive ? '🔴 LIVE - WILL DELETE FILE RECORDS' : '🟡 DRY RUN');
  console.log('');

  // Find the storage
  const storages = await iconikRequest<{ objects: Storage[] }>('files/v1/storages/');
  const storage = storages.objects.find(s => s.name === storageName);

  if (!storage) {
    console.error(`Storage "${storageName}" not found.`);
    console.error('Available storages:');
    storages.objects.forEach(s => console.error(`  - ${s.name}`));
    process.exit(1);
  }

  console.log('Storage ID:', storage.id);
  console.log('');

  // Calculate cutoff date
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
  console.log('Cutoff date:', cutoffDate.toISOString());
  console.log('Files created before this date will be deleted.');
  console.log('');

  // Get all files from this storage
  // We need to paginate through all files
  let page = 1;
  let totalFiles = 0;
  let expiredFiles: FileRecord[] = [];
  let activeFiles = 0;

  console.log('Scanning storage for files...');

  while (true) {
    try {
      const response = await iconikRequest<{ objects: FileRecord[]; pages?: number }>(
        `files/v1/storages/${storage.id}/files/?per_page=100&page=${page}`
      );

      if (!response.objects || response.objects.length === 0) break;

      for (const file of response.objects) {
        totalFiles++;

        const fileDate = new Date(file.date_created);

        if (fileDate < cutoffDate && file.status !== 'DELETED') {
          expiredFiles.push(file);
        } else if (file.status !== 'DELETED') {
          activeFiles++;
        }
      }

      process.stdout.write(`\rScanned ${totalFiles} files, found ${expiredFiles.length} expired...`);

      if (response.objects.length < 100) break;
      page++;
    } catch (e) {
      console.error('\nError fetching files:', e instanceof Error ? e.message : String(e));
      break;
    }
  }

  console.log('\n');
  console.log('═'.repeat(50));
  console.log('SCAN RESULTS');
  console.log('═'.repeat(50));
  console.log(`Total files scanned: ${totalFiles}`);
  console.log(`Active files (< ${maxAgeDays} days): ${activeFiles}`);
  console.log(`Expired files (> ${maxAgeDays} days): ${expiredFiles.length}`);
  console.log('');

  if (expiredFiles.length === 0) {
    console.log('No expired files to clean up.');
    return;
  }

  // Show some examples
  console.log('Sample expired files:');
  for (const file of expiredFiles.slice(0, 10)) {
    const age = Math.floor((Date.now() - new Date(file.date_created).getTime()) / (1000 * 60 * 60 * 24));
    console.log(`  - ${file.name} (${age} days old, ${(file.size / 1024 / 1024).toFixed(1)} MB)`);
  }
  if (expiredFiles.length > 10) {
    console.log(`  ... and ${expiredFiles.length - 10} more`);
  }
  console.log('');

  if (!isLive) {
    console.log('🟡 DRY RUN - No files deleted');
    console.log(`Run with --live to delete ${expiredFiles.length} expired file records`);
    return;
  }

  // Delete expired files
  console.log('Deleting expired file records...');
  let deletedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < expiredFiles.length; i++) {
    const file = expiredFiles[i];

    try {
      await iconikRequest(`files/v1/assets/${file.asset_id}/files/${file.id}/`, {
        method: 'DELETE'
      });
      deletedCount++;
    } catch (e) {
      errorCount++;
      if (errorCount <= 5) {
        console.log(`  Error deleting ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if ((i + 1) % 10 === 0) {
      process.stdout.write(`\rDeleted ${deletedCount}/${expiredFiles.length} files...`);
    }
  }

  console.log('\n');
  console.log('═'.repeat(50));
  console.log('DELETION RESULTS');
  console.log('═'.repeat(50));
  console.log(`Deleted: ${deletedCount}`);
  if (errorCount > 0) {
    console.log(`Errors: ${errorCount}`);
  }
}

main().catch(console.error);
