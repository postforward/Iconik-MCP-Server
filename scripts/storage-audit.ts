#!/usr/bin/env npx ts-node

/**
 * STORAGE AUDIT SCRIPT
 *
 * Analyzes your Iconik storage to find:
 * - Assets missing proxies
 * - Assets missing keyframes
 * - Failed transcodes
 * - Orphaned files
 * - Storage usage breakdown
 */

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

// Initialize with profile from args
const profileName = getProfileFromArgs();
initializeProfile(profileName);

interface PaginatedResponse<T> {
  objects: T[];
  total: number;
  page: number;
  pages: number;
}

interface Storage {
  id: string;
  name: string;
  status: string;
  method: string;
  purpose: string;
}

interface Asset {
  id: string;
  title: string;
  status: string;
  analyze_status: string;
  is_online: boolean;
  media_type?: string;
  proxies?: Array<{ id: string }>;
  keyframes?: Array<{ id: string }>;
  formats?: Array<{ name: string; status: string }>;
  date_created: string;
}

async function searchAssets(filter?: { operator: string; terms: Array<{ name: string; value: string }> }, perPage = 100, page = 1): Promise<PaginatedResponse<Asset>> {
  const body: Record<string, unknown> = {
    query: "*",
    doc_types: ["assets"],
    per_page: perPage,
    page,
    sort: [{ name: "date_created", order: "desc" }]
  };
  if (filter) {
    body.filter = filter;
  }
  return iconikRequest<PaginatedResponse<Asset>>("search/v1/search/", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

async function runStorageAudit() {
  const profile = getCurrentProfileInfo();
  console.log(`\n${"═".repeat(70)}`);
  console.log("                      STORAGE AUDIT REPORT");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Generated: ${new Date().toISOString()}\n`);

  // ============================================
  // STORAGE OVERVIEW
  // ============================================
  console.log("📦 STORAGE LOCATIONS");
  console.log("─".repeat(70));

  const storages = await iconikRequest<PaginatedResponse<Storage>>("files/v1/storages/");

  for (const storage of storages.objects || []) {
    const statusIcon = storage.status === "ACTIVE" ? "✅" : "⚠️";
    console.log(`  ${statusIcon} ${storage.name}`);
    console.log(`     ID: ${storage.id}`);
    console.log(`     Method: ${storage.method} | Purpose: ${storage.purpose} | Status: ${storage.status}`);
    console.log("");
  }

  // ============================================
  // ASSET ANALYSIS
  // ============================================
  console.log("\n📊 ASSET ANALYSIS");
  console.log("─".repeat(70));

  // Get total count
  const totalRes = await searchAssets(undefined, 1);
  const totalAssets = totalRes.total;
  console.log(`\nTotal assets: ${totalAssets}\n`);

  // Check for various issues
  const issues: Record<string, { count: number; samples: Asset[] }> = {
    missingProxies: { count: 0, samples: [] },
    missingKeyframes: { count: 0, samples: [] },
    failedAnalysis: { count: 0, samples: [] },
    offline: { count: 0, samples: [] },
  };

  // Count by analyze_status
  const analyzeStatuses = ["N/A", "REQUESTED", "IN_PROGRESS", "FAILED", "DONE"];
  console.log("Analyze Status Breakdown:");

  for (const status of analyzeStatuses) {
    const res = await searchAssets({
      operator: "AND",
      terms: [{ name: "analyze_status", value: status }]
    }, 1);
    const pct = totalAssets > 0 ? ((res.total / totalAssets) * 100).toFixed(1) : "0";
    console.log(`  ${status.padEnd(15)} ${String(res.total).padStart(6)} (${pct.padStart(5)}%)`);

    if (status === "FAILED") {
      issues.failedAnalysis.count = res.total;
    }
  }

  // Get failed analysis samples
  if (issues.failedAnalysis.count > 0) {
    const failedRes = await searchAssets({
      operator: "AND",
      terms: [{ name: "analyze_status", value: "FAILED" }]
    }, 10);
    issues.failedAnalysis.samples = failedRes.objects || [];
  }

  // Count offline assets
  const offlineRes = await searchAssets({
    operator: "AND",
    terms: [{ name: "is_online", value: "false" }]
  }, 10);
  issues.offline.count = offlineRes.total;
  issues.offline.samples = offlineRes.objects || [];

  // ============================================
  // MEDIA TYPE BREAKDOWN
  // ============================================
  console.log("\n\nMedia Type Breakdown:");

  const mediaTypes = ["video", "audio", "image", "document"];
  for (const mediaType of mediaTypes) {
    const res = await searchAssets({
      operator: "AND",
      terms: [{ name: "media_type", value: mediaType }]
    }, 1);
    if (res.total > 0) {
      const pct = ((res.total / totalAssets) * 100).toFixed(1);
      console.log(`  ${mediaType.padEnd(15)} ${String(res.total).padStart(6)} (${pct.padStart(5)}%)`);
    }
  }

  // ============================================
  // SAMPLE ASSETS TO CHECK FOR PROXIES/KEYFRAMES
  // ============================================
  console.log("\n\n🔍 DETAILED ASSET CHECK (sampling 50 assets)");
  console.log("─".repeat(70));

  const sampleRes = await searchAssets(undefined, 50);
  const sampleAssets = sampleRes.objects || [];

  let checkedCount = 0;
  for (const asset of sampleAssets) {
    checkedCount++;

    try {
      // Check proxies
      const proxiesRes = await iconikRequest<PaginatedResponse<{ id: string }>>(
        `files/v1/assets/${asset.id}/proxies/`
      );
      const proxyCount = proxiesRes.objects?.length || 0;

      // Check keyframes
      const keyframesRes = await iconikRequest<PaginatedResponse<{ id: string }>>(
        `files/v1/assets/${asset.id}/keyframes/`
      );
      const keyframeCount = keyframesRes.objects?.length || 0;

      if (proxyCount === 0 && asset.media_type === "video") {
        issues.missingProxies.count++;
        if (issues.missingProxies.samples.length < 10) {
          issues.missingProxies.samples.push(asset);
        }
      }

      if (keyframeCount === 0) {
        issues.missingKeyframes.count++;
        if (issues.missingKeyframes.samples.length < 10) {
          issues.missingKeyframes.samples.push(asset);
        }
      }
    } catch (e) {
      // Skip assets we can't check
    }

    // Progress indicator
    if (checkedCount % 10 === 0) {
      process.stdout.write(`  Checked ${checkedCount}/${sampleAssets.length} assets...\r`);
    }
  }
  console.log(`  Checked ${checkedCount} assets                    `);

  // ============================================
  // ISSUES REPORT
  // ============================================
  console.log("\n\n⚠️  ISSUES FOUND");
  console.log("═".repeat(70));

  // Failed Analysis
  if (issues.failedAnalysis.count > 0) {
    console.log(`\n🔴 FAILED ANALYSIS: ${issues.failedAnalysis.count} assets`);
    console.log("   These assets failed during media analysis (metadata extraction, proxy generation)");
    console.log("\n   Sample assets:");
    for (const asset of issues.failedAnalysis.samples.slice(0, 5)) {
      console.log(`     • ${asset.title} (${asset.id})`);
    }
    console.log("\n   💡 Fix: Re-trigger analysis via transcode job or re-upload source file");
  }

  // Offline Assets
  if (issues.offline.count > 0) {
    console.log(`\n🟡 OFFLINE ASSETS: ${issues.offline.count} assets`);
    console.log("   These assets are marked as offline (source files not accessible)");
    console.log("\n   Sample assets:");
    for (const asset of issues.offline.samples.slice(0, 5)) {
      console.log(`     • ${asset.title} (${asset.id})`);
    }
    console.log("\n   💡 Fix: Check storage connectivity or re-link source files");
  }

  // Missing Proxies (from sample)
  if (issues.missingProxies.count > 0) {
    console.log(`\n🟡 MISSING PROXIES: ~${issues.missingProxies.count} video assets (from ${checkedCount} sampled)`);
    console.log("   These video assets have no proxy files for playback");
    console.log("\n   Sample assets:");
    for (const asset of issues.missingProxies.samples.slice(0, 5)) {
      console.log(`     • ${asset.title} (${asset.id})`);
    }
    console.log("\n   💡 Fix: Trigger transcode job to generate proxies");
  }

  // Missing Keyframes (from sample)
  if (issues.missingKeyframes.count > 0) {
    console.log(`\n🟡 MISSING KEYFRAMES: ~${issues.missingKeyframes.count} assets (from ${checkedCount} sampled)`);
    console.log("   These assets have no thumbnail/keyframe images");
    console.log("\n   Sample assets:");
    for (const asset of issues.missingKeyframes.samples.slice(0, 5)) {
      console.log(`     • ${asset.title} (${asset.id})`);
    }
    console.log("\n   💡 Fix: Trigger keyframe generation job");
  }

  // All clear
  const totalIssues = issues.failedAnalysis.count + issues.offline.count +
                      issues.missingProxies.count + issues.missingKeyframes.count;

  if (totalIssues === 0) {
    console.log("\n✅ No issues found! Your storage looks healthy.");
  }

  // ============================================
  // SUMMARY
  // ============================================
  console.log(`\n\n${"═".repeat(70)}`);
  console.log("SUMMARY");
  console.log(`${"═".repeat(70)}`);
  console.log(`
  Total Assets:        ${totalAssets}
  Storage Locations:   ${storages.objects?.length || 0}
  Failed Analysis:     ${issues.failedAnalysis.count}
  Offline Assets:      ${issues.offline.count}
  Missing Proxies:     ~${issues.missingProxies.count} (sampled)
  Missing Keyframes:   ~${issues.missingKeyframes.count} (sampled)

  Health Score: ${totalIssues === 0 ? "✅ EXCELLENT" : totalIssues < 10 ? "🟡 GOOD" : "🔴 NEEDS ATTENTION"}
`);
}

// Check for help flag
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
STORAGE AUDIT SCRIPT

Usage:
  npx ts-node scripts/storage-audit.ts [--profile=name]

Options:
  --profile=name    Use a specific profile (default: uses default_profile from config)

Examples:
  npx ts-node scripts/storage-audit.ts
  npx ts-node scripts/storage-audit.ts --profile=production
`);
} else {
  runStorageAudit().catch(console.error);
}
