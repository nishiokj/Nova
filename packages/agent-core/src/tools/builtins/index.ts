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

// Re-export all tool options for easy registration
import { bashToolOptions } from './bash.js';
import { readToolOptions } from './read.js';
import { writeToolOptions, editToolOptions, batchEditToolOptions } from './write.js';
import { grepToolOptions } from './grep.js';
import { globToolOptions } from './glob.js';

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
];
