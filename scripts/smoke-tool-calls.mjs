#!/usr/bin/env node

/**
 * Raw smoke test: tool calling across LM Studio vs mlx-lm.
 *
 * Bypasses the adapter entirely — raw HTTP to isolate server behavior.
 *
 * Usage:
 *   node scripts/smoke-tool-calls.mjs [--server lmstudio|mlx|both] [--stream]
 *
 * Prerequisites:
 *   LM Studio:  running on :1234 with Qwen3.5-35B-A3B loaded
 *   mlx-lm:     mlx_lm.server --model ~/.lmstudio/models/mlx-community/Qwen3.5-35B-A3B-4bit \
 *                 --port 8080 --trust-remote-code
 *
 * Known issues being tested:
 *   1. Qwen3.5 native tool format is <parameter=key>value</parameter>, NOT JSON args
 *   2. mlx-lm parse_function does json.loads() — will crash on native Qwen format
 *   3. mlx-lm checks tokenizer.chat_template for '"tool"' string — Qwen3.5 stores
 *      template in separate .jinja file, so has_tool_calling may be False
 *   4. Harness Qwen tool skin teaches JSON args which conflicts with native format
 */

const SERVERS = {
  lmstudio: { url: 'http://localhost:1234/v1', model: 'qwen3.5-35b-a3b' },
  mlx:      { url: 'http://127.0.0.1:8080/v1', model: 'default_model' },
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Execute a bash command',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find files matching a glob pattern',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match files' },
        },
        required: ['pattern'],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are a coding assistant with access to tools. Use them to help the user.
When the user asks you to do something that requires tools, call the appropriate tool.
Do not describe what you would do — actually call the tool.`;

// This is what the harness currently injects for Qwen models (JSON args — NOT the native format)
const HARNESS_QWEN_SKIN = `
Qwen tool-calling skin:
When you need a tool, emit a tool-call block directly.
Use this exact shape:
<tool_call>
<function=Bash>{"command":"ls -la"}</function>
</tool_call>
Do not output only prose about calling tools.`;

const USER_MSG = 'List the files in the current directory.';

// ─── helpers ────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = { server: 'both', stream: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--server' && args[i + 1]) flags.server = args[++i];
    if (args[i] === '--stream') flags.stream = true;
  }
  return flags;
}

async function serverAlive(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return false;
    const data = await r.json();
    console.log(`  models: ${(data.data || []).map(m => m.id).join(', ') || '(none)'}`);
    return true;
  } catch {
    return false;
  }
}

function detectInlineToolCalls(content) {
  if (typeof content !== 'string') return { found: false };
  const markers = {
    hasToolCallTags: content.includes('<tool_call>'),
    hasFunctionTag: content.includes('<function='),
    hasParameterTag: content.includes('<parameter='),      // native Qwen3.5 format
    hasJsonArgs: /{[^}]*"(command|path|pattern)"/.test(content), // JSON args format
  };
  markers.found = markers.hasToolCallTags || markers.hasFunctionTag;
  return markers;
}

// ─── test runner ────────────────────────────────────────────────────

async function runTest(label, baseUrl, model, opts = {}) {
  const { stream, systemOverride, toolChoice, skipTools } = opts;
  const sep = '─'.repeat(60);
  console.log(`\n${sep}`);
  console.log(label);
  console.log(sep);

  const body = {
    model,
    messages: [
      { role: 'system', content: systemOverride || SYSTEM_PROMPT },
      { role: 'user', content: USER_MSG },
    ],
    max_tokens: 1024,
    temperature: 0.7,
    stream: !!stream,
  };

  if (!skipTools) {
    body.tools = TOOLS;
    body.tool_choice = toolChoice || 'auto';
  }

  console.log(`\nREQUEST → POST ${baseUrl}/chat/completions`);
  console.log(`  model: ${model}`);
  console.log(`  stream: ${body.stream}`);
  console.log(`  tools: ${skipTools ? 'NONE (prompt-only)' : `${TOOLS.length} tools via API`}`);
  console.log(`  tool_choice: ${body.tool_choice ?? 'n/a'}`);

  const start = Date.now();
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    console.log(`\n  FETCH ERROR: ${err.message}`);
    return { success: false, error: err.message };
  }

  console.log(`\nRESPONSE (${Date.now() - start}ms, HTTP ${res.status})`);

  if (!res.ok) {
    const errText = await res.text();
    console.log(`  ERROR BODY: ${errText.slice(0, 500)}`);
    return { success: false, error: errText };
  }

  return stream ? handleStream(res, start) : handleNonStream(res, start);
}

async function handleNonStream(res, start) {
  const raw = await res.text();
  console.log(`\n  RAW RESPONSE (${raw.length} bytes):`);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(`  (not valid JSON — dumping raw)`);
    console.log(raw.slice(0, 3000));
    return { success: false, raw };
  }

  const choice = parsed.choices?.[0];
  const msg = choice?.message;
  const content = msg?.content ?? '';

  console.log(`  finish_reason: ${choice?.finish_reason}`);
  console.log(`  message.role: ${msg?.role}`);

  // Show full content for debugging (tool calls are the whole point)
  console.log(`\n  === CONTENT START ===`);
  console.log(content.slice(0, 2000));
  if (content.length > 2000) console.log(`  ... (${content.length} total chars)`);
  console.log(`  === CONTENT END ===`);

  console.log(`\n  message.tool_calls: ${JSON.stringify(msg?.tool_calls)?.slice(0, 500) ?? 'undefined'}`);
  console.log(`  usage: ${JSON.stringify(parsed.usage)}`);
  console.log(`  elapsed: ${Date.now() - start}ms`);

  const hasStructured = msg?.tool_calls && msg.tool_calls.length > 0;
  const inline = detectInlineToolCalls(content);

  console.log(`\n  VERDICT:`);
  if (hasStructured) {
    console.log(`  ✅ STRUCTURED tool_calls (${msg.tool_calls.length})`);
    for (const tc of msg.tool_calls) {
      console.log(`     → ${tc.function?.name}(${tc.function?.arguments})`);
    }
  } else if (inline.found) {
    console.log(`  ⚠️  INLINE tool syntax in content (server didn't parse it into tool_calls)`);
    console.log(`     tags: ${JSON.stringify(inline)}`);
  } else {
    console.log(`  ❌ No tool calls — prose only`);
  }

  return { success: hasStructured, hasInline: inline.found, inline, content, parsed };
}

async function handleStream(res, start) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  const toolCalls = {};
  let finishReason = null;

  console.log(`\n  STREAM OUTPUT:`);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      const delta = chunk.choices?.[0]?.delta;
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;

      if (delta?.content) {
        fullContent += delta.content;
        process.stdout.write(delta.content);
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', args: '' };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
        }
      }
    }
  }

  console.log(`\n\n  finish_reason: ${finishReason}`);
  console.log(`  content length: ${fullContent.length}`);
  console.log(`  elapsed: ${Date.now() - start}ms`);

  const toolCallList = Object.values(toolCalls);
  const hasStructured = toolCallList.length > 0;
  const inline = detectInlineToolCalls(fullContent);

  console.log(`\n  VERDICT:`);
  if (hasStructured) {
    console.log(`  ✅ STRUCTURED tool_calls via stream (${toolCallList.length})`);
    for (const tc of toolCallList) {
      console.log(`     → ${tc.name}(${tc.args})`);
    }
  } else if (inline.found) {
    console.log(`  ⚠️  INLINE tool syntax in stream content (server didn't parse)`);
    console.log(`     tags: ${JSON.stringify(inline)}`);
  } else {
    console.log(`  ❌ No tool calls — prose only`);
  }

  return { success: hasStructured, hasInline: inline.found, inline, content: fullContent };
}

// ─── main ───────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs();
  const targets = flags.server === 'both'
    ? ['lmstudio', 'mlx']
    : [flags.server];

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  TOOL CALLING SMOKE TEST — LM Studio vs mlx-lm        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  targets: ${targets.join(', ')}`);
  console.log(`  stream: ${flags.stream}`);
  console.log();
  console.log(`  Qwen3.5 native format: <parameter=key>value</parameter>`);
  console.log(`  Harness skin format:   <function=Name>{"key":"value"}</function>`);
  console.log(`  mlx-lm parse_function: json.loads() — will fail on native format`);

  const results = {};

  for (const target of targets) {
    const srv = SERVERS[target];
    if (!srv) {
      console.log(`\n  Unknown server: ${target}`);
      continue;
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`SERVER: ${target.toUpperCase()} (${srv.url})`);
    console.log('═'.repeat(60));

    const alive = await serverAlive(srv.url);
    if (!alive) {
      console.log(`  ❌ Server not reachable — skipping`);
      results[target] = { alive: false };
      continue;
    }
    console.log(`  ✓ Server alive`);

    // Test A: tools API only (let server handle injection)
    const a = await runTest(
      `[${target}] A: tools API, tool_choice=auto — server handles formatting`,
      srv.url, srv.model,
      { stream: flags.stream, toolChoice: 'auto' },
    );

    // Test B: tools API with tool_choice=required
    const b = await runTest(
      `[${target}] B: tools API, tool_choice=required`,
      srv.url, srv.model,
      { stream: flags.stream, toolChoice: 'required' },
    );

    // Test C: harness Qwen skin in prompt, NO tools API
    // This tests: does the model generate tool calls from text instructions alone?
    const c = await runTest(
      `[${target}] C: harness Qwen skin (text prompt only, no tools API)`,
      srv.url, srv.model,
      { stream: flags.stream, systemOverride: SYSTEM_PROMPT + '\n\n' + HARNESS_QWEN_SKIN, skipTools: true },
    );

    // Test D: tools API + harness Qwen skin (what the harness actually sends)
    const d = await runTest(
      `[${target}] D: tools API + harness Qwen skin combined (harness behavior)`,
      srv.url, srv.model,
      { stream: flags.stream, systemOverride: SYSTEM_PROMPT + '\n\n' + HARNESS_QWEN_SKIN, toolChoice: 'required' },
    );

    results[target] = { alive: true, a, b, c, d };
  }

  // ─── summary ────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));

  for (const [target, r] of Object.entries(results)) {
    if (!r.alive) {
      console.log(`  ${target}: ❌ offline`);
      continue;
    }
    console.log(`  ${target}:`);
    for (const [test, result] of Object.entries(r)) {
      if (test === 'alive') continue;
      const icon = result.success ? '✅ structured' : result.hasInline ? '⚠️  inline only' : '❌ no calls';
      const fmt = result.inline
        ? ` [native=${result.inline.hasParameterTag}, json=${result.inline.hasJsonArgs}]`
        : '';
      console.log(`    ${test}: ${icon}${fmt}`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log('ANALYSIS GUIDE:');
  console.log('  ✅ structured = server parsed tool calls into OpenAI format');
  console.log('  ⚠️  inline    = model generated tool call text, server missed it');
  console.log('  ❌ no calls   = model didn\'t attempt any tool call');
  console.log('  native=true   = model used <parameter=key> format (Qwen3.5 native)');
  console.log('  json=true     = model used {"key":"value"} format (harness skin)');
  console.log(`${'─'.repeat(60)}\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
