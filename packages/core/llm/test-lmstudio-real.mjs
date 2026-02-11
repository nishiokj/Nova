#!/usr/bin/env node

import { createAdapter } from './dist/adapter.js';

const adapter = createAdapter({
  baseUrls: {
    'openai-compat': 'http://localhost:1234/v1',
  }
}, {
  debug: (msg, meta) => console.log(`[DEBUG] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.log(`[INFO] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[WARN] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ?? ''),
});

// Test with displayProvider set to lmstudio (which has authRequired: false)
const request = {
  llm: {
    provider: 'openai-compat',
    displayProvider: 'lmstudio',
    model: 'zai-org/glm-4.7-flash',
  },
  messages: [
    { role: 'user', content: 'What is 2 + 2? Answer with just the number.' },
  ],
  system: 'You are a helpful assistant.',
  maxTokens: 100,
  responseSchema: {
    name: 'answer',
    strict: false,
    schema: {
      type: 'object',
      properties: {
        answer: { type: 'string' },
      },
      required: ['answer'],
    },
  },
};

console.log('Sending request to LM Studio...');
const response = await adapter.respond(request);
console.log('Response:', response);
console.log('Success!');
