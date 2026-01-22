#!/usr/bin/env node
/**
 * Simple test to verify LM Studio works with tools
 */

import { createAdapter } from './dist/adapter.js';

const adapter = createAdapter({
  baseUrls: {
    'openai-compat': 'http://localhost:1234/v1',
  }
}, {
  debug: (msg, meta) => console.log(`[DEBUG] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.log(`[INFO] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.log(`[WARN] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ?? ''),
});

// Define tools
const tools = [
  {
    name: 'read_file',
    description: 'Read the contents of a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' }
      },
      required: ['path']
    }
  }
];

const request = {
  llm: {
    provider: 'openai-compat',
    displayProvider: 'lmstudio',
    model: 'zai-org/glm-4.7-flash',
  },
  messages: [{ role: 'user', content: 'Read the file /tmp/test.txt' }],
  system: 'You are a helpful assistant.',
  maxTokens: 200,
  tools,
  toolChoice: 'auto',
};

console.log('Testing LM Studio with tools...');
const response = await adapter.respond(request);
console.log('✓ Success!');
console.log('Content:', response.content);
console.log('Tool calls:', response.toolCalls);
console.log('Usage:', response.usage);
