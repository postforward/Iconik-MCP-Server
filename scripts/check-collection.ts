#!/usr/bin/env npx tsx

/**
 * CHECK COLLECTION - Recursively scans a collection and its sub-collections
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const collectionId = args[0];
const showArchiveIssues = process.argv.includes('--archive-issues') || process.argv.includes('--failures');

if (!collectionId || collectionId.startsWith('--')) {
  console.error(`
Usage: npx tsx scripts/check-collection.ts <collection_id> [options]

Options:
  --profile=name      Use a specific profile
  --archive-issues    Only show assets with archive failures or stuck archiving

Examples:
  npx tsx scripts/check-collection.ts abc-123-def --profile=tm
  npx tsx scripts/check-collection.ts abc-123-def --profile=tm --archive-issues
`);
  process.exit(1);
}

interface Collection {
  id: string;
  title: string;
  status: string;
  date_created: string;
}

interface CollectionContent {
  id: string;
  object_type: string;
  title?: string;
  status?: string;
  archive_status?: string;
  is_online?: boolean;
  media_type?: string;
  date_modified?: string;
}

interface PaginatedResponse<T> {
  objects: T[];
  total: number;
  page: number;
  pages: number;
}

interface AssetStats {
  total: number;
  byArchiveStatus: Record<string, number>;
  failedAssets: CollectionContent[];
  archivingAssets: CollectionContent[];
}

const stats: AssetStats = {
  total: 0,
  byArchiveStatus: {},
  failedAssets: [],
  archivingAssets: []
};

async function scanCollection(colId: string, depth: number = 0, path: string = ""): Promise<void> {
  const indent = "  ".repeat(depth);

  // Get collection info
  let collection: Collection;
  try {
    collection = await iconikRequest<Collection>(`assets/v1/collections/${colId}/`);
  } catch (e) {
    console.error(`${indent}Error fetching collection ${colId}`);
    return;
  }

  const currentPath = path ? `${path} > ${collection.title}` : collection.title;

  if (!showArchiveIssues) {
    console.log(`${indent}📁 ${collection.title}`);
  }

  // Get all contents (paginated)
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const contents = await iconikRequest<PaginatedResponse<CollectionContent>>(
      `assets/v1/collections/${colId}/contents/?per_page=100&page=${page}`
    );

    for (const item of contents.objects || []) {
      if (item.object_type === 'collections') {
        // Recurse into sub-collection
        await scanCollection(item.id, depth + 1, currentPath);
      } else if (item.object_type === 'assets') {
        stats.total++;

        const archiveStatus = item.archive_status || 'UNKNOWN';
        stats.byArchiveStatus[archiveStatus] = (stats.byArchiveStatus[archiveStatus] || 0) + 1;

        if (archiveStatus === 'FAILED_TO_ARCHIVE') {
          stats.failedAssets.push({ ...item, title: `${currentPath} > ${item.title}` });
        } else if (archiveStatus === 'ARCHIVING') {
          stats.archivingAssets.push({ ...item, title: `${currentPath} > ${item.title}` });
        }

        if (!showArchiveIssues) {
          const icon = item.media_type === 'video' ? '🎬' :
                       item.media_type === 'audio' ? '🔊' :
                       item.media_type === 'image' ? '🖼️' : '📄';
          const archiveIcon = archiveStatus === 'ARCHIVED' ? '✅' :
                              archiveStatus === 'FAILED_TO_ARCHIVE' ? '❌' :
                              archiveStatus === 'ARCHIVING' ? '⏳' : '⬜';
          console.log(`${indent}  ${icon} ${archiveIcon} ${item.title}`);
        }
      }
    }

    hasMore = contents.pages > page;
    page++;
  }
}

async function main() {
  const profile = getCurrentProfileInfo();

  console.log(`\n${"═".repeat(70)}`);
  console.log("COLLECTION SCAN" + (showArchiveIssues ? " - ARCHIVE ISSUES" : ""));
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Collection: ${collectionId}`);
  console.log(`Mode: ${showArchiveIssues ? "Archive issues only" : "Full listing"}`);
  console.log("");

  if (!showArchiveIssues) {
    console.log("Scanning...\n");
    console.log("Legend: ✅ Archived  ⏳ Archiving  ❌ Failed  ⬜ Not Archived\n");
  } else {
    console.log("Scanning for archive issues...\n");
  }

  await scanCollection(collectionId);

  // Print summary
  console.log(`\n${"═".repeat(70)}`);
  console.log("SUMMARY");
  console.log(`${"═".repeat(70)}\n`);

  console.log(`Total assets: ${stats.total}\n`);

  console.log("Archive Status Breakdown:");
  console.log("─".repeat(40));
  for (const [status, count] of Object.entries(stats.byArchiveStatus).sort((a, b) => b[1] - a[1])) {
    const pct = stats.total > 0 ? ((count / stats.total) * 100).toFixed(1) : "0";
    console.log(`  ${status.padEnd(20)} ${String(count).padStart(6)} (${pct.padStart(5)}%)`);
  }

  if (stats.failedAssets.length > 0) {
    console.log(`\n${"!".repeat(70)}`);
    console.log(`❌ FAILED TO ARCHIVE: ${stats.failedAssets.length} assets`);
    console.log(`${"!".repeat(70)}\n`);

    for (const asset of stats.failedAssets) {
      console.log(`  • ${asset.title}`);
      console.log(`    ID: ${asset.id}`);
      if (asset.date_modified) console.log(`    Modified: ${asset.date_modified}`);
      console.log("");
    }
  }

  if (stats.archivingAssets.length > 0) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`⏳ CURRENTLY ARCHIVING: ${stats.archivingAssets.length} assets`);
    console.log(`${"─".repeat(70)}\n`);

    const now = Date.now();
    const stuckThreshold = 24 * 60 * 60 * 1000;

    for (const asset of stats.archivingAssets) {
      const modified = asset.date_modified ? new Date(asset.date_modified).getTime() : now;
      const isStuck = (now - modified) > stuckThreshold;
      const stuckLabel = isStuck ? " ⚠️ STUCK >24h" : "";

      console.log(`  • ${asset.title}${stuckLabel}`);
      console.log(`    ID: ${asset.id}`);
      if (asset.date_modified) console.log(`    Modified: ${asset.date_modified}`);
      console.log("");
    }
  }

  if (stats.failedAssets.length === 0 && stats.archivingAssets.length === 0) {
    console.log("\n✅ No archive issues found in this collection!");
  }
}

main().catch(console.error);
