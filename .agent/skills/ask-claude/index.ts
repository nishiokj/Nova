/**
 * Ask Claude Skill - Executes ask_claude script and chains a Read of the output.
 *
 * Chained execution:
 * - Bash: Run ask_claude with output redirection
 * - Read: Immediately read the output file
 * - Both in same response (no round trip)
 */

import type { StructuredOutputSchema } from 'types';

// ============================================
// TYPES
// ============================================

/**
 * Output from ask-claude execution.
 */
export interface AskClaudeOutput {
  query: string;
  outputFilePath: string;
  response: string;
  success: boolean;
  error?: string;
}

// ============================================
// SCHEMA
// ============================================

/**
 * Structured output schema for ask-claude results.
 */
export const ASK_CLAUDE_OUTPUT_SCHEMA: StructuredOutputSchema = {
  name: 'ask_claude_output',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The original query sent to Claude',
      },
      outputFilePath: {
        type: 'string',
        description: 'Path to the output file containing Claude\'s response',
      },
      response: {
        type: 'string',
        description: 'Claude\'s full response from the file',
      },
      success: {
        type: 'boolean',
        description: 'Whether the execution succeeded',
      },
      error: {
        type: 'string',
        description: 'Error message if execution failed',
      },
    },
    required: ['query', 'outputFilePath', 'response', 'success'],
    additionalProperties: false,
  },
};

// ============================================
// HELPERS
// ============================================

/**
 * Generate a unique output file path.
 */
export function generateOutputPath(): string {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000);
  return `/tmp/claude_output_${timestamp}_${random}.txt`;
}

/**
 * Build the bash command to execute ask_claude with output redirection.
 */
export function buildAskClaudeCommand(query: string, outputPath: string): string {
  // Escape the query for shell safety
  const escapedQuery = query.replace(/"/g, '\\"').replace(/\$/g, '\\$');
  return `./ask_claude "${escapedQuery}" > ${outputPath} 2>&1`;
}

/**
 * Format the agent objective with the user's query.
 */
export function formatObjective(query: string, outputPath: string): string {
  return `Execute the ask_claude script with the following query and immediately read the output file.

## Query
${query}

## Output File
${outputPath}

## Steps
1. Run: ./ask_claude "${query.replace(/"/g, '\\"')}" > ${outputPath}
2. Read: Read("${outputPath}")
3. Return Claude's response`;
}

// ============================================
// ASK CLAUDE AGENT CONFIG
// ============================================

/**
 * Ask Claude agent configuration.
 * Uses Bash and Read tools in a single iteration.
 */
export const ASK_CLAUDE_AGENT_CONFIG = {
  type: 'ask-claude',
  systemPrompt: `You are an execution agent that queries Claude and immediately reads the result.

## Your Task
1. Receive a query from the user
2. Generate a unique output file path
3. Execute the ask_claude script with output redirection
4. Immediately read the output file
5. Present Claude's response

## Critical: Chained Execution
- You MUST emit both Bash and Read in the SAME response
- Do not wait for Bash to complete before reading
- This enables single-round-trip execution

## Format
- Output file: /tmp/claude_output_<timestamp>_<random>.txt
- Script path: ./ask_claude (from project root)
- Command: ./ask_claude "{query}" > {outputPath}`,
  tools: ['bash', 'read'],
  budget: {
    maxIterations: 1,
    maxToolCalls: 2, // Bash + Read
    maxDurationMs: 30_000,
  },
  outputSchema: ASK_CLAUDE_OUTPUT_SCHEMA,
};

// ============================================
// THRESHOLDS
// ============================================

/**
 * Configuration limits for ask-claude skill.
 */
export const ASK_CLAUDE_THRESHOLDS = {
  /** Maximum query length */
  maxQueryLength: 10_000,
  /** Maximum file size for output (bytes) */
  maxOutputSize: 100_000,
  /** Script timeout (seconds) */
  scriptTimeout: 10,
};
