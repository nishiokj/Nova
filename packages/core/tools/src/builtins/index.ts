/**
 * Built-in tools - Barrel export.
 */

// Bash
export { executeBash, executeBashEffect, bashToolOptions } from './bash.js';

// Read
export { executeRead, executeReadEffect, readToolOptions } from './read.js';

// Write & Edit
export {
  executeWrite,
  executeWriteEffect,
  executeEdit,
  executeEditEffect,
  executeBatchEdit,
  executeBatchEditEffect,
  writeToolOptions,
  editToolOptions,
  batchEditToolOptions,
} from './write.js';

// Grep
export { executeGrep, grepToolOptions } from './grep.js';

// Glob
export { executeGlob, globToolOptions } from './glob.js';

// PromptUser
export { executePromptUser, promptUserToolOptions } from './prompt_user.js';
export type { PromptUserArgs, PromptUserOption, PromptUserQuestion } from './prompt_user.js';

// WebSearch
export { executeWebSearch, executeWebSearchEffect, webSearchToolOptions } from './web_search.js';
export type { WebSearchArgs } from './web_search.js';

// WebFetch
export { executeWebFetch, executeWebFetchEffect, webFetchToolOptions } from './web_fetch.js';
export type { WebFetchArgs } from './web_fetch.js';

// ExpandConversation
export { executeExpandConversation, expandConversationToolOptions } from './expand_conversation.js';
export type { ExpandConversationArgs } from './expand_conversation.js';

// apply_patch
export {
  executeApplyPatch,
  executeApplyPatchEffect,
  applyPatchToolOptions,
  parsePatch,
  applyPatchOperations,
  PatchParseError,
  PatchApplyError,
} from './apply_patch.js';
export type { PatchOperation, Hunk, HunkLine } from './apply_patch.js';

// Re-export all tool options for easy registration
import { bashToolOptions } from './bash.js';
import { readToolOptions } from './read.js';
import { writeToolOptions, editToolOptions, batchEditToolOptions } from './write.js';
import { grepToolOptions } from './grep.js';
import { globToolOptions } from './glob.js';
import { promptUserToolOptions } from './prompt_user.js';
import { webSearchToolOptions } from './web_search.js';
import { webFetchToolOptions } from './web_fetch.js';
import { expandConversationToolOptions } from './expand_conversation.js';
import { applyPatchToolOptions } from './apply_patch.js';

/**
 * All built-in tool options.
 */
export const builtinToolOptions = [
  bashToolOptions,
  readToolOptions,
  writeToolOptions,
  editToolOptions,
  batchEditToolOptions,
  grepToolOptions,
  globToolOptions,
  promptUserToolOptions,
  webSearchToolOptions,
  webFetchToolOptions,
  expandConversationToolOptions,
  applyPatchToolOptions,
];
