#!/usr/bin/env npx tsx

/**
 * DOMAIN STATS - Get storage and user statistics for a domain
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

interface Storage {
  id: string;
  name: string;
  purpose: string;
  status: string;
  files_count?: number;
  size?: number;
}

interface User {
  id: string;
  email: string;
  status: string;
}

interface PaginatedResponse<T> {
  objects: T[];
  total?: number;
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
  console.log(`DOMAIN STATISTICS`);
  console.log(`${"═".repeat(70)}`);
  console.log(`Profile: ${profile.name}\n`);

  // Get users
  console.log(`${"─".repeat(70)}`);
  console.log(`USERS`);
  console.log(`${"─".repeat(70)}`);

  try {
    const users = await iconikRequest<PaginatedResponse<User>>('users/v1/users/?per_page=500');
    const activeUsers = (users.objects || []).filter(u => u.status === 'ACTIVE');
    const inactiveUsers = (users.objects || []).filter(u => u.status !== 'ACTIVE');

    console.log(`Total users: ${users.objects?.length || 0}`);
    console.log(`Active: ${activeUsers.length}`);
    console.log(`Inactive/Other: ${inactiveUsers.length}`);
    console.log(`\nActive users:`);
    for (const u of activeUsers) {
      console.log(`  - ${u.email}`);
    }
  } catch (e) {
    console.log(`Error fetching users: ${e instanceof Error ? e.message : e}`);
  }

  // Get storages
  console.log(`\n${"─".repeat(70)}`);
  console.log(`STORAGES`);
  console.log(`${"─".repeat(70)}`);

  try {
    const storages = await iconikRequest<PaginatedResponse<Storage>>('files/v1/storages/');

    for (const storage of storages.objects || []) {
      console.log(`\n${storage.name}`);
      console.log(`  Purpose: ${storage.purpose}`);
      console.log(`  Status: ${storage.status}`);
      console.log(`  ID: ${storage.id}`);

      // Get storage stats
      try {
        const stats = await iconikRequest<{ files_count: number; size: number }>(
          `files/v1/storages/${storage.id}/stats/`
        );
        console.log(`  Files: ${stats.files_count?.toLocaleString() || 'N/A'}`);
        console.log(`  Size: ${stats.size ? formatBytes(stats.size) : 'N/A'}`);
      } catch {
        // Try getting files count directly
        try {
          const files = await iconikRequest<PaginatedResponse<unknown>>(
            `files/v1/storages/${storage.id}/files/?per_page=1`
          );
          console.log(`  Files: ~${files.total?.toLocaleString() || 'N/A'}`);
        } catch {
          console.log(`  Stats: N/A`);
        }
      }
    }
  } catch (e) {
    console.log(`Error fetching storages: ${e instanceof Error ? e.message : e}`);
  }

  // Get system domain info if available
  console.log(`\n${"─".repeat(70)}`);
  console.log(`BILLING INFO`);
  console.log(`${"─".repeat(70)}`);

  try {
    const billing = await iconikRequest<{
      storage_used?: number;
      storage_limit?: number;
      users_count?: number;
      users_limit?: number;
    }>('admin/v1/billing/');

    if (billing.storage_used !== undefined) {
      console.log(`Storage used: ${formatBytes(billing.storage_used)}`);
    }
    if (billing.storage_limit !== undefined) {
      console.log(`Storage limit: ${formatBytes(billing.storage_limit)}`);
    }
    if (billing.users_count !== undefined) {
      console.log(`Users: ${billing.users_count}`);
    }
    if (billing.users_limit !== undefined) {
      console.log(`Users limit: ${billing.users_limit}`);
    }
  } catch {
    console.log(`Billing info not accessible (may require admin permissions)`);
  }

  console.log('');
}

main().catch(console.error);
