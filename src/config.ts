import * as fs from "fs";
import * as path from "path";

export interface IconikProfile {
  name: string;
  app_id: string;
  auth_token: string;
  api_url?: string; // Optional, defaults to https://app.iconik.io/API/
}

export interface Config {
  default_profile: string;
  profiles: Record<string, IconikProfile>;
}

const CONFIG_FILENAME = "iconik-config.json";
const DEFAULT_API_URL = "https://app.iconik.io/API/";

/**
 * Find config file by checking multiple locations
 */
function findConfigFile(): string | null {
  const locations = [
    // Current working directory
    path.join(process.cwd(), CONFIG_FILENAME),
    // User's home directory
    path.join(process.env.HOME || "", `.${CONFIG_FILENAME}`),
    // Package directory
    path.join(__dirname, "..", CONFIG_FILENAME),
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }
  return null;
}

/**
 * Load configuration from file or environment variables
 */
export function loadConfig(): Config {
  const configPath = findConfigFile();

  if (configPath) {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(content) as Config;
      return config;
    } catch (e) {
      console.error(`Error reading config file ${configPath}:`, e);
    }
  }

  // Fall back to environment variables (backwards compatible)
  if (process.env.ICONIK_APP_ID && process.env.ICONIK_AUTH_TOKEN) {
    return {
      default_profile: "default",
      profiles: {
        default: {
          name: "Default (from environment)",
          app_id: process.env.ICONIK_APP_ID,
          auth_token: process.env.ICONIK_AUTH_TOKEN,
          api_url: process.env.ICONIK_API_URL,
        },
      },
    };
  }

  // No config found
  console.error(`
Error: No configuration found.

Please create a config file or set environment variables:

Option 1: Create ${CONFIG_FILENAME} in the current directory:

  {
    "default_profile": "my-domain",
    "profiles": {
      "my-domain": {
        "name": "My Iconik Domain",
        "app_id": "your-app-id",
        "auth_token": "your-auth-token"
      }
    }
  }

Option 2: Set environment variables:

  export ICONIK_APP_ID=your-app-id
  export ICONIK_AUTH_TOKEN=your-auth-token

See iconik-config.example.json for a full example.
`);
  process.exit(1);
}

/**
 * Get a specific profile by name, or the default profile
 */
export function getProfile(profileName?: string): IconikProfile & { api_url: string } {
  const config = loadConfig();

  const name = profileName || config.default_profile;

  if (!config.profiles[name]) {
    const available = Object.keys(config.profiles).join(", ");
    console.error(`Error: Profile "${name}" not found.`);
    console.error(`Available profiles: ${available}`);
    process.exit(1);
  }

  const profile = config.profiles[name];

  return {
    ...profile,
    api_url: profile.api_url || DEFAULT_API_URL,
  };
}

/**
 * List all available profiles
 */
export function listProfiles(): void {
  const config = loadConfig();

  console.log("\nAvailable Iconik Profiles:");
  console.log("─".repeat(50));

  for (const [key, profile] of Object.entries(config.profiles)) {
    const isDefault = key === config.default_profile;
    const marker = isDefault ? " (default)" : "";
    console.log(`  ${key}${marker}`);
    console.log(`    Name: ${profile.name}`);
    console.log(`    API: ${profile.api_url || DEFAULT_API_URL}`);
    console.log("");
  }
}

/**
 * Parse --profile=name from command line args
 */
export function getProfileFromArgs(args: string[] = process.argv): string | undefined {
  const profileArg = args.find((a) => a.startsWith("--profile="));
  return profileArg?.split("=")[1];
}
