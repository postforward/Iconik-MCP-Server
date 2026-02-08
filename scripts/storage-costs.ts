#!/usr/bin/env npx tsx

/**
 * STORAGE COSTS - Estimate Iconik storage costs
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

interface StorageFile {
  id: string;
  name: string;
  size: number;
}

interface Storage {
  id: string;
  name: string;
  purpose: string;
}

interface PaginatedResponse<T> {
  objects: T[];
  total?: number;
  pages?: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

async function getStorageSize(storageId: string, storageName: string): Promise<{ files: number; size: number; isIconikManaged: boolean }> {
  const isIconikManaged = storageName.toLowerCase().includes('iconik-');

  let totalSize = 0;
  let fileCount = 0;
  let page = 1;

  // For iconik-managed storage, get full count; for others, sample
  const maxPages = isIconikManaged ? 1000 : 5;

  while (page <= maxPages) {
    try {
      const files = await iconikRequest<PaginatedResponse<StorageFile>>(
        `files/v1/storages/${storageId}/files/?per_page=100&page=${page}`
      );

      if (!files.objects || files.objects.length === 0) break;

      for (const file of files.objects) {
        fileCount++;
        totalSize += file.size || 0;
      }

      if (!files.pages || page >= files.pages) break;
      page++;

      // Progress indicator for large scans
      if (page % 50 === 0) {
        process.stdout.write(`  Scanning ${storageName}: ${fileCount} files...\r`);
      }
    } catch {
      break;
    }
  }

  return { files: fileCount, size: totalSize, isIconikManaged };
}

async function main() {
  const profile = getCurrentProfileInfo();

  console.log(`\n${"═".repeat(70)}`);
  console.log(`ICONIK STORAGE COST ANALYSIS`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Profile: ${profile.name}\n`);

  const storages = await iconikRequest<PaginatedResponse<Storage>>('files/v1/storages/');

  let iconikManagedTotal = 0;
  let iconikManagedFiles = 0;
  let customerStorageTotal = 0;
  let customerStorageFiles = 0;

  const results: Array<{
    name: string;
    purpose: string;
    files: number;
    size: number;
    isIconikManaged: boolean;
  }> = [];

  for (const storage of storages.objects) {
    console.log(`Analyzing: ${storage.name}...`);
    const stats = await getStorageSize(storage.id, storage.name);

    results.push({
      name: storage.name,
      purpose: storage.purpose,
      ...stats
    });

    if (stats.isIconikManaged) {
      iconikManagedTotal += stats.size;
      iconikManagedFiles += stats.files;
    } else {
      customerStorageTotal += stats.size;
      customerStorageFiles += stats.files;
    }
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`ICONIK-MANAGED STORAGE (billable)`);
  console.log(`${"─".repeat(70)}`);

  const iconikStorages = results.filter(r => r.isIconikManaged);
  for (const s of iconikStorages) {
    console.log(`  ${s.name.padEnd(25)} ${s.files.toString().padStart(8)} files  ${formatBytes(s.size).padStart(12)}`);
  }
  console.log(`  ${"─".repeat(55)}`);
  console.log(`  ${"TOTAL".padEnd(25)} ${iconikManagedFiles.toString().padStart(8)} files  ${formatBytes(iconikManagedTotal).padStart(12)}`);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`CUSTOMER-MANAGED STORAGE (not billable by Iconik)`);
  console.log(`${"─".repeat(70)}`);

  const customerStorages = results.filter(r => !r.isIconikManaged);
  for (const s of customerStorages) {
    console.log(`  ${s.name.padEnd(25)} ${s.files.toString().padStart(8)} files  ${formatBytes(s.size).padStart(12)}`);
  }
  console.log(`  ${"─".repeat(55)}`);
  console.log(`  ${"TOTAL".padEnd(25)} ${customerStorageFiles.toString().padStart(8)} files  ${formatBytes(customerStorageTotal).padStart(12)}`);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Iconik-managed storage: ${formatBytes(iconikManagedTotal)} (${iconikManagedFiles.toLocaleString()} files)`);
  console.log(`Customer storage: ${formatBytes(customerStorageTotal)} (${customerStorageFiles.toLocaleString()} files)`);

  // Rough cost estimate (Iconik charges vary, but ballpark)
  const gbUsed = iconikManagedTotal / (1024 * 1024 * 1024);
  console.log(`\nEstimated Iconik storage: ~${gbUsed.toFixed(1)} GB`);
  console.log(`(Note: Iconik pricing varies by plan - check your contract for actual rates)`);
  console.log('');
}

main().catch(console.error);
