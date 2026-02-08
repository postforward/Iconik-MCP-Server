#!/usr/bin/env npx tsx

/**
 * CHECK ARCHIVING STATUS - Check if assets stuck in ARCHIVING actually have archives
 */

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const assetIds = args;

if (assetIds.length === 0) {
  console.error(`
Usage: npx tsx scripts/check-archiving-status.ts <asset_id> [asset_id...] [--profile=name] [--fix]

Examples:
  npx tsx scripts/check-archiving-status.ts abc-123 --profile=tm
  npx tsx scripts/check-archiving-status.ts abc-123 def-456 --profile=tm --fix
`);
  process.exit(1);
}

const shouldFix = process.argv.includes('--fix');

interface Asset {
  id: string;
  title: string;
  archive_status: string;
}

interface Format {
  id: string;
  name: string;
  archive_status: string;
}

interface FileSet {
  id: string;
  is_archive: boolean;
  storage_id: string;
}

interface PaginatedResponse<T> {
  objects: T[];
}

async function main() {
  console.log(`\nChecking ${assetIds.length} asset(s)...`);
  console.log(`Mode: ${shouldFix ? 'FIX (will update status)' : 'CHECK ONLY'}\n`);

  let needsFix = 0;
  let fixed = 0;

  for (const assetId of assetIds) {
    console.log(`${"─".repeat(60)}`);
    console.log(`Asset: ${assetId}`);

    try {
      const asset = await iconikRequest<Asset>(`assets/v1/assets/${assetId}/`);
      console.log(`Title: ${asset.title}`);
      console.log(`Asset archive_status: ${asset.archive_status}`);

      // Check file sets directly for archive
      const fileSets = await iconikRequest<PaginatedResponse<FileSet>>(
        `files/v1/assets/${assetId}/file_sets/`
      );

      let hasArchive = false;
      let archiveFileSet: FileSet | null = null;

      console.log(`\n  File Sets: ${fileSets.objects?.length || 0}`);
      for (const fs of fileSets.objects || []) {
        const archiveLabel = fs.is_archive ? '📦 ARCHIVE' : '';
        console.log(`    - ${fs.id} ${archiveLabel}`);
        if (fs.is_archive) {
          hasArchive = true;
          archiveFileSet = fs;
        }
      }

      if (hasArchive && asset.archive_status !== 'ARCHIVED') {
        needsFix++;
        console.log(`\n  ⚠️  STATUS MISMATCH - Has archive but status is ${asset.archive_status}`);

        if (shouldFix) {
          // Fix asset status
          await iconikRequest(`assets/v1/assets/${assetId}/`, {
            method: 'PATCH',
            body: JSON.stringify({ archive_status: 'ARCHIVED' })
          });
          console.log(`  ✅ Fixed asset archive_status -> ARCHIVED`);

          // Fix all format statuses too (this is what the Files view shows)
          const formats = await iconikRequest<PaginatedResponse<Format>>(
            `files/v1/assets/${assetId}/formats/`
          );
          for (const format of formats.objects || []) {
            if (format.archive_status !== 'ARCHIVED') {
              await iconikRequest(`files/v1/assets/${assetId}/formats/${format.id}/`, {
                method: 'PATCH',
                body: JSON.stringify({ archive_status: 'ARCHIVED' })
              });
              console.log(`  ✅ Fixed format ${format.name} archive_status -> ARCHIVED`);
            }
          }
          fixed++;
        }
      } else if (!hasArchive) {
        console.log(`\n  ℹ️  No archive file set - genuinely still archiving or not started`);
      } else {
        console.log(`\n  ✅ Status is correct`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ❌ Error: ${msg}`);
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Checked: ${assetIds.length}`);
  console.log(`Needs fix: ${needsFix}`);
  if (shouldFix) {
    console.log(`Fixed: ${fixed}`);
  } else if (needsFix > 0) {
    console.log(`\nRun with --fix to update status`);
  }
}

main().catch(console.error);
