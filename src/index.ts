#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Import tool registration functions
import { registerAssetTools } from "./tools/assets.js";
import { registerSearchTools } from "./tools/search.js";
import { registerCollectionTools } from "./tools/collections.js";
import { registerMetadataTools } from "./tools/metadata.js";
import { registerFileTools } from "./tools/files.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerUserTools } from "./tools/users.js";
import { registerShareTools } from "./tools/shares.js";
import { registerSegmentTools } from "./tools/segments.js";
import { createFilteredServer, getAccessLevel } from "./tools/access-filter.js";

function createMcpServer(): McpServer {
  const rawServer = new McpServer({
    name: "Iconik-MCP-Server",
    version: "1.0.0",
  });

  const { proxy: server, logStats } = createFilteredServer(rawServer);

  registerAssetTools(server);
  registerSearchTools(server);
  registerCollectionTools(server);
  registerMetadataTools(server);
  registerFileTools(server);
  registerJobTools(server);
  registerUserTools(server);
  registerShareTools(server);
  registerSegmentTools(server);

  logStats();

  return rawServer;
}

async function startStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Iconik MCP Server started (stdio, access=${getAccessLevel()})`);
}

async function startHttpServer() {
  const port = parseInt(process.env.MCP_PORT || "8000", 10);
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/";

    // Health check endpoint
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // MCP endpoint
    if (url === "/mcp") {
      // Handle session initialization (POST without session ID)
      if (req.method === "POST") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (sessionId && sessions.has(sessionId)) {
          // Existing session
          const session = sessions.get(sessionId)!;
          await session.transport.handleRequest(req, res);
          return;
        }

        if (sessionId && !sessions.has(sessionId)) {
          // Unknown session ID
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }

        // New session — create server + transport
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        const server = createMcpServer();

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessions.delete(sid);
        };

        await server.connect(transport);
        await transport.handleRequest(req, res);

        const sid = transport.sessionId;
        if (sid) {
          sessions.set(sid, { server, transport });
        }
        return;
      }

      // GET — SSE stream for existing session
      if (req.method === "GET") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          await session.transport.handleRequest(req, res);
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session ID required" }));
        return;
      }

      // DELETE — close session
      if (req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          await session.transport.handleRequest(req, res);
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Unknown path
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, () => {
    console.error(`Iconik MCP Server started (HTTP on port ${port}, access=${getAccessLevel()})`);
  });
}

// Start server
async function main() {
  const transport = process.env.MCP_TRANSPORT || "stdio";

  if (transport === "http") {
    await startHttpServer();
  } else {
    await startStdioServer();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
