/**
 * SQLite-backed backup store for the backup-before-change pattern.
 *
 * Every mutating operation snapshots the current state before applying changes.
 * Backups are queryable and restorable via MCP tools.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const DEFAULT_DB_PATH = process.env.WP_BACKUP_DB_PATH || './data/wp-backups.db';
// Keep backups for 90 days by default; configurable via env
const RETENTION_DAYS = parseInt(process.env.WP_BACKUP_RETENTION_DAYS || '90', 10);
// Maximum number of backups to keep (hard cap)
const MAX_BACKUPS = parseInt(process.env.WP_BACKUP_MAX_COUNT || '10000', 10);

export class BackupStore {
  constructor(dbPath = DEFAULT_DB_PATH) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._migrate();
    this._pruneOldBackups();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_type TEXT NOT NULL,
        object_id INTEGER NOT NULL,
        snapshot JSON NOT NULL,
        action TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        change_summary TEXT,
        wp_site TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        restored_at TEXT,
        restored_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_backups_site_type_id
        ON backups(wp_site, object_type, object_id);
      CREATE INDEX IF NOT EXISTS idx_backups_changed_by
        ON backups(changed_by);
      CREATE INDEX IF NOT EXISTS idx_backups_created_at
        ON backups(created_at);
    `);
  }

  /**
   * Remove backups older than RETENTION_DAYS and enforce MAX_BACKUPS cap.
   * Called on startup and periodically via checkpoint().
   */
  _pruneOldBackups() {
    // Delete by age
    this.db.prepare(
      `DELETE FROM backups WHERE created_at < datetime('now', '-' || ? || ' days')`
    ).run(RETENTION_DAYS);

    // Enforce hard count cap — keep newest MAX_BACKUPS rows
    this.db.prepare(
      `DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT ?)`
    ).run(MAX_BACKUPS);
  }

  /**
   * Checkpoint WAL and prune old backups. Call periodically for long-running processes.
   */
  checkpoint() {
    this._pruneOldBackups();
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /**
   * Store a snapshot before mutation.
   * @returns {number} Backup ID
   */
  createBackup({ objectType, objectId, snapshot, action, changedBy, changeSummary, wpSite }) {
    const stmt = this.db.prepare(`
      INSERT INTO backups (object_type, object_id, snapshot, action, changed_by, change_summary, wp_site)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      objectType,
      objectId,
      JSON.stringify(snapshot),
      action,
      changedBy,
      changeSummary || null,
      wpSite
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Get a backup by ID.
   * @param {number} id
   * @returns {object|null}
   */
  getBackup(id) {
    const row = this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, snapshot: JSON.parse(row.snapshot) };
  }

  /**
   * List backups with filters.
   * @param {object} filters
   * @returns {object[]}
   */
  listBackups({ site, objectType, objectId, changedBy, startDate, endDate, limit = 50 } = {}) {
    const conditions = [];
    const params = [];

    if (site) {
      conditions.push('wp_site = ?');
      params.push(site);
    }
    if (objectType) {
      conditions.push('object_type = ?');
      params.push(objectType);
    }
    if (objectId) {
      conditions.push('object_id = ?');
      params.push(objectId);
    }
    if (changedBy) {
      conditions.push('changed_by = ?');
      params.push(changedBy);
    }
    if (startDate) {
      conditions.push('created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('created_at <= ?');
      params.push(endDate);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.max(1, Math.min(limit, 200)));

    const rows = this.db.prepare(
      `SELECT id, object_type, object_id, action, changed_by, change_summary, wp_site, created_at, restored_at, restored_by
       FROM backups ${where}
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(...params);

    return rows;
  }

  /**
   * Mark a backup as restored.
   * @param {number} id
   * @param {string} restoredBy
   */
  markRestored(id, restoredBy) {
    this.db.prepare(
      `UPDATE backups SET restored_at = datetime('now'), restored_by = ? WHERE id = ?`
    ).run(restoredBy, id);
  }

  /**
   * Close the database connection cleanly (flushes WAL).
   */
  close() {
    this.db.close();
  }
}
