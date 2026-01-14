/**
 * Default configuration embedded in the standalone binary.
 * This is used when no user config exists at ~/.rex/config.json.
 *
 * API keys use environment variable placeholders that are resolved at runtime.
 */

export const DEFAULT_CONFIG = {
  providers: {
    cerebras: "${CEREBRAS_API_KEY}",
    openai: "${OPENAI_API_KEY}",
    anthropic: "${ANTHROPIC_API_KEY}",
    together: "${TOGETHER_API_KEY}",
    groq: "${GROQ_API_KEY}",
    fireworks: "${FIREWORKS_API_KEY}",
    gemini: "${GEMINI_API_KEY}",
  },
  agents: {
    routing: {
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        max_tokens: 200,
        temperature: 0.1,
      },
      budget: {
        max_iterations: 1,
        max_tool_calls: 0,
        max_duration_ms: 3000,
      },
      output_schema: "routing",
    },
    simple: {
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        max_tokens: 4000,
        temperature: 0.5,
      },
      budget: {
        max_iterations: 1,
        max_tool_calls: 0,
        max_duration_ms: 3000,
      },
      output_schema: "agent_action",
    },
    explorer: {
      llm: {
        provider: "openai",
        model: "gpt-4o",
        max_tokens: 64000,
        temperature: 0.3,
      },
      budget: {
        max_iterations: 3,
        max_tool_calls: 40,
        max_duration_ms: 30000,
        uncertainty_targets: {
          structural: 0.8,
          relational: 0.8,
          behavioral: 0.6,
          contractual: 0.5,
        },
        overshoot_factor: 1.2,
      },
      tools: ["Read", "Glob", "Grep", "Bash"],
      output_schema: "explorer",
    },
    standard: {
      llm: {
        provider: "openai",
        model: "gpt-4o",
        max_tokens: 64000,
        temperature: 0.6,
      },
      budget: {
        max_iterations: 10,
        max_tool_calls: 150,
        max_duration_ms: 120000,
      },
      tools: [
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "Bash",
        "coding-agent",
        "explorer",
      ],
      output_schema: "goal_driven",
    },
    "coding-agent": {
      llm: {
        provider: "openai",
        model: "gpt-4o",
        max_tokens: 128000,
        temperature: 0.7,
      },
      budget: {
        max_iterations: 20,
        max_tool_calls: 100,
        max_duration_ms: 500000,
      },
      tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "standard"],
      output_schema: "goal_driven",
    },
    context_compactor: {
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        max_tokens: 200000,
        temperature: 0.3,
      },
      budget: {
        max_iterations: 2,
        max_tool_calls: 0,
        max_duration_ms: 30000,
      },
      output_schema: "agent_action",
    },
    debugger: {
      llm: {
        provider: "openai",
        model: "gpt-4o",
        max_tokens: 16000,
        temperature: 0.5,
      },
      budget: {
        max_iterations: 10,
        max_tool_calls: 15,
        max_duration_ms: 120000,
      },
      tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
      output_schema: "agent_action",
    },
    web_crawler: {
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        max_tokens: 8000,
        temperature: 0.5,
      },
      budget: {
        max_iterations: 10,
        max_tool_calls: 15,
        max_duration_ms: 120000,
      },
      tools: ["WebFetch", "WebSearch"],
      output_schema: "agent_action",
    },
  },
  tools: {
    bash_timeout_ms: 30000,
    max_output_length: 10000,
  },
  graphd: {
    enabled: true,
    host: "127.0.0.1",
    port: 9444,
    db_path: "~/.graphd/graphd.db",
  },
  context: {
    max_tokens: 200000,
  },
  skills: {
    enabled: true,
    directory: "~/.rex/skills",
  },
  hooks: {
    enabled: true,
    directory: "~/.rex/hooks",
  },
};
