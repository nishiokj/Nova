/**
 * Memory Injector
 *
 * Stateless retrieval layer that automatically injects relevant memory into agent context.
 * Uses existing coding_preferences and coding_decisions tables via their HTTP routes.
 *
 * @module memory-injector
 */

export { createMemoryInjector } from './injector.js';
export type { MemoryInjector, InjectParams, MemoryInjectorConfig } from './types.js';
