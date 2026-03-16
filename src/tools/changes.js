/**
 * Change log and restore tools.
 *
 * wp_list_changes — query the backup database
 * wp_restore — restore an object to a previous state (itself backed up first)
 */

import { listSiteSlugs } from '../config.js';
import { WRITABLE_POST_FIELDS } from './posts.js';

const siteEnum = listSiteSlugs();

// Writable fields per object type (for filtering snapshots before restore)
const WRITABLE_FIELDS = {
  post: WRITABLE_POST_FIELDS,
  page: WRITABLE_POST_FIELDS,
  media: ['title', 'alt_text', 'caption', 'description'],
};

// Meta keys that must never be written via restore (WordPress internal/security-sensitive)
const BLOCKED_META_KEYS = [
  '_wp_page_template', '_wp_attached_file', '_wp_attachment_metadata',
  '_edit_lock', '_edit_last', '_wp_trash_meta_status', '_wp_trash_meta_time',
  '_wp_old_slug', '_wp_old_date',
];

// Map object_type back to WP REST API endpoint
const TYPE_TO_ENDPOINT = {
  post: '/posts',
  page: '/pages',
  media: '/media',
};

export const CHANGES_TOOLS = [
  {
    name: 'wp_list_changes',
    description: 'List backed-up changes made via the WordPress MCP. Shows what was changed, when, and by whom. Each entry has a backup_id usable with wp_restore.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', enum: siteEnum, description: 'Filter by WordPress site' },
        object_type: { type: 'string', enum: ['post', 'page', 'media'], description: 'Filter by object type' },
        object_id: { type: 'number', description: 'Filter by specific object ID' },
        changed_by: { type: 'string', description: 'Filter by who made the change (email)' },
        start_date: { type: 'string', description: 'Filter from date (ISO 8601)' },
        end_date: { type: 'string', description: 'Filter to date (ISO 8601)' },
        limit: { type: 'number', description: 'Max results (default: 20, max: 200)' },
      },
    },
  },
  {
    name: 'wp_restore',
    description: 'Restore a WordPress object to a previous state using a backup ID from wp_list_changes. The current state is backed up first, making the restore itself reversible.',
    inputSchema: {
      type: 'object',
      properties: {
        backup_id: { type: 'number', description: 'Backup ID to restore from (from wp_list_changes)' },
      },
      required: ['backup_id'],
    },
  },
];

export async function handleListChanges(backupStore, args) {
  const backups = backupStore.listBackups({
    site: args.site,
    objectType: args.object_type,
    objectId: args.object_id,
    changedBy: args.changed_by,
    startDate: args.start_date,
    endDate: args.end_date,
    limit: args.limit || 20,
  });

  if (backups.length === 0) {
    return { count: 0, message: 'No changes found matching the filters.', changes: [] };
  }

  return {
    count: backups.length,
    changes: backups.map(b => ({
      backup_id: b.id,
      object_type: b.object_type,
      object_id: b.object_id,
      action: b.action,
      changed_by: b.changed_by,
      change_summary: b.change_summary,
      site: b.wp_site,
      created_at: b.created_at,
      restored: b.restored_at ? { at: b.restored_at, by: b.restored_by } : null,
    })),
  };
}

// Intentionally duplicated in posts.js and media.js to keep tool files self-contained
function requirePositiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

export async function handleRestore(client, backupStore, args, userEmail, site) {
  const backupId = requirePositiveInt(args.backup_id, 'backup_id');
  const backup = backupStore.getBackup(backupId);
  if (!backup) {
    throw new Error('Backup not found');
  }

  const objectType = backup.object_type;
  const objectId = backup.object_id;
  const endpoint = TYPE_TO_ENDPOINT[objectType];
  if (!endpoint) {
    throw new Error(`Cannot restore object type "${objectType}" — unsupported`);
  }

  // 1. Get current state (pre-restore backup)
  let current;
  try {
    current = await client.get(`${endpoint}/${objectId}?context=edit`);
  } catch (err) {
    // Object may have been permanently deleted
    if (err.message.includes('404')) {
      throw new Error(
        `Object ${objectType} #${objectId} no longer exists (may have been permanently deleted). ` +
        `Cannot restore via API — the object must be recreated manually.`
      );
    }
    throw err;
  }

  // 2. Back up current state before restoring
  const preRestoreBackupId = backupStore.createBackup({
    objectType,
    objectId,
    snapshot: current,
    action: 'pre-restore',
    changedBy: userEmail || 'unknown',
    changeSummary: `Pre-restore backup before restoring from backup #${args.backup_id}`,
    wpSite: backup.wp_site,
  });

  // 3. Filter snapshot to writable fields only
  const writableFields = WRITABLE_FIELDS[objectType] || [];
  const restoreBody = {};
  for (const key of writableFields) {
    const value = backup.snapshot[key];
    if (value !== undefined) {
      // Handle WP's { raw, rendered } format
      if (typeof value === 'object' && value !== null && 'raw' in value) {
        restoreBody[key] = value.raw;
      } else if (key === 'meta' && typeof value === 'object' && value !== null) {
        // Strip dangerous internal meta keys
        const safeMeta = { ...value };
        for (const blocked of BLOCKED_META_KEYS) {
          delete safeMeta[blocked];
        }
        restoreBody[key] = safeMeta;
      } else {
        restoreBody[key] = value;
      }
    }
  }

  // 4. Apply restore
  const restored = await client.post(`${endpoint}/${objectId}`, restoreBody);

  // 5. Mark original backup as restored
  backupStore.markRestored(args.backup_id, userEmail || 'unknown');

  return {
    restored_object_id: objectId,
    restored_object_type: objectType,
    from_backup_id: args.backup_id,
    pre_restore_backup_id: preRestoreBackupId,
    site: backup.wp_site,
    message: `Restored ${objectType} #${objectId} from backup #${args.backup_id}. ` +
             `Pre-restore backup: #${preRestoreBackupId} (use this to undo the restore)`,
  };
}
