import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { iconikRequest, buildQueryString } from "../client.js";

export function registerShareTools(server: McpServer) {
  server.tool(
    "list_shares",
    "List all shares",
    {
      page: z.number().optional().default(1),
      per_page: z.number().optional().default(20),
    },
    async ({ page, per_page }) => {
      const query = buildQueryString({ page, per_page });
      const result = await iconikRequest(`assets/v1/shares/${query}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_asset_shares",
    "Get all shares for a specific asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
    },
    async ({ asset_id }) => {
      const result = await iconikRequest(`assets/v1/assets/${asset_id}/shares/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_collection_shares",
    "Get all shares for a specific collection",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
    },
    async ({ collection_id }) => {
      const result = await iconikRequest(
        `assets/v1/collections/${collection_id}/shares/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_asset_share",
    "Create a share link for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      title: z.string().optional().describe("Share title"),
      expires: z.string().optional().describe("Expiration date (ISO format)"),
      allow_download: z.boolean().optional().default(true).describe("Allow downloads"),
      password: z.string().optional().describe("Password protect the share"),
      user_ids: z.array(z.string().uuid()).optional().describe("Specific users to share with"),
      group_ids: z.array(z.string().uuid()).optional().describe("Specific groups to share with"),
    },
    async ({ asset_id, title, expires, allow_download, password, user_ids, group_ids }) => {
      const body: Record<string, unknown> = {
        allow_download,
      };
      if (title) body.title = title;
      if (expires) body.expires = expires;
      if (password) body.password = password;
      if (user_ids) body.user_ids = user_ids;
      if (group_ids) body.group_ids = group_ids;

      const result = await iconikRequest(`assets/v1/assets/${asset_id}/shares/`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_collection_share",
    "Create a share link for a collection",
    {
      collection_id: z.string().uuid().describe("The collection UUID"),
      title: z.string().optional().describe("Share title"),
      expires: z.string().optional().describe("Expiration date (ISO format)"),
      allow_download: z.boolean().optional().default(true).describe("Allow downloads"),
      password: z.string().optional().describe("Password protect the share"),
      user_ids: z.array(z.string().uuid()).optional().describe("Specific users to share with"),
      group_ids: z.array(z.string().uuid()).optional().describe("Specific groups to share with"),
    },
    async ({ collection_id, title, expires, allow_download, password, user_ids, group_ids }) => {
      const body: Record<string, unknown> = {
        allow_download,
      };
      if (title) body.title = title;
      if (expires) body.expires = expires;
      if (password) body.password = password;
      if (user_ids) body.user_ids = user_ids;
      if (group_ids) body.group_ids = group_ids;

      const result = await iconikRequest(
        `assets/v1/collections/${collection_id}/shares/`,
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
    "get_share",
    "Get details of a specific share",
    {
      object_type: z.enum(["assets", "collections"]).describe("Type of shared object"),
      object_id: z.string().uuid().describe("The object UUID"),
      share_id: z.string().uuid().describe("The share UUID"),
    },
    async ({ object_type, object_id, share_id }) => {
      const result = await iconikRequest(
        `assets/v1/${object_type}/${object_id}/shares/${share_id}/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "delete_share",
    "Delete a share link",
    {
      object_type: z.enum(["assets", "collections"]).describe("Type of shared object"),
      object_id: z.string().uuid().describe("The object UUID"),
      share_id: z.string().uuid().describe("The share UUID to delete"),
    },
    async ({ object_type, object_id, share_id }) => {
      await iconikRequest(
        `assets/v1/${object_type}/${object_id}/shares/${share_id}/`,
        { method: "DELETE" }
      );
      return {
        content: [{ type: "text" as const, text: `Share ${share_id} deleted` }],
      };
    }
  );

  server.tool(
    "get_share_url",
    "Get the public URL for a share",
    {
      object_type: z.enum(["assets", "collections"]).describe("Type of shared object"),
      object_id: z.string().uuid().describe("The object UUID"),
    },
    async ({ object_type, object_id }) => {
      const result = await iconikRequest(
        `assets/v1/${object_type}/${object_id}/shares/url/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_share_users",
    "List users who have access to a share",
    {
      object_type: z.enum(["assets", "collections"]).describe("Type of shared object"),
      object_id: z.string().uuid().describe("The object UUID"),
      share_id: z.string().uuid().describe("The share UUID"),
    },
    async ({ object_type, object_id, share_id }) => {
      const result = await iconikRequest(
        `assets/v1/${object_type}/${object_id}/shares/${share_id}/users/`
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ============================================
  // APPROVALS
  // ============================================

  server.tool(
    "get_asset_approval",
    "Get approval status for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
    },
    async ({ asset_id }) => {
      const result = await iconikRequest(`assets/v1/assets/${asset_id}/approvals/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "request_asset_approval",
    "Request approval for an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      user_ids: z.array(z.string().uuid()).optional().describe("Users to request approval from"),
      group_ids: z.array(z.string().uuid()).optional().describe("Groups to request approval from"),
      message: z.string().optional().describe("Message to include with request"),
    },
    async ({ asset_id, user_ids, group_ids, message }) => {
      const body: Record<string, unknown> = {};
      if (user_ids) body.users = user_ids;
      if (group_ids) body.groups = group_ids;
      if (message) body.message = message;

      const result = await iconikRequest(
        `assets/v1/assets/${asset_id}/approvals/request/`,
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
    "approve_asset",
    "Approve an asset",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      message: z.string().optional().describe("Approval message"),
    },
    async ({ asset_id, message }) => {
      const body: Record<string, unknown> = { status: "APPROVED" };
      if (message) body.message = message;

      const result = await iconikRequest(`assets/v1/assets/${asset_id}/approvals/`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "reject_asset",
    "Reject an asset approval",
    {
      asset_id: z.string().uuid().describe("The asset UUID"),
      message: z.string().optional().describe("Rejection reason"),
    },
    async ({ asset_id, message }) => {
      const body: Record<string, unknown> = { status: "NOT_APPROVED" };
      if (message) body.message = message;

      const result = await iconikRequest(`assets/v1/assets/${asset_id}/approvals/`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
