# Iconik MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for the [Iconik](https://iconik.io) media asset management platform. Exposes 143 tools for AI assistants to browse, search, manage, and maintain assets in your Iconik library.

## Quick Start

```bash
docker run -d \
  -p 8000:8000 \
  -e ICONIK_APP_ID=your-app-id \
  -e ICONIK_AUTH_TOKEN=your-auth-token \
  postforward/iconik-mcp-server
```

Or with Docker Compose:

```yaml
services:
  iconik-mcp:
    image: postforward/iconik-mcp-server:latest
    ports:
      - "8000:8000"
    environment:
      - ICONIK_APP_ID=your-app-id
      - ICONIK_AUTH_TOKEN=your-auth-token
      - MCP_ACCESS_LEVEL=read
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ICONIK_APP_ID` | Yes | — | Iconik application ID |
| `ICONIK_AUTH_TOKEN` | Yes | — | Iconik auth token |
| `MCP_ACCESS_LEVEL` | No | `read` | Tool access level: `read`, `readwrite`, or `full` |
| `MCP_PORT` | No | `8000` | HTTP listen port |

## Access Levels

Controls which tools are registered at startup. Defaults to **read-only** for safety.

| Level | Tools | Count |
|-------|-------|-------|
| `read` | list, get, search, check | 85 |
| `readwrite` | read + create, update, bulk | 126 |
| `full` | readwrite + delete, purge | 143 |

## Tool Categories

- **Assets** — Search, browse, create, update, and manage media assets
- **Collections** — Organize assets into collections and subcollections
- **Metadata** — Read and update metadata fields and views
- **Files & Storage** — Manage file records, storages, transfers, and exports
- **Jobs** — Monitor and manage transcode, transcription, and analysis jobs
- **Users & Groups** — List and manage users, groups, and memberships
- **Shares** — Create and manage shared links
- **Segments** — Work with asset timeline segments and subtitles

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/mcp` | MCP protocol (Streamable HTTP) |
| `GET` | `/mcp` | SSE stream for existing session |
| `DELETE` | `/mcp` | Close session |
| `GET` | `/health` | Health check |

## Transports

- **HTTP** (default in Docker) — Streamable HTTP on `/mcp` for remote clients
- **stdio** — Set `MCP_TRANSPORT=stdio` for local MCP clients (Claude Code, Cursor, etc.)

## Getting Iconik Credentials

1. Log in to your Iconik domain
2. Go to **Admin** → **Settings** → **Applications**
3. Create a new application or use an existing one
4. Copy the **App ID** and generate an **Auth Token**

## Links

- [GitHub Repository](https://github.com/postforward/Iconik-MCP-Server)
- [Iconik API Documentation](https://app.iconik.io/docs/apidocs.html)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
