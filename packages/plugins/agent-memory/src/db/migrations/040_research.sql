-- Deep Research: tree-structured research pipeline
-- Projects contain a tree of nodes, each with sources and extracted claims.

-- Research projects (top-level)
CREATE TABLE research_projects (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  seed_query      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'complete')),
  depth_budget    INTEGER NOT NULL DEFAULT 3,
  max_sources_per_node INTEGER NOT NULL DEFAULT 8,
  output_path     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_research_projects_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_research_projects_updated_at
  BEFORE UPDATE ON research_projects
  FOR EACH ROW EXECUTE FUNCTION update_research_projects_updated_at();

-- Research nodes (tree structure)
CREATE TABLE research_nodes (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  parent_id       TEXT REFERENCES research_nodes(id) ON DELETE SET NULL,
  depth           INTEGER NOT NULL DEFAULT 0,
  query           TEXT NOT NULL,
  query_type      TEXT
    CHECK (query_type IS NULL OR query_type IN (
      'definitional', 'mechanistic', 'comparative', 'causal', 'critical'
    )),
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'collecting', 'reducing', 'synthesizing', 'scored', 'terminal'
    )),
  -- Synthesis output
  synthesis       TEXT,
  significance    TEXT,
  first_principles JSONB,
  gaps            JSONB,
  -- Scoring
  priority_score  REAL,
  novelty_score   REAL,
  gap_density     REAL,
  -- Metadata
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_research_nodes_project ON research_nodes (project_id, depth);
CREATE INDEX idx_research_nodes_parent ON research_nodes (parent_id);
CREATE INDEX idx_research_nodes_priority ON research_nodes (project_id, priority_score DESC NULLS LAST)
  WHERE status = 'scored';

CREATE OR REPLACE FUNCTION update_research_nodes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_research_nodes_updated_at
  BEFORE UPDATE ON research_nodes
  FOR EACH ROW EXECUTE FUNCTION update_research_nodes_updated_at();

-- Sources collected per node
CREATE TABLE research_sources (
  id              TEXT PRIMARY KEY,
  node_id         TEXT NOT NULL REFERENCES research_nodes(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  title           TEXT,
  domain          TEXT,
  raw_content     TEXT,
  extracted_content TEXT,
  quality_score   REAL,
  fetch_date      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_research_sources_node ON research_sources (node_id);

-- Claims extracted from sources
CREATE TABLE research_claims (
  id              TEXT PRIMARY KEY,
  node_id         TEXT NOT NULL REFERENCES research_nodes(id) ON DELETE CASCADE,
  source_id       TEXT REFERENCES research_sources(id) ON DELETE SET NULL,
  claim_text      TEXT NOT NULL,
  evidence_text   TEXT,
  confidence      TEXT NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('high', 'medium', 'low')),
  volatility      TEXT NOT NULL DEFAULT 'moderate'
    CHECK (volatility IN ('stable', 'moderate', 'volatile')),
  -- Staleness tracking
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status          TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'contradicted', 'retracted')),
  superseded_by   TEXT REFERENCES research_claims(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_research_claims_node ON research_claims (node_id);
CREATE INDEX idx_research_claims_stale ON research_claims (volatility, last_verified_at)
  WHERE status = 'active';
