import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { iconikRequest, buildQueryString } from "../client.js";

export function registerFileTools(server: McpServer) {
  // ============================================
  // STORAGE OPERATIONS
  // ============================================

  server.tool(
    "list_storages",
    "List all configured storage locations",
    {},
    async () => {
      const result = await iconikRequest("files/v1/storages/");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_storage",
    "Get details of a specific storage location",
    {
      storage_id: z.string().uuid().describe("The storage UUID"),
    },
    async ({ storage_id }) => {
      const result = await iconikRequest(`files/v1/storages/${storage_id}/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_storage_for_purpose",
    "Find the default storage for a specific purpose",
    {
      purpose: z
        .enum(["FILES", "PROXIES", "KEYFRAMES", "SUBTITLES"])
        .describe("Storage purpose"),
    },
    async ({ purpose }) => {
      const result = await iconikRequest(`files/v1/storages/matching/${purpose}/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_storage_files",
    "List files in a storage location",
    {
      storage_id: z.string().uuid().describe("The storage UUID"),
      page: z.number().optional().default(1),
      per_page: z.number().optional().default(20),
    },
    async ({ storage_id, page, per_page }) => {
      const query = buildQueryString({ page, per_page });
      const result = await iconikRequest(
        `files/v1/storages/${storage_id}/files/${query}`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "scan_storage",
    "Trigger a scan of a storage location to discover new files",
    {
      storage_id: z.string().uuid().describe("The storage UUID"),
    },
    async ({ storage_id }) => {
      const result = await iconikRequest(
        `files/v1/storages/${storage_id}/scan/`,
        { method: "POST" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ============================================
  // TRANSCODER OPERATIONS
  // ============================================

  server.tool(
    "list_transcoders",
    "List all configured transcoders",
    {},
    async () => {
      const result = await iconikRequest("files/v1/transcoders/");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_transcoder",
    "Get details of a specific transcoder",
    {
      transcoder_id: z.string().uuid().describe("The transcoder UUID"),
    },
    async ({ transcoder_id }) => {
      const result = await iconikRequest(`files/v1/transcoders/${transcoder_id}/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ============================================
  // FILE TRANSFER OPERATIONS
  // ============================================

  server.tool(
    "list_storage_transfers_from",
    "List pending transfers from a storage",
    {
      storage_id: z.string().uuid().describe("The source storage UUID"),
    },
    async ({ storage_id }) => {
      const result = await iconikRequest(
        `files/v1/storages/${storage_id}/transfers_from/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_storage_transfers_to",
    "List pending transfers to a storage",
    {
      storage_id: z.string().uuid().describe("The destination storage UUID"),
    },
    async ({ storage_id }) => {
      const result = await iconikRequest(
        `files/v1/storages/${storage_id}/transfers_to/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "transfer_file_set_to_storage",
    "Transfer a file set to another storage location",
    {
      file_set_id: z.string().uuid().describe("The file set UUID"),
      storage_id: z.string().uuid().describe("The destination storage UUID"),
    },
    async ({ file_set_id, storage_id }) => {
      const result = await iconikRequest(
        `files/v1/file_sets/${file_set_id}/transfers_to/${storage_id}/`,
        { method: "POST" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ============================================
  // EXPORT LOCATIONS
  // ============================================

  server.tool(
    "list_export_locations",
    "List all configured export locations",
    {},
    async () => {
      const result = await iconikRequest("files/v1/export_locations/");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_export_location",
    "Get details of a specific export location",
    {
      export_location_id: z.string().uuid().describe("The export location UUID"),
    },
    async ({ export_location_id }) => {
      const result = await iconikRequest(
        `files/v1/export_locations/${export_location_id}/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "export_asset_to_location",
    "Export an asset to an export location",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      export_location_id: z.string().uuid().describe("The export location UUID"),
    },
    async ({ asset_id, export_location_id }) => {
      const result = await iconikRequest(
        `files/v1/assets/${asset_id}/export_locations/${export_location_id}/`,
        { method: "POST" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "bulk_export_to_location",
    "Export multiple assets to an export location",
    {
      asset_ids: z.array(z.string().uuid()).describe("Array of asset UUIDs"),
      export_location_id: z.string().uuid().describe("The export location UUID"),
    },
    async ({ asset_ids, export_location_id }) => {
      const result = await iconikRequest(
        `files/v2/assets/export_locations/${export_location_id}/bulk/export/`,
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

  // ============================================
  // DELETE QUEUE (Files/Formats)
  // ============================================

  server.tool(
    "list_deleted_file_sets",
    "List file sets in the delete queue",
    {},
    async () => {
      const result = await iconikRequest("files/v1/delete_queue/file_sets/");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_deleted_formats",
    "List formats in the delete queue",
    {},
    async () => {
      const result = await iconikRequest("files/v1/delete_queue/formats/");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "purge_all_deleted_file_sets",
    "Permanently delete all file sets in the delete queue",
    {},
    async () => {
      const result = await iconikRequest(
        "files/v1/delete_queue/file_sets/purge/all/",
        { method: "DELETE" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "purge_all_deleted_formats",
    "Permanently delete all formats in the delete queue",
    {},
    async () => {
      const result = await iconikRequest(
        "files/v1/delete_queue/formats/purge/all/",
        { method: "DELETE" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ============================================
  // ANALYSIS PROFILES
  // ============================================

  server.tool(
    "list_analysis_profiles",
    "List all analysis profiles for media processing",
    {},
    async () => {
      const result = await iconikRequest("files/v1/analysis/profiles/");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_analysis_profile",
    "Get details of a specific analysis profile",
    {
      profile_id: z.string().uuid().describe("The analysis profile UUID"),
    },
    async ({ profile_id }) => {
      const result = await iconikRequest(`files/v1/analysis/profiles/${profile_id}/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
