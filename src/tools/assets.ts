import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { iconikRequest, buildQueryString } from "../client.js";
import type {
  Asset,
  AssetVersion,
  AssetHistory,
  Segment,
  Proxy,
  Keyframe,
  Format,
  FileSet,
  IconikFile,
  DownloadUrlResponse,
  RelationType,
  AssetRelation,
  TranscriptionProperties,
  PaginatedResponse,
} from "../types/iconik.js";

export function registerAssetTools(server: McpServer) {
  // ============================================
  // ASSET CRUD OPERATIONS
  // ============================================

  server.tool(
    "list_assets",
    "List all assets with pagination",
    {
      page: z.number().optional().default(1).describe("Page number"),
      per_page: z.number().optional().default(20).describe("Results per page (max 100)"),
      sort: z.string().optional().describe("Sort field (e.g., 'date_created', 'title')"),
      order: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort order"),
    },
    async ({ page, per_page, sort, order }) => {
      const query = buildQueryString({
        page,
        per_page: Math.min(per_page, 100),
        sort: sort ? `${sort}:${order}` : undefined,
      });
      const result = await iconikRequest<PaginatedResponse<Asset>>(
        `assets/v1/assets/${query}`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_asset",
    "Get detailed information about a specific asset by ID",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      include_collections: z.boolean().optional().describe("Include collections the asset belongs to"),
      include_users: z.boolean().optional().describe("Include user information"),
    },
    async ({ asset_id, include_collections, include_users }) => {
      const query = buildQueryString({
        include_collections,
        include_users,
      });
      const result = await iconikRequest<Asset>(
        `assets/v1/assets/${asset_id}/${query}`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_asset",
    "Create a new asset in Iconik",
    {
      title: z.string().describe("Asset title (required)"),
      type: z
        .enum(["ASSET", "SEQUENCE", "NLE_PROJECT", "PLACEHOLDER", "CUSTOM", "LINK", "SUBCLIP"])
        .optional()
        .default("ASSET")
        .describe("Asset type"),
      collection_id: z.string().uuid().optional().describe("Add to this collection"),
      external_id: z.string().optional().describe("External system reference ID"),
      external_link: z.string().url().optional().describe("External URL link"),
      category: z.string().optional().describe("Asset category"),
    },
    async ({ title, type, collection_id, external_id, external_link, category }) => {
      const result = await iconikRequest<Asset>("assets/v1/assets/", {
        method: "POST",
        body: JSON.stringify({
          title,
          type,
          collection_id,
          external_id,
          external_link,
          category,
        }),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "update_asset",
    "Update an existing asset's properties",
    {
      asset_id: z.string().uuid().describe("The asset UUID to update"),
      title: z.string().optional().describe("New title"),
      category: z.string().optional().describe("New category"),
      external_id: z.string().optional().describe("External ID"),
      external_link: z.string().url().optional().describe("External URL"),
      is_blocked: z.boolean().optional().describe("Block/unblock asset"),
      warning: z.string().optional().describe("Warning message to display"),
    },
    async ({ asset_id, ...updates }) => {
      const filteredUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, v]) => v !== undefined)
      );
      const result = await iconikRequest<Asset>(`assets/v1/assets/${asset_id}/`, {
        method: "PATCH",
        body: JSON.stringify(filteredUpdates),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_asset",
    "Delete an asset (moves to delete queue)",
    {
      asset_id: z.string().uuid().describe("The asset UUID to delete"),
    },
    async ({ asset_id }) => {
      await iconikRequest(`assets/v1/assets/${asset_id}/`, {
        method: "DELETE",
      });
      return {
        content: [{ type: "text" as const, text: `Asset ${asset_id} deleted successfully` }],
      };
    }
  );

  server.tool(
    "restore_asset",
    "Restore a deleted asset from the delete queue",
    {
      asset_id: z.string().uuid().describe("The asset UUID to restore"),
    },
    async ({ asset_id }) => {
      const result = await iconikRequest<Asset>(
        `assets/v1/assets/${asset_id}/restore/`,
        { method: "POST" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "purge_asset",
    "Permanently delete an asset (cannot be undone)",
    {
      asset_id: z.string().uuid().describe("The asset UUID to permanently delete"),
    },
    async ({ asset_id }) => {
      await iconikRequest(`assets/v1/assets/${asset_id}/purge/`, {
        method: "DELETE",
      });
      return {
        content: [{ type: "text" as const, text: `Asset ${asset_id} permanently purged` }],
      };
    }
  );

  // ============================================
  // ASSET VERSIONS
  // ============================================

  server.tool(
    "list_asset_versions",
    "List all versions of an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
    },
    async ({ asset_id }) => {
      const result = await iconikRequest<{ versions: AssetVersion[] }>(
        `assets/v1/assets/${asset_id}/versions/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_asset_version",
    "Get details of a specific asset version",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      version_id: z.string().uuid().describe("The version UUID"),
    },
    async ({ asset_id, version_id }) => {
      const result = await iconikRequest<AssetVersion>(
        `assets/v1/assets/${asset_id}/versions/${version_id}/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_asset_version",
    "Create a new version for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
    },
    async ({ asset_id }) => {
      const result = await iconikRequest<AssetVersion>(
        `assets/v1/assets/${asset_id}/versions/`,
        { method: "POST", body: JSON.stringify({}) }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "promote_asset_version",
    "Promote a version to be the current/active version",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      version_id: z.string().uuid().describe("The version UUID to promote"),
    },
    async ({ asset_id, version_id }) => {
      const result = await iconikRequest<AssetVersion>(
        `assets/v1/assets/${asset_id}/versions/${version_id}/promote/`,
        { method: "POST" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_asset_version",
    "Delete a specific version of an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      version_id: z.string().uuid().describe("The version UUID to delete"),
    },
    async ({ asset_id, version_id }) => {
      await iconikRequest(
        `assets/v1/assets/${asset_id}/versions/${version_id}/`,
        { method: "DELETE" }
      );
      return {
        content: [{ type: "text" as const, text: `Version ${version_id} deleted` }],
      };
    }
  );

  // ============================================
  // ASSET HISTORY
  // ============================================

  server.tool(
    "get_asset_history",
    "Get the history/audit log for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      page: z.number().optional().default(1).describe("Page number"),
      per_page: z.number().optional().default(20).describe("Results per page"),
    },
    async ({ asset_id, page, per_page }) => {
      const query = buildQueryString({ page, per_page });
      const result = await iconikRequest<PaginatedResponse<AssetHistory>>(
        `assets/v1/assets/${asset_id}/history/${query}`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ============================================
  // SEGMENTS (Markers, Chapters, Transcriptions, etc.)
  // ============================================

  server.tool(
    "list_asset_segments",
    "List all segments (markers, chapters, transcriptions, etc.) for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      segment_type: z
        .enum([
          "MARKER", "CHAPTER", "FACE", "LABEL", "COMMENT", "SHOT_CHANGE",
          "TRANSCRIPTION", "SPEECH", "SPEECH_SEGMENT", "OBJECT", "CUSTOM",
          "LOGO", "SENSITIVE_CONTENT", "TEXT", "CELEBRITY", "MODERATION",
          "MANUAL_TRANSCRIPTION", "SMPTE_TIMECODE"
        ])
        .optional()
        .describe("Filter by segment type"),
      page: z.number().optional().default(1),
      per_page: z.number().optional().default(100),
    },
    async ({ asset_id, segment_type, page, per_page }) => {
      let endpoint = `assets/v1/assets/${asset_id}/segments/`;
      if (segment_type) {
        endpoint = `assets/v1/assets/${asset_id}/segments/${segment_type}/`;
      }
      const query = buildQueryString({ page, per_page });
      const result = await iconikRequest<PaginatedResponse<Segment>>(
        `${endpoint}${query}`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_asset_segment",
    "Create a new segment (marker, chapter, etc.) on an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      segment_type: z
        .enum(["MARKER", "CHAPTER", "COMMENT", "CUSTOM", "MANUAL_TRANSCRIPTION"])
        .describe("Type of segment to create"),
      title: z.string().optional().describe("Segment title"),
      text: z.string().optional().describe("Segment text/content"),
      time_start_milliseconds: z.number().describe("Start time in milliseconds"),
      time_end_milliseconds: z.number().describe("End time in milliseconds"),
    },
    async ({ asset_id, segment_type, title, text, time_start_milliseconds, time_end_milliseconds }) => {
      const result = await iconikRequest<Segment>(
        `assets/v1/assets/${asset_id}/segments/`,
        {
          method: "POST",
          body: JSON.stringify({
            segment_type,
            title,
            text,
            time_start_milliseconds,
            time_end_milliseconds,
          }),
        }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_asset_segment",
    "Get a specific segment by ID",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      segment_id: z.string().uuid().describe("The segment UUID"),
    },
    async ({ asset_id, segment_id }) => {
      const result = await iconikRequest<Segment>(
        `assets/v1/assets/${asset_id}/segments/${segment_id}/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_asset_segment",
    "Delete a segment from an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      segment_id: z.string().uuid().describe("The segment UUID to delete"),
    },
    async ({ asset_id, segment_id }) => {
      await iconikRequest(
        `assets/v1/assets/${asset_id}/segments/${segment_id}/`,
        { method: "DELETE" }
      );
      return {
        content: [{ type: "text" as const, text: `Segment ${segment_id} deleted` }],
      };
    }
  );

  server.tool(
    "export_segments_srt",
    "Export asset segments as SRT subtitle format",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
    },
    async ({ asset_id }) => {
      const result = await iconikRequest<string>(
        `assets/v1/assets/${asset_id}/segments/srt/`
      );
      return {
        content: [{ type: "text" as const, text: typeof result === 'string' ? result : JSON.stringify(result) }],
      };
    }
  );

  server.tool(
    "export_segments_vtt",
    "Export asset segments as WebVTT subtitle format",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
    },
    async ({ asset_id }) => {
      const result = await iconikRequest<string>(
        `assets/v1/assets/${asset_id}/segments/vtt/`
      );
      return {
        content: [{ type: "text" as const, text: typeof result === 'string' ? result : JSON.stringify(result) }],
      };
    }
  );

  // ============================================
  // PROXIES
  // ============================================

  server.tool(
    "list_asset_proxies",
    "List all proxy files for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      version_id: z.string().uuid().optional().describe("Filter by version (optional)"),
    },
    async ({ asset_id, version_id }) => {
      const endpoint = version_id
        ? `files/v1/assets/${asset_id}/versions/${version_id}/proxies/`
        : `files/v1/assets/${asset_id}/proxies/`;
      const result = await iconikRequest<PaginatedResponse<Proxy>>(endpoint);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_asset_proxy",
    "Get details of a specific proxy",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      proxy_id: z.string().uuid().describe("The proxy UUID"),
    },
    async ({ asset_id, proxy_id }) => {
      const result = await iconikRequest<Proxy>(
        `files/v1/assets/${asset_id}/proxies/${proxy_id}/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_proxy_download_url",
    "Get a temporary download URL for a proxy file",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      proxy_id: z.string().uuid().describe("The proxy UUID"),
    },
    async ({ asset_id, proxy_id }) => {
      const result = await iconikRequest<DownloadUrlResponse>(
        `files/v1/assets/${asset_id}/proxies/${proxy_id}/download_url/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_proxy_public_url",
    "Get a public streaming URL for a proxy (if available)",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      proxy_id: z.string().uuid().describe("The proxy UUID"),
    },
    async ({ asset_id, proxy_id }) => {
      const result = await iconikRequest<{ url: string }>(
        `files/v1/assets/${asset_id}/proxies/${proxy_id}/public/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_asset_proxy",
    "Delete a proxy file",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      proxy_id: z.string().uuid().describe("The proxy UUID to delete"),
    },
    async ({ asset_id, proxy_id }) => {
      await iconikRequest(
        `files/v1/assets/${asset_id}/proxies/${proxy_id}/`,
        { method: "DELETE" }
      );
      return {
        content: [{ type: "text" as const, text: `Proxy ${proxy_id} deleted` }],
      };
    }
  );

  // ============================================
  // KEYFRAMES
  // ============================================

  server.tool(
    "list_asset_keyframes",
    "List all keyframes/thumbnails for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      version_id: z.string().uuid().optional().describe("Filter by version (optional)"),
    },
    async ({ asset_id, version_id }) => {
      const endpoint = version_id
        ? `files/v1/assets/${asset_id}/versions/${version_id}/keyframes/`
        : `files/v1/assets/${asset_id}/keyframes/`;
      const result = await iconikRequest<PaginatedResponse<Keyframe>>(endpoint);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_asset_keyframe",
    "Get details of a specific keyframe",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      keyframe_id: z.string().uuid().describe("The keyframe UUID"),
    },
    async ({ asset_id, keyframe_id }) => {
      const result = await iconikRequest<Keyframe>(
        `files/v1/assets/${asset_id}/keyframes/${keyframe_id}/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_keyframe_public_url",
    "Get a public URL for a keyframe image",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      keyframe_id: z.string().uuid().describe("The keyframe UUID"),
    },
    async ({ asset_id, keyframe_id }) => {
      const result = await iconikRequest<{ url: string }>(
        `files/v1/assets/${asset_id}/keyframes/${keyframe_id}/public/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "set_custom_keyframe",
    "Set a custom poster/keyframe for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      keyframe_id: z.string().uuid().describe("The keyframe UUID to use as poster"),
    },
    async ({ asset_id, keyframe_id }) => {
      const result = await iconikRequest(
        `files/v1/assets/${asset_id}/custom_keyframe/${keyframe_id}/`,
        { method: "PUT" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_asset_keyframe",
    "Delete a keyframe",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      keyframe_id: z.string().uuid().describe("The keyframe UUID to delete"),
    },
    async ({ asset_id, keyframe_id }) => {
      await iconikRequest(
        `files/v1/assets/${asset_id}/keyframes/${keyframe_id}/`,
        { method: "DELETE" }
      );
      return {
        content: [{ type: "text" as const, text: `Keyframe ${keyframe_id} deleted` }],
      };
    }
  );

  // ============================================
  // FORMATS & FILE SETS
  // ============================================

  server.tool(
    "list_asset_formats",
    "List all formats (ORIGINAL, PROXY, etc.) for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      version_id: z.string().uuid().optional().describe("Filter by version (optional)"),
    },
    async ({ asset_id, version_id }) => {
      const endpoint = version_id
        ? `files/v1/assets/${asset_id}/versions/${version_id}/formats/`
        : `files/v1/assets/${asset_id}/formats/`;
      const result = await iconikRequest<PaginatedResponse<Format>>(endpoint);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_asset_format",
    "Get details of a specific format",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      format_id: z.string().uuid().describe("The format UUID"),
    },
    async ({ asset_id, format_id }) => {
      const result = await iconikRequest<Format>(
        `files/v1/assets/${asset_id}/formats/${format_id}/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_asset_format",
    "Delete a format and its associated files",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      format_id: z.string().uuid().describe("The format UUID to delete"),
    },
    async ({ asset_id, format_id }) => {
      await iconikRequest(
        `files/v1/assets/${asset_id}/formats/${format_id}/`,
        { method: "DELETE" }
      );
      return {
        content: [{ type: "text" as const, text: `Format ${format_id} deleted` }],
      };
    }
  );

  server.tool(
    "list_asset_file_sets",
    "List all file sets for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      version_id: z.string().uuid().optional().describe("Filter by version (optional)"),
    },
    async ({ asset_id, version_id }) => {
      const endpoint = version_id
        ? `files/v1/assets/${asset_id}/versions/${version_id}/file_sets/`
        : `files/v1/assets/${asset_id}/file_sets/`;
      const result = await iconikRequest<PaginatedResponse<FileSet>>(endpoint);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_asset_file_set",
    "Get details of a specific file set",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      file_set_id: z.string().uuid().describe("The file set UUID"),
    },
    async ({ asset_id, file_set_id }) => {
      const result = await iconikRequest<FileSet>(
        `files/v1/assets/${asset_id}/file_sets/${file_set_id}/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_asset_file_set",
    "Delete a file set",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      file_set_id: z.string().uuid().describe("The file set UUID to delete"),
    },
    async ({ asset_id, file_set_id }) => {
      await iconikRequest(
        `files/v1/assets/${asset_id}/file_sets/${file_set_id}/`,
        { method: "DELETE" }
      );
      return {
        content: [{ type: "text" as const, text: `File set ${file_set_id} deleted` }],
      };
    }
  );

  server.tool(
    "restore_asset_file_set",
    "Restore a deleted file set",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      file_set_id: z.string().uuid().describe("The file set UUID to restore"),
    },
    async ({ asset_id, file_set_id }) => {
      const result = await iconikRequest<FileSet>(
        `files/v1/assets/${asset_id}/file_sets/${file_set_id}/restore/`,
        { method: "POST" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_file_set_files",
    "List all file records in a specific file set",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      file_set_id: z.string().uuid().describe("The file set UUID"),
    },
    async ({ asset_id, file_set_id }) => {
      const result = await iconikRequest<PaginatedResponse<IconikFile>>(
        `files/v1/assets/${asset_id}/file_sets/${file_set_id}/files/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_asset_file_set_details",
    "Get a combined view of all file sets for an asset with storage names and file records",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
    },
    async ({ asset_id }) => {
      const storageCache = new Map<string, string>();

      const fileSetsResponse = await iconikRequest<PaginatedResponse<FileSet>>(
        `files/v1/assets/${asset_id}/file_sets/`
      );
      const fileSets = fileSetsResponse.objects || [];

      const details = [];
      for (const fs of fileSets) {
        // Resolve storage name
        let storageName = storageCache.get(fs.storage_id);
        if (!storageName) {
          try {
            const storage = await iconikRequest<{ id: string; name: string }>(
              `files/v1/storages/${fs.storage_id}/`
            );
            storageName = storage.name;
          } catch {
            storageName = "(unknown)";
          }
          storageCache.set(fs.storage_id, storageName);
        }

        // Get file records for this file set
        let files: IconikFile[] = [];
        try {
          const filesResponse = await iconikRequest<PaginatedResponse<IconikFile>>(
            `files/v1/assets/${asset_id}/file_sets/${fs.id}/files/`
          );
          files = filesResponse.objects || [];
        } catch {
          // file set may have no files endpoint; continue
        }

        details.push({
          file_set_id: fs.id,
          format_id: fs.format_id,
          storage_id: fs.storage_id,
          storage_name: storageName,
          name: fs.name,
          status: fs.status,
          base_dir: fs.base_dir,
          date_created: fs.date_created,
          files: files.map((f) => ({
            id: f.id,
            name: f.name,
            original_name: f.original_name,
            size: f.size,
            status: f.status,
            directory_path: f.directory_path,
          })),
        });
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
      };
    }
  );

  // ============================================
  // FILES & DOWNLOADS
  // ============================================

  server.tool(
    "list_asset_files",
    "List all files associated with an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      version_id: z.string().uuid().optional().describe("Filter by version (optional)"),
    },
    async ({ asset_id, version_id }) => {
      const endpoint = version_id
        ? `files/v1/assets/${asset_id}/versions/${version_id}/files/`
        : `files/v1/assets/${asset_id}/files/`;
      const result = await iconikRequest<PaginatedResponse<IconikFile>>(endpoint);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_asset_file",
    "Get details of a specific file",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      file_id: z.string().uuid().describe("The file UUID"),
    },
    async ({ asset_id, file_id }) => {
      const result = await iconikRequest<IconikFile>(
        `files/v1/assets/${asset_id}/files/${file_id}/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_file_download_url",
    "Get a temporary download URL for an original file",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      file_id: z.string().uuid().describe("The file UUID"),
    },
    async ({ asset_id, file_id }) => {
      const result = await iconikRequest<DownloadUrlResponse>(
        `files/v1/assets/${asset_id}/files/${file_id}/download_url/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_file_mediainfo",
    "Get mediainfo/technical metadata for a file",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      file_id: z.string().uuid().describe("The file UUID"),
    },
    async ({ asset_id, file_id }) => {
      const result = await iconikRequest(
        `files/v1/assets/${asset_id}/files/${file_id}/mediainfo/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_file_record",
    "Create a file record in an asset's file set. Looks up the file set to resolve format_id and storage_id automatically.",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      file_set_id: z.string().uuid().describe("The file set UUID to add the file to"),
      name: z.string().describe("File name (e.g., 'video.mxf')"),
      original_name: z.string().optional().describe("Original file name"),
      size: z.number().optional().describe("File size in bytes"),
      directory_path: z.string().optional().describe("Directory path within the storage"),
      status: z
        .enum(["ACTIVE", "CLOSED", "DELETED"])
        .optional()
        .default("CLOSED")
        .describe("File status"),
    },
    async ({ asset_id, file_set_id, name, original_name, size, directory_path, status }) => {
      // Look up file set to resolve format_id and storage_id
      const fileSet = await iconikRequest<FileSet>(
        `files/v1/assets/${asset_id}/file_sets/${file_set_id}/`
      );

      const body: Record<string, unknown> = {
        file_set_id,
        format_id: fileSet.format_id,
        storage_id: fileSet.storage_id,
        name,
        original_name: original_name || name,
        size,
        directory_path,
        status,
      };

      const result = await iconikRequest<IconikFile>(
        `files/v1/assets/${asset_id}/files/`,
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "capture_keyframe_from_file",
    "Capture a keyframe from a video file at a specific time",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      file_id: z.string().uuid().describe("The file UUID"),
      milliseconds: z.number().describe("Time position in milliseconds to capture"),
    },
    async ({ asset_id, file_id, milliseconds }) => {
      const result = await iconikRequest<Keyframe>(
        `files/v1/assets/${asset_id}/files/${file_id}/capture/${milliseconds}/`,
        { method: "POST" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ============================================
  // SUBTITLES
  // ============================================

  server.tool(
    "list_asset_subtitles",
    "List all subtitle tracks for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      version_id: z.string().uuid().optional().describe("Filter by version (optional)"),
    },
    async ({ asset_id, version_id }) => {
      const endpoint = version_id
        ? `files/v1/assets/${asset_id}/versions/${version_id}/subtitles/`
        : `files/v1/assets/${asset_id}/subtitles/`;
      const result = await iconikRequest(endpoint);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_subtitle_webvtt",
    "Get subtitle content in WebVTT format",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      language: z.string().describe("Language code (e.g., 'en', 'es')"),
      version_id: z.string().uuid().optional().describe("Version ID (optional)"),
    },
    async ({ asset_id, language, version_id }) => {
      const endpoint = version_id
        ? `files/v1/assets/${asset_id}/versions/${version_id}/subtitles/${language}/webvtt/`
        : `files/v1/assets/${asset_id}/subtitles/${language}/webvtt/`;
      const result = await iconikRequest<string>(endpoint);
      return {
        content: [{ type: "text" as const, text: typeof result === 'string' ? result : JSON.stringify(result) }],
      };
    }
  );

  // ============================================
  // ASSET RELATIONS
  // ============================================

  server.tool(
    "list_relation_types",
    "List all available asset relation types",
    {},
    async () => {
      const result = await iconikRequest<PaginatedResponse<RelationType>>(
        "assets/v1/assets/relation_types/"
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_asset_relations",
    "List all relations for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      relation_type: z.string().optional().describe("Filter by relation type"),
    },
    async ({ asset_id, relation_type }) => {
      const endpoint = relation_type
        ? `assets/v1/assets/${asset_id}/relations/${relation_type}/`
        : `assets/v1/assets/${asset_id}/relations/`;
      const result = await iconikRequest<PaginatedResponse<AssetRelation>>(endpoint);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_asset_relation",
    "Create a relation between two assets",
    {
      asset_id: z.string().uuid().describe("The source asset UUID"),
      related_to_asset_id: z.string().uuid().describe("The target asset UUID"),
      relation_type: z.string().describe("The relation type (e.g., 'RELATES_TO')"),
    },
    async ({ asset_id, related_to_asset_id, relation_type }) => {
      const result = await iconikRequest<AssetRelation>(
        `assets/v1/assets/${asset_id}/relations/${relation_type}/${related_to_asset_id}/`,
        { method: "PUT" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_asset_relation",
    "Remove a relation between two assets",
    {
      asset_id: z.string().uuid().describe("The source asset UUID"),
      related_to_asset_id: z.string().uuid().describe("The target asset UUID"),
      relation_type: z.string().describe("The relation type"),
    },
    async ({ asset_id, related_to_asset_id, relation_type }) => {
      await iconikRequest(
        `assets/v1/assets/${asset_id}/relations/${relation_type}/${related_to_asset_id}/`,
        { method: "DELETE" }
      );
      return {
        content: [{ type: "text" as const, text: `Relation deleted` }],
      };
    }
  );

  // ============================================
  // TRANSCRIPTIONS
  // ============================================

  server.tool(
    "get_transcription_properties",
    "Get transcription properties for an asset version",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      version_id: z.string().uuid().describe("The version UUID"),
    },
    async ({ asset_id, version_id }) => {
      const result = await iconikRequest<{ objects: TranscriptionProperties[] }>(
        `assets/v1/assets/${asset_id}/versions/${version_id}/transcriptions/properties/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_transcription_subtitles",
    "Get transcription as subtitles",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      version_id: z.string().uuid().describe("The version UUID"),
    },
    async ({ asset_id, version_id }) => {
      const result = await iconikRequest(
        `assets/v1/assets/${asset_id}/versions/${version_id}/transcriptions/subtitles/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ============================================
  // ARCHIVE OPERATIONS
  // ============================================

  server.tool(
    "archive_asset_format",
    "Archive a format to cold storage",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      format_id: z.string().uuid().describe("The format UUID to archive"),
    },
    async ({ asset_id, format_id }) => {
      const result = await iconikRequest(
        `files/v2/assets/${asset_id}/formats/${format_id}/archive/`,
        { method: "POST" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "restore_asset_format",
    "Restore a format from archive/cold storage",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      format_id: z.string().uuid().describe("The format UUID to restore"),
    },
    async ({ asset_id, format_id }) => {
      const result = await iconikRequest(
        `files/v1/assets/${asset_id}/formats/${format_id}/restore/`,
        { method: "POST" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "bulk_archive_assets",
    "Archive multiple assets to cold storage",
    {
      asset_ids: z.array(z.string().uuid()).describe("Array of asset UUIDs to archive"),
    },
    async ({ asset_ids }) => {
      const result = await iconikRequest(
        "files/v2/assets/bulk/archive/",
        {
          method: "POST",
          body: JSON.stringify({ object_ids: asset_ids }),
        }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "bulk_restore_assets",
    "Restore multiple assets from cold storage",
    {
      asset_ids: z.array(z.string().uuid()).describe("Array of asset UUIDs to restore"),
    },
    async ({ asset_ids }) => {
      const result = await iconikRequest(
        "files/v2/assets/bulk/restore/",
        {
          method: "POST",
          body: JSON.stringify({ object_ids: asset_ids }),
        }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "update_archive_status",
    "Bulk update archive_status on assets and all their formats. Useful for resetting stuck ARCHIVING states.",
    {
      asset_ids: z.array(z.string().uuid()).describe("Array of asset UUIDs to update"),
      archive_status: z
        .enum(["NOT_ARCHIVED", "ARCHIVING", "FAILED_TO_ARCHIVE", "ARCHIVED"])
        .describe("The new archive_status to set"),
    },
    async ({ asset_ids, archive_status }) => {
      const logs: string[] = [];
      logs.push(`Updating archive_status to "${archive_status}" for ${asset_ids.length} asset(s)`);
      logs.push("");

      for (const assetId of asset_ids) {
        try {
          // Update the asset itself
          await iconikRequest<Asset>(`assets/v1/assets/${assetId}/`, {
            method: "PATCH",
            body: JSON.stringify({ archive_status }),
          });
          logs.push(`Asset ${assetId}: updated`);

          // Get all formats and update each
          const formatsResponse = await iconikRequest<PaginatedResponse<Format>>(
            `files/v1/assets/${assetId}/formats/`
          );
          const formats = formatsResponse.objects || [];

          for (const fmt of formats) {
            try {
              await iconikRequest(
                `files/v1/assets/${assetId}/formats/${fmt.id}/`,
                {
                  method: "PATCH",
                  body: JSON.stringify({ archive_status }),
                }
              );
              logs.push(`  Format ${fmt.id} (${fmt.name}): updated`);
            } catch (fmtErr) {
              const msg = fmtErr instanceof Error ? fmtErr.message : String(fmtErr);
              logs.push(`  Format ${fmt.id} (${fmt.name}): ERROR - ${msg}`);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logs.push(`Asset ${assetId}: ERROR - ${msg}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: logs.join("\n") }],
      };
    }
  );

  // ============================================
  // BULK PROXY DELETION OPERATIONS
  // ============================================

  server.tool(
    "delete_proxies_by_collection",
    "Delete all proxies for assets in a collection. Use dry_run=true (default) to preview without deleting.",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
      dry_run: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true (default), only report what would be deleted without actually deleting"),
    },
    async ({ collection_id, dry_run }) => {
      const logs: string[] = [];
      const errors: string[] = [];
      let totalAssetsProcessed = 0;
      let totalAssetsWithProxies = 0;
      let totalProxiesFound = 0;
      let totalProxiesDeleted = 0;

      logs.push(`Starting proxy deletion for collection: ${collection_id}`);
      logs.push(`Mode: ${dry_run ? "DRY RUN (no actual deletions)" : "LIVE (will delete proxies)"}`);
      logs.push("");

      // Paginate through collection contents
      let page = 1;
      const perPage = 100;
      let hasMore = true;

      while (hasMore) {
        logs.push(`Fetching collection contents page ${page}...`);

        interface CollectionContent {
          id: string;
          object_type: string;
          title?: string;
        }

        const contentsResponse = await iconikRequest<PaginatedResponse<CollectionContent>>(
          `assets/v1/collections/${collection_id}/contents/?page=${page}&per_page=${perPage}&content_types=assets`
        );

        const assets = contentsResponse.objects || [];
        logs.push(`Found ${assets.length} assets on page ${page}`);

        for (const item of assets) {
          if (item.object_type !== "assets") continue;

          const assetId = item.id;
          totalAssetsProcessed++;

          try {
            // Get proxies for this asset
            const proxiesResponse = await iconikRequest<PaginatedResponse<Proxy>>(
              `files/v1/assets/${assetId}/proxies/`
            );

            const proxies = proxiesResponse.objects || [];

            if (proxies.length === 0) {
              logs.push(`  Asset ${assetId}: No proxies, skipping`);
              continue;
            }

            totalAssetsWithProxies++;
            totalProxiesFound += proxies.length;
            logs.push(`  Asset ${assetId}: Found ${proxies.length} proxies`);

            for (const proxy of proxies) {
              if (dry_run) {
                logs.push(`    [DRY RUN] Would delete proxy: ${proxy.id} (${proxy.name || "unnamed"})`);
                totalProxiesDeleted++;
              } else {
                try {
                  await iconikRequest(
                    `files/v1/assets/${assetId}/proxies/${proxy.id}/`,
                    { method: "DELETE" }
                  );
                  logs.push(`    Deleted proxy: ${proxy.id} (${proxy.name || "unnamed"})`);
                  totalProxiesDeleted++;
                } catch (deleteError) {
                  const errMsg = deleteError instanceof Error ? deleteError.message : String(deleteError);
                  errors.push(`Failed to delete proxy ${proxy.id} on asset ${assetId}: ${errMsg}`);
                  logs.push(`    ERROR deleting proxy ${proxy.id}: ${errMsg}`);
                }
              }
            }
          } catch (assetError) {
            const errMsg = assetError instanceof Error ? assetError.message : String(assetError);
            errors.push(`Failed to process asset ${assetId}: ${errMsg}`);
            logs.push(`  ERROR processing asset ${assetId}: ${errMsg}`);
          }
        }

        // Check if there are more pages
        hasMore = contentsResponse.pages > page;
        page++;
      }

      // Build summary
      logs.push("");
      logs.push("=".repeat(50));
      logs.push("SUMMARY");
      logs.push("=".repeat(50));
      logs.push(`Mode: ${dry_run ? "DRY RUN" : "LIVE"}`);
      logs.push(`Collection: ${collection_id}`);
      logs.push(`Total assets processed: ${totalAssetsProcessed}`);
      logs.push(`Assets with proxies: ${totalAssetsWithProxies}`);
      logs.push(`Total proxies found: ${totalProxiesFound}`);
      logs.push(`Proxies ${dry_run ? "that would be deleted" : "deleted"}: ${totalProxiesDeleted}`);
      if (errors.length > 0) {
        logs.push(`Errors: ${errors.length}`);
        logs.push("");
        logs.push("ERRORS:");
        errors.forEach((e) => logs.push(`  - ${e}`));
      }

      return {
        content: [{ type: "text" as const, text: logs.join("\n") }],
      };
    }
  );

  server.tool(
    "delete_proxies_by_storage",
    "Delete all proxies for assets on a specific storage. Use dry_run=true (default) to preview without deleting.",
    {
      storage_id: z.string().uuid().describe("The storage UUID"),
      dry_run: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true (default), only report what would be deleted without actually deleting"),
    },
    async ({ storage_id, dry_run }) => {
      const logs: string[] = [];
      const errors: string[] = [];
      let totalAssetsProcessed = 0;
      let totalAssetsWithProxies = 0;
      let totalProxiesFound = 0;
      let totalProxiesDeleted = 0;
      const processedAssetIds = new Set<string>();

      logs.push(`Starting proxy deletion for storage: ${storage_id}`);
      logs.push(`Mode: ${dry_run ? "DRY RUN (no actual deletions)" : "LIVE (will delete proxies)"}`);
      logs.push("");

      // Paginate through files on storage to find unique assets
      let page = 1;
      const perPage = 100;
      let hasMore = true;

      logs.push("Phase 1: Discovering assets on storage...");

      while (hasMore) {
        logs.push(`Fetching storage files page ${page}...`);

        interface StorageFile {
          id: string;
          asset_id?: string;
          name?: string;
        }

        const filesResponse = await iconikRequest<PaginatedResponse<StorageFile>>(
          `files/v1/storages/${storage_id}/files/?page=${page}&per_page=${perPage}`
        );

        const files = filesResponse.objects || [];
        logs.push(`Found ${files.length} files on page ${page}`);

        for (const file of files) {
          if (file.asset_id) {
            processedAssetIds.add(file.asset_id);
          }
        }

        hasMore = filesResponse.pages > page;
        page++;
      }

      logs.push(`Discovered ${processedAssetIds.size} unique assets on storage`);
      logs.push("");
      logs.push("Phase 2: Processing assets and deleting proxies...");

      // Now process each unique asset
      for (const assetId of processedAssetIds) {
        totalAssetsProcessed++;

        try {
          // Get proxies for this asset
          const proxiesResponse = await iconikRequest<PaginatedResponse<Proxy>>(
            `files/v1/assets/${assetId}/proxies/`
          );

          const proxies = proxiesResponse.objects || [];

          if (proxies.length === 0) {
            logs.push(`  Asset ${assetId}: No proxies, skipping`);
            continue;
          }

          totalAssetsWithProxies++;
          totalProxiesFound += proxies.length;
          logs.push(`  Asset ${assetId}: Found ${proxies.length} proxies`);

          for (const proxy of proxies) {
            if (dry_run) {
              logs.push(`    [DRY RUN] Would delete proxy: ${proxy.id} (${proxy.name || "unnamed"})`);
              totalProxiesDeleted++;
            } else {
              try {
                await iconikRequest(
                  `files/v1/assets/${assetId}/proxies/${proxy.id}/`,
                  { method: "DELETE" }
                );
                logs.push(`    Deleted proxy: ${proxy.id} (${proxy.name || "unnamed"})`);
                totalProxiesDeleted++;
              } catch (deleteError) {
                const errMsg = deleteError instanceof Error ? deleteError.message : String(deleteError);
                errors.push(`Failed to delete proxy ${proxy.id} on asset ${assetId}: ${errMsg}`);
                logs.push(`    ERROR deleting proxy ${proxy.id}: ${errMsg}`);
              }
            }
          }
        } catch (assetError) {
          const errMsg = assetError instanceof Error ? assetError.message : String(assetError);
          errors.push(`Failed to process asset ${assetId}: ${errMsg}`);
          logs.push(`  ERROR processing asset ${assetId}: ${errMsg}`);
        }

        // Log progress every 50 assets
        if (totalAssetsProcessed % 50 === 0) {
          logs.push(`  Progress: ${totalAssetsProcessed}/${processedAssetIds.size} assets processed`);
        }
      }

      // Build summary
      logs.push("");
      logs.push("=".repeat(50));
      logs.push("SUMMARY");
      logs.push("=".repeat(50));
      logs.push(`Mode: ${dry_run ? "DRY RUN" : "LIVE"}`);
      logs.push(`Storage: ${storage_id}`);
      logs.push(`Total assets processed: ${totalAssetsProcessed}`);
      logs.push(`Assets with proxies: ${totalAssetsWithProxies}`);
      logs.push(`Total proxies found: ${totalProxiesFound}`);
      logs.push(`Proxies ${dry_run ? "that would be deleted" : "deleted"}: ${totalProxiesDeleted}`);
      if (errors.length > 0) {
        logs.push(`Errors: ${errors.length}`);
        logs.push("");
        logs.push("ERRORS:");
        errors.forEach((e) => logs.push(`  - ${e}`));
      }

      return {
        content: [{ type: "text" as const, text: logs.join("\n") }],
      };
    }
  );
}
