import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { iconikRequest, buildQueryString } from "../client.js";

export function registerUserTools(server: McpServer) {
  server.tool(
    "list_users",
    "List all users in the system",
    {
      page: z.number().optional().default(1),
      per_page: z.number().optional().default(20),
    },
    async ({ page, per_page }) => {
      const query = buildQueryString({ page, per_page });
      const result = await iconikRequest(`users/v1/users/${query}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_user",
    "Get details of a specific user",
    {
      user_id: z.string().uuid().describe("The user UUID"),
    },
    async ({ user_id }) => {
      const result = await iconikRequest(`users/v1/users/${user_id}/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_current_user",
    "Get the currently authenticated user",
    {},
    async () => {
      const result = await iconikRequest("users/v1/users/me/");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_groups",
    "List all groups in the system",
    {
      page: z.number().optional().default(1),
      per_page: z.number().optional().default(20),
    },
    async ({ page, per_page }) => {
      const query = buildQueryString({ page, per_page });
      const result = await iconikRequest(`users/v1/groups/${query}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_group",
    "Get details of a specific group",
    {
      group_id: z.string().uuid().describe("The group UUID"),
    },
    async ({ group_id }) => {
      const result = await iconikRequest(`users/v1/groups/${group_id}/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_group_members",
    "List all members of a group",
    {
      group_id: z.string().uuid().describe("The group UUID"),
    },
    async ({ group_id }) => {
      const result = await iconikRequest(`users/v1/groups/${group_id}/users/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "add_user_to_group",
    "Add a user to a group",
    {
      group_id: z.string().uuid().describe("The group UUID"),
      user_id: z.string().uuid().describe("The user UUID to add"),
    },
    async ({ group_id, user_id }) => {
      const result = await iconikRequest(
        `users/v1/groups/${group_id}/users/${user_id}/`,
        { method: "PUT" }
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "remove_user_from_group",
    "Remove a user from a group",
    {
      group_id: z.string().uuid().describe("The group UUID"),
      user_id: z.string().uuid().describe("The user UUID to remove"),
    },
    async ({ group_id, user_id }) => {
      await iconikRequest(`users/v1/groups/${group_id}/users/${user_id}/`, {
        method: "DELETE",
      });
      return {
        content: [{ type: "text" as const, text: `User removed from group` }],
      };
    }
  );

  server.tool(
    "list_user_groups",
    "List all groups a user belongs to",
    {
      user_id: z.string().uuid().describe("The user UUID"),
    },
    async ({ user_id }) => {
      const result = await iconikRequest(`users/v1/users/${user_id}/groups/`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
