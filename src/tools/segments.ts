import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { iconikRequest, buildQueryString } from "../client.js";

// Note: Most segment operations are in assets.ts
// This file contains additional segment-specific operations

export function registerSegmentTools(server: McpServer) {
  server.tool(
    "bulk_create_segments",
    "Create multiple segments at once for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      segments: z
        .array(
          z.object({
            segment_type: z.enum([
              "MARKER",
              "CHAPTER",
              "COMMENT",
              "CUSTOM",
              "MANUAL_TRANSCRIPTION",
            ]),
            title: z.string().optional(),
            text: z.string().optional(),
            time_start_milliseconds: z.number(),
            time_end_milliseconds: z.number(),
          })
        )
        .describe("Array of segments to create"),
    },
    async ({ asset_id, segments }) => {
      const result = await iconikRequest(
        `assets/v1/assets/${asset_id}/segments/bulk/`,
        {
          method: "POST",
          body: JSON.stringify({ objects: segments }),
        }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "import_segments_from_csv",
    "Import segments from CSV data",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      csv_content: z.string().describe("CSV content with segment data"),
    },
    async ({ asset_id, csv_content }) => {
      const result = await iconikRequest(
        `assets/v1/assets/${asset_id}/segments/csv/`,
        {
          method: "POST",
          body: csv_content,
          headers: {
            "Content-Type": "text/csv",
          },
        }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_segments_text",
    "Get all segment text content as plain text",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
    },
    async ({ asset_id }) => {
      const result = await iconikRequest(
        `assets/v1/assets/${asset_id}/segments/text/`
      );
      return {
        content: [{ type: "text" as const, text: typeof result === 'string' ? result : JSON.stringify(result) }],
      };
    }
  );

  server.tool(
    "search_segments",
    "Search for segments across all assets",
    {
      query: z.string().describe("Search query"),
      segment_type: z
        .enum([
          "MARKER",
          "CHAPTER",
          "FACE",
          "LABEL",
          "COMMENT",
          "SHOT_CHANGE",
          "TRANSCRIPTION",
          "SPEECH",
          "SPEECH_SEGMENT",
          "OBJECT",
          "CUSTOM",
          "LOGO",
          "SENSITIVE_CONTENT",
          "TEXT",
          "CELEBRITY",
          "MODERATION",
          "MANUAL_TRANSCRIPTION",
          "SMPTE_TIMECODE",
        ])
        .optional()
        .describe("Filter by segment type"),
      page: z.number().optional().default(1),
      per_page: z.number().optional().default(20),
    },
    async ({ query, segment_type, page, per_page }) => {
      const searchBody: Record<string, unknown> = {
        query,
        doc_types: ["segments"],
        per_page: Math.min(per_page, 100),
        page,
      };

      if (segment_type) {
        searchBody.filter = {
          terms: {
            segment_type: [segment_type],
          },
        };
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
    "update_segment",
    "Update an existing segment",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      segment_id: z.string().uuid().describe("The segment UUID"),
      title: z.string().optional().describe("New title"),
      text: z.string().optional().describe("New text content"),
      time_start_milliseconds: z.number().optional().describe("New start time"),
      time_end_milliseconds: z.number().optional().describe("New end time"),
    },
    async ({ asset_id, segment_id, ...updates }) => {
      const filteredUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, v]) => v !== undefined)
      );
      const result = await iconikRequest(
        `assets/v1/assets/${asset_id}/segments/${segment_id}/`,
        {
          method: "PATCH",
          body: JSON.stringify(filteredUpdates),
        }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
