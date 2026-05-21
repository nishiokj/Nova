/**
 * Tools Module - Barrel Export
 *
 * Provides tool registry and built-in tools.
 */

// Types
export type {
  Tool,
  ToolExecutor,
  ToolExecutionContext,
  ToolExecutionError,
  ToolRegistrationOptions,
  CachedToolResult,
  CacheConfig,
  ToolRegistryConfig,
} from './types.js';

export {
  createTool,
  createExecutionContext,
  DEFAULT_CACHE_CONFIG,
  DEFAULT_TOOL_CONFIG,
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXCLUDE_EXTENSIONS,
  DANGEROUS_PATTERNS,
  toToolExecutionError,
  shouldSkipDir,
  shouldSkipFile,
  isDangerousCommand,
} from './types.js';

// Registry
export { ToolRegistry, type ToolExecuteOptions } from './registry.js';

export {
  executionerToolOptions,
  isExecutionerToolName,
  withExecutionerToolExecutors,
  type ExecutionerSubmitResult,
  type ExecutionerToolLogEvent,
  type ExecutionerToolLogger,
  type ExecutionerToolEnvironment,
  type ExecutionerToolEnvironmentProvider,
} from './executioner_tools.js';

// Tool argument schemas
export {
  TOOL_SCHEMAS,
  validateToolArgs,
  getToolSchema,
  BashArgsSchema,
  ReadArgsSchema,
  WriteArgsSchema,
  EditArgsSchema,
  GlobArgsSchema,
  GrepArgsSchema,
  PromptUserArgsSchema,
  ExpandConversationArgsSchema,
  WebSearchArgsSchema,
  type BashArgs,
  type ReadArgs,
  type WriteArgs,
  type EditArgs,
  type GlobArgs,
  type GrepArgs,
  type PromptUserArgs,
  type ExpandConversationArgs,
  type WebSearchArgs,
} from './tool_schemas.js';

// Built-in tools
export {
  executeBash,
  executeBashEffect,
  executeRead,
  executeReadEffect,
  executeWrite,
  executeWriteEffect,
  executeEdit,
  executeEditEffect,
  executeBatchEditEffect,
  executeGrep,
  executeGlob,
  executePromptUser,
  executeExpandConversation,
  executeWebSearch,
  executeWebSearchEffect,
  executeWebFetch,
  executeWebFetchEffect,
  bashToolOptions,
  readToolOptions,
  writeToolOptions,
  editToolOptions,
  grepToolOptions,
  globToolOptions,
  promptUserToolOptions,
  webSearchToolOptions,
  webFetchToolOptions,
  expandConversationToolOptions,
  builtinToolOptions,
} from './builtins/index.js';

// Convenience function to create a registry with all builtins
import { ToolRegistry } from './registry.js';
import { builtinToolOptions } from './builtins/index.js';
import type { ToolRegistryConfig } from './types.js';

/**
 * Create a tool registry with all built-in tools registered.
 */
export function createToolRegistry(
  config?: Partial<ToolRegistryConfig>,
  defaultWorkingDir?: string
): ToolRegistry {
  const registry = new ToolRegistry(config, defaultWorkingDir);

  for (const options of builtinToolOptions) {
    registry.register(options);
  }

  return registry;
}
