# Iconik-MCP-Server

A Model Context Protocol (MCP) server for the [Iconik](https://iconik.io) media asset management API. This enables AI assistants like Claude to interact with your Iconik media library.

## Features

- **45+ MCP Tools** - Comprehensive coverage of the Iconik API
- **Multi-Profile Support** - Manage multiple Iconik domains/accounts
- **Standalone Scripts** - CLI tools for common bulk operations
- **Dry Run Mode** - Safely preview destructive operations

## Installation

```bash
# Clone the repository
git clone https://github.com/postforward/Iconik-MCP-Server.git
cd Iconik-MCP-Server

# Install dependencies
npm install

# Build
npm run build
```

## Configuration

### Option 1: Config File (Recommended for Multiple Profiles)

Create `iconik-config.json` in the project directory:

```json
{
  "default_profile": "production",
  "profiles": {
    "production": {
      "name": "Production Domain",
      "app_id": "your-app-id",
      "auth_token": "your-auth-token"
    },
    "staging": {
      "name": "Staging Domain",
      "app_id": "your-staging-app-id",
      "auth_token": "your-staging-auth-token",
      "api_url": "https://preview.iconik.cloud/API/"
    }
  }
}
```

The config file is searched in these locations:
1. Current working directory: `./iconik-config.json`
2. Home directory: `~/.iconik-config.json`
3. Package directory

### Option 2: Environment Variables

For a single profile, use environment variables:

```bash
export ICONIK_APP_ID=your-app-id
export ICONIK_AUTH_TOKEN=your-auth-token
export ICONIK_API_URL=https://app.iconik.io/API/  # Optional
```

Or create a `.env` file:

```
ICONIK_APP_ID=your-app-id
ICONIK_AUTH_TOKEN=your-auth-token
```

## Usage with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "iconik": {
      "command": "node",
      "args": ["/path/to/Iconik-MCP-Server/dist/index.js"],
      "env": {
        "ICONIK_APP_ID": "your-app-id",
        "ICONIK_AUTH_TOKEN": "your-auth-token"
      }
    }
  }
}
```

Then restart Claude Desktop.

## MCP Tools

The server provides tools organized by category:

### Assets
- `search_assets` - Search for assets with filters
- `get_asset` - Get asset details
- `create_asset` - Create a new asset
- `update_asset` - Update asset properties
- `delete_asset` - Delete an asset
- `get_asset_proxies` - List proxy files
- `delete_proxies_by_collection` - Bulk delete proxies
- And 30+ more asset tools...

### Collections
- `list_collections` - List all collections
- `get_collection` - Get collection details
- `create_collection` - Create a collection
- `get_collection_contents` - List collection contents
- `add_to_collection` - Add assets to collection

### Metadata
- `get_asset_metadata` - Get asset metadata
- `update_asset_metadata` - Update metadata values
- `list_metadata_views` - List available views
- `get_metadata_view` - Get view schema

### Files & Storage
- `list_storages` - List storage locations
- `get_asset_files` - List asset files
- `create_file` - Create file record

### Jobs & Transcoding
- `list_jobs` - List transcoding jobs
- `get_job` - Get job status
- `create_transcode_job` - Start transcode

### Users & Shares
- `list_users` - List users
- `list_shares` - List shared links
- `create_share` - Create share link

## Standalone Scripts

Run scripts directly for bulk operations:

### Smart Search
```bash
npx ts-node scripts/smart-search.ts search "interview" --type=video --transcripts
npx ts-node scripts/smart-search.ts export "*" ./all-assets.csv --limit=500
npx ts-node scripts/smart-search.ts recent --limit=10 --profile=staging
```

### Delete Proxies
```bash
# Dry run (preview)
npx ts-node scripts/delete-proxies.ts collection <collection_id>

# Actually delete
npx ts-node scripts/delete-proxies.ts collection <collection_id> --live

# Use specific profile
npx ts-node scripts/delete-proxies.ts collection <id> --profile=production --live
```

### Storage Audit
```bash
npx ts-node scripts/storage-audit.ts
npx ts-node scripts/storage-audit.ts --profile=production
```

### Archive Health Report
```bash
npx ts-node scripts/archive-health-report.ts
```

### Bulk Metadata Update
```bash
# List available metadata views
npx ts-node scripts/metadata-bulk-update.ts list-views

# Update by collection (dry run)
npx ts-node scripts/metadata-bulk-update.ts collection <collection_id> <view_id> '{"field":"value"}'

# Update from CSV
npx ts-node scripts/metadata-bulk-update.ts csv ./updates.csv <view_id> --live
```

## Getting Your Iconik Credentials

1. Log in to your Iconik domain
2. Go to **Admin** → **Settings** → **Applications**
3. Create a new application or use an existing one
4. Copy the **App ID** and generate an **Auth Token**

## API Reference

This MCP server wraps the [Iconik API](https://app.iconik.io/docs/apidocs.html). See their documentation for detailed endpoint information.

## License

ISC

## Contributing

Contributions welcome! Please open an issue or PR.
