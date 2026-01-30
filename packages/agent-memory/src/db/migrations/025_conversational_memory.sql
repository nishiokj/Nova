-- Conversational Memory Tables
-- Adds projects, goals, conversation digests, and entity mentions

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  CONSTRAINT projects_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'abandoned')),
  repo_url TEXT,
  parent_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_count INTEGER NOT NULL DEFAULT 0,
  last_discussed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  CONSTRAINT goals_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'failed', 'abandoned')),
  parent_goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  progress_notes TEXT[] NOT NULL DEFAULT '{}',
  target_date TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  conversation_count INTEGER NOT NULL DEFAULT 0,
  last_discussed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_digests (
  id TEXT PRIMARY KEY,
  CONSTRAINT conversation_digests_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  conversation_id TEXT NOT NULL REFERENCES canonical_conversation(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcome TEXT CHECK (outcome IN ('resolved', 'ongoing', 'blocked', 'abandoned')),
  processor_version TEXT NOT NULL,
  model_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS entity_mentions (
  id TEXT PRIMARY KEY,
  CONSTRAINT entity_mentions_id_ulid CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  conversation_id TEXT NOT NULL REFERENCES canonical_conversation(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('project', 'goal', 'person', 'issue', 'concept')),
  entity_id TEXT,
  surface_form TEXT NOT NULL,
  message_ids TEXT[] NOT NULL DEFAULT '{}',
  confidence FLOAT NOT NULL DEFAULT 0,
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT entity_mentions_entity_id_check CHECK (
    (entity_type = 'concept' AND entity_id IS NULL)
    OR (entity_type <> 'concept' AND entity_id IS NOT NULL)
  )
);

-- Indexes: projects/goals
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_project_id) WHERE parent_project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_last_discussed ON projects(last_discussed_at) WHERE last_discussed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_goals_title ON goals(title);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_goal_id) WHERE parent_goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_goals_target_date ON goals(target_date) WHERE target_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_goals_last_discussed ON goals(last_discussed_at) WHERE last_discussed_at IS NOT NULL;

-- Indexes: conversation digests
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_digests_conversation_id ON conversation_digests(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_digests_created ON conversation_digests(created_at DESC);

-- Indexes: entity mentions
CREATE INDEX IF NOT EXISTS idx_entity_mentions_conversation_id ON entity_mentions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_created ON entity_mentions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_embedding ON entity_mentions USING hnsw (embedding vector_cosine_ops);
