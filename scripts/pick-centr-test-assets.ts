#!/usr/bin/env npx tsx

/**
 * PICK TEST ASSETS FROM TAGGED COLLECTIONS
 *
 * Recursively walks each collection in a JSON config and grabs N matching assets
 * from deep within the tree. Reports asset IDs to use for testing workflows.
 *
 * Usage:
 *   npx tsx scripts/pick-centr-test-assets.ts --profile=<name> --collections=<json> [--n=2]
 *
 * The collections JSON file should be an array of:
 *   [{ "tier": "cold|warm", "id": "<uuid>", "title": "Display name" }, ...]
 *
 * For collections whose title contains "stills", image extensions are also matched.
 */

import { readFileSync } from "fs";
import { iconikRequest, initializeProfile } from "../src/client.ts";
import { getProfileFromArgs } from "../src/config.ts";

const profileName = getProfileFromArgs();
initializeProfile(profileName);

const args = process.argv.slice(2);
const n = parseInt(args.find(a => a.startsWith("--n="))?.split("=")[1] || "2");
const collectionsArg = args.find(a => a.startsWith("--collections="))?.split("=").slice(1).join("=");

if (!collectionsArg) {
  console.error("Required: --collections=<path to JSON config>");
  process.exit(1);
}

interface TaggedCollection {
  tier: string;
  id: string;
  title: string;
}

const TAGGED_COLLECTIONS: TaggedCollection[] = JSON.parse(readFileSync(collectionsArg, "utf-8"));

const VIDEO_EXTS = [".mov", ".mp4", ".mxf", ".m4v", ".avi", ".mkv", ".prores", ".braw", ".r3d"];
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".cr2", ".cr3", ".arw", ".nef", ".dng"];

interface CollectionContent {
  id: string;
  title: string;
  object_type: string;
  media_type?: string;
}

interface PaginatedResponse<T> {
  objects: T[];
  total: number;
  page: number;
  pages: number;
}

async function getContents(colId: string): Promise<CollectionContent[]> {
  const all: CollectionContent[] = [];
  let page = 1;
  while (true) {
    const res = await iconikRequest<PaginatedResponse<CollectionContent>>(
      `assets/v1/collections/${colId}/contents/?per_page=100&page=${page}`,
    );
    all.push(...(res.objects || []));
    if (res.pages <= page) break;
    page++;
  }
  return all;
}

/** Recursively walk and find first N matching assets, preferring deep paths */
async function findAssets(
  colId: string,
  needed: number,
  exts: string[],
  depth = 0,
  pathSoFar: string[] = [],
): Promise<Array<{ id: string; title: string; path: string }>> {
  const found: Array<{ id: string; title: string; path: string }> = [];
  const contents = await getContents(colId);
  const subcols = contents.filter(c => c.object_type === "collections");
  const assets = contents.filter(c => c.object_type === "assets");

  // Recurse into deepest subcollection first
  for (const sub of subcols) {
    if (found.length >= needed) break;
    const subFound = await findAssets(
      sub.id,
      needed - found.length,
      exts,
      depth + 1,
      [...pathSoFar, sub.title],
    );
    found.push(...subFound);
  }

  // Then check assets in this collection
  for (const asset of assets) {
    if (found.length >= needed) break;
    const lower = asset.title.toLowerCase();
    if (exts.some(ext => lower.endsWith(ext))) {
      found.push({
        id: asset.id,
        title: asset.title,
        path: pathSoFar.join("/"),
      });
    }
  }

  return found;
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("TEST ASSET PICKER");
  console.log("══════════════════════════════════════════════════════════════════════\n");

  const allPicks: Array<{ tier: string; collection: string; asset: { id: string; title: string; path: string } }> = [];

  for (const col of TAGGED_COLLECTIONS) {
    console.log(`[${col.tier.toUpperCase()}] ${col.title}`);
    // Stills folders also match image extensions
    const exts = col.title.toLowerCase().includes("stills")
      ? [...IMAGE_EXTS, ...VIDEO_EXTS]
      : VIDEO_EXTS;
    try {
      const assets = await findAssets(col.id, n, exts);
      if (assets.length === 0) {
        console.log("  (no video assets found)\n");
        continue;
      }
      for (const a of assets) {
        console.log(`  ${a.id}  ${a.path}/${a.title}`);
        allPicks.push({ tier: col.tier, collection: col.title, asset: a });
      }
      console.log("");
    } catch (e) {
      console.log(`  ERROR: ${e instanceof Error ? e.message : e}\n`);
    }
  }

  // Print summary at bottom for easy copy
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("ASSET IDS FOR TESTING");
  console.log("══════════════════════════════════════════════════════════════════════");
  for (const pick of allPicks) {
    console.log(`${pick.tier.padEnd(5)} ${pick.asset.id}  ${pick.asset.title}`);
  }
}

main().catch(console.error);
