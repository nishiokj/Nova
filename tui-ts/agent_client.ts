/**
 * AgentClient - Drop-in replacement for JSONLClient.
 *
 * Communicates directly with the TypeScript AgentHarness instead of
 * spawning a Python bridge subprocess.
 */

import { EventEmitter } from 'events';
import path from 'path';
import {
  AgentHarness,
  createHarnessFromEnv,
  loadSkillDefinitions,
  loadHookDefinitions,
} from '../src/agent-ts/harness/index.js';
import { createLogSubscriber, type LogSubscriber } from '../src/agent-ts/communication/index.js';
import type { BridgeCommand, BridgeEvent } from './types.js';

/**
 * Generate a unique request ID.
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate a session key.
 */
function generateSessionKey(): string {
  return `tui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * AgentClient - In-process agent client for the TUI.
 *
 * Emits the same events as JSONLClient:
 * - 'event': BridgeEvent from the agent
 * - 'exit': When shutting down
 * - 'error': On errors
 */
export class AgentClient extends EventEmitter {
  private harness: AgentHarness | null = null;
  private logSubscriber: LogSubscriber | null = null;
  private sessionKey: string;
  private activeRequestId: string | null = null;
  private workingDir: string;
  private isShuttingDown = false;
  private skillsDir: string = 'config/skills';
  private hooksDir: string = 'config/hooks';

  constructor(workingDir?: string) {
    super();
    this.workingDir = workingDir ?? process.cwd();
    this.sessionKey = generateSessionKey();
  }

  /**
   * Send a command to the agent.
   * Mimics the JSONLClient interface for TUI compatibility.
   */
  send(command: BridgeCommand): void {
    if (this.isShuttingDown) {
      return;
    }

    try {
      switch (command.type) {
        case 'init':
          this.handleInit(command.data);
          break;

        case 'send_text':
          this.handleSendText(command.data);
          break;

        case 'user_prompt_response':
          this.handleUserPromptResponse(command.data);
          break;

        case 'get_config':
          this.handleGetConfig();
          break;

        case 'get_status':
          this.handleGetStatus();
          break;

        case 'shutdown':
          this.handleShutdown();
          break;

        // Deferred: voice commands
        case 'voice_start':
        case 'voice_stop':
          // Voice is deferred, emit error
          this.emitEvent({
            type: 'error',
            data: { message: 'Voice is not yet supported in TypeScript mode', fatal: false },
          });
          break;

        // Skills management
        case 'skills_list':
          this.handleSkillsList();
          break;
        case 'skills_get':
        case 'skills_create':
        case 'skills_update':
        case 'skills_delete':
        case 'skills_run':
          // Skills CRUD deferred - return empty success
          this.emitEvent({
            type: 'response',
            data: {
              success: true,
              content: '',
              metadata: { kind: command.type, payload: null },
            },
          });
          break;

        // Hooks management
        case 'hooks_list':
          this.handleHooksList();
          break;
        case 'hooks_get':
        case 'hooks_create':
        case 'hooks_update':
        case 'hooks_delete':
          // Hooks CRUD deferred - return empty success
          this.emitEvent({
            type: 'response',
            data: {
              success: true,
              content: '',
              metadata: { kind: command.type, payload: null },
            },
          });
          break;

        case 'get_models':
          this.handleGetModels();
          break;

        default:
          console.warn(`Unknown command type: ${command.type}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent({
        type: 'error',
        data: { message, fatal: false },
      });
    }
  }

  private emitEvent(event: BridgeEvent): void {
    this.emit('event', event);
  }

  private async handleInit(data?: Record<string, unknown>): Promise<void> {
    try {
      // Create harness from config file with env overrides
      const configPath = data?.config_path as string | undefined;
      this.harness = createHarnessFromEnv(this.workingDir, configPath);

      // Store skills/hooks directories from loaded config
      const config = this.harness.getConfig();
      this.skillsDir = path.resolve(this.workingDir, config.skills.skillsDir);
      this.hooksDir = path.resolve(this.workingDir, config.hooks.hooksDir);

      // Set up structured event logging via EventBus subscription
      const logDir = String(data?.log_dir ?? path.join(this.workingDir, 'tui', 'logs'));
      this.logSubscriber = createLogSubscriber(
        this.harness.getEventBus(),
        logDir,
        'agent-events.jsonl'
      );

      // Start async services (GraphD is optional, will gracefully degrade)
      await this.harness.start();

      // Emit ready event
      const readyEvent = this.harness.createReadyEvent(this.sessionKey);
      this.emitEvent(readyEvent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent({
        type: 'error',
        data: { message, fatal: true },
      });
    }
  }

  private handleSendText(data?: Record<string, unknown>): void {
    if (!this.harness) {
      this.emitEvent({
        type: 'error',
        data: { message: 'Agent not initialized. Call init first.', fatal: false },
      });
      return;
    }

    const text = String(data?.text ?? '');
    const clientRequestId = String(data?.client_request_id ?? generateRequestId());
    const tier = String(data?.tier ?? 'standard');

    if (!text.trim()) {
      this.emitEvent({
        type: 'error',
        data: { message: 'Empty message', fatal: false },
      });
      return;
    }

    this.activeRequestId = clientRequestId;

    // Run the agent
    const handle = this.harness.run({
      requestId: clientRequestId,
      inputText: text,
      tier,
      sessionKey: this.sessionKey,
    });

    // Stream events to TUI
    this.streamEvents(handle.events, handle.result);
  }

  private handleUserPromptResponse(data?: Record<string, unknown>): void {
    if (!this.harness) {
      this.emitEvent({
        type: 'error',
        data: { message: 'Agent not initialized', fatal: false },
      });
      return;
    }

    const requestId = String(data?.request_id ?? this.activeRequestId ?? '');
    const answer = String(data?.answer ?? '');

    if (!answer) {
      this.emitEvent({
        type: 'error',
        data: { message: 'Empty answer', fatal: false },
      });
      return;
    }

    // Resume the agent
    const handle = this.harness.resume(requestId, answer, this.sessionKey);

    // Stream events to TUI
    this.streamEvents(handle.events, handle.result);
  }

  private async streamEvents(
    events: AsyncIterable<BridgeEvent>,
    result: Promise<unknown>
  ): Promise<void> {
    try {
      for await (const event of events) {
        this.emitEvent(event);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent({
        type: 'error',
        data: { message, fatal: false },
      });
    }

    // Wait for result to complete (events already emitted)
    try {
      await result;
    } catch (error) {
      // Error already handled in event stream
    }
  }

  private handleGetConfig(): void {
    if (this.harness) {
      const config = this.harness.getConfig();
      this.emitEvent({
        type: 'response',
        data: {
          success: true,
          content: '',
          metadata: {
            kind: 'config',
            payload: {
              llm_provider: config.llm.provider,
              model: config.llm.model,
              tier_tool_limits: config.agent.tierToolLimits,
              tier_max_tokens: config.agent.tierMaxTokens,
              enabled_tools: config.tools.enabledTools,
              graphd_enabled: config.graphd.enabled,
              skills_enabled: config.skills.enabled,
              hooks_enabled: config.hooks.enabled,
              router_enabled: config.router.enabled,
              default_tier: config.router.defaultTier,
            },
          },
        },
      });
    } else {
      this.emitEvent({
        type: 'response',
        data: {
          success: true,
          content: '',
          metadata: {
            kind: 'config',
            payload: {
              llm_provider: process.env.LLM_PROVIDER ?? 'anthropic',
              model: process.env.LLM_MODEL ?? 'default',
            },
          },
        },
      });
    }
  }

  private handleSkillsList(): void {
    const skills = loadSkillDefinitions(this.skillsDir);
    this.emitEvent({
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: { kind: 'skills_list', payload: skills },
      },
    });
  }

  private handleHooksList(): void {
    const hooks = loadHookDefinitions(this.hooksDir);
    this.emitEvent({
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: { kind: 'hooks_list', payload: hooks },
      },
    });
  }

  private handleGetStatus(): void {
    this.emitEvent({
      type: 'status',
      data: {
        state: this.harness?.isShuttingDown() ? 'error' : 'idle',
        message: 'Ready',
      },
    });
  }

  private handleGetModels(): void {
    this.emitEvent({
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: {
          kind: 'models',
          payload: [
            { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
            { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
            { id: 'gpt-4o', name: 'GPT-4o' },
            { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
          ],
        },
      },
    });
  }

  private async handleShutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Close log subscriber first
    if (this.logSubscriber) {
      this.logSubscriber.close();
      this.logSubscriber = null;
    }

    if (this.harness) {
      await this.harness.shutdown();
    }
    this.emit('exit', { code: 0, signal: null });
  }

  /**
   * Close the client. Required for JSONLClient compatibility.
   */
  close(): void {
    // No-op for in-process client
    // The harness will be shut down via handleShutdown
  }
}
