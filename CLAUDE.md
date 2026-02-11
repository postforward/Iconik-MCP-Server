# Iconik-MCP-Server

Iconik API client and maintenance scripts for managing media assets.

## Profiles (iconik-config.json)
- `dev` - PostForward Dev
- `tm` - Client TM
- `privcap` - Client PrivCap

## Common Scripts

### File/Storage Maintenance
- `scripts/fix-orphaned-with-sizes-parallel.ts` - Fix orphaned file sets by creating file records with sizes from mounted volume
- `scripts/cleanup-expired-delivery-files.ts` - Delete file records older than X days from a storage
- `scripts/undelete-and-create-file.ts` - Undelete a file set and create its file record
- `scripts/fix-orphaned-with-sizes.ts` - Non-parallel version of orphaned file set fix

## Usage

```bash
npx tsx scripts/<script-name>.ts --profile=<profile> [--live]
```

All scripts run in **dry-run mode** by default. Add `--live` to make actual changes.

## Key Concepts

- **Asset** - A media item in Iconik
- **Format** - A version of an asset (e.g., ORIGINAL, PROXY)
- **File Set** - Links an asset to a storage location
- **File Record** - The actual file entry with size, path, status
- **Storage** - A configured storage backend (Mortar, Trick, GCS, etc.)

### Common Issue: Orphaned File Sets
When Iconik archives assets, it sometimes creates file sets without file records. This causes assets to show 0 bytes. Fix with `fix-orphaned-with-sizes-parallel.ts`.

### Common Issue: GCS Lifecycle Orphans
When GCS deletes files via lifecycle policy, Iconik file records remain. Clean up with `cleanup-expired-delivery-files.ts`.

## Mounted Volumes
- Mortar storage typically mounted at `/Volumes/mortar`
