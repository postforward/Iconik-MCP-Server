#!/usr/bin/env npx tsx

/**
 * RETRIGGER ARCHIVE - Retrigger archive jobs for specific assets
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const assetIds = args;

if (assetIds.length === 0) {
  console.error(`
Usage: npx tsx scripts/retrigger-archive.ts <asset_id> [asset_id...] [--profile=name]

Examples:
  npx tsx scripts/retrigger-archive.ts abc-123 --profile=tm
  npx tsx scripts/retrigger-archive.ts abc-123 def-456 ghi-789 --profile=tm
`);
  process.exit(1);
}

interface Storage {
  id: string;
  name: string;
  purpose: string;
}

interface PaginatedResponse<T> {
  objects: T[];
}

async function main() {
  const profile = getCurrentProfileInfo();

  console.log(`\n${"═".repeat(70)}`);
  console.log("RETRIGGER ARCHIVE JOBS");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Assets: ${assetIds.length}`);
  console.log("");

  // Find the archive storage
  const storages = await iconikRequest<PaginatedResponse<Storage>>('files/v1/storages/');
  const archiveStorage = storages.objects.find(s => s.purpose === 'ARCHIVE');

  if (!archiveStorage) {
    console.error("❌ No archive storage found!");
    process.exit(1);
  }

  console.log(`Using archive storage: ${archiveStorage.name} (${archiveStorage.id})\n`);

  let succeeded = 0;
  let failed = 0;

  for (const assetId of assetIds) {
    try {
      // First get asset info
      const asset = await iconikRequest<{ title: string; id: string }>(`assets/v1/assets/${assetId}/`);

      // Create archive job
      const job = await iconikRequest<{ id: string }>('jobs/v1/jobs/', {
        method: 'POST',
        body: JSON.stringify({
          type: 'ARCHIVE',
          object_type: 'assets',
          object_id: assetId,
          title: `Archive asset - ${asset.title}`,
          status: 'READY',
          metadata: {
            storage_id: archiveStorage.id
          }
        })
      });

      console.log(`✅ Created archive job: ${asset.title}`);
      console.log(`   Asset ID: ${assetId}`);
      console.log(`   Job ID: ${job.id}`);
      succeeded++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`❌ Failed: ${assetId}`);
      console.log(`   Error: ${msg}`);
      failed++;
    }
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);
  console.log(`\nJobs created! Check Iconik's job queue to monitor progress.`);
}

main().catch(console.error);
