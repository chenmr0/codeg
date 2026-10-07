/**
 * Database Migrations
 *
 * Schema versioning and migration support.
 */

import { SqliteDatabase } from './sqlite-adapter';

/**
 * Current schema version
 */
export const CURRENT_SCHEMA_VERSION = 9;

/**
 * Migration definition
 */
interface Migration {
  version: number;
  description: string;
  up: (db: SqliteDatabase) => void;
}

/**
 * All migrations in order
 *
 * Note: Version 1 is the initial schema, handled by schema.sql
 * Future migrations go here.
 */
const migrations: Migration[] = [
  {
    version: 2,
    description: 'Add project metadata, provenance tracking, and unresolved ref context',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        ALTER TABLE unresolved_refs ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE unresolved_refs ADD COLUMN language TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE edges ADD COLUMN provenance TEXT DEFAULT NULL;
        CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
        CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
      `);
    },
  },
  {
    version: 3,
    description: 'Add lower(name) expression index for memory-efficient case-insensitive lookups',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
      `);
    },
  },
  {
    version: 4,
    description:
      'Drop redundant idx_edges_source / idx_edges_target (covered by source_kind / target_kind composites)',
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_edges_source;
        DROP INDEX IF EXISTS idx_edges_target;
      `);
    },
  },
  {
    version: 5,
    description:
      'Add nodes.return_type — normalized return/result type for receiver-type inference (C++ singletons/factories, #645)',
    up: (db) => {
      db.exec(`
        ALTER TABLE nodes ADD COLUMN return_type TEXT;
      `);
    },
  },
  {
    version: 6,
    description:
      'Add nodes.is_declaration — mark C/C++ function prototypes (no body) so cDeclDefEdges can pair them with definitions without the buggy endLine>startLine heuristic (which misclassified multi-line prototypes as definitions)',
    up: (db) => {
      db.exec(`
        ALTER TABLE nodes ADD COLUMN is_declaration INTEGER DEFAULT 0;
      `);
    },
  },
  {
    version: 7,
    description:
      'Deduplicate identical edge rows and add a UNIQUE identity index so INSERT OR IGNORE prevents duplicates',
    up: (db) => {
      // Keep migration 6 above local to this fork: it owns is_declaration.
      // The community edge-identity migration is therefore intentionally
      // renumbered to 7 so existing fork databases do not skip it.
      db.exec(`
        DELETE FROM edges
        WHERE id NOT IN (
          SELECT MIN(id) FROM edges
          GROUP BY source, target, kind, IFNULL(line, -1), IFNULL(col, -1)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_identity
          ON edges(source, target, kind, IFNULL(line, -1), IFNULL(col, -1));
      `);
    },
  },
  {
    version: 8,
    description:
      'Keep attempted unresolved references so sync can retry them when matching symbols appear',
    up: (db) => {
      // ALTER TABLE has no IF NOT EXISTS. A database initialized from the
      // current schema can still have an older recorded version in migration
      // tests or after an interrupted upgrade, so guard both columns.
      const columns = db.prepare('PRAGMA table_info(unresolved_refs)').all() as Array<{
        name: string;
      }>;
      const hasColumn = (name: string) => columns.some((column) => column.name === name);
      if (!hasColumn('status')) {
        db.exec("ALTER TABLE unresolved_refs ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
      }
      if (!hasColumn('name_tail')) {
        db.exec("ALTER TABLE unresolved_refs ADD COLUMN name_tail TEXT NOT NULL DEFAULT ''");
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_unresolved_status ON unresolved_refs(status);
        CREATE INDEX IF NOT EXISTS idx_unresolved_failed_tail
          ON unresolved_refs(name_tail) WHERE status = 'failed';
      `);
    },
  },
  {
    version: 9,
    description: 'Persist ordinary-field evidence and index suppressed field references',
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(nodes)').all() as Array<{name:string}>;
      if (!columns.some(column => column.name === 'ordinary_field')) db.exec('ALTER TABLE nodes ADD COLUMN ordinary_field INTEGER');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_unresolved_suppressed_field_tail
          ON unresolved_refs(name_tail) WHERE status = 'suppressed_field';`);
    },
  },
];

/**
 * Get the current schema version from the database
 */
export function getCurrentVersion(db: SqliteDatabase): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as version FROM schema_versions')
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Record a migration as applied
 */
function recordMigration(db: SqliteDatabase, version: number, description: string): void {
  db.prepare(
    'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
  ).run(version, Date.now(), description);
}

/**
 * Run all pending migrations
 */
export function runMigrations(db: SqliteDatabase, fromVersion: number): void {
  const pending = migrations.filter((m) => m.version > fromVersion);

  if (pending.length === 0) {
    return;
  }

  // Sort by version
  pending.sort((a, b) => a.version - b.version);

  // Run each migration in a transaction
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      recordMigration(db, migration.version, migration.description);
    })();
  }
}

/**
 * Check if the database needs migration
 */
export function needsMigration(db: SqliteDatabase): boolean {
  const current = getCurrentVersion(db);
  return current < CURRENT_SCHEMA_VERSION;
}

/**
 * Get list of pending migrations
 */
export function getPendingMigrations(db: SqliteDatabase): Migration[] {
  const current = getCurrentVersion(db);
  return migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
}

/**
 * Get migration history from database
 */
export function getMigrationHistory(
  db: SqliteDatabase
): Array<{ version: number; appliedAt: number; description: string | null }> {
  const rows = db
    .prepare('SELECT version, applied_at, description FROM schema_versions ORDER BY version')
    .all() as Array<{ version: number; applied_at: number; description: string | null }>;

  return rows.map((row) => ({
    version: row.version,
    appliedAt: row.applied_at,
    description: row.description,
  }));
}
