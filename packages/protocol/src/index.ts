/**
 * Protocol - Types and Schemas for Orchestrator State
 *
 * This package provides:
 * - Discriminated unions for all state, events, decisions, and effects
 * - Hook interfaces and policy contracts
 * - Patch definitions for single-writer mutation
 * - Policy-driven failure handling
 *
 * Key Principles:
 * 1. Discriminated unions everywhere - exhaustive handling enforced by TypeScript
 * 2. Orchestrator is the only state owner and executor
 * 3. Hooks declare outcomes; orchestrator enforces execution semantics
 */

// Domain layer - core types
export * from './domain/index.js';

// Control layer - decisions, gates
export * from './control/index.js';

// Effects layer - patches, commands
export * from './effects/index.js';

// Hooks layer - outcome, policy, types
export * from './hooks/index.js';

// Protocol layer - schemas, prompts, version
export * from './protocol/index.js';

// Exhaustiveness helper
export * from './assertNever.js';
