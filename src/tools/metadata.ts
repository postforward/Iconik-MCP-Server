import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { iconikRequest } from "../client.js";

export function registerMetadataTools(server: McpServer) {
  server.tool(
    "get_asset_metadata",
    "Get all metadata views and values for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
    },
    async ({ asset_id }) => {
      const result = await iconikRequest(
        `metadata/v1/assets/${asset_id}/views/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_asset_metadata_view",
    "Get metadata for a specific view",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      view_id: z.string().uuid().describe("The metadata view UUID"),
    },
    async ({ asset_id, view_id }) => {
      const result = await iconikRequest(
        `metadata/v1/assets/${asset_id}/views/${view_id}/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "update_asset_metadata",
    "Update metadata values for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      view_id: z.string().uuid().describe("The metadata view UUID"),
      metadata_values: z
        .string()
        .describe("Metadata field values as JSON string (e.g., '{\"field_name\": \"value\"}')"),
    },
    async ({ asset_id, view_id, metadata_values }) => {
      const result = await iconikRequest(
        `metadata/v1/assets/${asset_id}/views/${view_id}/`,
        {
          method: "PUT",
          body: JSON.stringify({ metadata_values: JSON.parse(metadata_values) }),
        }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_collection_metadata",
    "Get all metadata views and values for a collection",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
    },
    async ({ collection_id }) => {
      const result = await iconikRequest(
        `metadata/v1/collections/${collection_id}/views/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "update_collection_metadata",
    "Update metadata values for a collection",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
      view_id: z.string().uuid().describe("The metadata view UUID"),
      metadata_values: z
        .string()
        .describe("Metadata field values as JSON string (e.g., '{\"field_name\": \"value\"}')"),
    },
    async ({ collection_id, view_id, metadata_values }) => {
      const result = await iconikRequest(
        `metadata/v1/collections/${collection_id}/views/${view_id}/`,
        {
          method: "PUT",
          body: JSON.stringify({ metadata_values: JSON.parse(metadata_values) }),
        }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_metadata_views",
    "List all available metadata views",
    {
      _placeholder: z.string().optional().describe("Placeholder parameter (not used)"),
    },
    async () => {
      const result = await iconikRequest("metadata/v1/views/");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_metadata_view",
    "Get details of a specific metadata view including its fields",
    {
      view_id: z.string().uuid().describe("The metadata view UUID"),
    },
    async ({ view_id }) => {
      const result = await iconikRequest(`metadata/v1/views/${view_id}/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_metadata_fields",
    "List all available metadata fields",
    {
      _placeholder: z.string().optional().describe("Placeholder parameter (not used)"),
    },
    async () => {
      const result = await iconikRequest("metadata/v1/fields/");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_metadata_field",
    "Get details of a specific metadata field",
    {
      field_name: z.string().describe("The metadata field name"),
    },
    async ({ field_name }) => {
      const result = await iconikRequest(`metadata/v1/fields/${field_name}/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
