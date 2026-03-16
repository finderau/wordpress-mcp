# WordPress MCP Server

MCP server that wraps the WordPress REST API with **backup-before-change** and **multi-site** support. Every mutating operation snapshots the current state before applying changes, enabling full audit trail and rollback.

## Features

- **Multi-site** — target different WordPress instances via `site` parameter (enum)
- **Backup-before-change** — automatic snapshots before updates and deletes
- **Change log** — query what changed, when, and by whom
- **Rollback** — restore any object to a previous state (restores are themselves reversible)
- **Gateway-ready** — per-user credential injection, caller identity tracking

## Tools

| Tool | Description |
|------|-------------|
| `wp_list_posts` | List/search posts or pages |
| `wp_get_post` | Get a single post/page with full content |
| `wp_list_revisions` | List WordPress native revisions for a post/page |
| `wp_create_post` | Create a new post/page (defaults to draft) |
| `wp_update_post` | Update a post/page (auto-backup) |
| `wp_delete_post` | Trash or delete a post/page (auto-backup) |
| `wp_list_media` | List media library items |
| `wp_upload_media` | Upload a file to media library (10MB limit) |
| `wp_delete_media` | Delete media (auto-backup of metadata) |
| `wp_get_categories` | List categories |
| `wp_get_tags` | List tags |
| `wp_get_site_info` | Site info and connectivity check |
| `wp_list_changes` | Query the backup/change log |
| `wp_restore` | Restore from a backup (auto-backup before restore) |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure credentials

Copy `.env.example` to `.env` and fill in your WordPress Application Passwords:

```bash
cp .env.example .env
```

Each site needs a WordPress user with an Application Password. Create one in WP Admin > Users > Profile > Application Passwords.

### 3. Run locally

```bash
node src/server.js
```

### 4. Add to MCP config (Claude Code)

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "/Users/you/projects/wordpress-mcp/run-wordpress-mcp.sh"
    }
  }
}
```

## Adding a new site

Edit `src/config.js` and add an entry to the `SITES` object:

```js
'my-new-site': {
  label: 'My New Site',
  baseUrl: 'https://my-new-site.example.com',
  multisite: false,
  credentialPrefix: 'WP_MY_NEW_SITE',
}
```

Then set the corresponding env vars: `WP_MY_NEW_SITE_USER` and `WP_MY_NEW_SITE_APP_PASSWORD`.

## Backup storage

Backups are stored in SQLite at `./data/wp-backups.db` (configurable via `WP_BACKUP_DB_PATH` env var). The database is created automatically on first run.

## Gateway deployment

1. Copy repo to `/opt/gateway/wordpress-mcp/`
2. `npm install --production`
3. Add credentials to `/opt/gateway/secrets/wordpress.env`
4. Add server entry to gateway YAML config
5. Restart gateway
