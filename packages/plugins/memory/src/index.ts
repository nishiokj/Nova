/**
 * Unified memory plugin facade.
 *
 * Provides a single install surface for:
 * - agent-memory (SyncClient + memory system exports)
 * - memory-injector
 * - entity-graph (including parser APIs used by the TUI)
 */

import postgres from 'postgres';
import { EntityGraph } from 'entity-graph';
import type { EntityGraphConfig } from 'entity-graph';

export * from 'agent-memory';

export { createMemoryInjector, detectQueryIntent } from 'memory-injector';
export type {
  MemoryInjector,
  InjectRecentParams,
  EvidenceInjectParams,
  EvidenceInjectResult,
  MemoryInjectorConfig,
  MemoryQueryStrategy,
  QueryIntent,
  QueryPlanSummary,
  InjectWatcherContextParams,
  WatcherContextResult,
} from 'memory-injector';

export {
  EntityGraph,
  initParser,
  isParserInitialized,
  languageForFile,
  createParser,
  parseSource,
} from 'entity-graph';
export type {
  Entity,
  Edge,
  ParseResult,
  EntityKind,
  EdgeType,
  EntityGraphConfig,
  EntityGraphHooks,
  EntityGraphHookResult,
  FileLease,
  BlastRadiusResult,
  GraphStats,
  BlastRadiusEntry,
  SupportedLanguage,
  Sql as EntityGraphSql,
} from 'entity-graph';

type PostgresFactory = (url: string, options: Record<string, unknown>) => unknown;
type EntityGraphSql = ConstructorParameters<typeof EntityGraph>[0];

export type CreateEntityGraphOptions = {
  databaseUrl: string;
  config: EntityGraphConfig;
  postgresOptions?: Record<string, unknown>;
  postgresFactory?: PostgresFactory;
};

const DEFAULT_POSTGRES_OPTIONS = {
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
};

/**
 * Build an EntityGraph instance with default postgres pool settings.
 */
export function createEntityGraph(options: CreateEntityGraphOptions): EntityGraph {
  const createPostgres = options.postgresFactory ?? (postgres as unknown as PostgresFactory);
  const sql = createPostgres(options.databaseUrl, {
    ...DEFAULT_POSTGRES_OPTIONS,
    ...(options.postgresOptions ?? {}),
  });
  return new EntityGraph(sql as EntityGraphSql, options.config);
}
