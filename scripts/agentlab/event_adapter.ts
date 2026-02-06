/**
 * AgentLab hook_events_v1 translation layer.
 *
 * Subscribes to the Rex EventBus and emits hook_events_v1 JSONL lines
 * to `harness_events.jsonl`, plus writes `harness_manifest.json` at construction.
 *
 * State machine invariants (enforced by the Rust runner's hooks-validate):
 *  - `seq` strictly monotonic (++seq per emit)
 *  - `step_index` sequential: 0, 1, 2… (no gaps, no reuse)
 *  - Ordering: step_start → (model_call_end | tool_call_end)* → step_end → control_ack
 *  - No step_start after control_ack with action_observed: "stop"
 */
import { createHash } from 'crypto';
import { appendFileSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import type { AgentEvent } from '../../packages/types/src/events.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TrialIds {
  run_id: string;
  trial_id: string;
  variant_id: string;
  task_id: string;
  repl_idx: number;
}

interface AdapterConfig {
  ids: TrialIds;
  /** Absolute path to the harness_events.jsonl output file */
  eventsPath: string;
  /** Absolute path to the harness_manifest.json output file */
  manifestPath: string;
  /** Absolute path to /state/lab_control.json */
  controlPath: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function isoNow(): string {
  return new Date().toISOString();
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export class AgentLabEventAdapter {
  private readonly ids: TrialIds;
  private readonly eventsPath: string;
  private readonly controlPath: string;

  private seq = 0;
  private stepIndex = -1; // pre-first-step
  private stepOpen = false;
  private stopped = false;

  // Parallel work item tracking: emit one step_start on first WI,
  // one step_end + control_ack when last WI completes.
  private activeWorkIds = new Set<string>();
  private currentIteration = -1;

  // Per-step budget accumulators (reset each step_start)
  private stepTokensIn = 0;
  private stepTokensOut = 0;
  private stepToolCalls = 0;

  constructor(config: AdapterConfig) {
    this.ids = config.ids;
    this.eventsPath = config.eventsPath;
    this.controlPath = config.controlPath;

    // Ensure output directories exist
    mkdirSync(dirname(config.eventsPath), { recursive: true });
    mkdirSync(dirname(config.manifestPath), { recursive: true });

    // Write harness_manifest.json
    const manifest = {
      schema_version: 'harness_manifest_v1',
      created_at: isoNow(),
      integration_level: 'cli_events',
      harness: {
        name: 'rex',
        version: '0.1.0',
        entry_command: ['bun', './scripts/agentlab/run_cli.ts'],
      },
      step: { semantics: 'none' },
      control_plane: { mode: 'file', path: '/state/lab_control.json' },
      hooks: {
        schema_version: 'hook_events_v1',
        events_path: '/out/harness_events.jsonl',
        header_event_emitted: false,
      },
    };
    writeFileSync(config.manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    // Truncate events file to start fresh
    writeFileSync(config.eventsPath, '');
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /** EventBus handler — call with every event from subscribeRun. */
  handle = (event: AgentEvent): void => {
    if (this.stopped) return;

    switch (event.type) {
      case 'iteration_started':
        this.onIterationStarted(event);
        break;
      case 'llm_call':
        this.onLLMCall(event);
        break;
      case 'llm_error':
        this.onLLMError(event);
        break;
      case 'tool_call':
        this.onToolCall(event);
        break;
      case 'iteration_completed':
        this.onIterationCompleted(event);
        break;
    }
  };

  /** Emit an error event (call from catch blocks). */
  emitError(errorType: string, message: string, stack?: string): void {
    this.emit({
      event_type: 'error',
      error_type: errorType,
      message,
      ...(stack ? { stack } : {}),
    });
  }

  /** Flush — no-op since we use synchronous appendFileSync. */
  flush(): void {
    // All writes are sync; nothing to flush.
  }

  // ─── Event Handlers ─────────────────────────────────────────────────────

  private onIterationStarted(event: AgentEvent): void {
    const data = event.data as { iteration?: number; workId?: string };
    const iteration = data.iteration ?? 0;
    const workId = data.workId ?? '__default__';

    if (iteration !== this.currentIteration) {
      // New iteration — open a new step
      this.currentIteration = iteration;
      this.activeWorkIds.clear();
      this.activeWorkIds.add(workId);

      this.stepIndex++;
      this.stepOpen = true;
      this.stepTokensIn = 0;
      this.stepTokensOut = 0;
      this.stepToolCalls = 0;

      this.emit({
        event_type: 'agent_step_start',
        step_index: this.stepIndex,
      });
    } else {
      // Same iteration, additional parallel work item
      this.activeWorkIds.add(workId);
    }
  }

  private onLLMCall(event: AgentEvent): void {
    const d = event.data as {
      model?: string;
      promptTokens?: number;
      completionTokens?: number;
      durationMs?: number;
    };

    this.stepTokensIn += d.promptTokens ?? 0;
    this.stepTokensOut += d.completionTokens ?? 0;

    this.emit({
      event_type: 'model_call_end',
      call_id: `llm_${this.seq + 1}`,
      ...(this.stepIndex >= 0 ? { step_index: this.stepIndex } : {}),
      model: d.model ? { identity: d.model } : undefined,
      usage: {
        tokens_in: d.promptTokens ?? 0,
        tokens_out: d.completionTokens ?? 0,
      },
      timing: {
        duration_ms: d.durationMs ?? 0,
      },
      outcome: { status: 'ok' },
    });
  }

  private onLLMError(event: AgentEvent): void {
    const d = event.data as {
      model?: string;
      error?: string;
      errorType?: string;
    };

    this.emit({
      event_type: 'model_call_end',
      call_id: `llm_err_${this.seq + 1}`,
      ...(this.stepIndex >= 0 ? { step_index: this.stepIndex } : {}),
      model: d.model ? { identity: d.model } : undefined,
      outcome: {
        status: 'error',
        error_type: d.errorType ?? 'unknown',
        message: d.error ?? 'LLM error',
      },
    });
  }

  private onToolCall(event: AgentEvent): void {
    const d = event.data as {
      toolName?: string;
      phase?: string;
      success?: boolean;
      durationMs?: number;
    };

    // Only emit on completed phase
    if (d.phase !== 'completed') return;

    this.stepToolCalls++;

    this.emit({
      event_type: 'tool_call_end',
      call_id: `tool_${this.seq + 1}`,
      ...(this.stepIndex >= 0 ? { step_index: this.stepIndex } : {}),
      tool: { name: d.toolName ?? 'unknown' },
      timing: {
        duration_ms: d.durationMs ?? 0,
      },
      outcome: {
        status: d.success !== false ? 'ok' : 'error',
      },
    });
  }

  private onIterationCompleted(event: AgentEvent): void {
    const data = event.data as { workId?: string };
    const workId = data.workId ?? '__default__';

    // Remove this work item from active set
    this.activeWorkIds.delete(workId);

    // Only close the step when all parallel work items have completed
    if (this.activeWorkIds.size > 0) return;
    if (!this.stepOpen) return;

    // agent_step_end
    this.emit({
      event_type: 'agent_step_end',
      step_index: this.stepIndex,
      budgets: {
        steps: this.stepIndex + 1,
        tokens_in: this.stepTokensIn,
        tokens_out: this.stepTokensOut,
        tool_calls: this.stepToolCalls,
      },
    });

    // control_ack — read the control file and hash it
    const { controlVersion, actionObserved } = this.readControl();

    this.emit({
      event_type: 'control_ack',
      step_index: this.stepIndex,
      control_version: controlVersion,
      action_observed: actionObserved,
      action_taken: actionObserved,
    });

    this.stepOpen = false;

    if (actionObserved === 'stop') {
      this.stopped = true;
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private readControl(): { controlVersion: string; actionObserved: string } {
    try {
      const content = readFileSync(this.controlPath, 'utf8');
      const hash = sha256Hex(content);
      const parsed = JSON.parse(content);
      const action = parsed.action ?? 'continue';
      return { controlVersion: `sha256:${hash}`, actionObserved: action };
    } catch {
      // Control file missing or unreadable — default to continue
      const hash = sha256Hex('{}');
      return { controlVersion: `sha256:${hash}`, actionObserved: 'continue' };
    }
  }

  private emit(payload: Record<string, unknown>): void {
    this.seq++;
    const line: Record<string, unknown> = {
      hooks_schema_version: 'hook_events_v1',
      event_type: payload.event_type,
      ts: isoNow(),
      seq: this.seq,
      ids: this.ids,
      ...payload,
    };

    // Clean undefined values (JSON.stringify drops them, but be explicit)
    appendFileSync(this.eventsPath, JSON.stringify(line) + '\n');
  }
}
