import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { iconikRequest } from "../client.js";

export function registerSearchTools(server: McpServer) {
  server.tool(
    "search_assets",
    "Search for assets in Iconik using a query string",
    {
      query: z.string().describe("Search query string"),
      page: z.number().optional().default(1).describe("Page number (default: 1)"),
      per_page: z
        .number()
        .optional()
        .default(20)
        .describe("Results per page (default: 20, max: 100)"),
      doc_types: z
        .array(z.enum(["assets", "collections"]))
        .optional()
        .default(["assets"])
        .describe("Document types to search (default: ['assets'])"),
      sort: z
        .string()
        .optional()
        .describe("Sort field (e.g., 'date_created', 'title')"),
      order: z
        .enum(["asc", "desc"])
        .optional()
        .default("desc")
        .describe("Sort order"),
      filter: z
        .string()
        .optional()
        .describe("Additional filter criteria as JSON string"),
    },
    async ({ query, page, per_page, doc_types, sort, order, filter }) => {
      const searchBody: Record<string, unknown> = {
        query,
        doc_types,
        per_page: Math.min(per_page, 100),
        page,
      };

      if (sort) {
        searchBody.sort = [{ name: sort, order }];
      }

      if (filter) {
        searchBody.filter = JSON.parse(filter);
      }

      const result = await iconikRequest("search/v1/search/", {
        method: "POST",
        body: JSON.stringify(searchBody),
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "search_faceted",
    "Perform a faceted search to get aggregations/counts",
    {
      query: z.string().describe("Search query string"),
      facets: z
        .array(z.string())
        .describe("Fields to facet on (e.g., ['media_type', 'status'])"),
      doc_types: z
        .array(z.enum(["assets", "collections"]))
        .optional()
        .default(["assets"]),
    },
    async ({ query, facets, doc_types }) => {
      const searchBody = {
        query,
        doc_types,
        facets: facets.map((f) => ({ name: f })),
        per_page: 0, // Just want facets, not results
      };

      const result = await iconikRequest("search/v1/search/", {
        method: "POST",
        body: JSON.stringify(searchBody),
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "search_by_metadata",
    "Search assets by specific metadata field values",
    {
      metadata_field: z.string().describe("Metadata field name"),
      value: z.string().describe("Value to search for"),
      page: z.number().optional().default(1),
      per_page: z.number().optional().default(20),
    },
    async ({ metadata_field, value, page, per_page }) => {
      const searchBody = {
        query: "",
        doc_types: ["assets"],
        filter: {
          terms: {
            [`metadata.${metadata_field}`]: [value],
          },
        },
        per_page: Math.min(per_page, 100),
        page,
      };

      const result = await iconikRequest("search/v1/search/", {
        method: "POST",
        body: JSON.stringify(searchBody),
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "search_by_date_range",
    "Search assets created within a date range",
    {
      query: z.string().optional().default("").describe("Optional search query"),
      start_date: z.string().describe("Start date (ISO format: YYYY-MM-DD)"),
      end_date: z.string().describe("End date (ISO format: YYYY-MM-DD)"),
      date_field: z
        .enum(["date_created", "date_modified", "date_imported"])
        .optional()
        .default("date_created")
        .describe("Date field to filter on"),
      page: z.number().optional().default(1),
      per_page: z.number().optional().default(20),
    },
    async ({ query, start_date, end_date, date_field, page, per_page }) => {
      const searchBody = {
        query,
        doc_types: ["assets"],
        filter: {
          range: {
            [date_field]: {
              gte: start_date,
              lte: end_date,
            },
          },
        },
        per_page: Math.min(per_page, 100),
        page,
      };

      const result = await iconikRequest("search/v1/search/", {
        method: "POST",
        body: JSON.stringify(searchBody),
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
