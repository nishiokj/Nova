/**
 * BridgeGateway - Routes bridge commands from the bus to the harness.
 */

import path from 'path';
import type { BusServer } from '../../../../packages/comms-bus/src/bus_server.js';
import { BRIDGE_COMMAND_CHANNEL, runChannel, sessionChannel } from '../../../../packages/comms-bus/src/bus_channels.js';
import type { AgentRunHandle, BridgeEvent } from './types.js';
import { createErrorEvent } from './event_translator.js';
import type { FullHarnessConfig } from './config_types.js';
import { loadHookDefinitions, loadSkillDefinitions } from './skills_loader.js';

interface BridgeCommand {
  type: string;
  data?: Record<string, unknown>;
}

interface HarnessLike {
  run(params: {
    requestId: string;
    inputText: string;
    tier?: 'simple' | 'standard' | 'complex';
    sessionKey: string;
    context?: string;
  }): AgentRunHandle;
  resume(requestId: string, answer: string, sessionKey: string): AgentRunHandle;
  createReadyEvent(sessionKey: string): BridgeEvent;
  getConfig(): FullHarnessConfig;
  isShuttingDown(): boolean;
  shutdown(): Promise<void>;
}

interface ConnectionState {
  sessionKey: string | null;
  activeRequestId: string | null;
}

export class BridgeGateway {
  private readonly bus: BusServer;
  private readonly harness: HarnessLike;
  private readonly workingDir: string;
  private skillsDir: string;
  private hooksDir: string;
  private connections = new Map<string, ConnectionState>();

  constructor(bus: BusServer, harness: HarnessLike, workingDir: string) {
    this.bus = bus;
    this.harness = harness;
    this.workingDir = workingDir;

    const config = harness.getConfig();
    this.skillsDir = config.skills.directory
      ? path.resolve(this.workingDir, config.skills.directory)
      : path.resolve(this.workingDir, 'config/skills');
    this.hooksDir = config.hooks.directory
      ? path.resolve(this.workingDir, config.hooks.directory)
      : path.resolve(this.workingDir, 'config/hooks');
  }

  handleDisconnect(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  async handlePublish(
    connectionId: string,
    channel: string,
    payload: unknown
  ): Promise<void> {
    if (channel !== BRIDGE_COMMAND_CHANNEL) {
      return;
    }

    if (!payload || typeof payload !== 'object') {
      this.sendError(connectionId, 'Invalid bridge command payload');
      return;
    }

    const command = payload as BridgeCommand;
    const state = this.getOrCreateConnectionState(connectionId);

    try {
      switch (command.type) {
        case 'init':
          this.handleInit(connectionId, command.data, state);
          return;
        case 'send_text':
          this.handleSendText(connectionId, command.data, state);
          return;
        case 'user_prompt_response':
          this.handleUserPromptResponse(connectionId, command.data, state);
          return;
        case 'get_config':
          this.handleGetConfig(connectionId, state);
          return;
        case 'get_status':
          this.handleGetStatus(connectionId);
          return;
        case 'get_models':
          this.handleGetModels(connectionId);
          return;
        case 'skills_list':
          this.handleSkillsList(connectionId);
          return;
        case 'skills_get':
        case 'skills_create':
        case 'skills_update':
        case 'skills_delete':
        case 'skills_run':
          this.handleDeferredResponse(connectionId, command.type);
          return;
        case 'voice_start':
        case 'voice_stop':
          this.sendEvent(connectionId, {
            type: 'error',
            data: { message: 'Voice is not yet supported in TypeScript mode', fatal: false },
          });
          return;
        case 'hooks_list':
          this.handleHooksList(connectionId);
          return;
        case 'hooks_get':
        case 'hooks_create':
        case 'hooks_update':
        case 'hooks_delete':
          this.handleDeferredResponse(connectionId, command.type);
          return;
        case 'shutdown':
          this.sendError(connectionId, 'Shutdown is not supported via bridge');
          return;
        default:
          this.sendError(connectionId, `Unknown command type: ${command.type}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendEvent(connectionId, createErrorEvent(message, false));
    }
  }

  private handleInit(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
    const requestedSessionKey = data?.session_key;
    const sessionKey =
      typeof requestedSessionKey === 'string' && requestedSessionKey.length > 0
        ? requestedSessionKey
        : generateSessionKey();
    state.sessionKey = sessionKey;

    const readyEvent = this.harness.createReadyEvent(sessionKey);
    this.sendEvent(connectionId, readyEvent, sessionChannel(sessionKey));
  }

  private handleSendText(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendError(connectionId, 'Session not initialized. Call init first.');
      return;
    }

    const text = String(data?.text ?? '');
    if (!text.trim()) {
      this.sendError(connectionId, 'Empty message');
      return;
    }

    const candidateRequestId =
      typeof data?.client_request_id === 'string' ? data.client_request_id : '';
    const clientRequestId = candidateRequestId.length > 0
      ? candidateRequestId
      : generateRequestId();
    const rawTier = typeof data?.tier === 'string' ? data.tier.trim() : '';
    const tier = rawTier && rawTier !== 'auto' ? rawTier : undefined;

    state.activeRequestId = clientRequestId;

    const handle = this.harness.run({
      requestId: clientRequestId,
      inputText: text,
      ...(tier ? { tier: tier as 'simple' | 'standard' | 'complex' } : {}),
      sessionKey,
    });

    this.streamRunEvents(clientRequestId, handle);
  }

  private handleUserPromptResponse(
    connectionId: string,
    data: Record<string, unknown> | undefined,
    state: ConnectionState
  ): void {
    const sessionKey = state.sessionKey;
    if (!sessionKey) {
      this.sendError(connectionId, 'Session not initialized.');
      return;
    }

    const requestId = String(data?.request_id ?? state.activeRequestId ?? '');
    const answer = String(data?.answer ?? '');
    if (!requestId) {
      this.sendError(connectionId, 'Missing request_id');
      return;
    }
    if (!answer) {
      this.sendError(connectionId, 'Empty answer');
      return;
    }

    const handle = this.harness.resume(requestId, answer, sessionKey);
    this.streamRunEvents(requestId, handle);
  }

  private handleGetConfig(connectionId: string, state: ConnectionState): void {
    const config = this.harness.getConfig();
    const defaultAgent = config.agents[config.defaultAgent];

    this.sendEvent(connectionId, {
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: {
          kind: 'config',
          payload: {
            llm_provider: defaultAgent?.llm.provider ?? 'unknown',
            model: defaultAgent?.llm.model ?? 'unknown',
            default_agent: config.defaultAgent,
            agent_count: Object.keys(config.agents).length,
            graphd_enabled: config.graphd.enabled,
            skills_enabled: config.skills.enabled,
            hooks_enabled: config.hooks.enabled,
          },
        },
      },
    }, state.sessionKey ? sessionChannel(state.sessionKey) : 'direct');
  }

  private handleGetStatus(connectionId: string): void {
    this.sendEvent(connectionId, {
      type: 'status',
      data: {
        state: this.harness.isShuttingDown() ? 'error' : 'idle',
        message: 'Ready',
      },
    });
  }

  private handleGetModels(connectionId: string): void {
    this.sendEvent(connectionId, {
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

  private handleSkillsList(connectionId: string): void {
    try {
      const skills = loadSkillDefinitions(this.skillsDir);
      this.sendEvent(connectionId, {
        type: 'response',
        data: {
          success: true,
          content: '',
          metadata: { kind: 'skills', payload: { action: 'list', items: skills, errors: [] } },
        },
      });
    } catch (error) {
      this.sendEvent(connectionId, {
        type: 'response',
        data: {
          success: true,
          content: '',
          metadata: { kind: 'skills', payload: { action: 'list', items: [], errors: [String(error)] } },
        },
      });
    }
  }

  private handleHooksList(connectionId: string): void {
    try {
      const hooks = loadHookDefinitions(this.hooksDir);
      this.sendEvent(connectionId, {
        type: 'response',
        data: {
          success: true,
          content: '',
          metadata: { kind: 'hooks', payload: { action: 'list', items: hooks, errors: [] } },
        },
      });
    } catch (error) {
      this.sendEvent(connectionId, {
        type: 'response',
        data: {
          success: true,
          content: '',
          metadata: { kind: 'hooks', payload: { action: 'list', items: [], errors: [String(error)] } },
        },
      });
    }
  }

  private handleDeferredResponse(connectionId: string, commandType: string): void {
    this.sendEvent(connectionId, {
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: { kind: commandType, payload: null },
      },
    });
  }

  private streamRunEvents(requestId: string, handle: AgentRunHandle): void {
    const channel = runChannel(requestId);

    void (async () => {
      try {
        for await (const event of handle.events) {
          this.bus.publish(channel, event);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.bus.publish(channel, createErrorEvent(message, false));
      } finally {
        try {
          await handle.result;
        } catch {
          // Errors are already emitted via events.
        }
      }
    })();
  }

  private getOrCreateConnectionState(connectionId: string): ConnectionState {
    const existing = this.connections.get(connectionId);
    if (existing) return existing;
    const state: ConnectionState = { sessionKey: null, activeRequestId: null };
    this.connections.set(connectionId, state);
    return state;
  }

  private sendEvent(connectionId: string, event: BridgeEvent, channel?: string): void {
    const targetChannel = channel ?? 'direct';
    this.bus.sendTo(connectionId, targetChannel, event);
  }

  private sendError(connectionId: string, message: string): void {
    this.sendEvent(connectionId, createErrorEvent(message, false));
  }
}

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateSessionKey(): string {
  return `tui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
