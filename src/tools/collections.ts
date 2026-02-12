import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { iconikRequest, buildQueryString } from "../client.js";
import type { PaginatedResponse, Asset } from "../types/iconik.js";

export function registerCollectionTools(server: McpServer) {
  server.tool(
    "list_collections",
    "List all collections with pagination",
    {
      page: z.number().optional().default(1).describe("Page number"),
      per_page: z.number().optional().default(20).describe("Results per page (max 100)"),
      sort: z.string().optional().default("date_created").describe("Sort field"),
      order: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort order"),
    },
    async ({ page, per_page, sort, order }) => {
      const query = buildQueryString({
        page,
        per_page: Math.min(per_page, 100),
        sort: `${sort}:${order}`,
      });
      const result = await iconikRequest(`assets/v1/collections/${query}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_collection",
    "Get detailed information about a specific collection",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
    },
    async ({ collection_id }) => {
      const result = await iconikRequest(`assets/v1/collections/${collection_id}/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_collection",
    "Create a new collection",
    {
      title: z.string().describe("Collection title"),
      parent_id: z.string().uuid().optional().describe("Parent collection UUID (for nested collections)"),
      description: z.string().optional().describe("Collection description"),
    },
    async ({ title, parent_id, description }) => {
      const result = await iconikRequest("assets/v1/collections/", {
        method: "POST",
        body: JSON.stringify({ title, parent_id, description }),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "update_collection",
    "Update a collection's properties",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
    },
    async ({ collection_id, ...updates }) => {
      const filteredUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, v]) => v !== undefined)
      );
      const result = await iconikRequest(`assets/v1/collections/${collection_id}/`, {
        method: "PATCH",
        body: JSON.stringify(filteredUpdates),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_collection",
    "Delete a collection (moves to delete queue)",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
    },
    async ({ collection_id }) => {
      await iconikRequest(`assets/v1/collections/${collection_id}/`, {
        method: "DELETE",
      });
      return {
        content: [{ type: "text" as const, text: `Collection ${collection_id} deleted` }],
      };
    }
  );

  server.tool(
    "get_collection_contents",
    "Get the contents (assets and sub-collections) of a collection",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
      page: z.number().optional().default(1),
      per_page: z.number().optional().default(20),
      content_types: z
        .array(z.enum(["assets", "collections"]))
        .optional()
        .describe("Filter by content type"),
    },
    async ({ collection_id, page, per_page, content_types }) => {
      const query = buildQueryString({
        page,
        per_page: Math.min(per_page, 100),
        content_types: content_types?.join(","),
      });
      const result = await iconikRequest(
        `assets/v1/collections/${collection_id}/contents/${query}`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "add_asset_to_collection",
    "Add an asset to a collection",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
      asset_id: z.string().uuid().describe("The asset UUID to add"),
    },
    async ({ collection_id, asset_id }) => {
      const result = await iconikRequest(
        `assets/v1/collections/${collection_id}/contents/assets/${asset_id}/`,
        { method: "PUT" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "remove_asset_from_collection",
    "Remove an asset from a collection",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
      asset_id: z.string().uuid().describe("The asset UUID to remove"),
    },
    async ({ collection_id, asset_id }) => {
      await iconikRequest(
        `assets/v1/collections/${collection_id}/contents/assets/${asset_id}/`,
        { method: "DELETE" }
      );
      return {
        content: [{ type: "text" as const, text: `Asset removed from collection` }],
      };
    }
  );

  server.tool(
    "get_collection_ancestors",
    "Get all ancestor collections (parent hierarchy)",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
    },
    async ({ collection_id }) => {
      const result = await iconikRequest(
        `assets/v1/collections/${collection_id}/ancestors/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_collection_subcollections",
    "Get direct child sub-collections",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
    },
    async ({ collection_id }) => {
      const result = await iconikRequest(
        `assets/v1/collections/${collection_id}/subcollections/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_collection_full_path",
    "Get the full path of a collection (breadcrumb)",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
    },
    async ({ collection_id }) => {
      const result = await iconikRequest(
        `assets/v1/collections/${collection_id}/full/path/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_collection_size",
    "Get the total size of all files in a collection",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
    },
    async ({ collection_id }) => {
      const result = await iconikRequest(
        `assets/v1/collections/${collection_id}/size/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "check_collection_archive_health",
    "Scan a collection and report archive health: group assets by archive_status, flag ARCHIVING stuck >24h, list FAILED_TO_ARCHIVE assets.",
    {
      collection_id: z.string().uuid().describe("The collection UUID to scan"),
    },
    async ({ collection_id }) => {
      const statusCounts: Record<string, number> = {};
      const stuckArchiving: { id: string; title: string; date_modified: string }[] = [];
      const failedToArchive: { id: string; title: string }[] = [];
      const now = Date.now();
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;

      let page = 1;
      const perPage = 100;
      let hasMore = true;
      let totalAssets = 0;

      interface CollectionContent {
        id: string;
        object_type: string;
      }

      while (hasMore) {
        const contentsResponse = await iconikRequest<PaginatedResponse<CollectionContent>>(
          `assets/v1/collections/${collection_id}/contents/?page=${page}&per_page=${perPage}&content_types=assets`
        );

        const items = contentsResponse.objects || [];

        for (const item of items) {
          if (item.object_type !== "assets") continue;
          totalAssets++;

          try {
            const asset = await iconikRequest<Asset>(
              `assets/v1/assets/${item.id}/`
            );

            const status = asset.archive_status || "NOT_ARCHIVED";
            statusCounts[status] = (statusCounts[status] || 0) + 1;

            if (status === "ARCHIVING") {
              const modified = new Date(asset.date_modified).getTime();
              if (now - modified > twentyFourHoursMs) {
                stuckArchiving.push({
                  id: asset.id,
                  title: asset.title,
                  date_modified: asset.date_modified,
                });
              }
            }

            if (status === "FAILED_TO_ARCHIVE") {
              failedToArchive.push({ id: asset.id, title: asset.title });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            statusCounts["ERROR"] = (statusCounts["ERROR"] || 0) + 1;
            // Log but continue processing
            console.error(`Error fetching asset ${item.id}: ${msg}`);
          }
        }

        hasMore = contentsResponse.pages > page;
        page++;
      }

      const report = {
        collection_id,
        total_assets: totalAssets,
        archive_status_counts: statusCounts,
        stuck_archiving_over_24h: stuckArchiving,
        failed_to_archive: failedToArchive,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
      };
    }
  );
}
