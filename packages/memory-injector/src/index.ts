/**
 * Memory Injector
 *
 * Stateless retrieval layer that automatically injects relevant memory into agent context.
 * Uses existing coding_preferences and coding_decisions tables via their HTTP routes.
 *
 * @module memory-injector
 */

export { createMemoryInjector, detectQueryIntent } from './injector.js';
export type {
  MemoryInjector,
  InjectParams,
  InjectParamsV2,
  InjectResultV2,
  MemoryInjectorConfig,
  MemoryQueryStrategy,
  QueryIntent,
  QueryPlanSummary,
  InjectWatcherContextParams,
  WatcherContextResult,
} from './types.js';
