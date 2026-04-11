#!/usr/bin/env npx tsx

/**
 * TAG CENTR COLLECTIONS WITH StorageTier
 *
 * Reads the triage CSV and sets StorageTier metadata on matching Iconik
 * collections. Matches collections by their external_id path suffix.
 *
 * Only processes warm/cold tags (skips delete/review — those don't need proxies).
 *
 * Usage:
 *   npx tsx scripts/tag-centr-storage-tier.ts --profile=centr --csv=<path> [--live] [--all-tags]
 *
 * Options:
 *   --all-tags    Also apply delete/review tags (default: only warm/cold)
 */

import { readFileSync } from "fs";
import { iconikRequest, initializeProfile, getCurrentProfileInfo } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2);
const dryRun = !args.includes("--live");
const allTags = args.includes("--all-tags");
const csvPath = args.find(a => a.startsWith("--csv="))?.split("=").slice(1).join("=");

if (!csvPath) {
  console.error("Required: --csv=<path to triage CSV>");
  process.exit(1);
}

interface CsvRow {
  path: string;
  bucket: string;
  name: string;
  sizeGb: number;
  fileCount: number;
  tag: string;
}

interface PaginatedResponse<T> {
  objects: T[];
  total: number;
  page: number;
  pages: number;
}

async function apiRequest<T = unknown>(
  endpoint: string,
  options: Parameters<typeof iconikRequest>[1] = {}
): Promise<T> {
  const maxRetries = 5;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await iconikRequest<T>(endpoint, options);
    } catch (e: any) {
      if (e.message?.includes("429") && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Max retries exceeded");
}

/** Parse the triage CSV */
function parseCsv(filePath: string): CsvRow[] {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.trim().split("\n").slice(1); // skip header
  return lines.map(line => {
    const cols = line.split(",").map(c => c.replace(/^"|"$/g, ""));
    return {
      path: cols[0],
      bucket: cols[1],
      name: cols[2],
      sizeGb: parseFloat(cols[3]),
      fileCount: parseInt(cols[4]),
      tag: cols[6]?.toLowerCase() || "",
    };
  }).filter(r => r.path && r.tag);
}

/** Find the metadata view containing StorageTier */
async function findStorageTierView(): Promise<string | null> {
  const views = await apiRequest<PaginatedResponse<{ id: string; name: string; view_fields: { name: string }[] }>>(
    "metadata/v1/views/?per_page=50"
  );
  for (const view of views.objects || []) {
    if (view.view_fields?.some(f => f.name === "StorageTier")) {
      return view.id;
    }
  }
  return null;
}

/** Search for a collection by matching its external_id to the CSV path */
async function findCollectionByPath(csvPath: string): Promise<{ id: string; title: string; external_id: string } | null> {
  // The external_id in Iconik looks like: <storage_id>/<root_collection_id>/<path>
  // The CSV path is like: /<bucket>/<top>/<sub>/.../<folder>/
  // We need to match the folder name part. Strip bucket prefix to get the relative path.
  const parts = csvPath.split("/").filter(Boolean);
  const bucket = parts[0];
  const relativePath = parts.slice(1).join("/");

  // Search by collection title (last path segment) then verify by external_id
  const folderName = parts[parts.length - 1];

  // Use collection search
  const res = await apiRequest<PaginatedResponse<{ id: string; title: string; external_id: string }>>(
    "search/v1/search/?per_page=20",
    {
      method: "POST",
      body: JSON.stringify({
        doc_types: ["collections"],
        query: `"${folderName}"`,
      }),
    }
  );

  // Match by external_id containing the relative path
  for (const col of res.objects || []) {
    if (col.external_id && col.external_id.includes(relativePath)) {
      return col;
    }
  }

  // Fallback: try searching with parent context
  if (parts.length >= 3) {
    const parentName = parts[parts.length - 2];
    const res2 = await apiRequest<PaginatedResponse<{ id: string; title: string; external_id: string }>>(
      "search/v1/search/?per_page=50",
      {
        method: "POST",
        body: JSON.stringify({
          doc_types: ["collections"],
          query: `"${parentName}" "${folderName}"`,
        }),
      }
    );
    for (const col of res2.objects || []) {
      if (col.external_id && col.external_id.includes(relativePath)) {
        return col;
      }
    }
  }

  return null;
}

/** Set StorageTier on a collection */
async function setStorageTier(collectionId: string, viewId: string, tier: string): Promise<void> {
  await apiRequest(`metadata/v1/collections/${collectionId}/views/${viewId}/`, {
    method: "PUT",
    body: JSON.stringify({
      metadata_values: {
        StorageTier: {
          field_values: [{ value: tier }],
        },
      },
    }),
  });
}

async function main() {
  const profile = getCurrentProfileInfo();

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("TAG CENTR COLLECTIONS — StorageTier");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`Profile:  ${profile.name}`);
  console.log(`Mode:     ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`CSV:      ${csvPath}`);
  console.log(`Tags:     ${allTags ? "all (warm/cold/delete/review)" : "warm/cold only"}`);
  console.log("");

  // Parse CSV
  const rows = parseCsv(csvPath);
  const targetTags = allTags ? ["warm", "cold", "delete", "review"] : ["warm", "cold"];
  const filtered = rows.filter(r => targetTags.includes(r.tag));

  console.log(`CSV rows: ${rows.length} total, ${filtered.length} with ${targetTags.join("/")} tags\n`);

  // Find StorageTier view
  const viewId = await findStorageTierView();
  if (!viewId) {
    console.error("ERROR: Could not find metadata view containing StorageTier field");
    process.exit(1);
  }
  console.log(`StorageTier view: ${viewId}\n`);

  // Process each row
  let matched = 0;
  let updated = 0;
  let notFound = 0;
  let errors = 0;

  for (const row of filtered) {
    const shortPath = row.path.replace(`/${row.bucket}/`, "");
    process.stdout.write(`  ${row.tag.padEnd(6)} ${shortPath.padEnd(55)} `);

    const col = await findCollectionByPath(row.path);
    if (!col) {
      console.log("NOT FOUND");
      notFound++;
      continue;
    }

    matched++;

    if (dryRun) {
      console.log(`-> ${col.id} (${col.title})`);
      updated++;
      continue;
    }

    try {
      await setStorageTier(col.id, viewId, row.tag);
      console.log(`SET -> ${col.id}`);
      updated++;
    } catch (e) {
      console.log(`ERROR: ${e instanceof Error ? e.message : e}`);
      errors++;
    }
  }

  console.log(`\n${"══════════════════════════════════════════════════════════════════════"}`);
  console.log("SUMMARY");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`Rows processed:  ${filtered.length}`);
  console.log(`Collections found: ${matched}`);
  console.log(`${dryRun ? "Would tag" : "Tagged"}:     ${updated}`);
  if (notFound > 0) console.log(`Not found:       ${notFound}`);
  if (errors > 0) console.log(`Errors:          ${errors}`);
  console.log("══════════════════════════════════════════════════════════════════════");
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
