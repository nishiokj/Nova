/**
 * Entity Graph Schema
 *
 * DDL for the entity_graph Postgres schema. Idempotent — uses IF NOT EXISTS
 * throughout since this is a derived cache that can be rebuilt from source.
 */

export const SCHEMA_DDL = `
-- Isolated schema for entity graph (separate from agent-memory)
CREATE SCHEMA IF NOT EXISTS entity_graph;

-- Core entity table
CREATE TABLE IF NOT EXISTS entity_graph.entities (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  filepath    TEXT NOT NULL,
  start_line  INTEGER,
  end_line    INTEGER,
  exported    BOOLEAN NOT NULL DEFAULT FALSE,
  async       BOOLEAN NOT NULL DEFAULT FALSE,
  raw_text    TEXT,
  params_text TEXT,
  return_text TEXT
);

-- Relationship tables (one per edge type, composite PKs)

CREATE TABLE IF NOT EXISTS entity_graph.imports (
  importer_id TEXT NOT NULL,
  imported_id TEXT NOT NULL,
  symbol      TEXT,
  PRIMARY KEY (importer_id, imported_id)
);

CREATE TABLE IF NOT EXISTS entity_graph.calls (
  caller_id   TEXT NOT NULL,
  callee_id   TEXT NOT NULL,
  site_line   INTEGER,
  PRIMARY KEY (caller_id, callee_id)
);

CREATE TABLE IF NOT EXISTS entity_graph.uses (
  user_id     TEXT NOT NULL,
  used_id     TEXT NOT NULL,
  PRIMARY KEY (user_id, used_id)
);

CREATE TABLE IF NOT EXISTS entity_graph.owns (
  owner_id    TEXT NOT NULL,
  owned_id    TEXT NOT NULL,
  PRIMARY KEY (owner_id, owned_id)
);

CREATE TABLE IF NOT EXISTS entity_graph.extends (
  child_id    TEXT NOT NULL,
  parent_id   TEXT NOT NULL,
  PRIMARY KEY (child_id, parent_id)
);

CREATE TABLE IF NOT EXISTS entity_graph.implements (
  implementor_id TEXT NOT NULL,
  interface_id   TEXT NOT NULL,
  PRIMARY KEY (implementor_id, interface_id)
);

-- File leases for multi-agent coordination
CREATE TABLE IF NOT EXISTS entity_graph.file_leases (
  filepath    TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Indexes on entity lookup
CREATE INDEX IF NOT EXISTS idx_eg_entities_filepath ON entity_graph.entities(filepath);
CREATE INDEX IF NOT EXISTS idx_eg_entities_kind     ON entity_graph.entities(kind);

-- Indexes on both sides of every relationship
CREATE INDEX IF NOT EXISTS idx_eg_imports_importer    ON entity_graph.imports(importer_id);
CREATE INDEX IF NOT EXISTS idx_eg_imports_imported    ON entity_graph.imports(imported_id);
CREATE INDEX IF NOT EXISTS idx_eg_calls_caller        ON entity_graph.calls(caller_id);
CREATE INDEX IF NOT EXISTS idx_eg_calls_callee        ON entity_graph.calls(callee_id);
CREATE INDEX IF NOT EXISTS idx_eg_uses_user           ON entity_graph.uses(user_id);
CREATE INDEX IF NOT EXISTS idx_eg_uses_used           ON entity_graph.uses(used_id);
CREATE INDEX IF NOT EXISTS idx_eg_owns_owner          ON entity_graph.owns(owner_id);
CREATE INDEX IF NOT EXISTS idx_eg_owns_owned          ON entity_graph.owns(owned_id);
CREATE INDEX IF NOT EXISTS idx_eg_extends_child       ON entity_graph.extends(child_id);
CREATE INDEX IF NOT EXISTS idx_eg_extends_parent      ON entity_graph.extends(parent_id);
CREATE INDEX IF NOT EXISTS idx_eg_implements_impl     ON entity_graph.implements(implementor_id);
CREATE INDEX IF NOT EXISTS idx_eg_implements_iface    ON entity_graph.implements(interface_id);

-- Lease expiry index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_eg_file_leases_expires ON entity_graph.file_leases(expires_at);

-- Test health: env var reads detected in source code
CREATE TABLE IF NOT EXISTS entity_graph.env_reads (
  id          SERIAL PRIMARY KEY,
  entity_id   TEXT NOT NULL,
  var_name    TEXT NOT NULL,
  filepath    TEXT NOT NULL,
  line        INTEGER,
  accessor    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eg_env_reads_entity ON entity_graph.env_reads(entity_id);
CREATE INDEX IF NOT EXISTS idx_eg_env_reads_var    ON entity_graph.env_reads(var_name);

-- Test health: constructor parameter dependencies
CREATE TABLE IF NOT EXISTS entity_graph.constructor_deps (
  id          SERIAL PRIMARY KEY,
  class_id    TEXT NOT NULL,
  param_name  TEXT NOT NULL,
  param_type  TEXT,
  position    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eg_ctor_deps_class ON entity_graph.constructor_deps(class_id);

-- Test health: function/method parameter dependencies
CREATE TABLE IF NOT EXISTS entity_graph.function_deps (
  id          SERIAL PRIMARY KEY,
  function_id TEXT NOT NULL,
  param_name  TEXT NOT NULL,
  param_type  TEXT,
  position    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eg_fn_deps_function ON entity_graph.function_deps(function_id);

-- Persisted test-block facts for skeptic/test-health dossier construction
CREATE TABLE IF NOT EXISTS entity_graph.test_cases (
  id          TEXT PRIMARY KEY,
  filepath    TEXT NOT NULL,
  name        TEXT NOT NULL,
  line_start  INTEGER NOT NULL,
  line_end    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eg_test_cases_filepath ON entity_graph.test_cases(filepath);

CREATE TABLE IF NOT EXISTS entity_graph.test_case_imports (
  test_case_id   TEXT NOT NULL,
  local_name     TEXT NOT NULL,
  imported_name  TEXT NOT NULL,
  resolved_path  TEXT,
  is_prod        BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (test_case_id, local_name, imported_name)
);
CREATE INDEX IF NOT EXISTS idx_eg_test_case_imports_case ON entity_graph.test_case_imports(test_case_id);
CREATE INDEX IF NOT EXISTS idx_eg_test_case_imports_path ON entity_graph.test_case_imports(resolved_path);

CREATE TABLE IF NOT EXISTS entity_graph.test_case_calls (
  id            SERIAL PRIMARY KEY,
  test_case_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  resolved_path TEXT,
  line          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eg_test_case_calls_case ON entity_graph.test_case_calls(test_case_id);
CREATE INDEX IF NOT EXISTS idx_eg_test_case_calls_path ON entity_graph.test_case_calls(resolved_path);

CREATE TABLE IF NOT EXISTS entity_graph.test_case_assertions (
  id            SERIAL PRIMARY KEY,
  test_case_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  target_symbol TEXT,
  resolved_path TEXT,
  line          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eg_test_case_assertions_case ON entity_graph.test_case_assertions(test_case_id);

CREATE TABLE IF NOT EXISTS entity_graph.test_case_mocks (
  id            SERIAL PRIMARY KEY,
  test_case_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  api           TEXT NOT NULL,
  target        TEXT,
  line          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eg_test_case_mocks_case ON entity_graph.test_case_mocks(test_case_id);

CREATE TABLE IF NOT EXISTS entity_graph.test_case_seam_overrides (
  id            SERIAL PRIMARY KEY,
  test_case_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  target        TEXT NOT NULL,
  line          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eg_test_case_seams_case ON entity_graph.test_case_seam_overrides(test_case_id);
`
