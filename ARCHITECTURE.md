# Architecture

## Overview

The WordPress MCP Server wraps the WordPress REST API as an MCP (Model Context Protocol) server. It adds backup-before-change semantics, multi-site support, and per-user credential injection for gateway deployments.

## Request Flow

```
Claude Code (stdin/stdout)
  → StdioServerTransport
  → server.js (route by tool name)
  → tools/*.js (handler)
  → wordpress-client.js (HTTP + Basic Auth + 429 retry)
  → WordPress REST API (/wp-json/wp/v2/...)
```

## Key Design Decisions

### Backup-Before-Change

Every mutating operation (update, delete) snapshots the current object state into SQLite before applying the change. This provides:

- **Audit trail** — who changed what, when (`wp_list_changes`)
- **Rollback** — restore any object to a previous state (`wp_restore`)
- **Reversible restores** — restoring creates its own backup, so restores can be undone

The backup stores the full WP object as JSON. On restore, only writable fields are written back (see `WRITABLE_POST_FIELDS` and `WRITABLE_FIELDS` allowlists).

### Credential Resolution

Credentials are resolved in priority order:

1. **Per-user credentials** (gateway mode) — injected via `_gateway_user_credentials` in tool args
2. **Group/default credentials** — from environment variables (`WP_<PREFIX>_USER`, `WP_<PREFIX>_APP_PASSWORD`)

This allows multi-user deployments where each user has their own WordPress Application Password.

### Multi-Site

Sites are registered in `src/config.js` with a slug, base URL, and credential prefix. The `site` parameter is an enum in every tool schema, validated at the config layer. Adding a new site requires only a config entry and corresponding env vars.

## File Map

| File | Purpose |
|------|---------|
| `src/server.js` | MCP server bootstrap, tool routing, client construction |
| `src/config.js` | Site registry, credential resolution |
| `src/wordpress-client.js` | HTTP client with Basic Auth and 429 retry |
| `src/backup-store.js` | SQLite backup database (better-sqlite3, WAL mode) |
| `src/tools/index.js` | Tool registry aggregation and request router |
| `src/tools/posts.js` | Post/page CRUD tools (6 tools) |
| `src/tools/media.js` | Media library tools (3 tools) |
| `src/tools/taxonomy.js` | Category/tag listing (2 tools) |
| `src/tools/site.js` | Site info/connectivity check (1 tool) |
| `src/tools/changes.js` | Change log query and restore (2 tools) |
| `src/shared/gateway-credentials.js` | Per-user credential extraction from gateway headers |
| `run-wordpress-mcp.sh` | Gateway deployment launcher (sources secrets, auto-installs deps) |

## Security

### Transport Security
- HTTPS is enforced — `WordPressClient` rejects non-HTTPS base URLs at construction time.
- Credentials use HTTP Basic Auth (base64-encoded) which is safe only over HTTPS.

### Input Validation
- **Site slug** — validated against the `SITES` registry; unknown slugs are rejected without echoing user input.
- **Post type** — allowlisted to `posts` and `pages` only.
- **Integer IDs** — all post, media, and backup IDs are validated as positive integers before use in URL paths or DB queries.
- **Writable fields** — both create/update and restore use a field allowlist (`WRITABLE_POST_FIELDS`).
- **Meta keys** — restore filters out dangerous WordPress internal meta keys (`_wp_page_template`, `_edit_lock`, etc.).
- **Media uploads** — filename is sanitised (path traversal, control chars, quotes stripped). 10MB file size limit enforced. MIME type validated against an allowlist (images, video, audio, PDFs, Office docs, text). Content-Type is stripped of control characters before use in multipart headers. Meta field values are sanitised to prevent multipart boundary injection. Meta field keys are validated against a fixed allowlist. Multipart boundary uses cryptographically random bytes.

### Request Timeouts
- Each HTTP request gets a fresh `AbortSignal.timeout(30s)` per attempt. The signal is not reused across 429 retries, so retry-after waits don't eat into the next attempt's timeout budget.

### Rate Limiting
- The HTTP client respects `429 Too Many Requests` with automatic retry, but caps `Retry-After` wait time to 30 seconds to prevent DoS via excessively large values.

### Error Handling
- WordPress API error responses are sanitised before returning to MCP callers — only the HTTP status code and WP error code are exposed, not internal messages that could reveal plugin names, user IDs, or file paths.
- Credential-related errors do not reveal the expected environment variable names.
- Error messages never echo back user-supplied input (site slugs, post types, backup IDs, etc.).
- Response body size limits are enforced on all code paths, including the `text()` fallback when streaming is unavailable.

### Audit Trail
- Every mutation (create, update, delete) creates a backup with caller identity (`changed_by`).
- Creates log the newly created object; updates/deletes log the pre-change state.
- Restores are themselves reversible (pre-restore backup created automatically).
- `wp_list_changes` provides full change history with filtering.

### Backup Database
- Stored at `./data/wp-backups.db` (`.gitignore`d). Contains full object snapshots which may include sensitive content.
- WAL mode for concurrent reads. Clean shutdown flushes WAL via `SIGINT`/`SIGTERM` handlers.
- Consider restricting file permissions (`chmod 600`) in production.

## Limitations

- **Media restore is metadata-only** — the WordPress REST API doesn't support re-uploading deleted files. Backups store metadata (title, alt_text, caption, description) but not the file content.
- **Permanently deleted posts cannot be restored** — if `force=true` was used on delete, the WP object no longer exists and `wp_restore` will fail with a 404. The backup still holds the snapshot for manual recreation.
- **QA sites** — currently disabled in config because they don't support Application Passwords.
