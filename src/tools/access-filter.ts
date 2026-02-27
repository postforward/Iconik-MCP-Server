import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type AccessLevel = "read" | "readwrite" | "full";

type ToolLevel = "read" | "write" | "delete";

const LEVEL_HIERARCHY: Record<AccessLevel, ToolLevel[]> = {
  read: ["read"],
  readwrite: ["read", "write"],
  full: ["read", "write", "delete"],
};

const READ_PREFIXES = ["list_", "get_", "search_", "check_", "export_segments_"];
const WRITE_PREFIXES = ["create_", "update_", "bulk_"];
const DELETE_PREFIXES = ["delete_", "purge_", "remove_"];

// Tools that don't match prefix rules (all are write-level)
const OVERRIDE_MAP: Record<string, ToolLevel> = {
  add_asset_to_collection: "write",
  add_user_to_group: "write",
  restore_asset: "write",
  restore_asset_file_set: "write",
  restore_asset_format: "write",
  promote_asset_version: "write",
  set_custom_keyframe: "write",
  capture_keyframe_from_file: "write",
  scan_storage: "write",
  transfer_file_set_to_storage: "write",
  export_asset_to_location: "write",
  import_segments_from_csv: "write",
  archive_asset_format: "write",
  abort_job: "write",
  retry_job: "write",
  request_asset_approval: "write",
  approve_asset: "write",
  reject_asset: "write",
};

function classifyTool(name: string): ToolLevel {
  if (OVERRIDE_MAP[name]) return OVERRIDE_MAP[name];
  if (READ_PREFIXES.some((p) => name.startsWith(p))) return "read";
  if (WRITE_PREFIXES.some((p) => name.startsWith(p))) return "write";
  if (DELETE_PREFIXES.some((p) => name.startsWith(p))) return "delete";
  // Unrecognized tools require full access (fail-safe)
  return "delete";
}

export function getAccessLevel(): AccessLevel {
  const env = process.env.MCP_ACCESS_LEVEL?.toLowerCase();
  if (env === "readwrite" || env === "full") return env;
  return "read";
}

export interface FilteredServer {
  proxy: McpServer;
  logStats(): void;
}

export function createFilteredServer(server: McpServer): FilteredServer {
  const accessLevel = getAccessLevel();
  const allowed = LEVEL_HIERARCHY[accessLevel];
  let registered = 0;
  let skipped = 0;

  const proxy = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") {
        return (name: string, ...args: unknown[]) => {
          const level = classifyTool(name);
          if (!allowed.includes(level)) {
            skipped++;
            return;
          }
          registered++;
          return (target.tool as Function).call(target, name, ...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return {
    proxy,
    logStats() {
      const total = registered + skipped;
      console.error(`Access level: ${accessLevel} — registered ${registered}/${total} tools (skipped ${skipped})`);
    },
  };
}
