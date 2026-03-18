import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import type { Sql } from 'postgres'
import { SCHEMA_DDL as ENTITY_GRAPH_SCHEMA_DDL } from '../../../plugins/entity-graph/src/schema.js'

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function buildGraphDatabaseName(): string {
  return `metarepo_graph_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

export function deriveDatabaseUrl(adminDatabaseUrl: string, databaseName: string): string {
  const url = new URL(adminDatabaseUrl)
  url.pathname = `/${databaseName}`
  return url.toString()
}

const APP_SCHEMA_DDL = `
CREATE SCHEMA IF NOT EXISTS metarepo;

CREATE TABLE IF NOT EXISTS metarepo.repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('local', 'git')),
  root_path TEXT,
  clone_url TEXT,
  default_branch TEXT,
  auth_ref TEXT,
  registry_path TEXT,
  default_env_profile_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS metarepo_repos_local_root_path_key
  ON metarepo.repos(root_path)
  WHERE source_kind = 'local' AND root_path IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS metarepo_repos_git_clone_url_key
  ON metarepo.repos(clone_url)
  WHERE source_kind = 'git' AND clone_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS metarepo.runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES metarepo.repos(id) ON DELETE CASCADE,
  workflow TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  source_fingerprint_json JSONB NOT NULL,
  requested_by TEXT,
  error_message TEXT,
  graph_database_name TEXT,
  temp_root_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS metarepo_runs_repo_id_idx ON metarepo.runs(repo_id, created_at DESC);

CREATE TABLE IF NOT EXISTS metarepo.artifacts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES metarepo.repos(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES metarepo.runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  source_fingerprint_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS metarepo_artifacts_repo_id_idx ON metarepo.artifacts(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS metarepo_artifacts_run_id_idx ON metarepo.artifacts(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS metarepo_artifacts_kind_idx ON metarepo.artifacts(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS metarepo.event_ledger (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES metarepo.repos(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES metarepo.runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS metarepo_event_ledger_repo_id_idx ON metarepo.event_ledger(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS metarepo_event_ledger_run_id_idx ON metarepo.event_ledger(run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS metarepo.bugs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES metarepo.repos(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES metarepo.runs(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_fingerprint_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS metarepo_bugs_repo_id_idx ON metarepo.bugs(repo_id, created_at DESC);

CREATE TABLE IF NOT EXISTS metarepo.secret_refs (
  id TEXT PRIMARY KEY,
  repo_id TEXT REFERENCES metarepo.repos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  encrypted_payload TEXT,
  external_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metarepo.env_profiles (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES metarepo.repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  variables_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_bindings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS metarepo_env_profiles_repo_id_idx ON metarepo.env_profiles(repo_id, created_at DESC);
`

export class DatabaseManager {
  private appSql
  private initPromise: Promise<void> | null = null

  constructor(private databaseUrl: string) {
    this.appSql = postgres(this.databaseUrl, { max: 8, idle_timeout: 30, connect_timeout: 10 })
  }

  async ready(): Promise<void> {
    await this.initialize()
    await this.appSql`SELECT 1`
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.appSql.unsafe(APP_SCHEMA_DDL)
        .then(() => this.appSql.unsafe(ENTITY_GRAPH_SCHEMA_DDL))
        .then(() => undefined)
    }
    await this.initPromise
  }

  getAppSql(): Sql {
    return this.appSql as unknown as Sql
  }

  async createGraphDatabase(): Promise<{ databaseName: string; databaseUrl: string }> {
    await this.initialize()
    const databaseName = buildGraphDatabaseName()
    const sql = postgres(this.databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 })

    try {
      await sql.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
    } finally {
      await sql.end()
    }

    return {
      databaseName,
      databaseUrl: deriveDatabaseUrl(this.databaseUrl, databaseName),
    }
  }

  async initializeGraphDatabase(databaseUrl: string): Promise<void> {
    const sql = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 })
    try {
      await sql.unsafe(ENTITY_GRAPH_SCHEMA_DDL)
    } finally {
      await sql.end()
    }
  }

  async resetGraphDatabase(databaseUrl: string): Promise<void> {
    const sql = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 })
    try {
      await sql.unsafe('DROP SCHEMA IF EXISTS entity_graph CASCADE')
      await sql.unsafe(ENTITY_GRAPH_SCHEMA_DDL)
    } finally {
      await sql.end()
    }
  }

  async dropGraphDatabase(databaseName: string): Promise<void> {
    const sql = postgres(this.databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 })
    try {
      await sql`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${databaseName}
          AND pid <> pg_backend_pid()
      `
      await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`)
    } finally {
      await sql.end()
    }
  }

  async shutdown(): Promise<void> {
    await this.appSql.end()
  }
}
