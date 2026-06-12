/**
 * Automatic database migration that runs at server startup.
 *
 * Goals:
 *  - Works on a brand-new Replit project (empty DB) → creates all tables.
 *  - Works on an existing DB → adds missing columns, fixes type mismatches.
 *  - 100% idempotent — safe to run on every startup.
 *  - Self-contained — no drizzle-kit, no tsx, no Python required at runtime.
 *
 * How to extend:
 *  - Add new tables to CREATE_TABLES.
 *  - Add missing columns to ADD_COLUMNS.
 *  - Add tricky type changes (e.g. text → boolean) to TYPE_FIXES.
 */

import { createHash } from "crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger";

// ─── Table definitions ────────────────────────────────────────────────────────
// Full CREATE TABLE IF NOT EXISTS statements — must match lib/db/src/schema/.

const CREATE_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS gateway_stats (
    id                  TEXT        PRIMARY KEY DEFAULT 'singleton',
    total_requests      INTEGER     NOT NULL DEFAULT 0,
    success_requests    INTEGER     NOT NULL DEFAULT 0,
    failed_requests     INTEGER     NOT NULL DEFAULT 0,
    total_response_time REAL        NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS request_logs (
    id            TEXT        PRIMARY KEY,
    success       BOOLEAN     NOT NULL,
    response_time INTEGER     NOT NULL DEFAULT 0,
    model         TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS api_keys (
    id            TEXT        PRIMARY KEY,
    name          TEXT        NOT NULL,
    key_hash      TEXT        NOT NULL,
    key_preview   TEXT        NOT NULL,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    request_count INTEGER     NOT NULL DEFAULT 0,
    last_used     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS chat_sessions (
    conversation_id TEXT        PRIMARY KEY,
    model           TEXT        NOT NULL,
    messages        JSONB       NOT NULL DEFAULT '[]',
    message_count   INTEGER     NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS gateway_config (
    key        TEXT        PRIMARY KEY,
    value      TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

// ─── Missing column additions ─────────────────────────────────────────────────
// For schema evolution: columns added after the initial deploy.
// Each entry runs: ALTER TABLE <table> ADD COLUMN IF NOT EXISTS <column> <definition>

interface ColumnAddition {
  table: string;
  column: string;
  definition: string;
}

const ADD_COLUMNS: ColumnAddition[] = [
  // Example for future schema additions:
  // { table: "request_logs", column: "input_tokens", definition: "INTEGER NOT NULL DEFAULT 0" },
];

// ─── Type-cast fixes ──────────────────────────────────────────────────────────
// PostgreSQL can't auto-cast between certain types (e.g. text → boolean).
// check()  → returns true if the column currently has the wrong type
// apply()  → runs the ALTER TABLE … USING cast to convert it

interface TypeFix {
  description: string;
  check: () => Promise<boolean>;
  apply: () => Promise<void>;
}

const TYPE_FIXES: TypeFix[] = [
  {
    description: "request_logs.success: text → boolean",
    async check() {
      const { rows } = await pool.query<{ data_type: string }>(`
        SELECT data_type
        FROM   information_schema.columns
        WHERE  table_name  = 'request_logs'
        AND    column_name = 'success'
      `);
      return rows[0]?.data_type === "text";
    },
    async apply() {
      await pool.query(`
        ALTER TABLE request_logs
          ALTER COLUMN success TYPE boolean
          USING CASE WHEN success = 'true' THEN TRUE ELSE FALSE END
      `);
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runMigrations(): Promise<void> {
  // 1. Create tables that don't exist yet (fresh DB or new tables added)
  for (const sql of CREATE_TABLES) {
    await pool.query(sql);
  }
  logger.info("DB migration: tables verified");

  // 2. Add missing columns (schema evolution after initial deploy)
  for (const { table, column, definition } of ADD_COLUMNS) {
    await pool.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`
    );
  }
  if (ADD_COLUMNS.length > 0) {
    logger.info({ count: ADD_COLUMNS.length }, "DB migration: columns added");
  }

  // 3. Apply type-cast fixes that drizzle-kit push cannot auto-handle
  let fixCount = 0;
  for (const fix of TYPE_FIXES) {
    const needed = await fix.check();
    if (needed) {
      logger.info({ fix: fix.description }, "DB migration: applying type fix");
      await fix.apply();
      fixCount++;
    }
  }
  if (fixCount > 0) {
    logger.info({ count: fixCount }, "DB migration: type fixes applied");
  }

  logger.info("DB migration: schema up-to-date ✓");

  // 4. Seed master API key from GATEWAY_MASTER_KEY env var (idempotent upsert).
  //    This ensures the key survives a fresh DB (new Replit project / deployment)
  //    as long as the env var is set. Safe to run on every startup.
  const masterKey = process.env["GATEWAY_MASTER_KEY"];
  if (masterKey) {
    const keyHash   = createHash("sha256").update(masterKey).digest("hex");
    const preview   = masterKey.length > 8
      ? masterKey.slice(0, 5) + "****" + masterKey.slice(-4)
      : masterKey;
    // Deterministic UUID derived from key hash so the row never duplicates
    const deterministicId = [
      keyHash.slice(0, 8),
      keyHash.slice(8, 12),
      "4" + keyHash.slice(13, 16),
      ((parseInt(keyHash[16], 16) & 0x3) | 0x8).toString(16) + keyHash.slice(17, 20),
      keyHash.slice(20, 32),
    ].join("-");

    await pool.query(`
      INSERT INTO api_keys (id, name, key_hash, key_preview, is_active, request_count, created_at)
      VALUES ($1, 'master-key (env)', $2, $3, TRUE, 0, NOW())
      ON CONFLICT (id) DO UPDATE
        SET key_hash   = EXCLUDED.key_hash,
            key_preview = EXCLUDED.key_preview,
            is_active  = TRUE
    `, [deterministicId, keyHash, preview]);

    logger.info({ preview }, "DB migration: GATEWAY_MASTER_KEY seeded ✓");
  }
}
