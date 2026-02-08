#!/usr/bin/env npx tsx

/**
 * FIX FORMAT STATUS - Fix format archive_status for assets
 */

import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const assetIds = args;

if (assetIds.length === 0) {
  console.error(`
Usage: npx tsx scripts/fix-format-status.ts <asset_id> [asset_id...] [--profile=name]
`);
  process.exit(1);
}

interface Format {
  id: string;
  name: string;
  archive_status: string;
}

interface PaginatedResponse<T> {
  objects: T[];
}

async function main() {
  console.log(`\nFixing format status for ${assetIds.length} asset(s)...\n`);

  for (const assetId of assetIds) {
    console.log(`Asset: ${assetId}`);

    try {
      const formats = await iconikRequest<PaginatedResponse<Format>>(
        `files/v1/assets/${assetId}/formats/`
      );

      for (const format of formats.objects || []) {
        console.log(`  Format: ${format.name} - current status: ${format.archive_status}`);

        if (format.archive_status !== 'ARCHIVED') {
          await iconikRequest(`files/v1/assets/${assetId}/formats/${format.id}/`, {
            method: 'PATCH',
            body: JSON.stringify({ archive_status: 'ARCHIVED' })
          });
          console.log(`    ✅ Updated to ARCHIVED`);
        } else {
          console.log(`    Already ARCHIVED`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ❌ Error: ${msg}`);
    }
    console.log('');
  }

  console.log('Done!');
}

main().catch(console.error);
