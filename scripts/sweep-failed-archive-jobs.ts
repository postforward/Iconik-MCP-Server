#!/usr/bin/env npx tsx

/**
 * sweep-failed-archive-jobs.ts
 *
 * Interactive tool to find and fix failed Iconik archive jobs. Scans for all
 * failed ARCHIVE jobs (newest first), presents them for selection, then
 * processes the chosen jobs by archiving failed assets and updating job status.
 *
 * Modes:
 *   --interactive (default)  Prompt to select jobs, then dry-run, then confirm live
 *   --select=1,2,3           Pre-select jobs by number (skip selection prompt)
 *   --select=all             Select all failed jobs
 *   --select-job=<id>        Target a specific job by UUID (for webhook/Slack integration)
 *   --live                   Apply changes (still previews first unless --yes)
 *   --finish                 Only mark job(s) as FINISHED (skip archiving, use after assets are fixed)
 *   --yes                    Skip confirmation prompts (for automation/Slack)
 *   --json                   Output results as JSON (for Slack/webhook consumption)
 *
 * Usage:
 *   # Interactive discovery
 *   npx tsx scripts/sweep-failed-archive-jobs.ts --profile=<name> \
 *     --source-mount=<path> --archive-mount=<path>
 *
 *   # Webhook/Slack: fix assets for a specific job
 *   npx tsx scripts/sweep-failed-archive-jobs.ts --profile=<name> \
 *     --source-mount=<path> --archive-mount=<path> \
 *     --select-job=<job_uuid> --live --yes --json
 *
 *   # Webhook/Slack: finish a job (after assets are fixed)
 *   npx tsx scripts/sweep-failed-archive-jobs.ts --profile=<name> \
 *     --source-mount=<path> --archive-mount=<path> \
 *     --select-job=<job_uuid> --finish --yes --json
 */

import { iconikRequest, initializeProfile } from "../src/client.js";
import { getProfileFromArgs } from "../src/config.js";
import { existsSync, statSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { createInterface } from "readline";

// --- CLI args ---
const profileName = getProfileFromArgs();
initializeProfile(profileName);

const rawArgs = process.argv.slice(2);
const live = rawArgs.includes("--live");
const autoYes = rawArgs.includes("--yes");
const jsonOutput = rawArgs.includes("--json");
const finishOnly = rawArgs.includes("--finish");

function getArgValue(prefix: string): string | undefined {
  const arg = rawArgs.find((a) => a.startsWith(prefix));
  return arg?.split("=")[1];
}

const sourceMountPath = getArgValue("--source-mount=");
const archiveMountPath = getArgValue("--archive-mount=");
const selectArg = getArgValue("--select=");
const selectJobArg = getArgValue("--select-job=");

if (!sourceMountPath || !archiveMountPath) {
  console.error(
    "Usage: npx tsx scripts/sweep-failed-archive-jobs.ts --profile=<name> \\"
  );
  console.error(
    "  --source-mount=<path> --archive-mount=<path> [options]"
  );
  console.error("");
  console.error("Options:");
  console.error("  --profile=<name>         Iconik profile to use");
  console.error("  --source-mount=<path>    Local mount point for source storage");
  console.error("  --archive-mount=<path>   Local mount point for archive storage");
  console.error("  --select=1,2,3           Pre-select jobs by number");
  console.error("  --select=all             Select all failed jobs");
  console.error("  --select-job=<id>        Target a specific job by UUID");
  console.error("  --live                   Apply changes (default: dry-run)");
  console.error("  --finish                 Only mark job(s) as FINISHED (skip archiving)");
  console.error("  --yes                    Skip confirmation prompts");
  console.error("  --json                   Output results as JSON");
  process.exit(1);
}

// --- Types ---

interface PaginatedResponse<T> {
  objects: T[];
  page: number;
  pages: number;
  per_page: number;
  total: number;
}

interface JobSummary {
  id: string;
  title: string;
  date: string;
  storageName: string;
  storageId: string;
  totalSubjobs: number;
  failedSubjobs: number;
  errors: string[];
}

interface ProcessResult {
  jobId: string;
  jobTitle: string;
  assetsProcessed: number;
  assetsFailed: number;
  jobUpdated: boolean;
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

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len - 1) + "\u2026" : s;
}

// --- Look up a single job by ID ---

async function getJobSummary(jobId: string): Promise<JobSummary | null> {
  try {
    const job = await iconikRequest<any>(`jobs/v1/jobs/${jobId}/`);
    const storageId = job.metadata?.storage_id || job.storage_id || "";
    const storage = storageId ? await getStorage(storageId) : null;

    const failedSubjobs = await getAllPages<any>(
      `jobs/v1/jobs/?parent_id=${jobId}&status=FAILED&per_page=10`
    );

    const uniqueErrors = [
      ...new Set(
        failedSubjobs.map((s: any) => s.error_message).filter(Boolean)
      ),
    ];

    return {
      id: job.id,
      title: job.title || "(untitled)",
      date: job.date_created,
      storageName: storage?.name || storageId,
      storageId,
      totalSubjobs: job.progress_total || 0,
      failedSubjobs: failedSubjobs.length,
      errors: uniqueErrors as string[],
    };
  } catch (err) {
    console.error(`ERROR: Could not fetch job ${jobId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// --- Discover failed archive jobs ---

async function discoverFailedJobs(): Promise<JobSummary[]> {
  // Get all failed ARCHIVE parent jobs (no parent_id = top-level)
  const jobs = await getAllPages<any>(
    `jobs/v1/jobs/?type=ARCHIVE&status=FAILED&per_page=50`
  );

  // Filter to parent jobs only and sort newest first
  const parentJobs = jobs
    .filter((j: any) => !j.parent_id)
    .sort(
      (a: any, b: any) =>
        new Date(b.date_created).getTime() -
        new Date(a.date_created).getTime()
    );

  const summaries: JobSummary[] = [];

  for (const job of parentJobs) {
    const storageId = job.metadata?.storage_id || job.storage_id || "";
    const storage = storageId ? await getStorage(storageId) : null;

    // Get failed subjob count and sample errors
    const failedSubjobs = await getAllPages<any>(
      `jobs/v1/jobs/?parent_id=${job.id}&status=FAILED&per_page=10`
    );

    if (failedSubjobs.length === 0) continue; // Job says FAILED but no failed subjobs

    const uniqueErrors = [
      ...new Set(
        failedSubjobs
          .map((s: any) => s.error_message)
          .filter(Boolean)
      ),
    ];

    summaries.push({
      id: job.id,
      title: job.title || "(untitled)",
      date: job.date_created,
      storageName: storage?.name || storageId,
      storageId,
      totalSubjobs: job.progress_total || 0,
      failedSubjobs: failedSubjobs.length,
      errors: uniqueErrors as string[],
    });
  }

  return summaries;
}

// --- Archive a single asset ---

async function archiveAsset(
  assetId: string,
  archiveStorageId: string,
  sourceStorageId: string,
  applyChanges: boolean
): Promise<boolean> {
  const prefix = applyChanges ? "" : "[DRY RUN] ";

  const asset = await iconikRequest<any>(`assets/v1/assets/${assetId}/`);
  console.log(`\n  ${"─".repeat(56)}`);
  console.log(
    `  ${prefix}${assetId} "${truncate(asset.title, 50)}" [${asset.archive_status}]`
  );

  if (asset.archive_status === "ARCHIVED") {
    console.log(`    Already ARCHIVED — skipping`);
    return true;
  }

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
    console.log(`    ERROR: No format found — skipping`);
    return false;
  }

  const sourceFile = files.find((f: any) => f.storage_id === sourceStorageId);
  const archiveFileRecord = files.find(
    (f: any) => f.storage_id === archiveStorageId
  );
  const archiveFileSet = fileSets.find(
    (fs: any) => fs.storage_id === archiveStorageId
  );

  const refFile = sourceFile || archiveFileRecord || files[0];
  if (!refFile) {
    console.log(`    ERROR: No file records at all — skipping`);
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
    console.log(`    Archive disk: already present (${size} bytes)`);
  } else if (sourceDiskPath && existsSync(sourceDiskPath)) {
    const srcSize = statSync(sourceDiskPath).size;
    console.log(
      `    ${prefix}Copying to archive storage (${srcSize} bytes)...`
    );
    if (applyChanges) {
      mkdirSync(dirname(archiveDiskPath), { recursive: true });
      copyFileSync(sourceDiskPath, archiveDiskPath);
      const dstSize = statSync(archiveDiskPath).size;
      if (srcSize !== dstSize) {
        console.log(
          `    ERROR: Copy size mismatch (src=${srcSize} dst=${dstSize})`
        );
        return false;
      }
      console.log(`    Copied ${dstSize} bytes`);
    }
  } else {
    console.log(`    ERROR: File not on archive or source disk — skipping`);
    if (sourceDiskPath) console.log(`      Source: ${sourceDiskPath}`);
    console.log(`      Archive: ${archiveDiskPath}`);
    return false;
  }

  // Step 2: Ensure archive file set exists
  let fileSetId: string;
  if (archiveFileSet) {
    fileSetId = archiveFileSet.id;
    console.log(`    Archive file set: already exists (${fileSetId})`);
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

    console.log(`    ${prefix}Creating archive file set...`);
    if (applyChanges) {
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
      console.log(`    Created file set: ${fileSetId}`);
    } else {
      fileSetId = "(dry-run)";
    }
  }

  // Step 3: Ensure archive file record exists
  if (archiveFileRecord) {
    console.log(
      `    Archive file record: already exists (${archiveFileRecord.id})`
    );
    if (archiveFileRecord.status === "MISSING") {
      console.log(
        `    ${prefix}Fixing file record status MISSING -> CLOSED...`
      );
      if (applyChanges) {
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
      `    ${prefix}Creating archive file record (${fileSize} bytes)...`
    );
    if (applyChanges) {
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
      console.log(`    Created file record: ${fr.id}`);
    }
  }

  // Step 4: Set archive_status -> ARCHIVED
  console.log(`    ${prefix}Setting archive_status -> ARCHIVED...`);
  if (applyChanges) {
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
    console.log(`    Asset + ${formats.length} format(s) -> ARCHIVED`);
  }

  return true;
}

// --- Process a single parent job (archive assets + fix metadata only) ---

async function processJob(
  jobSummary: JobSummary,
  applyChanges: boolean
): Promise<ProcessResult> {
  const prefix = applyChanges ? "" : "[DRY RUN] ";
  const result: ProcessResult = {
    jobId: jobSummary.id,
    jobTitle: jobSummary.title,
    assetsProcessed: 0,
    assetsFailed: 0,
    jobUpdated: false,
  };

  console.log(`\n${"=".repeat(60)}`);
  console.log(`${prefix}Job: "${jobSummary.title}"`);
  console.log(`  Storage: ${jobSummary.storageName}`);

  const job = await iconikRequest<any>(`jobs/v1/jobs/${jobSummary.id}/`);
  const archiveStorageId = job.metadata?.storage_id || job.storage_id;

  const failedSubjobs = await getAllPages<any>(
    `jobs/v1/jobs/?parent_id=${jobSummary.id}&status=FAILED`
  );

  console.log(
    `  Processing ${failedSubjobs.length} failed subjob(s)...`
  );

  for (const subjob of failedSubjobs) {
    const assetId = subjob.object_id;
    const sourceStorageId =
      subjob.metadata?.original_storage_id ||
      subjob.job_context?.original_storage_id ||
      "";

    if (!assetId) {
      console.log(`\n  SKIP: Subjob ${subjob.id} has no object_id`);
      result.assetsFailed++;
      continue;
    }

    try {
      const ok = await archiveAsset(
        assetId,
        archiveStorageId,
        sourceStorageId,
        applyChanges
      );
      if (ok) {
        result.assetsProcessed++;
      } else {
        result.assetsFailed++;
      }
    } catch (err) {
      console.log(
        `    FATAL: ${err instanceof Error ? err.message : err}`
      );
      result.assetsFailed++;
    }
  }

  if (result.assetsFailed > 0) {
    console.log(
      `\n  ${result.assetsFailed} asset(s) still failed`
    );
  }

  return result;
}

// --- Mark a job and its failed subjobs as FINISHED ---

async function finishJob(jobSummary: JobSummary): Promise<boolean> {
  const job = await iconikRequest<any>(`jobs/v1/jobs/${jobSummary.id}/`);

  const failedSubjobs = await getAllPages<any>(
    `jobs/v1/jobs/?parent_id=${jobSummary.id}&status=FAILED`
  );

  for (const subjob of failedSubjobs) {
    await iconikRequest(`jobs/v1/jobs/${subjob.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ status: "FINISHED" }),
    });
    console.log(`  Subjob ${subjob.id} -> FINISHED`);
  }

  await iconikRequest(`jobs/v1/jobs/${jobSummary.id}/`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "FINISHED",
      progress_processed: job.progress_total || 100,
    }),
  });
  console.log(`  Parent job ${jobSummary.id} -> FINISHED`);
  return true;
}

// --- Main ---

async function main() {
  if (!jsonOutput) {
    console.log(`Profile: ${profileName}`);
    console.log(`Source mount: ${sourceMountPath}`);
    console.log(`Archive mount: ${archiveMountPath}\n`);
  }

  // Validate mounts
  if (!existsSync(sourceMountPath!)) {
    console.error(`ERROR: Source storage not mounted at ${sourceMountPath}`);
    process.exit(1);
  }
  if (!existsSync(archiveMountPath!)) {
    console.error(`ERROR: Archive storage not mounted at ${archiveMountPath}`);
    process.exit(1);
  }

  // --- Resolve selected jobs ---
  let selectedJobs: JobSummary[];

  if (selectJobArg) {
    // Direct job ID mode (for webhook/Slack integration)
    const jobIds = selectJobArg.split(",").map((s) => s.trim());
    const summaries: JobSummary[] = [];
    for (const id of jobIds) {
      if (!jsonOutput) console.log(`Looking up job ${id}...`);
      const summary = await getJobSummary(id);
      if (summary) summaries.push(summary);
    }
    if (summaries.length === 0) {
      const msg = "No valid jobs found for the given ID(s).";
      if (jsonOutput) {
        console.log(JSON.stringify({ status: "error", message: msg }));
      } else {
        console.error(msg);
      }
      process.exit(1);
    }
    selectedJobs = summaries;
  } else {
    // Discovery mode — scan for all failed jobs
    if (!jsonOutput) console.log("Scanning for failed archive jobs...\n");
    const failedJobs = await discoverFailedJobs();

    if (failedJobs.length === 0) {
      if (jsonOutput) {
        console.log(JSON.stringify({ status: "ok", message: "No failed archive jobs found", jobs: [] }));
      } else {
        console.log("No failed archive jobs found.");
      }
      return;
    }

    // Display job list
    if (!jsonOutput) {
      console.log(`Found ${failedJobs.length} failed archive job(s):\n`);
      for (let i = 0; i < failedJobs.length; i++) {
        const j = failedJobs[i];
        const errorSummary = j.errors.length > 0
          ? truncate(j.errors[0], 50)
          : "(no error message)";
        console.log(`  [${i + 1}] ${j.title}`);
        console.log(
          `      ${formatDate(j.date)}  |  ${j.failedSubjobs}/${j.totalSubjobs} failed  |  -> ${j.storageName}`
        );
        console.log(`      "${errorSummary}"`);
        console.log();
      }
    }

    // Select jobs by number
    let selectedIndices: number[];

    if (selectArg) {
      if (selectArg.toLowerCase() === "all") {
        selectedIndices = failedJobs.map((_, i) => i);
      } else {
        selectedIndices = selectArg
          .split(",")
          .map((s) => parseInt(s.trim(), 10) - 1)
          .filter((i) => i >= 0 && i < failedJobs.length);
      }
    } else {
      const answer = await prompt(
        `Process which jobs? (e.g. 1,2 or "all" or "none"): `
      );
      if (!answer || answer.toLowerCase() === "none" || answer.toLowerCase() === "n") {
        console.log("No jobs selected — exiting.");
        return;
      }
      if (answer.toLowerCase() === "all" || answer.toLowerCase() === "a") {
        selectedIndices = failedJobs.map((_, i) => i);
      } else {
        selectedIndices = answer
          .split(",")
          .map((s) => parseInt(s.trim(), 10) - 1)
          .filter((i) => i >= 0 && i < failedJobs.length);
      }
    }

    if (selectedIndices.length === 0) {
      console.log("No valid jobs selected — exiting.");
      return;
    }

    selectedJobs = selectedIndices.map((i) => failedJobs[i]);
  }

  if (!jsonOutput) {
    console.log(
      `\nSelected ${selectedJobs.length} job(s): ${selectedJobs.map((j) => `"${truncate(j.title, 40)}"`).join(", ")}`
    );
  }

  // --- Finish-only mode: just mark jobs as FINISHED ---
  if (finishOnly) {
    if (!jsonOutput) {
      console.log("\n--- FINISH JOBS MODE ---\n");
      console.log("WARNING: Finishing jobs may trigger downstream webhooks/scripts.\n");
      for (const j of selectedJobs) {
        console.log(`  "${truncate(j.title, 40)}" (${j.failedSubjobs} failed subjobs)`);
      }
    }

    if (!autoYes) {
      const confirmFinish = await prompt(
        `\nMark ${selectedJobs.length} job(s) as FINISHED? (y/N): `
      );
      if (confirmFinish.toLowerCase() !== "y" && confirmFinish.toLowerCase() !== "yes") {
        console.log("Aborted.");
        return;
      }
    }

    const results: ProcessResult[] = [];
    for (const jobSummary of selectedJobs) {
      if (!jsonOutput) console.log(`\nJob: "${jobSummary.title}"`);
      try {
        await finishJob(jobSummary);
        results.push({
          jobId: jobSummary.id,
          jobTitle: jobSummary.title,
          assetsProcessed: 0,
          assetsFailed: 0,
          jobUpdated: true,
        });
      } catch (err) {
        if (!jsonOutput) {
          console.log(`  ERROR: ${err instanceof Error ? err.message : err}`);
        }
        results.push({
          jobId: jobSummary.id,
          jobTitle: jobSummary.title,
          assetsProcessed: 0,
          assetsFailed: 0,
          jobUpdated: false,
        });
      }
    }

    const jobsCompleted = results.filter((r) => r.jobUpdated).length;
    if (jsonOutput) {
      console.log(JSON.stringify({
        status: jobsCompleted === results.length ? "ok" : "partial",
        action: "finish",
        jobsCompleted,
        jobsTotal: results.length,
        results,
      }, null, 2));
    } else {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Jobs finished: ${jobsCompleted}/${results.length}`);
    }
    return;
  }

  // --- Archive mode: fix assets, then optionally finish jobs ---

  // Phase 1: Dry run preview (always runs first)
  console.log("\n--- DRY RUN PREVIEW ---\n");
  const dryResults: ProcessResult[] = [];
  for (const job of selectedJobs) {
    dryResults.push(await processJob(job, false));
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("DRY RUN SUMMARY:");
  for (const r of dryResults) {
    console.log(
      `  "${truncate(r.jobTitle, 40)}" — ${r.assetsProcessed} would fix, ${r.assetsFailed} would fail`
    );
  }

  if (!live) {
    console.log("\nTo apply these changes, re-run with --live");
    if (jsonOutput) {
      console.log(JSON.stringify({ status: "dry_run", results: dryResults }, null, 2));
    }
    return;
  }

  // Phase 2: Confirm and archive assets
  if (!autoYes) {
    const totalAssets = selectedJobs.reduce(
      (sum, j) => sum + j.failedSubjobs,
      0
    );
    const confirmArchive = await prompt(
      `\nArchive ${totalAssets} failed asset(s) across ${selectedJobs.length} job(s)? (y/N): `
    );
    if (confirmArchive.toLowerCase() !== "y" && confirmArchive.toLowerCase() !== "yes") {
      console.log("Aborted.");
      return;
    }
  }

  console.log("\n--- ARCHIVING ASSETS ---\n");
  const results: ProcessResult[] = [];
  for (const job of selectedJobs) {
    results.push(await processJob(job, true));
  }

  // Archive summary
  const totalProcessed = results.reduce(
    (sum, r) => sum + r.assetsProcessed, 0
  );
  const totalFailed = results.reduce(
    (sum, r) => sum + r.assetsFailed, 0
  );

  console.log(`\n${"=".repeat(60)}`);
  console.log("ARCHIVE SUMMARY:");
  console.log(`  Assets archived: ${totalProcessed}`);
  console.log(`  Assets failed:   ${totalFailed}`);
  for (const r of results) {
    console.log(
      `  - "${truncate(r.jobTitle, 40)}" — ${r.assetsProcessed} fixed, ${r.assetsFailed} failed`
    );
  }

  // Phase 3: Prompt to finish jobs (separate step — triggers webhooks)
  const finishableJobs = results.filter(
    (r) => r.assetsFailed === 0 && r.assetsProcessed > 0
  );

  if (finishableJobs.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({
        status: totalFailed === 0 ? "ok" : "partial",
        action: "archive",
        assetsProcessed: totalProcessed,
        assetsFailed: totalFailed,
        jobsCompleted: 0,
        results,
      }, null, 2));
    } else {
      console.log("\nNo jobs eligible to finish (all have remaining failures).");
    }
    return;
  }

  if (!jsonOutput) {
    console.log(
      `\n${finishableJobs.length} job(s) ready to mark as FINISHED.`
    );
    console.log("WARNING: Finishing jobs may trigger downstream webhooks/scripts.\n");

    for (const r of finishableJobs) {
      console.log(`  "${truncate(r.jobTitle, 40)}" (${r.assetsProcessed} assets fixed)`);
    }
  }

  let doFinish = false;
  if (autoYes) {
    doFinish = true;
  } else {
    const confirmFinish = await prompt(
      `\nMark these ${finishableJobs.length} job(s) as FINISHED? (y/N): `
    );
    doFinish =
      confirmFinish.toLowerCase() === "y" ||
      confirmFinish.toLowerCase() === "yes";
  }

  if (doFinish) {
    if (!jsonOutput) console.log("\n--- FINISHING JOBS ---\n");
    for (const r of finishableJobs) {
      const jobSummary = selectedJobs.find((j) => j.id === r.jobId)!;
      if (!jsonOutput) console.log(`Job: "${r.jobTitle}"`);
      try {
        await finishJob(jobSummary);
        r.jobUpdated = true;
      } catch (err) {
        if (!jsonOutput) {
          console.log(`  ERROR: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  } else {
    if (!jsonOutput) {
      console.log("\nJobs left as FAILED. Run again with --finish when ready.");
    }
  }

  const jobsCompleted = results.filter((r) => r.jobUpdated).length;

  if (jsonOutput) {
    console.log(JSON.stringify({
      status: totalFailed === 0 ? "ok" : "partial",
      action: "archive",
      assetsProcessed: totalProcessed,
      assetsFailed: totalFailed,
      jobsCompleted,
      results,
    }, null, 2));
  } else {
    console.log(`\n${"=".repeat(60)}`);
    console.log("FINAL SUMMARY:");
    console.log(`  Assets archived: ${totalProcessed}`);
    console.log(`  Assets failed:   ${totalFailed}`);
    console.log(`  Jobs finished:   ${jobsCompleted}/${results.length}`);
    for (const r of results) {
      const status = r.jobUpdated
        ? "FINISHED"
        : r.assetsFailed > 0
          ? "STILL FAILED"
          : "ASSETS FIXED (job not finished)";
      console.log(
        `  - "${truncate(r.jobTitle, 40)}" — ${r.assetsProcessed} fixed, ${r.assetsFailed} failed — ${status}`
      );
    }
  }
}

main().catch(console.error);
