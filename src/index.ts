#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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

// Create server instance
const server = new McpServer({
  name: "iconik-mcp-server",
  version: "1.0.0",
});

// Register all tools
registerAssetTools(server);
registerSearchTools(server);
registerCollectionTools(server);
registerMetadataTools(server);
registerFileTools(server);
registerJobTools(server);
registerUserTools(server);
registerShareTools(server);
registerSegmentTools(server);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Iconik MCP Server started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
