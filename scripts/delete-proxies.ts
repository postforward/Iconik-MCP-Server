#!/usr/bin/env npx ts-node

import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.js";
import { getProfileFromArgs } from "../src/config.js";

// Initialize with profile from args
const profileName = getProfileFromArgs();
initializeProfile(profileName);

interface PaginatedResponse<T> {
  objects: T[];
  page: number;
  pages: number;
  per_page: number;
  total: number;
}

interface Proxy {
  id: string;
  name?: string;
}

async function deleteProxiesByCollection(collectionId: string, dryRun: boolean = true) {
  const profile = getCurrentProfileInfo();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`DELETE PROXIES BY COLLECTION`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Collection: ${collectionId}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no actual deletions)" : "LIVE (will delete proxies)"}`);
  console.log(`${"=".repeat(60)}\n`);

  let totalAssetsProcessed = 0;
  let totalAssetsWithProxies = 0;
  let totalProxiesFound = 0;
  let totalProxiesDeleted = 0;
  const errors: string[] = [];

  let page = 1;
  const perPage = 100;
  let hasMore = true;

  while (hasMore) {
    console.log(`Fetching collection contents page ${page}...`);

    const contentsResponse = await iconikRequest<PaginatedResponse<{ id: string; object_type: string }>>(
      `assets/v1/collections/${collectionId}/contents/?page=${page}&per_page=${perPage}&content_types=assets`
    );

    const assets = contentsResponse.objects || [];
    console.log(`Found ${assets.length} assets on page ${page}`);

    for (const item of assets) {
      if (item.object_type !== "assets") continue;

      const assetId = item.id;
      totalAssetsProcessed++;

      try {
        const proxiesResponse = await iconikRequest<PaginatedResponse<Proxy>>(
          `files/v1/assets/${assetId}/proxies/`
        );

        const proxies = proxiesResponse.objects || [];

        if (proxies.length === 0) {
          continue;
        }

        totalAssetsWithProxies++;
        totalProxiesFound += proxies.length;
        console.log(`  Asset ${assetId}: ${proxies.length} proxies`);

        for (const proxy of proxies) {
          if (dryRun) {
            console.log(`    [DRY RUN] Would delete: ${proxy.id}`);
            totalProxiesDeleted++;
          } else {
            try {
              await iconikRequest(`files/v1/assets/${assetId}/proxies/${proxy.id}/`, { method: "DELETE" });
              console.log(`    Deleted: ${proxy.id}`);
              totalProxiesDeleted++;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              errors.push(`Proxy ${proxy.id}: ${msg}`);
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Asset ${assetId}: ${msg}`);
      }
    }

    hasMore = contentsResponse.pages > page;
    page++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(60)}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Assets processed: ${totalAssetsProcessed}`);
  console.log(`Assets with proxies: ${totalAssetsWithProxies}`);
  console.log(`Proxies found: ${totalProxiesFound}`);
  console.log(`Proxies ${dryRun ? "would be deleted" : "deleted"}: ${totalProxiesDeleted}`);
  if (errors.length > 0) {
    console.log(`Errors: ${errors.length}`);
    errors.forEach((e) => console.log(`  - ${e}`));
  }
}

async function deleteProxiesByStorage(storageId: string, dryRun: boolean = true) {
  const profile = getCurrentProfileInfo();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`DELETE PROXIES BY STORAGE`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Storage: ${storageId}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no actual deletions)" : "LIVE (will delete proxies)"}`);
  console.log(`${"=".repeat(60)}\n`);

  let totalAssetsProcessed = 0;
  let totalAssetsWithProxies = 0;
  let totalProxiesFound = 0;
  let totalProxiesDeleted = 0;
  const errors: string[] = [];
  const assetIds = new Set<string>();

  // Phase 1: Discover assets
  console.log("Phase 1: Discovering assets on storage...");
  let page = 1;
  const perPage = 100;
  let hasMore = true;

  while (hasMore) {
    console.log(`  Fetching files page ${page}...`);

    const filesResponse = await iconikRequest<PaginatedResponse<{ asset_id?: string }>>(
      `files/v1/storages/${storageId}/files/?page=${page}&per_page=${perPage}`
    );

    for (const file of filesResponse.objects || []) {
      if (file.asset_id) assetIds.add(file.asset_id);
    }

    hasMore = filesResponse.pages > page;
    page++;
  }

  console.log(`Found ${assetIds.size} unique assets\n`);
  console.log("Phase 2: Processing proxies...");

  // Phase 2: Process assets
  for (const assetId of assetIds) {
    totalAssetsProcessed++;

    try {
      const proxiesResponse = await iconikRequest<PaginatedResponse<Proxy>>(
        `files/v1/assets/${assetId}/proxies/`
      );

      const proxies = proxiesResponse.objects || [];
      if (proxies.length === 0) continue;

      totalAssetsWithProxies++;
      totalProxiesFound += proxies.length;
      console.log(`  Asset ${assetId}: ${proxies.length} proxies`);

      for (const proxy of proxies) {
        if (dryRun) {
          console.log(`    [DRY RUN] Would delete: ${proxy.id}`);
          totalProxiesDeleted++;
        } else {
          try {
            await iconikRequest(`files/v1/assets/${assetId}/proxies/${proxy.id}/`, { method: "DELETE" });
            console.log(`    Deleted: ${proxy.id}`);
            totalProxiesDeleted++;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`Proxy ${proxy.id}: ${msg}`);
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Asset ${assetId}: ${msg}`);
    }

    if (totalAssetsProcessed % 50 === 0) {
      console.log(`  Progress: ${totalAssetsProcessed}/${assetIds.size}`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(60)}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Assets processed: ${totalAssetsProcessed}`);
  console.log(`Assets with proxies: ${totalAssetsWithProxies}`);
  console.log(`Proxies found: ${totalProxiesFound}`);
  console.log(`Proxies ${dryRun ? "would be deleted" : "deleted"}: ${totalProxiesDeleted}`);
  if (errors.length > 0) {
    console.log(`Errors: ${errors.length}`);
    errors.forEach((e) => console.log(`  - ${e}`));
  }
}

// CLI
const args = process.argv.slice(2).filter(a => !a.startsWith("--profile="));
const command = args[0];
const id = args[1];
const live = args.includes("--live");

if (command === "collection" && id) {
  deleteProxiesByCollection(id, !live);
} else if (command === "storage" && id) {
  deleteProxiesByStorage(id, !live);
} else {
  console.log(`
Usage:
  npx ts-node scripts/delete-proxies.ts collection <collection_id> [--profile=name] [--live]
  npx ts-node scripts/delete-proxies.ts storage <storage_id> [--profile=name] [--live]

Options:
  --profile=name    Use a specific profile (default: uses default_profile from config)
  --live            Actually delete proxies (default is dry run)

Examples:
  npx ts-node scripts/delete-proxies.ts collection abc-123-def
  npx ts-node scripts/delete-proxies.ts collection abc-123-def --profile=production --live
  npx ts-node scripts/delete-proxies.ts storage xyz-456-ghi --profile=staging
`);
}
