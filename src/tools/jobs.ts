import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { iconikRequest, buildQueryString } from "../client.js";

export function registerJobTools(server: McpServer) {
  server.tool(
    "list_jobs",
    "List all jobs with pagination",
    {
      page: z.number().optional().default(1),
      per_page: z.number().optional().default(20),
      status: z
        .enum(["PENDING", "IN_PROGRESS", "FINISHED", "FAILED", "ABORTED"])
        .optional()
        .describe("Filter by job status"),
      type: z.string().optional().describe("Filter by job type"),
    },
    async ({ page, per_page, status, type }) => {
      const query = buildQueryString({ page, per_page, status, type });
      const result = await iconikRequest(`jobs/v1/jobs/${query}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_job",
    "Get details of a specific job",
    {
      job_id: z.string().uuid().describe("The job UUID"),
    },
    async ({ job_id }) => {
      const result = await iconikRequest(`jobs/v1/jobs/${job_id}/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "abort_job",
    "Abort/cancel a running job",
    {
      job_id: z.string().uuid().describe("The job UUID to abort"),
    },
    async ({ job_id }) => {
      const result = await iconikRequest(`jobs/v1/jobs/${job_id}/abort/`, {
        method: "POST",
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "retry_job",
    "Retry a failed job",
    {
      job_id: z.string().uuid().describe("The job UUID to retry"),
    },
    async ({ job_id }) => {
      const result = await iconikRequest(`jobs/v1/jobs/${job_id}/retry/`, {
        method: "POST",
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_job_steps",
    "List all steps/tasks for a job",
    {
      job_id: z.string().uuid().describe("The job UUID"),
    },
    async ({ job_id }) => {
      const result = await iconikRequest(`jobs/v1/jobs/${job_id}/steps/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ============================================
  // TRANSCODE OPERATIONS
  // ============================================

  server.tool(
    "create_transcode_job",
    "Create a transcode job for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      version_id: z.string().uuid().describe("The version UUID"),
      transcode_profile_id: z.string().uuid().optional().describe("Transcode profile to use"),
    },
    async ({ asset_id, version_id, transcode_profile_id }) => {
      const body: Record<string, unknown> = { asset_id, version_id };
      if (transcode_profile_id) {
        body.transcode_profile_id = transcode_profile_id;
      }
      const result = await iconikRequest(
        `files/v1/assets/${asset_id}/versions/${version_id}/transcode/`,
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
    "create_analyze_job",
    "Create an analyze job for an asset (extract metadata, generate keyframes)",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
    },
    async ({ asset_id }) => {
      const result = await iconikRequest(`transcode/v1/analyze/`, {
        method: "POST",
        body: JSON.stringify({ asset_id }),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_keyframe_job",
    "Create a job to generate keyframes for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
    },
    async ({ asset_id }) => {
      const result = await iconikRequest(`transcode/v1/keyframes/`, {
        method: "POST",
        body: JSON.stringify({ asset_id }),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_transcription_job",
    "Create a transcription job for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      language: z.string().optional().describe("Language code (e.g., 'en-US')"),
    },
    async ({ asset_id, language }) => {
      const body: Record<string, unknown> = { asset_id };
      if (language) {
        body.language = language;
      }
      const result = await iconikRequest(`transcode/v1/transcribe/`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_face_recognition_job",
    "Create a face recognition job for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
    },
    async ({ asset_id }) => {
      const result = await iconikRequest(`transcode/v1/face_recognition/`, {
        method: "POST",
        body: JSON.stringify({ asset_id }),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
