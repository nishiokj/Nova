#!/usr/bin/env node

/**
 * End-to-end test for LM Studio inference.
 *
 * This test:
 * 1. Imports the LLM adapter
 * 2. Uses system prompts for standard and agent types
 * 3. Uses actual response schemas from packages/core/shared/src/output_schemas.ts:
 *    - AgentActionOutputSchema: { action, response, goalStateReached, handoffSpec }
 *    - GoalDrivenOutputSchema: extends AgentActionOutput with { work_done }
 *    - ExplorerOutputSchema: extends AgentActionOutput with { packageManagers, frameworks, languages, os, artifacts }
 *    - RuntimeScriptOutputSchema: extends AgentActionOutput with { goal, workItems }
 * 4. Tests tool calls with proper tool definitions
 * 5. Hardcodes necessary data
 * 6. Queries the LM Studio development server (http://localhost:1234/v1)
 * 7. Logs results to console and file
 */

import { createAdapter } from './dist/adapter.js';

// Hardcode the standard prompt inline to avoid import issues
const STANDARD_PROMPT = `You are an execution agent. Reduce the delta between current state and goal state while keeping the user informed.

## Core Principles

1. **Be talkative** - Emit text alongside tool calls. Update the user as you work.
2. **Batch tool calls** - Multiple independent operations in ONE response.
3. **Explorer before Read** - Don't know which files? Ask Explorer. Have a specific path? Read it.
4. **Finish fast** - Each iteration costs time and resources. Minimize loops.

## Tool Selection

- **Explorer**: "How does auth work?" / "Where is the config?" → Explorer handles discovery
- **Read**: You have \`src/auth.ts\` and need the content → Read that file

Never read files one-by-one to "explore". That's what Explorer is for.

## Completion

**Set \`goalStateReached: true\` when done.** Failure causes infinite loops.

- Task fulfilled → \`goalStateReached: true\`
- Need user input → \`PromptUser\` tool or \`awaitingUserInput: true\`
- More work genuinely needed → \`action: "continue"\` (use sparingly)

Don't gold-plate. Don't explore tangent files. Don't add unrequested features.`;

// ============================================
// CONFIGURATION
// ============================================

const LMSTUDIO_BASE_URL = 'http://localhost:1234/v1';
const TEST_MODEL = 'zai-org/glm-4.7-flash';
const LOG_FILE = '/tmp/lmstudio_test.log';

// Custom logger that writes to both console and file
const testLogger = {
  debug: (msg, meta) => {
    const logLine = `[DEBUG] ${msg} ${meta ? JSON.stringify(meta) : ''}`;
    console.debug(logLine);
  },
  info: (msg, meta) => {
    const logLine = `[INFO] ${msg} ${meta ? JSON.stringify(meta) : ''}`;
    console.info(logLine);
  },
  warn: (msg, meta) => {
    const logLine = `[WARN] ${msg} ${meta ? JSON.stringify(meta) : ''}`;
    console.warn(logLine);
  },
  error: (msg, meta) => {
    const logLine = `[ERROR] ${msg} ${meta ? JSON.stringify(meta) : ''}`;
    console.error(logLine);
  },
};

// ============================================
// TEST CASES
// ============================================

/**
 * Test 1: Simple query with standard system prompt
 */
async function testSimpleQuery() {
  console.log('\n========================================');
  console.log('TEST 1: Simple query with standard prompt');
  console.log('========================================\n');

  testLogger.info('Creating adapter', { baseUrl: LMSTUDIO_BASE_URL });

  const adapter = createAdapter(
    {
      baseUrls: {
        'openai-compat': LMSTUDIO_BASE_URL,
      },
    },
    testLogger
  );

  // Using actual GoalDrivenOutputSchema from output_schemas.ts
  const request = {
    llm: {
      provider: 'openai-compat',
      displayProvider: 'lmstudio',
      model: TEST_MODEL,
      baseUrl: LMSTUDIO_BASE_URL,
    },
    messages: [
      { role: 'user', content: 'What is 2 + 2? Answer with just the number.' },
    ],
    system: 'You are a helpful assistant.',
    maxTokens: 100,
    responseSchema: {
      name: 'goal_driven',
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['done', 'continue', 'handoff']
          },
          response: { type: 'string', nullable: true },
          goalStateReached: { type: 'boolean', nullable: true },
          handoffSpec: { type: 'object', nullable: true },
          work_done: { type: 'string', nullable: true }
        }
      },
      strict: false,
    },
  };

  testLogger.info('Sending request', {
    provider: request.llm.provider,
    model: request.llm.model,
    messageCount: request.messages.length,
  });

  try {
    const response = await adapter.respond(request);

    testLogger.info('Response received', {
      content: response.content,
      usage: response.usage,
      durationMs: response.durationMs,
      model: response.model,
      stopReason: response.stopReason,
    });

    console.log('✓ Test 1 PASSED');
    console.log(`  Content: ${response.content}`);
    console.log(`  Usage: ${JSON.stringify(response.usage)}`);
    console.log(`  Duration: ${response.durationMs}ms`);

    return { success: true, response };
  } catch (error) {
    testLogger.error('Test 1 FAILED', { error: error.message });
    console.error('✗ Test 1 FAILED:', error.message);
    return { success: false, error };
  }
}

/**
 * Test 2: Query with full standard agent prompt
 */
async function testStandardAgentPrompt() {
  console.log('\n========================================');
  console.log('TEST 2: Query with standard agent prompt');
  console.log('========================================\n');

  const adapter = createAdapter(
    {
      baseUrls: {
        'openai-compat': LMSTUDIO_BASE_URL,
      },
    },
    testLogger
  );

  // Using the full STANDARD_PROMPT from prompts.ts with actual GoalDrivenOutputSchema
  const request = {
    llm: {
      provider: 'openai-compat',
      displayProvider: 'lmstudio',
      model: TEST_MODEL,
      baseUrl: LMSTUDIO_BASE_URL,
    },
    messages: [
      {
        role: 'user',
        content: 'Hello! Can you briefly introduce yourself in one sentence?',
      },
    ],
    system: STANDARD_PROMPT,
    maxTokens: 500,
    temperature: 0.7,
    responseSchema: {
      name: 'goal_driven',
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['done', 'continue', 'handoff']
          },
          response: { type: 'string', nullable: true },
          goalStateReached: { type: 'boolean', nullable: true },
          handoffSpec: { type: 'object', nullable: true },
          work_done: { type: 'string', nullable: true }
        }
      },
      strict: false,
    },
  };

  testLogger.info('Sending request with standard agent prompt', {
    systemPromptLength: request.system.length,
    provider: request.llm.provider,
    model: request.llm.model,
  });

  try {
    const response = await adapter.respond(request);

    testLogger.info('Response received', {
      contentLength: response.content.length,
      usage: response.usage,
      durationMs: response.durationMs,
    });

    console.log('✓ Test 2 PASSED');
    console.log(`  Content: ${response.content.substring(0, 200)}...`);
    console.log(`  Content Length: ${response.content.length} chars`);
    console.log(`  Usage: ${JSON.stringify(response.usage)}`);
    console.log(`  Duration: ${response.durationMs}ms`);

    return { success: true, response };
  } catch (error) {
    testLogger.error('Test 2 FAILED', { error: error.message });
    console.error('✗ Test 2 FAILED:', error.message);
    return { success: false, error };
  }
}

/**
 * Test 3: Multi-turn conversation
 */
async function testMultiTurnConversation() {
  console.log('\n========================================');
  console.log('TEST 3: Multi-turn conversation');
  console.log('========================================\n');

  const adapter = createAdapter(
    {
      baseUrls: {
        'openai-compat': LMSTUDIO_BASE_URL,
      },
    },
    testLogger
  );

  const messages = [
    { role: 'user', content: 'I have 3 apples.' },
    { role: 'assistant', content: 'Okay, you have 3 apples.' },
    { role: 'user', content: 'I buy 2 more apples. How many do I have now?' },
  ];

  const request = {
    llm: {
      provider: 'openai-compat',
      displayProvider: 'lmstudio',
      model: TEST_MODEL,
      baseUrl: LMSTUDIO_BASE_URL,
    },
    messages,
    system: 'You are a helpful math assistant.',
    maxTokens: 100,
    responseSchema: {
      name: 'goal_driven',
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['done', 'continue', 'handoff']
          },
          response: { type: 'string', nullable: true },
          goalStateReached: { type: 'boolean', nullable: true },
          handoffSpec: { type: 'object', nullable: true },
          work_done: { type: 'string', nullable: true }
        }
      },
      strict: false,
    },
  };

  testLogger.info('Sending multi-turn request', { messageCount: messages.length });

  try {
    const response = await adapter.respond(request);

    testLogger.info('Response received', {
      content: response.content,
      usage: response.usage,
    });

    console.log('✓ Test 3 PASSED');
    console.log(`  Response: ${response.content}`);
    console.log(`  Usage: ${JSON.stringify(response.usage)}`);

    return { success: true, response };
  } catch (error) {
    testLogger.error('Test 3 FAILED', { error: error.message });
    console.error('✗ Test 3 FAILED:', error.message);
    return { success: false, error };
  }
}

/**
 * Test 4: Explorer agent output schema
 */
async function testExplorerSchema() {
  console.log('\n========================================');
  console.log('TEST 4: Explorer agent output schema');
  console.log('========================================\n');

  const adapter = createAdapter(
    {
      baseUrls: {
        'openai-compat': LMSTUDIO_BASE_URL,
      },
    },
    testLogger
  );

  // Using actual ExplorerOutputSchema from output_schemas.ts
  const request = {
    llm: {
      provider: 'openai-compat',
      displayProvider: 'lmstudio',
      model: TEST_MODEL,
      baseUrl: LMSTUDIO_BASE_URL,
    },
    messages: [
      {
        role: 'user',
        content: 'Analyze this simple codebase and return one artifact: function "main" at line 10.',
      },
    ],
    system: 'You are a codebase exploration agent. Extract artifacts from files.',
    maxTokens: 200,
    responseSchema: {
      name: 'explorer',
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['done', 'continue', 'handoff']
          },
          response: { type: 'string', nullable: true },
          goalStateReached: { type: 'boolean', nullable: true },
          handoffSpec: { type: 'object', nullable: true },
          packageManagers: { type: 'array', items: { type: 'string' } },
          frameworks: { type: 'array', items: { type: 'string' } },
          languages: { type: 'array', items: { type: 'string' } },
          os: { type: 'string' },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sourcePath: { type: 'string' },
                line: { type: 'number', nullable: true },
                kind: {
                  type: 'string',
                  enum: ['function', 'class', 'interface', 'import', 'export', 'constant', 'pattern', 'summary']
                },
                name: { type: 'string' },
                signature: { type: 'string', nullable: true },
                modifies: { type: 'array', items: { type: 'string' }, nullable: true },
                calls: { type: 'array', items: { type: 'string' }, nullable: true },
                insight: { type: 'string', nullable: true },
                reduces: {
                  type: 'string',
                  enum: ['structural', 'relational', 'behavioral', 'contractual'],
                  nullable: true
                }
              }
            }
          }
        }
      },
      strict: false,
    },
  };

  testLogger.info('Sending explorer request', { schemaName: 'explorer' });

  try {
    const response = await adapter.respond(request);

    testLogger.info('Response received', {
      contentLength: response.content.length,
      usage: response.usage,
    });

    console.log('✓ Test 4 PASSED');
    console.log(`  Content: ${response.content.substring(0, 200)}...`);
    console.log(`  Usage: ${JSON.stringify(response.usage)}`);

    return { success: true, response };
  } catch (error) {
    testLogger.error('Test 4 FAILED', { error: error.message });
    console.error('✗ Test 4 FAILED:', error.message);
    return { success: false, error };
  }
}

/**
 * Test 5: Test with tools
 */
async function testWithTools() {
  console.log('\n========================================');
  console.log('TEST 5: Request with tools');
  console.log('========================================\n');

  const adapter = createAdapter(
    {
      baseUrls: {
        'openai-compat': LMSTUDIO_BASE_URL,
      },
    },
    testLogger
  );

  // Actual tool definitions from packages/core/tools/src/tool_schemas.ts
  // Converted from Zod schemas to JSON Schema format
  const tools = [
    {
      name: 'Read',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to read'
          },
          file_path: {
            type: 'string',
            description: 'Alias for path'
          },
          encoding: {
            type: 'string'
          },
          maxBytes: {
            type: 'number',
            description: 'Maximum number of bytes to read'
          },
          offset: {
            type: 'number',
            description: 'Offset to start reading from'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read'
          }
        },
        required: ['path']
      }
    },
    {
      name: 'Write',
      description: 'Write content to a file',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to write'
          },
          file_path: {
            type: 'string',
            description: 'Alias for path'
          },
          content: {
            type: 'string',
            description: 'Content to write to the file'
          },
          encoding: {
            type: 'string'
          },
          mode: {
            type: 'number',
            description: 'File mode (permissions)'
          }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'Bash',
      description: 'Execute a bash command',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Command to execute'
          },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds'
          },
          env: {
            type: 'object',
            description: 'Environment variables'
          }
        },
        required: ['command']
      }
    },
    {
      name: 'Glob',
      description: 'Find files matching a pattern',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to match files'
          },
          path: {
            type: 'string',
            description: 'Subdirectory to search within'
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Patterns to ignore'
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results'
          }
        },
        required: ['pattern']
      }
    },
    {
      name: 'Grep',
      description: 'Search for text patterns in files',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Pattern to search for'
          },
          path: {
            type: 'string',
            description: 'Subdirectory to search within'
          },
          glob: {
            type: 'string',
            description: 'Glob pattern to filter files'
          },
          type: {
            type: 'string',
            description: 'File type to filter'
          },
          caseInsensitive: {
            type: 'boolean',
            description: 'Case insensitive search'
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results'
          }
        },
        required: ['pattern']
      }
    }
  ];

  // Using actual GoalDrivenOutputSchema from output_schemas.ts
  const request = {
    llm: {
      provider: 'openai-compat',
      displayProvider: 'lmstudio',
      model: TEST_MODEL,
      baseUrl: LMSTUDIO_BASE_URL,
    },
    messages: [
      { role: 'user', content: 'Please list all TypeScript files in the current directory using the Glob tool.' },
    ],
    system: 'You are a helpful assistant with access to tools. Use tools to help answer user requests.',
    maxTokens: 500,
    tools,
    toolChoice: 'auto',
    responseSchema: {
      name: 'goal_driven',
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['done', 'continue', 'handoff']
          },
          response: { type: 'string', nullable: true },
          goalStateReached: { type: 'boolean', nullable: true },
          handoffSpec: { type: 'object', nullable: true },
          work_done: { type: 'string', nullable: true }
        }
      },
      strict: false,
    },
  };

  testLogger.info('Sending request with tools', { toolCount: tools.length });

  try {
    const response = await adapter.respond(request);

    testLogger.info('Response received', {
      contentLength: response.content.length,
      hasToolCalls: response.toolCalls && response.toolCalls.length > 0,
      toolCallCount: response.toolCalls?.length || 0,
      usage: response.usage,
    });

    console.log('✓ Test 5 PASSED');
    console.log(`  Content: ${response.content.substring(0, 200)}...`);
    if (response.toolCalls && response.toolCalls.length > 0) {
      console.log(`  Tool Calls: ${response.toolCalls.length}`);
      response.toolCalls.forEach((tc, i) => {
        console.log(`    ${i + 1}. ${tc.name}`);
      });
    }
    console.log(`  Usage: ${JSON.stringify(response.usage)}`);

    return { success: true, response };
  } catch (error) {
    testLogger.error('Test 5 FAILED', { error: error.message });
    console.error('✗ Test 5 FAILED:', error.message);
    return { success: false, error };
  }
}

/**
 * Test 6: Streaming response
 */
async function testStreaming() {
  console.log('\n========================================');
  console.log('TEST 5: Streaming response');
  console.log('========================================\n');

  const adapter = createAdapter(
    {
      baseUrls: {
        'openai-compat': LMSTUDIO_BASE_URL,
      },
    },
    testLogger
  );

  const request = {
    llm: {
      provider: 'openai-compat',
      displayProvider: 'lmstudio',
      model: TEST_MODEL,
      baseUrl: LMSTUDIO_BASE_URL,
    },
    messages: [
      { role: 'user', content: 'Count from 1 to 5 slowly, with one number per line.' },
    ],
    system: 'You are a helpful assistant.',
    maxTokens: 100,
    onChunk: (chunk) => {
      process.stdout.write(chunk); // Write to stdout in real-time
    },
  };

  testLogger.info('Starting streaming request');

  try {
    const chunks = [];
    for await (const chunk of adapter.stream(request)) {
      chunks.push(chunk);
    }

    console.log('\n\n✓ Test 5 PASSED');
    console.log(`  Total chunks: ${chunks.length}`);
    console.log(`  Full content: ${chunks.join('')}`);

    return { success: true, chunks };
  } catch (error) {
    testLogger.error('Test 5 FAILED', { error: error.message });
    console.error('\n✗ Test 5 FAILED:', error.message);
    return { success: false, error };
  }
}

/**
 * Test 5: Verify LM Studio server is accessible
 */
async function testServerHealth() {
  console.log('\n========================================');
  console.log('TEST 0: LM Studio Server Health Check');
  console.log('========================================\n');

  try {
    const response = await fetch(`${LMSTUDIO_BASE_URL}/models`);
    
    if (response.ok) {
      const data = await response.json();
      testLogger.info('LM Studio server is running', {
        status: response.status,
        modelCount: data.data?.length || 0,
        models: data.data?.map(m => m.id) || [],
      });
      
      console.log('✓ LM Studio server is running');
      console.log(`  Status: ${response.status}`);
      console.log(`  Available models: ${data.data?.map(m => m.id).join(', ') || 'None'}`);
      
      return { success: true, models: data.data || [] };
    } else {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  } catch (error) {
    testLogger.error('LM Studio server not accessible', { error: error.message });
    console.error('✗ LM Studio server not accessible');
    console.error('  Error:', error.message);
    console.error('  Make sure LM Studio is running and the server is enabled:');
    console.error('    1. Open LM Studio');
    console.error('    2. Go to the "Local Server" tab');
    console.error('    3. Click "Start Server"');
    console.error('    4. Ensure port 1234 is being used');
    return { success: false, error };
  }
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('='.repeat(50));
  console.log('LM Studio End-to-End Inference Test');
  console.log('='.repeat(50));
  console.log(`Base URL: ${LMSTUDIO_BASE_URL}`);
  console.log(`Model: ${TEST_MODEL}`);
  console.log(`Log file: ${LOG_FILE}`);

  const results = {
    serverHealth: false,
    simpleQuery: false,
    standardPrompt: false,
    multiTurn: false,
    explorerSchema: false,
    withTools: false,
    streaming: false,
  };

  // Test 0: Server health
  const healthResult = await testServerHealth();
  if (!healthResult.success) {
    console.log('\n❌ Cannot continue tests - LM Studio server is not running');
    process.exit(1);
  }
  results.serverHealth = true;

  // Test 1: Simple query
  const test1Result = await testSimpleQuery();
  results.simpleQuery = test1Result.success;

  // Test 2: Standard agent prompt
  const test2Result = await testStandardAgentPrompt();
  results.standardPrompt = test2Result.success;

  // Test 3: Multi-turn
  const test3Result = await testMultiTurnConversation();
  results.multiTurn = test3Result.success;

  // Test 4: Explorer schema
  const test4Result = await testExplorerSchema();
  results.explorerSchema = test4Result.success;

  // Test 5: Tools
  const test5Result = await testWithTools();
  results.withTools = test5Result.success;

  // Test 6: Streaming
  const test6Result = await testStreaming();
  results.streaming = test6Result.success;

  // ============================================
  // SUMMARY
  // ============================================
  console.log('\n' + '='.repeat(50));
  console.log('TEST SUMMARY');
  console.log('='.repeat(50));
  console.log(`Server Health:    ${results.serverHealth ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Simple Query:     ${results.simpleQuery ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Standard Prompt:  ${results.standardPrompt ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Multi-turn:       ${results.multiTurn ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Explorer Schema:  ${results.explorerSchema ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`With Tools:       ${results.withTools ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Streaming:        ${results.streaming ? '✓ PASS' : '✗ FAIL'}`);

  const allPassed = Object.values(results).every(r => r === true);
  
  console.log('='.repeat(50));
  if (allPassed) {
    console.log('✓ ALL TESTS PASSED');
    process.exit(0);
  } else {
    console.log('✗ SOME TESTS FAILED');
    process.exit(1);
  }
}

// Run the tests
main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
