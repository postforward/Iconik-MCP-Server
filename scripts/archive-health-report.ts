#!/usr/bin/env npx ts-node

/**
 * ARCHIVE HEALTH REPORT
 *
 * Monitors archive status across your Iconik assets:
 * - Counts by archive status
 * - Lists failed archives with details
 * - Identifies potentially stuck archiving jobs
 * - Shows recently archived assets
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.js";
import { getProfileFromArgs } from "../src/config.js";

// Initialize with profile from args
const profileName = getProfileFromArgs();
initializeProfile(profileName);

interface SearchResponse {
  objects: Array<{
    id: string;
    title: string;
    archive_status: string;
    status: string;
    is_online: boolean;
    date_created: string;
    date_modified: string;
  }>;
  total: number;
  page: number;
  pages: number;
}

async function countByArchiveStatus(status: string): Promise<number> {
  const res = await iconikRequest<SearchResponse>("search/v1/search/", {
    method: "POST",
    body: JSON.stringify({
      query: "*",
      doc_types: ["assets"],
      filter: {
        operator: "AND",
        terms: [{ name: "archive_status", value: status }]
      },
      per_page: 1
    })
  });
  return res.total;
}

async function getAssetsByArchiveStatus(status: string, limit: number = 10): Promise<SearchResponse["objects"]> {
  const res = await iconikRequest<SearchResponse>("search/v1/search/", {
    method: "POST",
    body: JSON.stringify({
      query: "*",
      doc_types: ["assets"],
      filter: {
        operator: "AND",
        terms: [{ name: "archive_status", value: status }]
      },
      per_page: limit,
      sort: [{ name: "date_modified", order: "desc" }]
    })
  });
  return res.objects || [];
}

async function getTotalAssets(): Promise<number> {
  const res = await iconikRequest<SearchResponse>("search/v1/search/", {
    method: "POST",
    body: JSON.stringify({
      query: "*",
      doc_types: ["assets"],
      per_page: 1
    })
  });
  return res.total;
}

async function runReport() {
  const profile = getCurrentProfileInfo();
  console.log(`\n${"═".repeat(70)}`);
  console.log("                    ARCHIVE HEALTH REPORT");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Generated: ${new Date().toISOString()}\n`);

  // Get counts for each archive status
  const statuses = ["NOT_ARCHIVED", "ARCHIVING", "ARCHIVED", "FAILED_TO_ARCHIVE"];
  const counts: Record<string, number> = {};

  console.log("Gathering statistics...\n");

  const total = await getTotalAssets();
  console.log(`Total assets in system: ${total}\n`);

  console.log("Archive Status Breakdown:");
  console.log("─".repeat(40));

  for (const status of statuses) {
    counts[status] = await countByArchiveStatus(status);
    const pct = total > 0 ? ((counts[status] / total) * 100).toFixed(1) : "0";
    const bar = "█".repeat(Math.round(counts[status] / total * 30));
    console.log(`  ${status.padEnd(20)} ${String(counts[status]).padStart(6)} (${pct.padStart(5)}%) ${bar}`);
  }

  console.log("─".repeat(40));

  // Detailed sections for problem statuses
  if (counts["FAILED_TO_ARCHIVE"] > 0) {
    console.log(`\n${"!".repeat(70)}`);
    console.log("⚠️  FAILED ARCHIVES DETECTED");
    console.log(`${"!".repeat(70)}\n`);

    const failed = await getAssetsByArchiveStatus("FAILED_TO_ARCHIVE", 20);
    console.log(`Showing ${failed.length} of ${counts["FAILED_TO_ARCHIVE"]} failed assets:\n`);

    for (const asset of failed) {
      console.log(`  • ${asset.title}`);
      console.log(`    ID: ${asset.id}`);
      console.log(`    Modified: ${asset.date_modified}`);
      console.log(`    Online: ${asset.is_online}`);
      console.log("");
    }

    console.log("💡 Suggestions:");
    console.log("   1. Check if source files are still accessible");
    console.log("   2. Verify archive storage is configured and online");
    console.log("   3. Review job history for specific error messages");
    console.log("   4. Try re-initiating archive for individual assets");
  }

  if (counts["ARCHIVING"] > 0) {
    console.log(`\n${"─".repeat(70)}`);
    console.log("⏳ ASSETS CURRENTLY ARCHIVING");
    console.log(`${"─".repeat(70)}\n`);

    const archiving = await getAssetsByArchiveStatus("ARCHIVING", 10);
    console.log(`Showing ${archiving.length} of ${counts["ARCHIVING"]} archiving assets:\n`);

    for (const asset of archiving) {
      console.log(`  • ${asset.title}`);
      console.log(`    ID: ${asset.id}`);
      console.log(`    Modified: ${asset.date_modified}`);
      console.log("");
    }

    // Check if any have been "archiving" for too long
    const now = Date.now();
    const stuckThreshold = 24 * 60 * 60 * 1000; // 24 hours
    const potentiallyStuck = archiving.filter(a => {
      const modified = new Date(a.date_modified).getTime();
      return (now - modified) > stuckThreshold;
    });

    if (potentiallyStuck.length > 0) {
      console.log(`⚠️  ${potentiallyStuck.length} asset(s) have been archiving for >24 hours - may be stuck`);
    }
  }

  if (counts["ARCHIVED"] > 0) {
    console.log(`\n${"─".repeat(70)}`);
    console.log("📦 RECENTLY ARCHIVED ASSETS");
    console.log(`${"─".repeat(70)}\n`);

    const archived = await getAssetsByArchiveStatus("ARCHIVED", 5);
    console.log(`Showing 5 most recently archived:\n`);

    for (const asset of archived) {
      console.log(`  • ${asset.title}`);
      console.log(`    Archived: ${asset.date_modified}`);
      console.log("");
    }
  }

  // Summary
  console.log(`\n${"═".repeat(70)}`);
  console.log("SUMMARY");
  console.log(`${"═".repeat(70)}`);

  const healthScore = counts["FAILED_TO_ARCHIVE"] === 0 ? "✅ HEALTHY" : "⚠️  NEEDS ATTENTION";
  console.log(`\nArchive Health: ${healthScore}`);

  if (counts["FAILED_TO_ARCHIVE"] === 0 && counts["ARCHIVING"] === 0) {
    console.log("No failed or in-progress archives detected.");
  }

  console.log(`\nArchived: ${counts["ARCHIVED"]} / ${total} assets (${((counts["ARCHIVED"] / total) * 100).toFixed(1)}%)`);
  console.log(`Not Archived: ${counts["NOT_ARCHIVED"]} assets`);

  if (counts["FAILED_TO_ARCHIVE"] > 0) {
    console.log(`\n🔴 Action Required: ${counts["FAILED_TO_ARCHIVE"]} assets failed to archive`);
  }

  console.log("");
}

// Check for help flag
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
ARCHIVE HEALTH REPORT

Usage:
  npx ts-node scripts/archive-health-report.ts [--profile=name]

Options:
  --profile=name    Use a specific profile (default: uses default_profile from config)

Examples:
  npx ts-node scripts/archive-health-report.ts
  npx ts-node scripts/archive-health-report.ts --profile=production
`);
} else {
  runReport().catch(console.error);
}
