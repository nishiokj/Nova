/**
 * Built-in tools - Barrel export.
 */

// Bash
export { executeBash, bashToolOptions } from './bash.js';

// Read
export { executeRead, readToolOptions } from './read.js';

// Write & Edit
export {
  executeWrite,
  executeEdit,
  executeBatchEdit,
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
export { executeWebSearch, webSearchToolOptions } from './web_search.js';
export type { WebSearchArgs } from './web_search.js';

// WebFetch
export { executeWebFetch, webFetchToolOptions } from './web_fetch.js';
export type { WebFetchArgs } from './web_fetch.js';

// ExpandConversation
export { executeExpandConversation, expandConversationToolOptions } from './expand_conversation.js';
export type { ExpandConversationArgs } from './expand_conversation.js';

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
];
