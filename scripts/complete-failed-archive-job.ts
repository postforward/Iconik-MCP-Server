#!/usr/bin/env npx tsx

/**
 * complete-failed-archive-job.ts
 *
 * Completes a failed Iconik archive job by processing its failed subjobs.
 * For each failed subjob the script:
 *   1. Copies the file from source to archive storage (if not already present)
 *   2. Creates a file set + file record on the archive storage in Iconik
 *   3. Sets archive_status -> ARCHIVED on the asset and all formats
 *   4. Updates the subjob status to FINISHED
 *   5. Updates the parent job progress to 100% and status to FINISHED
 *
 * Dry-run by default. Add --live to apply changes.
 *
 * Usage:
 *   npx tsx scripts/complete-failed-archive-job.ts --profile=<name> \
 *     --source-mount=<path> --archive-mount=<path> <job_id>
 *
 *   npx tsx scripts/complete-failed-archive-job.ts --profile=<name> \
 *     --source-mount=<path> --archive-mount=<path> --live <job_id>
 */

import { iconikRequest, initializeProfile } from "../src/client.js";
import { getProfileFromArgs } from "../src/config.js";
import { existsSync, statSync, mkdirSync, copyFileSync } from "fs";
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
const jobArgs = rawArgs.filter((a) => !a.startsWith("--"));

if (!sourceMountPath || !archiveMountPath || jobArgs.length !== 1) {
  console.error(
    "Usage: npx tsx scripts/complete-failed-archive-job.ts --profile=<name> \\"
  );
  console.error(
    "  --source-mount=<path> --archive-mount=<path> [--live] <job_id>"
  );
  console.error("");
  console.error("Options:");
  console.error("  --profile=<name>         Iconik profile to use");
  console.error("  --source-mount=<path>    Local mount point for source storage");
  console.error("  --archive-mount=<path>   Local mount point for archive storage");
  console.error("  --live                   Apply changes (default: dry-run)");
  process.exit(1);
}

const jobId = jobArgs[0];

interface PaginatedResponse<T> {
  objects: T[];
  page: number;
  pages: number;
  per_page: number;
  total: number;
}

// --- Helpers ---

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

async function getAllPages<T>(baseUrl: string, perPage = 100): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  while (true) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const resp = await iconikRequest<PaginatedResponse<T>>(
      `${baseUrl}${sep}page=${page}&per_page=${perPage}`
    );
    all.push(...(resp.objects || []));
    if (page >= (resp.pages || 1)) break;
    page++;
  }
  return all;
}

// --- Archive a single asset ---

async function archiveAsset(
  assetId: string,
  archiveStorageId: string,
  sourceStorageId: string
): Promise<boolean> {
  const prefix = live ? "" : "[DRY RUN] ";

  const asset = await iconikRequest<any>(`assets/v1/assets/${assetId}/`);
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${prefix}${assetId} "${asset.title}" [${asset.archive_status}]`);

  if (asset.archive_status === "ARCHIVED") {
    console.log(`  Already ARCHIVED — skipping`);
    return true;
  }

  // Get formats, file sets, and files
  const formats = await getAllPages<any>(
    `files/v1/assets/${assetId}/formats/`
  );
  const fileSets = await getAllPages<any>(
    `files/v1/assets/${assetId}/file_sets/`
  );
  const files = await getAllPages<any>(
    `files/v1/assets/${assetId}/files/`
  );

  const originalFormat =
    formats.find((f: any) => f.name === "ORIGINAL") || formats[0];
  if (!originalFormat) {
    console.log(`  ERROR: No format found — skipping`);
    return false;
  }

  // Find source and archive file records
  const sourceFile = files.find((f: any) => f.storage_id === sourceStorageId);
  const archiveFileRecord = files.find(
    (f: any) => f.storage_id === archiveStorageId
  );
  const archiveFileSet = fileSets.find(
    (fs: any) => fs.storage_id === archiveStorageId
  );

  const refFile = sourceFile || archiveFileRecord || files[0];
  if (!refFile) {
    console.log(`  ERROR: No file records at all — skipping`);
    return false;
  }

  const dirPath = refFile.directory_path || "";
  const fileName = refFile.name;
  const archiveDiskPath = join(archiveMountPath!, dirPath, fileName);
  const sourceDiskPath = sourceFile
    ? join(sourceMountPath!, sourceFile.directory_path || "", sourceFile.name)
    : null;

  // Step 1: Ensure file is on archive disk
  if (existsSync(archiveDiskPath)) {
    const size = statSync(archiveDiskPath).size;
    console.log(`  Archive disk: already present (${size} bytes)`);
  } else if (sourceDiskPath && existsSync(sourceDiskPath)) {
    const srcSize = statSync(sourceDiskPath).size;
    console.log(`  ${prefix}Copying to archive storage (${srcSize} bytes)...`);
    if (live) {
      mkdirSync(dirname(archiveDiskPath), { recursive: true });
      copyFileSync(sourceDiskPath, archiveDiskPath);
      const dstSize = statSync(archiveDiskPath).size;
      if (srcSize !== dstSize) {
        console.log(
          `  ERROR: Copy size mismatch (src=${srcSize} dst=${dstSize})`
        );
        return false;
      }
      console.log(`  Copied ${dstSize} bytes`);
    }
  } else {
    console.log(`  ERROR: File not on archive or source disk — skipping`);
    if (sourceDiskPath) console.log(`    Source: ${sourceDiskPath}`);
    console.log(`    Archive: ${archiveDiskPath}`);
    return false;
  }

  // Step 2: Ensure archive file set exists in Iconik
  let fileSetId: string;
  if (archiveFileSet) {
    fileSetId = archiveFileSet.id;
    console.log(`  Archive file set: already exists (${fileSetId})`);
  } else {
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
    console.log(
      `  Archive file record: already exists (${archiveFileRecord.id})`
    );
    // Fix status if needed
    if (archiveFileRecord.status === "MISSING") {
      console.log(`  ${prefix}Fixing file record status MISSING -> CLOSED...`);
      if (live) {
        await iconikRequest(
          `files/v1/assets/${assetId}/files/${archiveFileRecord.id}/`,
          {
            method: "PATCH",
            body: JSON.stringify({ status: "CLOSED" }),
          }
        );
      }
    }
  } else {
    const fileSize = existsSync(archiveDiskPath)
      ? statSync(archiveDiskPath).size
      : sourceFile?.size || 0;
    console.log(
      `  ${prefix}Creating archive file record (${fileSize} bytes)...`
    );
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

  // Step 4: Set archive_status -> ARCHIVED on asset + all formats
  console.log(`  ${prefix}Setting archive_status -> ARCHIVED...`);
  if (live) {
    await iconikRequest(`assets/v1/assets/${assetId}/`, {
      method: "PATCH",
      body: JSON.stringify({ archive_status: "ARCHIVED" }),
    });
    for (const fmt of formats) {
      await iconikRequest(
        `files/v1/assets/${assetId}/formats/${fmt.id}/`,
        {
          method: "PATCH",
          body: JSON.stringify({ archive_status: "ARCHIVED" }),
        }
      );
    }
    console.log(`  Asset + ${formats.length} format(s) -> ARCHIVED`);
  }

  console.log(`  ${prefix}DONE`);
  return true;
}

// --- Main ---

async function main() {
  console.log(`Profile: ${profileName}`);
  console.log(`Mode: ${live ? "LIVE" : "DRY RUN"}`);
  console.log(`Source mount: ${sourceMountPath}`);
  console.log(`Archive mount: ${archiveMountPath}`);
  console.log(`Job ID: ${jobId}\n`);

  // Validate mounts
  if (!existsSync(sourceMountPath!)) {
    console.error(`ERROR: Source storage not mounted at ${sourceMountPath}`);
    process.exit(1);
  }
  if (!existsSync(archiveMountPath!)) {
    console.error(`ERROR: Archive storage not mounted at ${archiveMountPath}`);
    process.exit(1);
  }

  // Get the parent job
  const job = await iconikRequest<any>(`jobs/v1/jobs/${jobId}/`);
  console.log(`Job: "${job.title}"`);
  console.log(
    `Status: ${job.status} | Progress: ${job.progress_processed}/${job.progress_total}`
  );

  if (job.status !== "FAILED") {
    console.log(`WARNING: Job status is ${job.status}, not FAILED`);
  }

  // Get archive storage ID from the job (stored in metadata.storage_id)
  const archiveStorageId =
    job.metadata?.storage_id || job.storage_id;
  if (!archiveStorageId) {
    console.error("ERROR: Could not determine archive storage from job");
    process.exit(1);
  }
  const archiveStorage = await getStorage(archiveStorageId);
  console.log(
    `Archive storage: "${archiveStorage?.name}" (${archiveStorageId})`
  );

  // Find failed subjobs
  const allSubjobs = await getAllPages<any>(
    `jobs/v1/jobs/?parent_id=${jobId}&status=FAILED`
  );
  console.log(`Failed subjobs: ${allSubjobs.length}`);

  if (allSubjobs.length === 0) {
    console.log("No failed subjobs found — nothing to do");
    return;
  }

  // Process each failed subjob
  let success = 0;
  let errors = 0;
  const successfulSubjobs: any[] = [];
  const prefix = live ? "" : "[DRY RUN] ";

  for (const subjob of allSubjobs) {
    const assetId = subjob.object_id;
    const sourceStorageId =
      subjob.metadata?.original_storage_id ||
      subjob.job_context?.original_storage_id ||
      "";

    if (!assetId) {
      console.log(`\n  SKIP: Subjob ${subjob.id} has no object_id`);
      errors++;
      continue;
    }

    console.log(`\nSubjob: ${subjob.id}`);
    console.log(`  Error was: ${subjob.error_message || "(none)"}`);

    try {
      const ok = await archiveAsset(assetId, archiveStorageId, sourceStorageId);
      if (ok) {
        success++;
        successfulSubjobs.push(subjob);
      } else {
        errors++;
      }
    } catch (err) {
      console.log(
        `  FATAL: ${err instanceof Error ? err.message : err}`
      );
      errors++;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `Mode: ${live ? "LIVE" : "DRY RUN"} | Archived: ${success} | Errors: ${errors}`
  );

  if (!live || errors > 0 || success === 0) {
    if (errors > 0) {
      console.log(`${errors} subjob(s) still failed — job NOT updated`);
    }
    return;
  }

  // Prompt before finishing the job (triggers downstream webhooks)
  console.log(
    `\nAll ${success} asset(s) archived successfully.`
  );
  console.log("WARNING: Finishing the job may trigger downstream webhooks/scripts.\n");

  const rl = await import("readline");
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    iface.question("Mark job as FINISHED? (y/N): ", (a) => {
      iface.close();
      resolve(a.trim());
    });
  });

  if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
    console.log("Job left as FAILED. Run again when ready to finish.");
    return;
  }

  // Finish subjobs + parent job
  for (const subjob of successfulSubjobs) {
    await iconikRequest(`jobs/v1/jobs/${subjob.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ status: "FINISHED" }),
    });
    console.log(`Subjob ${subjob.id} -> FINISHED`);
  }

  await iconikRequest(`jobs/v1/jobs/${jobId}/`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "FINISHED",
      progress_processed: job.progress_total || 100,
    }),
  });
  console.log(`Parent job ${jobId} -> FINISHED`);
}

main().catch(console.error);
