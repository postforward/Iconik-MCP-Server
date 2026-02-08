#!/usr/bin/env npx ts-node

/**
 * METADATA BULK UPDATER
 *
 * Bulk update metadata across assets. Supports:
 * - Update by collection
 * - Update by search query
 * - Update from CSV file
 * - Find and replace in metadata fields
 */

import * as fs from "fs";
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

interface Asset {
  id: string;
  title: string;
}

// ============================================
// COLLECTION-BASED UPDATE
// ============================================
async function updateByCollection(
  collectionId: string,
  viewId: string,
  metadataValues: Record<string, unknown>,
  dryRun: boolean = true
) {
  const profile = getCurrentProfileInfo();
  console.log(`\n${"═".repeat(70)}`);
  console.log("BULK METADATA UPDATE - BY COLLECTION");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Collection: ${collectionId}`);
  console.log(`View ID: ${viewId}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Values to set:`, JSON.stringify(metadataValues, null, 2));
  console.log("");

  let page = 1;
  let updated = 0;
  let errors: string[] = [];

  while (true) {
    const res = await iconikRequest<PaginatedResponse<{ id: string; object_type: string; title?: string }>>(
      `assets/v1/collections/${collectionId}/contents/?page=${page}&per_page=100&content_types=assets`
    );

    const assets = (res.objects || []).filter(o => o.object_type === "assets");
    if (assets.length === 0) break;

    for (const asset of assets) {
      try {
        if (dryRun) {
          console.log(`  [DRY RUN] Would update: ${asset.title || asset.id}`);
        } else {
          await iconikRequest(`metadata/v1/assets/${asset.id}/views/${viewId}/`, {
            method: "PUT",
            body: JSON.stringify({ metadata_values: metadataValues })
          });
          console.log(`  ✅ Updated: ${asset.title || asset.id}`);
        }
        updated++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${asset.id}: ${msg}`);
        console.log(`  ❌ Failed: ${asset.title || asset.id} - ${msg}`);
      }
    }

    if (res.pages <= page) break;
    page++;
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`${dryRun ? "Would update" : "Updated"}: ${updated} assets`);
  if (errors.length > 0) {
    console.log(`Errors: ${errors.length}`);
  }
}

// ============================================
// SEARCH-BASED UPDATE
// ============================================
async function updateBySearch(
  query: string,
  viewId: string,
  metadataValues: Record<string, unknown>,
  dryRun: boolean = true,
  maxAssets: number = 100
) {
  const profile = getCurrentProfileInfo();
  console.log(`\n${"═".repeat(70)}`);
  console.log("BULK METADATA UPDATE - BY SEARCH");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Query: "${query}"`);
  console.log(`View ID: ${viewId}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Max assets: ${maxAssets}`);
  console.log(`Values to set:`, JSON.stringify(metadataValues, null, 2));
  console.log("");

  const res = await iconikRequest<PaginatedResponse<Asset>>("search/v1/search/", {
    method: "POST",
    body: JSON.stringify({
      query,
      doc_types: ["assets"],
      per_page: Math.min(maxAssets, 100)
    })
  });

  const assets = res.objects || [];
  console.log(`Found ${res.total} assets, processing ${assets.length}\n`);

  let updated = 0;
  let errors: string[] = [];

  for (const asset of assets) {
    try {
      if (dryRun) {
        console.log(`  [DRY RUN] Would update: ${asset.title}`);
      } else {
        await iconikRequest(`metadata/v1/assets/${asset.id}/views/${viewId}/`, {
          method: "PUT",
          body: JSON.stringify({ metadata_values: metadataValues })
        });
        console.log(`  ✅ Updated: ${asset.title}`);
      }
      updated++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${asset.id}: ${msg}`);
      console.log(`  ❌ Failed: ${asset.title} - ${msg}`);
    }
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`${dryRun ? "Would update" : "Updated"}: ${updated} assets`);
  if (errors.length > 0) {
    console.log(`Errors: ${errors.length}`);
  }
}

// ============================================
// FIND AND REPLACE IN FIELD
// ============================================
async function findAndReplace(
  fieldName: string,
  findValue: string,
  replaceValue: string,
  viewId: string,
  dryRun: boolean = true
) {
  const profile = getCurrentProfileInfo();
  console.log(`\n${"═".repeat(70)}`);
  console.log("BULK METADATA UPDATE - FIND & REPLACE");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Field: ${fieldName}`);
  console.log(`Find: "${findValue}"`);
  console.log(`Replace: "${replaceValue}"`);
  console.log(`View ID: ${viewId}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log("");

  // Search for assets with the field value
  const res = await iconikRequest<PaginatedResponse<Asset>>("search/v1/search/", {
    method: "POST",
    body: JSON.stringify({
      query: findValue,
      doc_types: ["assets"],
      per_page: 100
    })
  });

  const assets = res.objects || [];
  console.log(`Found ${res.total} potential matches, checking ${assets.length}\n`);

  let updated = 0;
  let skipped = 0;
  let errors: string[] = [];

  for (const asset of assets) {
    try {
      // Get current metadata
      const metaRes = await iconikRequest<{ metadata_values?: Record<string, unknown> }>(
        `metadata/v1/assets/${asset.id}/views/${viewId}/`
      );

      const currentValue = metaRes.metadata_values?.[fieldName];

      if (typeof currentValue === "string" && currentValue.includes(findValue)) {
        const newValue = currentValue.replace(new RegExp(findValue, "g"), replaceValue);

        if (dryRun) {
          console.log(`  [DRY RUN] ${asset.title}`);
          console.log(`            "${currentValue}" → "${newValue}"`);
        } else {
          await iconikRequest(`metadata/v1/assets/${asset.id}/views/${viewId}/`, {
            method: "PUT",
            body: JSON.stringify({ metadata_values: { [fieldName]: newValue } })
          });
          console.log(`  ✅ ${asset.title}: "${currentValue}" → "${newValue}"`);
        }
        updated++;
      } else {
        skipped++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${asset.id}: ${msg}`);
    }
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`${dryRun ? "Would update" : "Updated"}: ${updated} assets`);
  console.log(`Skipped (no match): ${skipped}`);
  if (errors.length > 0) {
    console.log(`Errors: ${errors.length}`);
  }
}

// ============================================
// CSV-BASED UPDATE
// ============================================
async function updateFromCsv(
  csvPath: string,
  viewId: string,
  dryRun: boolean = true
) {
  const profile = getCurrentProfileInfo();
  console.log(`\n${"═".repeat(70)}`);
  console.log("BULK METADATA UPDATE - FROM CSV");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}`);
  console.log(`CSV File: ${csvPath}`);
  console.log(`View ID: ${viewId}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log("");

  if (!fs.existsSync(csvPath)) {
    console.error(`Error: CSV file not found: ${csvPath}`);
    return;
  }

  const content = fs.readFileSync(csvPath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());

  if (lines.length < 2) {
    console.error("Error: CSV must have header row and at least one data row");
    return;
  }

  // Parse header
  const headers = lines[0].split(",").map(h => h.trim());
  const assetIdIndex = headers.findIndex(h => h.toLowerCase() === "asset_id" || h.toLowerCase() === "id");

  if (assetIdIndex === -1) {
    console.error("Error: CSV must have 'asset_id' or 'id' column");
    return;
  }

  const metadataFields = headers.filter((_, i) => i !== assetIdIndex);
  console.log(`Found fields: ${metadataFields.join(", ")}\n`);

  let updated = 0;
  let errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map(v => v.trim());
    const assetId = values[assetIdIndex];

    if (!assetId) continue;

    const metadataValues: Record<string, string> = {};
    headers.forEach((header, idx) => {
      if (idx !== assetIdIndex && values[idx]) {
        metadataValues[header] = values[idx];
      }
    });

    try {
      if (dryRun) {
        console.log(`  [DRY RUN] Asset ${assetId}:`, metadataValues);
      } else {
        await iconikRequest(`metadata/v1/assets/${assetId}/views/${viewId}/`, {
          method: "PUT",
          body: JSON.stringify({ metadata_values: metadataValues })
        });
        console.log(`  ✅ Updated: ${assetId}`);
      }
      updated++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${assetId}: ${msg}`);
      console.log(`  ❌ Failed: ${assetId} - ${msg}`);
    }
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`${dryRun ? "Would update" : "Updated"}: ${updated} assets`);
  if (errors.length > 0) {
    console.log(`Errors: ${errors.length}`);
  }
}

// ============================================
// LIST METADATA VIEWS (helper)
// ============================================
async function listViews() {
  const profile = getCurrentProfileInfo();
  console.log(`\n${"═".repeat(70)}`);
  console.log("AVAILABLE METADATA VIEWS");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}\n`);

  const res = await iconikRequest<PaginatedResponse<{ id: string; name: string; description?: string }>>(
    "metadata/v1/views/"
  );

  for (const view of res.objects || []) {
    console.log(`  ${view.name}`);
    console.log(`    ID: ${view.id}`);
    if (view.description) console.log(`    Description: ${view.description}`);
    console.log("");
  }
}

// ============================================
// CLI
// ============================================
const args = process.argv.slice(2).filter(a => !a.startsWith("--profile="));
const command = args[0];

function printHelp() {
  console.log(`
METADATA BULK UPDATER

Usage:
  npx ts-node scripts/metadata-bulk-update.ts <command> [options]

Commands:

  list-views [--profile=name]
    List all available metadata views and their IDs

  collection <collection_id> <view_id> <json_values> [--profile=name] [--live]
    Update all assets in a collection
    Example: npx ts-node scripts/metadata-bulk-update.ts collection abc-123 def-456 '{"project":"Summer 2024"}'

  search <query> <view_id> <json_values> [--profile=name] [--live] [--max=100]
    Update assets matching a search query
    Example: npx ts-node scripts/metadata-bulk-update.ts search "summer" def-456 '{"status":"approved"}'

  replace <field_name> <find> <replace> <view_id> [--profile=name] [--live]
    Find and replace values in a specific field
    Example: npx ts-node scripts/metadata-bulk-update.ts replace project_name "2023" "2024" def-456

  csv <csv_path> <view_id> [--profile=name] [--live]
    Update from CSV file (must have 'asset_id' column)
    Example: npx ts-node scripts/metadata-bulk-update.ts csv ./updates.csv def-456

Options:
  --profile=name    Use a specific profile (default: uses default_profile from config)
  --live            Actually make changes (default is dry run)
  --max=N           Maximum assets to update (for search command)
`);
}

async function main() {
  const live = args.includes("--live");
  const maxArg = args.find(a => a.startsWith("--max="));
  const maxAssets = maxArg ? parseInt(maxArg.split("=")[1]) : 100;

  switch (command) {
    case "list-views":
      await listViews();
      break;

    case "collection":
      if (args.length < 4) {
        console.error("Usage: collection <collection_id> <view_id> <json_values> [--live]");
        process.exit(1);
      }
      await updateByCollection(args[1], args[2], JSON.parse(args[3]), !live);
      break;

    case "search":
      if (args.length < 4) {
        console.error("Usage: search <query> <view_id> <json_values> [--live] [--max=N]");
        process.exit(1);
      }
      await updateBySearch(args[1], args[2], JSON.parse(args[3]), !live, maxAssets);
      break;

    case "replace":
      if (args.length < 5) {
        console.error("Usage: replace <field_name> <find> <replace> <view_id> [--live]");
        process.exit(1);
      }
      await findAndReplace(args[1], args[2], args[3], args[4], !live);
      break;

    case "csv":
      if (args.length < 3) {
        console.error("Usage: csv <csv_path> <view_id> [--live]");
        process.exit(1);
      }
      await updateFromCsv(args[1], args[2], !live);
      break;

    default:
      printHelp();
  }
}

main().catch(console.error);
