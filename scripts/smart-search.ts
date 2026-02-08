#!/usr/bin/env npx ts-node

/**
 * SMART SEARCH HELPER
 *
 * Natural language-ish search interface for Iconik that:
 * - Searches across titles, metadata, and transcriptions
 * - Filters by date ranges, media type, collections
 * - Shows rich results with context
 * - Exports results to CSV
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
  facets?: Record<string, { buckets: Array<{ key: string; doc_count: number }> }>;
}

interface Asset {
  id: string;
  title: string;
  status: string;
  media_type?: string;
  is_online: boolean;
  date_created: string;
  date_modified: string;
  in_collections?: string[];
  metadata?: Record<string, unknown>;
  keyframes?: Array<{ id: string }>;
  proxies?: Array<{ id: string; name: string }>;
  duration_milliseconds?: number;
}

interface Segment {
  id: string;
  asset_id: string;
  segment_type: string;
  title?: string;
  text?: string;
  time_start_milliseconds: number;
  time_end_milliseconds: number;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatTimecode(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

// ============================================
// SEARCH FUNCTIONS
// ============================================

interface SearchOptions {
  query: string;
  mediaType?: string;
  collectionId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  includeTranscripts?: boolean;
  facets?: boolean;
}

async function search(options: SearchOptions): Promise<void> {
  const { query, mediaType, collectionId, dateFrom, dateTo, limit = 20, includeTranscripts = false, facets = false } = options;

  const profile = getCurrentProfileInfo();
  console.log(`\n${"═".repeat(70)}`);
  console.log("SMART SEARCH");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Query: "${query}"`);
  if (mediaType) console.log(`Media Type: ${mediaType}`);
  if (collectionId) console.log(`Collection: ${collectionId}`);
  if (dateFrom || dateTo) console.log(`Date Range: ${dateFrom || "any"} to ${dateTo || "any"}`);
  console.log("");

  // Build search body
  const searchBody: Record<string, unknown> = {
    query,
    doc_types: ["assets"],
    per_page: Math.min(limit, 100),
    sort: [{ name: "date_created", order: "desc" }]
  };

  // Build filter terms
  const terms: Array<{ name: string; value: string }> = [];

  if (mediaType) {
    terms.push({ name: "media_type", value: mediaType });
  }

  if (collectionId) {
    terms.push({ name: "in_collections", value: collectionId });
  }

  if (terms.length > 0) {
    searchBody.filter = { operator: "AND", terms };
  }

  // Add date range if specified
  if (dateFrom || dateTo) {
    const range: Record<string, string> = {};
    if (dateFrom) range.gte = dateFrom;
    if (dateTo) range.lte = dateTo;
    searchBody.filter = {
      ...searchBody.filter as object,
      range: { date_created: range }
    };
  }

  // Add facets for aggregations
  if (facets) {
    searchBody.facets = ["media_type", "status", "archive_status"];
  }

  const res = await iconikRequest<PaginatedResponse<Asset>>("search/v1/search/", {
    method: "POST",
    body: JSON.stringify(searchBody)
  });

  console.log(`Found ${res.total} results\n`);

  // Show facets if requested
  if (facets && res.facets) {
    console.log("📊 FACETS");
    console.log("─".repeat(40));
    for (const [name, facetData] of Object.entries(res.facets)) {
      console.log(`  ${name}:`);
      for (const bucket of facetData.buckets.slice(0, 5)) {
        console.log(`    ${bucket.key}: ${bucket.doc_count}`);
      }
    }
    console.log("");
  }

  // Display results
  console.log("📋 RESULTS");
  console.log("─".repeat(70));

  for (const asset of res.objects || []) {
    console.log(`\n  📄 ${asset.title}`);
    console.log(`     ID: ${asset.id}`);
    console.log(`     Type: ${asset.media_type || "unknown"} | Status: ${asset.status} | Online: ${asset.is_online}`);

    if (asset.duration_milliseconds) {
      console.log(`     Duration: ${formatDuration(asset.duration_milliseconds)}`);
    }

    console.log(`     Created: ${asset.date_created}`);

    if (asset.in_collections?.length) {
      console.log(`     Collections: ${asset.in_collections.length}`);
    }

    // Show metadata highlights if available
    if (asset.metadata) {
      const metaPreview = Object.entries(asset.metadata)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      if (metaPreview) {
        console.log(`     Metadata: ${metaPreview}`);
      }
    }

    // Search transcriptions if requested
    if (includeTranscripts && asset.media_type === "video") {
      try {
        const segRes = await iconikRequest<PaginatedResponse<Segment>>(
          `assets/v1/assets/${asset.id}/segments/TRANSCRIPTION/?per_page=100`
        );

        const matchingSegments = (segRes.objects || []).filter(
          seg => seg.text?.toLowerCase().includes(query.toLowerCase())
        );

        if (matchingSegments.length > 0) {
          console.log(`     🎤 Transcript matches:`);
          for (const seg of matchingSegments.slice(0, 3)) {
            const time = formatTimecode(seg.time_start_milliseconds);
            const preview = seg.text?.substring(0, 80) + (seg.text && seg.text.length > 80 ? "..." : "");
            console.log(`        [${time}] "${preview}"`);
          }
          if (matchingSegments.length > 3) {
            console.log(`        ... and ${matchingSegments.length - 3} more matches`);
          }
        }
      } catch (e) {
        // No transcription available
      }
    }
  }

  if (res.total > limit) {
    console.log(`\n... and ${res.total - limit} more results`);
  }
}

// ============================================
// TRANSCRIPT SEARCH
// ============================================

async function searchTranscripts(query: string, limit: number = 20): Promise<void> {
  const profile = getCurrentProfileInfo();
  console.log(`\n${"═".repeat(70)}`);
  console.log("TRANSCRIPT SEARCH");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Query: "${query}"\n`);

  // Search in segments
  const res = await iconikRequest<PaginatedResponse<Segment>>("search/v1/search/", {
    method: "POST",
    body: JSON.stringify({
      query,
      doc_types: ["segments"],
      filter: {
        operator: "AND",
        terms: [{ name: "segment_type", value: "TRANSCRIPTION" }]
      },
      per_page: Math.min(limit, 100)
    })
  });

  console.log(`Found ${res.total} transcript matches\n`);

  // Group by asset
  const byAsset: Record<string, Segment[]> = {};
  for (const seg of res.objects || []) {
    if (!byAsset[seg.asset_id]) byAsset[seg.asset_id] = [];
    byAsset[seg.asset_id].push(seg);
  }

  console.log("📋 RESULTS (grouped by asset)");
  console.log("─".repeat(70));

  for (const [assetId, segments] of Object.entries(byAsset)) {
    // Get asset details
    try {
      const asset = await iconikRequest<Asset>(`assets/v1/assets/${assetId}/`);
      console.log(`\n  📄 ${asset.title}`);
      console.log(`     ID: ${assetId}`);

      for (const seg of segments.slice(0, 5)) {
        const time = formatTimecode(seg.time_start_milliseconds);
        const preview = seg.text?.substring(0, 100) + (seg.text && seg.text.length > 100 ? "..." : "");
        console.log(`     [${time}] "${preview}"`);
      }

      if (segments.length > 5) {
        console.log(`     ... and ${segments.length - 5} more matches in this asset`);
      }
    } catch (e) {
      console.log(`\n  Asset ${assetId}: ${segments.length} matches (asset details unavailable)`);
    }
  }
}

// ============================================
// EXPORT TO CSV
// ============================================

async function exportToCsv(query: string, outputPath: string, limit: number = 1000): Promise<void> {
  const profile = getCurrentProfileInfo();
  console.log(`\n${"═".repeat(70)}`);
  console.log("EXPORT SEARCH RESULTS TO CSV");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Query: "${query}"`);
  console.log(`Output: ${outputPath}`);
  console.log(`Max results: ${limit}\n`);

  const allAssets: Asset[] = [];
  let page = 1;
  const perPage = 100;

  while (allAssets.length < limit) {
    const res = await iconikRequest<PaginatedResponse<Asset>>("search/v1/search/", {
      method: "POST",
      body: JSON.stringify({
        query,
        doc_types: ["assets"],
        per_page: perPage,
        page
      })
    });

    allAssets.push(...(res.objects || []));
    console.log(`  Fetched page ${page} (${allAssets.length}/${res.total})`);

    if (res.pages <= page || allAssets.length >= limit) break;
    page++;
  }

  // Build CSV
  const headers = ["id", "title", "media_type", "status", "is_online", "date_created", "date_modified", "duration_seconds", "collections_count"];
  const rows = allAssets.slice(0, limit).map(asset => [
    asset.id,
    `"${(asset.title || "").replace(/"/g, '""')}"`,
    asset.media_type || "",
    asset.status,
    asset.is_online,
    asset.date_created,
    asset.date_modified,
    asset.duration_milliseconds ? Math.round(asset.duration_milliseconds / 1000) : "",
    asset.in_collections?.length || 0
  ].join(","));

  const csv = [headers.join(","), ...rows].join("\n");
  fs.writeFileSync(outputPath, csv);

  console.log(`\n✅ Exported ${rows.length} assets to ${outputPath}`);
}

// ============================================
// FIND SIMILAR (by collection membership)
// ============================================

async function findSimilar(assetId: string, limit: number = 10): Promise<void> {
  const profile = getCurrentProfileInfo();
  console.log(`\n${"═".repeat(70)}`);
  console.log("FIND SIMILAR ASSETS");
  console.log(`${"═".repeat(70)}\n`);
  console.log(`Profile: ${profile.name}`);

  // Get the source asset
  const asset = await iconikRequest<Asset>(`assets/v1/assets/${assetId}/?include_collections=true`);
  console.log(`Source: ${asset.title}`);
  console.log(`Collections: ${asset.in_collections?.length || 0}\n`);

  if (!asset.in_collections?.length) {
    console.log("Asset is not in any collections - cannot find similar assets.");
    return;
  }

  // Search for assets in the same collections
  const collectionId = asset.in_collections[0];
  const res = await iconikRequest<PaginatedResponse<Asset>>("search/v1/search/", {
    method: "POST",
    body: JSON.stringify({
      query: "*",
      doc_types: ["assets"],
      filter: {
        operator: "AND",
        terms: [{ name: "in_collections", value: collectionId }]
      },
      per_page: limit + 1 // +1 to exclude source
    })
  });

  const similar = (res.objects || []).filter(a => a.id !== assetId);

  console.log(`Found ${similar.length} similar assets (same collection):\n`);

  for (const sim of similar.slice(0, limit)) {
    console.log(`  📄 ${sim.title}`);
    console.log(`     ID: ${sim.id}`);
    console.log(`     Type: ${sim.media_type || "unknown"}`);
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
SMART SEARCH HELPER

Usage:
  npx ts-node scripts/smart-search.ts <command> [options]

Commands:

  search <query> [options]
    Search for assets
    Options:
      --profile=name                       Use a specific profile
      --type=video|audio|image|document   Filter by media type
      --collection=<id>                   Filter by collection
      --from=YYYY-MM-DD                   Filter by date range start
      --to=YYYY-MM-DD                     Filter by date range end
      --limit=N                           Max results (default: 20)
      --transcripts                       Include transcript search
      --facets                            Show aggregations

    Example: npx ts-node scripts/smart-search.ts search "interview" --type=video --transcripts

  transcripts <query> [--limit=N] [--profile=name]
    Search specifically in transcriptions/captions
    Example: npx ts-node scripts/smart-search.ts transcripts "product launch"

  export <query> <output.csv> [--limit=N] [--profile=name]
    Export search results to CSV
    Example: npx ts-node scripts/smart-search.ts export "*" ./all-assets.csv --limit=500

  similar <asset_id> [--limit=N] [--profile=name]
    Find assets similar to a given asset (by collection membership)
    Example: npx ts-node scripts/smart-search.ts similar abc-123-def

  recent [--limit=N] [--type=video|audio|image] [--profile=name]
    Show recently added assets
    Example: npx ts-node scripts/smart-search.ts recent --limit=10 --type=video
`);
}

async function main() {
  // Parse options
  const getOption = (name: string): string | undefined => {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg?.split("=")[1];
  };

  const hasFlag = (name: string): boolean => args.includes(`--${name}`);

  const limit = parseInt(getOption("limit") || "20");
  const mediaType = getOption("type");
  const collectionId = getOption("collection");
  const dateFrom = getOption("from");
  const dateTo = getOption("to");

  switch (command) {
    case "search":
      if (!args[1]) {
        console.error("Usage: search <query> [options]");
        process.exit(1);
      }
      await search({
        query: args[1],
        mediaType,
        collectionId,
        dateFrom,
        dateTo,
        limit,
        includeTranscripts: hasFlag("transcripts"),
        facets: hasFlag("facets")
      });
      break;

    case "transcripts":
      if (!args[1]) {
        console.error("Usage: transcripts <query> [--limit=N]");
        process.exit(1);
      }
      await searchTranscripts(args[1], limit);
      break;

    case "export":
      if (!args[1] || !args[2]) {
        console.error("Usage: export <query> <output.csv> [--limit=N]");
        process.exit(1);
      }
      await exportToCsv(args[1], args[2], limit);
      break;

    case "similar":
      if (!args[1]) {
        console.error("Usage: similar <asset_id> [--limit=N]");
        process.exit(1);
      }
      await findSimilar(args[1], limit);
      break;

    case "recent":
      await search({
        query: "*",
        mediaType,
        limit,
        facets: true
      });
      break;

    default:
      printHelp();
  }
}

main().catch(console.error);
