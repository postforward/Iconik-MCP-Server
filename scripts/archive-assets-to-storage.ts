#!/usr/bin/env npx tsx

/**
 * archive-assets-to-storage.ts
 *
 * Manually archives individual assets by copying files between locally-mounted
 * storage volumes and updating Iconik metadata. Useful when Iconik's built-in
 * archive jobs fail or get stuck.
 *
 * For each asset the script:
 *   1. Copies the file from the source storage mount to the archive storage mount
 *   2. Verifies the copy (size match)
 *   3. Creates a file set + file record on the archive storage in Iconik
 *   4. Sets archive_status -> ARCHIVED on the asset and all formats
 *   5. Deletes file sets from the source storage in Iconik
 *   6. Deletes the source files from disk
 *
 * The script is idempotent — it detects what's already done and picks up from
 * where it left off (e.g. if the file is already copied, it skips the copy).
 *
 * Dry-run by default. Add --live to apply changes.
 *
 * Usage:
 *   npx tsx scripts/archive-assets-to-storage.ts --profile=<name> \
 *     --source-mount=/mnt/source --archive-mount=/mnt/archive \
 *     --archive-storage=<storage_id> <asset_id> [...]
 *
 *   npx tsx scripts/archive-assets-to-storage.ts --profile=<name> \
 *     --source-mount=/mnt/source --archive-mount=/mnt/archive \
 *     --archive-storage=<storage_id> --live <asset_id> [...]
 */

import { iconikRequest, initializeProfile } from "../src/client.js";
import { getProfileFromArgs } from "../src/config.js";
import { existsSync, statSync, mkdirSync, copyFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";

// --- CLI args ---
const profileName = getProfileFromArgs();
initializeProfile(profileName);

const rawArgs = process.argv.slice(2);
const live = rawArgs.includes("--live");

function getArgValue(prefix: string): string | undefined {
  const arg = rawArgs.find((a) => a.startsWith(prefix));
  return arg?.split("=")[1];
}

const sourceMountPath = getArgValue("--source-mount=");
const archiveMountPath = getArgValue("--archive-mount=");
const archiveStorageId = getArgValue("--archive-storage=");
const assetArgs = rawArgs.filter((a) => !a.startsWith("--"));

if (!sourceMountPath || !archiveMountPath || !archiveStorageId || assetArgs.length === 0) {
  console.error(
    "Usage: npx tsx scripts/archive-assets-to-storage.ts --profile=<name> \\"
  );
  console.error(
    "  --source-mount=<path> --archive-mount=<path> --archive-storage=<storage_id> \\"
  );
  console.error("  [--live] <asset_id> [...]");
  console.error("");
  console.error("Options:");
  console.error("  --profile=<name>              Iconik profile to use");
  console.error("  --source-mount=<path>         Local mount point for source (working) storage");
  console.error("  --archive-mount=<path>        Local mount point for archive storage");
  console.error("  --archive-storage=<storage_id> Iconik storage ID for the archive destination");
  console.error("  --live                        Apply changes (default: dry-run)");
  console.error("");
  console.error("To find your archive storage ID, check Iconik admin or run:");
  console.error("  Use the list_storages MCP tool, or check files/v1/storages/ API");
  process.exit(1);
}

interface PaginatedResponse<T> {
  objects: T[];
  page: number;
  pages: number;
  per_page: number;
  total: number;
}

// --- Storage helpers ---

const storageCache = new Map<string, any>();

async function getStorage(id: string) {
  if (storageCache.has(id)) return storageCache.get(id);
  try {
    const s = await iconikRequest<any>(`files/v1/storages/${id}/`);
    storageCache.set(id, s);
    return s;
  } catch {
    storageCache.set(id, null);
    return null;
  }
}

// Collect all source storage IDs (non-archive purpose) for cleanup
const sourceStorageIds = new Set<string>();

async function discoverSourceStorages(files: any[]) {
  for (const f of files) {
    const storage = await getStorage(f.storage_id);
    if (storage && storage.purpose !== "ARCHIVE" && f.storage_id !== archiveStorageId) {
      sourceStorageIds.add(f.storage_id);
    }
  }
}

// --- Main archive logic ---

async function archiveAsset(assetId: string): Promise<boolean> {
  const prefix = live ? "" : "[DRY RUN] ";

  const asset = await iconikRequest<any>(`assets/v1/assets/${assetId}/`);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${prefix}${assetId} "${asset.title}" [${asset.archive_status}]`);

  // Get files, file sets, formats
  const filesResp = await iconikRequest<PaginatedResponse<any>>(
    `files/v1/assets/${assetId}/files/`
  );
  const files = filesResp.objects || [];
  const fsResp = await iconikRequest<PaginatedResponse<any>>(
    `files/v1/assets/${assetId}/file_sets/?per_page=50`
  );
  const fileSets = fsResp.objects || [];
  const formatsResp = await iconikRequest<PaginatedResponse<any>>(
    `files/v1/assets/${assetId}/formats/`
  );
  const formats = formatsResp.objects || [];
  const originalFormat =
    formats.find((f: any) => f.name === "ORIGINAL") || formats[0];

  if (!originalFormat) {
    console.log(`  ERROR: No format found -- skipping`);
    return false;
  }

  // Discover source storages for later cleanup
  await discoverSourceStorages(files);

  const archiveFileRecord = files.find(
    (f: any) => f.storage_id === archiveStorageId
  );
  const archiveFileSet = fileSets.find(
    (fs: any) => fs.storage_id === archiveStorageId
  );
  // Find a source file (any non-archive storage)
  const sourceFile = files.find(
    (f: any) => f.storage_id !== archiveStorageId
  );
  const refFile = sourceFile || archiveFileRecord || files[0];

  if (!refFile) {
    console.log(`  ERROR: No file records at all -- skipping`);
    return false;
  }

  const dirPath = refFile.directory_path || "";
  const fileName = refFile.name;
  const archiveDiskPath = join(archiveMountPath, dirPath, fileName);
  const sourceDiskPath = sourceFile
    ? join(sourceMountPath, sourceFile.directory_path || "", sourceFile.name)
    : null;

  // Step 1: Ensure file is on archive disk
  if (existsSync(archiveDiskPath)) {
    const size = statSync(archiveDiskPath).size;
    console.log(`  Archive disk: already present (${size} bytes)`);
  } else if (sourceDiskPath && existsSync(sourceDiskPath)) {
    console.log(`  ${prefix}Copying to archive storage...`);
    if (live) {
      mkdirSync(dirname(archiveDiskPath), { recursive: true });
      copyFileSync(sourceDiskPath, archiveDiskPath);
      const srcSize = statSync(sourceDiskPath).size;
      const dstSize = statSync(archiveDiskPath).size;
      if (srcSize !== dstSize) {
        console.log(`  ERROR: Copy size mismatch (src=${srcSize} dst=${dstSize})`);
        return false;
      }
      console.log(`  Copied ${dstSize} bytes`);
    }
  } else {
    console.log(`  ERROR: File not on archive or source disk -- skipping`);
    if (sourceDiskPath) console.log(`    Source path checked: ${sourceDiskPath}`);
    console.log(`    Archive path checked: ${archiveDiskPath}`);
    return false;
  }

  // Step 2: Ensure archive file set exists in Iconik
  let fileSetId: string;
  if (archiveFileSet) {
    fileSetId = archiveFileSet.id;
    console.log(`  Archive file set: already exists (${fileSetId})`);
  } else {
    // Get component IDs for the format
    let componentIds = [originalFormat.id];
    try {
      const comps = await iconikRequest<any>(
        `files/v1/assets/${assetId}/formats/${originalFormat.id}/components/`
      );
      if (comps.objects?.length) {
        componentIds = comps.objects.map((c: any) => c.id);
      }
    } catch {}

    console.log(`  ${prefix}Creating archive file set...`);
    if (live) {
      const fs = await iconikRequest<any>(
        `files/v1/assets/${assetId}/file_sets/`,
        {
          method: "POST",
          body: JSON.stringify({
            storage_id: archiveStorageId,
            format_id: originalFormat.id,
            component_ids: componentIds,
            name: fileName,
            base_dir: dirPath.endsWith("/") ? dirPath : dirPath + "/",
          }),
        }
      );
      fileSetId = fs.id;
      console.log(`  Created file set: ${fileSetId}`);
    } else {
      fileSetId = "(dry-run)";
    }
  }

  // Step 3: Ensure archive file record exists
  if (archiveFileRecord) {
    console.log(`  Archive file record: already exists (${archiveFileRecord.id})`);
  } else {
    const fileSize = existsSync(archiveDiskPath)
      ? statSync(archiveDiskPath).size
      : sourceFile?.size || 0;
    console.log(`  ${prefix}Creating archive file record (${fileSize} bytes)...`);
    if (live) {
      const fr = await iconikRequest<any>(
        `files/v1/assets/${assetId}/files/`,
        {
          method: "POST",
          body: JSON.stringify({
            file_set_id: fileSetId,
            format_id: originalFormat.id,
            storage_id: archiveStorageId,
            name: fileName,
            original_name: fileName,
            directory_path: dirPath.endsWith("/") ? dirPath : dirPath + "/",
            size: fileSize,
            type: "FILE",
            status: "CLOSED",
          }),
        }
      );
      console.log(`  Created file record: ${fr.id}`);
    }
  }

  // Step 4: Set archive_status -> ARCHIVED
  console.log(`  ${prefix}Setting archive_status -> ARCHIVED...`);
  if (live) {
    await iconikRequest(`assets/v1/assets/${assetId}/`, {
      method: "PATCH",
      body: JSON.stringify({ archive_status: "ARCHIVED" }),
    });
    for (const fmt of formats) {
      await iconikRequest(`files/v1/assets/${assetId}/formats/${fmt.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ archive_status: "ARCHIVED" }),
      });
    }
    console.log(`  Asset + ${formats.length} format(s) -> ARCHIVED`);
  }

  // Step 5: Delete source file sets from Iconik
  const sourceFileSets = fileSets.filter(
    (fs: any) => sourceStorageIds.has(fs.storage_id)
  );
  if (sourceFileSets.length > 0) {
    console.log(`  ${prefix}Deleting ${sourceFileSets.length} source file set(s)...`);
    for (const fs of sourceFileSets) {
      const storage = await getStorage(fs.storage_id);
      const storageName = storage?.name || fs.storage_id;
      if (live) {
        try {
          await iconikRequest(
            `files/v1/assets/${assetId}/file_sets/${fs.id}/`,
            { method: "DELETE" }
          );
          console.log(`    Deleted ${fs.id} (${storageName})`);
        } catch (err: any) {
          console.log(`    WARN: ${fs.id} (${storageName}): ${err.message}`);
        }
      } else {
        console.log(`    ${prefix}Delete ${fs.id} (${storageName})`);
      }
    }
  }

  // Step 6: Delete source files from disk
  const sourceFiles = files.filter(
    (f: any) => sourceStorageIds.has(f.storage_id)
  );
  if (sourceFiles.length > 0) {
    console.log(`  ${prefix}Deleting ${sourceFiles.length} source file(s) from disk...`);
    for (const f of sourceFiles) {
      const filePath = join(sourceMountPath, f.directory_path || "", f.name);
      if (existsSync(filePath)) {
        if (live) {
          unlinkSync(filePath);
          console.log(`    Deleted: ${filePath}`);
        } else {
          console.log(`    ${prefix}rm "${filePath}"`);
        }
      }
    }
  }

  console.log(`  ${prefix}DONE`);
  return true;
}

async function main() {
  console.log(`Profile: ${profileName}`);
  console.log(`Mode: ${live ? "LIVE" : "DRY RUN"}`);
  console.log(`Source mount: ${sourceMountPath}`);
  console.log(`Archive mount: ${archiveMountPath}`);
  console.log(`Archive storage ID: ${archiveStorageId}`);
  console.log(`Assets: ${assetArgs.length}`);

  if (!existsSync(sourceMountPath!)) {
    console.error(`ERROR: Source storage not mounted at ${sourceMountPath}`);
    process.exit(1);
  }
  if (!existsSync(archiveMountPath!)) {
    console.error(`ERROR: Archive storage not mounted at ${archiveMountPath}`);
    process.exit(1);
  }

  // Verify archive storage exists in Iconik
  const archiveStorage = await getStorage(archiveStorageId!);
  if (!archiveStorage) {
    console.error(`ERROR: Archive storage ${archiveStorageId} not found in Iconik`);
    process.exit(1);
  }
  console.log(`Archive storage: "${archiveStorage.name}" (${archiveStorage.purpose})\n`);

  let success = 0;
  let errors = 0;
  for (const id of assetArgs) {
    try {
      if (await archiveAsset(id)) success++;
      else errors++;
    } catch (err) {
      console.log(`  FATAL: ${err instanceof Error ? err.message : err}`);
      errors++;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Mode: ${live ? "LIVE" : "DRY RUN"} | Success: ${success} | Errors: ${errors}`);
}

main().catch(console.error);
