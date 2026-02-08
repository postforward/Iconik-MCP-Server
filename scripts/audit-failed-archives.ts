#!/usr/bin/env npx ts-node

import "dotenv/config";

const ICONIK_API_BASE = "https://app.iconik.io/API/";
const APP_ID = process.env.ICONIK_APP_ID;
const AUTH_TOKEN = process.env.ICONIK_AUTH_TOKEN;

if (!APP_ID || !AUTH_TOKEN) {
  console.error("Error: ICONIK_APP_ID and ICONIK_AUTH_TOKEN environment variables are required");
  process.exit(1);
}

interface PaginatedResponse<T> {
  objects: T[];
  page: number;
  pages: number;
  per_page: number;
  total: number;
}

interface Asset {
  id: string;
  title: string;
  archive_status: string;
  status: string;
  is_online: boolean;
  date_created: string;
  date_modified: string;
  in_collections?: string[];
}

interface Format {
  id: string;
  name: string;
  status: string;
  archive_status?: string;
  storage_id?: string;
}

interface FileSet {
  id: string;
  name: string;
  status: string;
  storage_id: string;
  format_id: string;
}

interface Job {
  id: string;
  type: string;
  status: string;
  title?: string;
  error_message?: string;
  date_created: string;
}

interface Storage {
  id: string;
  name: string;
  status: string;
  method: string;
  purpose: string;
}

async function iconikRequest<T = unknown>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${ICONIK_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "App-ID": APP_ID!,
      "Auth-Token": AUTH_TOKEN!,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Iconik API error (${response.status}): ${errorText}`);
  }

  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

interface DiagnosticResult {
  asset: Asset;
  issues: string[];
  suggestions: string[];
  formats: Format[];
  fileSets: FileSet[];
  recentJobs: Job[];
}

async function diagnoseAsset(asset: Asset): Promise<DiagnosticResult> {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let formats: Format[] = [];
  let fileSets: FileSet[] = [];
  let recentJobs: Job[] = [];

  try {
    // Get formats
    const formatsResponse = await iconikRequest<PaginatedResponse<Format>>(
      `files/v1/assets/${asset.id}/formats/`
    );
    formats = formatsResponse.objects || [];

    // Get file sets
    const fileSetsResponse = await iconikRequest<PaginatedResponse<FileSet>>(
      `files/v1/assets/${asset.id}/file_sets/`
    );
    fileSets = fileSetsResponse.objects || [];

    // Check for format issues
    const failedFormats = formats.filter(f => f.archive_status === "FAILED_TO_ARCHIVE");
    if (failedFormats.length > 0) {
      issues.push(`${failedFormats.length} format(s) failed to archive: ${failedFormats.map(f => f.name).join(", ")}`);
    }

    const deletedFormats = formats.filter(f => f.status === "DELETED");
    if (deletedFormats.length > 0) {
      issues.push(`${deletedFormats.length} format(s) are deleted`);
      suggestions.push("Restore deleted formats before archiving, or purge them if not needed");
    }

    // Check for missing file sets
    if (fileSets.length === 0) {
      issues.push("No file sets found - asset may have no files to archive");
      suggestions.push("Check if original files were ever uploaded");
    }

    const failedFileSets = fileSets.filter(fs => fs.status === "FAILED");
    if (failedFileSets.length > 0) {
      issues.push(`${failedFileSets.length} file set(s) in FAILED status`);
      suggestions.push("Try re-uploading the source files or check storage connectivity");
    }

    // Check if asset is online
    if (!asset.is_online) {
      issues.push("Asset is marked as offline");
      suggestions.push("Asset files may not be accessible - check storage status");
    }

    // Look for archive-related jobs
    // Note: This searches recent jobs - the API may have limitations
    try {
      const historyResponse = await iconikRequest<PaginatedResponse<{
        operation_type: string;
        operation_description?: string;
        job_id?: string;
        date_created: string;
      }>>(`assets/v1/assets/${asset.id}/history/?per_page=20`);

      const archiveHistory = (historyResponse.objects || []).filter(h =>
        h.operation_type === "ARCHIVE" ||
        h.operation_type === "RESTORE_ARCHIVE" ||
        h.operation_type === "FAILED_TO_ARCHIVE"
      );

      if (archiveHistory.length > 0) {
        const lastArchiveOp = archiveHistory[0];
        issues.push(`Last archive operation: ${lastArchiveOp.operation_type} on ${lastArchiveOp.date_created}`);
        if (lastArchiveOp.operation_description) {
          issues.push(`Description: ${lastArchiveOp.operation_description}`);
        }
      }
    } catch (e) {
      // History might not be available
    }

    // Check storage configuration
    const storageIds = new Set(fileSets.map(fs => fs.storage_id).filter(Boolean));
    for (const storageId of storageIds) {
      try {
        const storage = await iconikRequest<Storage>(`files/v1/storages/${storageId}/`);
        if (storage.status !== "ACTIVE") {
          issues.push(`Storage "${storage.name}" is ${storage.status}`);
          suggestions.push(`Check storage "${storage.name}" configuration and connectivity`);
        }
      } catch (e) {
        issues.push(`Could not retrieve storage ${storageId}`);
      }
    }

    // If no specific issues found
    if (issues.length === 0) {
      issues.push("No obvious issues detected - may need manual investigation");
      suggestions.push("Check Iconik system logs or contact support");
    }

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    issues.push(`Error during diagnosis: ${msg}`);
  }

  return { asset, issues, suggestions, formats, fileSets, recentJobs };
}

async function findFailedArchives() {
  console.log(`\n${"=".repeat(70)}`);
  console.log("FAILED ARCHIVE AUDIT");
  console.log(`${"=".repeat(70)}\n`);

  // Search for assets with FAILED_TO_ARCHIVE status
  const searchBody = {
    query: "*",
    doc_types: ["assets"],
    filter: {
      operator: "AND",
      terms: [{ name: "archive_status", value: "FAILED_TO_ARCHIVE" }]
    },
    per_page: 100,
    page: 1
  };

  console.log("Searching for assets with FAILED_TO_ARCHIVE status...\n");

  let allFailedAssets: Asset[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    searchBody.page = page;
    const searchResponse = await iconikRequest<PaginatedResponse<Asset>>(
      "search/v1/search/",
      { method: "POST", body: JSON.stringify(searchBody) }
    );

    const assets = searchResponse.objects || [];
    allFailedAssets = allFailedAssets.concat(assets);

    console.log(`Page ${page}: Found ${assets.length} assets (total: ${allFailedAssets.length})`);

    hasMore = searchResponse.pages > page;
    page++;
  }

  if (allFailedAssets.length === 0) {
    console.log("\n✅ No assets with failed archive status found!\n");

    // Also check for assets stuck in ARCHIVING state
    console.log("Checking for assets stuck in ARCHIVING state...\n");

    const archivingSearch = {
      query: "*",
      doc_types: ["assets"],
      filter: {
        operator: "AND",
        terms: [{ name: "archive_status", value: "ARCHIVING" }]
      },
      per_page: 100,
      page: 1
    };

    const archivingResponse = await iconikRequest<PaginatedResponse<Asset>>(
      "search/v1/search/",
      { method: "POST", body: JSON.stringify(archivingSearch) }
    );

    const archivingAssets = archivingResponse.objects || [];
    if (archivingAssets.length > 0) {
      console.log(`⚠️  Found ${archivingAssets.length} assets stuck in ARCHIVING state:\n`);
      for (const asset of archivingAssets.slice(0, 10)) {
        console.log(`  - ${asset.title} (${asset.id})`);
        console.log(`    Modified: ${asset.date_modified}`);
      }
      if (archivingAssets.length > 10) {
        console.log(`  ... and ${archivingAssets.length - 10} more`);
      }
      console.log("\nThese assets may have stalled archive jobs.");
    } else {
      console.log("✅ No assets stuck in ARCHIVING state.\n");
    }

    return;
  }

  console.log(`\nFound ${allFailedAssets.length} assets with failed archive status.`);
  console.log("Running diagnostics...\n");

  const diagnostics: DiagnosticResult[] = [];

  for (let i = 0; i < allFailedAssets.length; i++) {
    const asset = allFailedAssets[i];
    console.log(`[${i + 1}/${allFailedAssets.length}] Diagnosing: ${asset.title}`);

    const result = await diagnoseAsset(asset);
    diagnostics.push(result);
  }

  // Print detailed report
  console.log(`\n${"=".repeat(70)}`);
  console.log("DIAGNOSTIC REPORT");
  console.log(`${"=".repeat(70)}\n`);

  for (const diag of diagnostics) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`ASSET: ${diag.asset.title}`);
    console.log(`ID: ${diag.asset.id}`);
    console.log(`Status: ${diag.asset.status} | Archive Status: ${diag.asset.archive_status} | Online: ${diag.asset.is_online}`);
    console.log(`Created: ${diag.asset.date_created} | Modified: ${diag.asset.date_modified}`);
    console.log(`${"─".repeat(70)}`);

    console.log("\nFORMATS:");
    if (diag.formats.length === 0) {
      console.log("  (none)");
    } else {
      for (const fmt of diag.formats) {
        console.log(`  - ${fmt.name}: status=${fmt.status}, archive_status=${fmt.archive_status || "N/A"}`);
      }
    }

    console.log("\nFILE SETS:");
    if (diag.fileSets.length === 0) {
      console.log("  (none)");
    } else {
      for (const fs of diag.fileSets) {
        console.log(`  - ${fs.name || fs.id}: status=${fs.status}, storage=${fs.storage_id}`);
      }
    }

    console.log("\n⚠️  ISSUES:");
    for (const issue of diag.issues) {
      console.log(`  • ${issue}`);
    }

    if (diag.suggestions.length > 0) {
      console.log("\n💡 SUGGESTIONS:");
      for (const sug of diag.suggestions) {
        console.log(`  → ${sug}`);
      }
    }
  }

  // Summary by issue type
  console.log(`\n${"=".repeat(70)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(70)}`);
  console.log(`Total failed assets: ${diagnostics.length}`);

  const issueCount: Record<string, number> = {};
  for (const diag of diagnostics) {
    for (const issue of diag.issues) {
      const key = issue.split(":")[0];
      issueCount[key] = (issueCount[key] || 0) + 1;
    }
  }

  console.log("\nIssue breakdown:");
  for (const [issue, count] of Object.entries(issueCount).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}x - ${issue}`);
  }

  // Export to JSON for further analysis
  const reportPath = `./failed-archive-report-${Date.now()}.json`;
  const report = {
    timestamp: new Date().toISOString(),
    totalFailed: diagnostics.length,
    assets: diagnostics.map(d => ({
      id: d.asset.id,
      title: d.asset.title,
      archive_status: d.asset.archive_status,
      is_online: d.asset.is_online,
      issues: d.issues,
      suggestions: d.suggestions,
      formatCount: d.formats.length,
      fileSetCount: d.fileSets.length,
    }))
  };

  await Bun?.write?.(reportPath, JSON.stringify(report, null, 2)).catch(() => {
    require("fs").writeFileSync(reportPath, JSON.stringify(report, null, 2));
  });

  console.log(`\n📄 Full report saved to: ${reportPath}`);
}

// Run
findFailedArchives().catch(console.error);
