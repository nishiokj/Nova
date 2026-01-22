# BridgeGateway Refactoring Plan

## Problem Statement

`bridge_gateway.ts` is a 700+ line monolith that handles:
- Auth commands (start, poll, verify, logout)
- Provider management (list, save, delete, test)
- Skills CRUD (list, get, create, update, delete, enable, disable)
- Hooks CRUD (list, get, create, update, delete, enable, disable)
- Model selection (get, set, delete)
- Session management (init, fork, close, list)
- Context compaction
- Ralph loop (start, cancel)

Adding a new command requires modifying the massive `handlePublish` method's switch statement.

---

## Refactoring Strategy

### Phase 1: Create Handler Base Infrastructure

#### 1.1 Define Handler Interface

```typescript
// handlers/base_handler.ts
import type { ConnectionState } from '../bridge_gateway.js';

export interface HandlerContext {
  connectionId: string;
  state: ConnectionState;
  sendEvent: (event: BridgeEvent, channel?: string) => void;
  sendError: (message: string) => void;
}

export interface CommandHandler {
  handle(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> | void;
}
```

#### 1.2 Create Command Router

```typescript
// utils/command_router.ts
export class CommandRouter {
  private handlers = new Map<string, CommandHandler>();

  register(commandType: string, handler: CommandHandler): void {
    if (this.handlers.has(commandType)) {
      throw new Error(`Handler already registered for command: ${commandType}`);
    }
    this.handlers.set(commandType, handler);
  }

  async execute(commandType: string, context: HandlerContext, data: Record<string, unknown> | undefined): Promise<void> {
    const handler = this.handlers.get(commandType);
    if (!handler) {
      context.sendError(`Unknown command type: ${commandType}`);
      return;
    }
    await handler.handle(data, context);
  }

  listCommands(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }
}
```

---

### Phase 2: Extract Handlers

#### 2.1 Auth Handler

```typescript
// handlers/auth_handler.ts
import type { AuthService } from '../auth_service.js';
import type { LocalProviderManager } from '../local_providers.js';
import type { FullHarnessConfig } from '../config_types.js';

export class AuthHandler implements CommandHandler {
  constructor(
    private readonly authService: AuthService | null,
    private readonly localProviders: LocalProviderManager | null,
    private readonly harness: HarnessLike
  ) {}

  async handle(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    const command = data?._command as string;
    const handler = this.handlers.get(command);

    if (!handler) {
      context.sendError(`Unknown auth command: ${command}`);
      return;
    }

    await handler(data, context);
  }

  private readonly handlers = new Map<string, (data: Record<string, unknown> | undefined, ctx: HandlerContext) => Promise<void>>([
    ['auth_start', this.handleAuthStart.bind(this)],
    ['auth_poll', this.handleAuthPoll.bind(this)],
    ['auth_verify', this.handleAuthVerify.bind(this)],
    ['auth_logout', this.handleAuthLogout.bind(this)],
    ['providers_list', this.handleProvidersList.bind(this)],
    ['providers_save', this.handleProvidersSave.bind(this)],
    ['providers_delete', this.handleProvidersDelete.bind(this)],
    ['providers_test', this.handleProvidersTest.bind(this)],
  ]);

  private async handleAuthStart(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    if (!this.authService) {
      this.sendAuthResponse(context, 'auth_start', {
        success: false,
        error: 'Auth service not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      });
      return;
    }

    const deviceName = typeof data?.device === 'string' ? data.device : undefined;
    const result = this.authService.startAuth(deviceName);

    this.sendAuthResponse(context, 'auth_start', {
      success: true,
      authUrl: result.authUrl,
      stateToken: result.stateToken,
    });
  }

  private async handleAuthPoll(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    if (!this.authService) {
      this.sendAuthResponse(context, 'auth_poll', { success: false, error: 'Auth not configured' });
      return;
    }

    const stateToken = typeof data?.stateToken === 'string' ? data.stateToken : '';
    if (!stateToken) {
      this.sendAuthResponse(context, 'auth_poll', { success: false, error: 'Missing stateToken' });
      return;
    }

    const result = this.authService.pollSession(stateToken);
    this.sendAuthResponse(context, 'auth_poll', { success: true, ...result });
  }

  private async handleAuthVerify(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    if (!this.authService) {
      this.sendAuthResponse(context, 'auth_verify', { success: false, valid: false });
      return;
    }

    const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
    if (!sessionToken) {
      this.sendAuthResponse(context, 'auth_verify', { success: false, valid: false });
      return;
    }

    const result = this.authService.verifySession(sessionToken);
    this.sendAuthResponse(context, 'auth_verify', { success: true, ...result });
  }

  private async handleAuthLogout(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    if (!this.authService) {
      this.sendAuthResponse(context, 'auth_logout', { success: false });
      return;
    }

    const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
    const loggedOut = sessionToken ? this.authService.logout(sessionToken) : false;
    this.sendAuthResponse(context, 'auth_logout', { success: loggedOut });
  }

  private async handleProvidersList(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    if (this.localProviders) {
      const result = this.localProviders.listProviders();
      this.sendAuthResponse(context, 'providers_list', result);
      return;
    }

    if (this.authService) {
      const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
      if (!sessionToken) {
        this.sendAuthResponse(context, 'providers_list', { success: false, error: 'Missing sessionToken' });
        return;
      }
      const result = this.authService.listProviders(sessionToken);
      this.sendAuthResponse(context, 'providers_list', result);
      return;
    }

    this.sendAuthResponse(context, 'providers_list', { success: false, error: 'Provider management not configured' });
  }

  private async handleProvidersSave(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    const provider = typeof data?.provider === 'string' ? data.provider : '';
    const rawKey = typeof data?.apiKey === 'string' ? data.apiKey : '';
    const apiKey = rawKey
      .replace(/\x1b\[200~/g, '')
      .replace(/\x1b\[201~/g, '')
      .replace(/\[200~/g, '')
      .replace(/\[201~/g, '')
      .trim();

    if (!provider || !apiKey) {
      this.sendAuthResponse(context, 'providers_save', { success: false, error: 'Missing provider or apiKey' });
      return;
    }

    if (this.localProviders) {
      const result = this.localProviders.saveProviderKey(provider, apiKey);

      if (result.success && this.harness.updateApiKey) {
        const canonicalProvider = isOpenAICompatProvider(provider) ? 'openai-compat' : provider;
        this.harness.updateApiKey(canonicalProvider, apiKey);
      }

      this.sendAuthResponse(context, 'providers_save', result);
      return;
    }

    if (this.authService) {
      const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
      if (!sessionToken) {
        this.sendAuthResponse(context, 'providers_save', { success: false, error: 'Missing sessionToken' });
        return;
      }
      const result = this.authService.saveProviderKey(sessionToken, provider, apiKey);

      if (result.success && this.harness.updateApiKey) {
        const canonicalProvider = isOpenAICompatProvider(provider) ? 'openai-compat' : provider;
        this.harness.updateApiKey(canonicalProvider, apiKey);
      }

      this.sendAuthResponse(context, 'providers_save', result);
      return;
    }

    this.sendAuthResponse(context, 'providers_save', { success: false, error: 'Provider management not configured' });
  }

  private async handleProvidersDelete(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    const provider = typeof data?.provider === 'string' ? data.provider : '';

    if (!provider) {
      this.sendAuthResponse(context, 'providers_delete', { success: false, error: 'Missing provider' });
      return;
    }

    if (this.localProviders) {
      const result = this.localProviders.deleteProviderKey(provider);
      this.sendAuthResponse(context, 'providers_delete', result);
      return;
    }

    if (this.authService) {
      const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
      if (!sessionToken) {
        this.sendAuthResponse(context, 'providers_delete', { success: false, error: 'Missing sessionToken' });
        return;
      }
      const result = this.authService.deleteProviderKey(sessionToken, provider);
      this.sendAuthResponse(context, 'providers_delete', result);
      return;
    }

    this.sendAuthResponse(context, 'providers_delete', { success: false, error: 'Provider management not configured' });
  }

  private async handleProvidersTest(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    const provider = typeof data?.provider === 'string' ? data.provider : '';

    if (!provider) {
      this.sendAuthResponse(context, 'providers_test', { success: false, error: 'Missing provider' });
      return;
    }

    if (this.localProviders) {
      const result = await this.localProviders.testProviderKey(provider);
      this.sendAuthResponse(context, 'providers_test', result);
      return;
    }

    if (this.authService) {
      const sessionToken = typeof data?.sessionToken === 'string' ? data.sessionToken : '';
      if (!sessionToken) {
        this.sendAuthResponse(context, 'providers_test', { success: false, error: 'Missing sessionToken' });
        return;
      }
      const result = await this.authService.testProviderKey(sessionToken, provider);
      this.sendAuthResponse(context, 'providers_test', { success: true, ...result });
      return;
    }

    this.sendAuthResponse(context, 'providers_test', { success: false, error: 'Provider management not configured' });
  }

  private sendAuthResponse(context: HandlerContext, kind: string, payload: Record<string, unknown>): void {
    context.sendEvent({
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: { kind, payload },
      },
    });
  }
}
```

#### 2.2 Skills Handler

```typescript
// handlers/skills_handler.ts
import type { SkillInput } from '../skills_loader.js';
import {
  loadSkillDefinitions,
  getSkillDefinition,
  createSkill,
  updateSkill,
  deleteSkill,
  setSkillEnabled,
} from '../skills_loader.js';

export class SkillsHandler implements CommandHandler {
  constructor(private readonly skillsDir: string) {}

  async handle(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    const command = data?._command as string;
    const handler = this.handlers.get(command);

    if (!handler) {
      context.sendError(`Unknown skills command: ${command}`);
      return;
    }

    await handler(data, context);
  }

  private readonly handlers = new Map<string, (data: Record<string, unknown> | undefined, ctx: HandlerContext) => Promise<void>>([
    ['skills_list', this.handleList.bind(this)],
    ['skills_get', this.handleGet.bind(this)],
    ['skills_create', this.handleCreate.bind(this)],
    ['skills_update', this.handleUpdate.bind(this)],
    ['skills_delete', this.handleDelete.bind(this)],
    ['skills_enable', this.handleEnable.bind(this)],
    ['skills_disable', this.handleDisable.bind(this)],
  ]);

  private async handleList(_data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    try {
      const skills = loadSkillDefinitions(this.skillsDir);
      this.sendResponse(context, 'list', { items: skills, errors: [] });
    } catch (error) {
      this.sendResponse(context, 'list', { items: [], errors: [String(error)] });
    }
  }

  private async handleGet(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      this.sendResponse(context, 'get', { success: false, error: 'Missing skill id' });
      return;
    }

    const skill = getSkillDefinition(this.skillsDir, id);
    if (!skill) {
      this.sendResponse(context, 'get', { success: false, error: `Skill '${id}' not found` });
      return;
    }

    this.sendResponse(context, 'get', { success: true, skill });
  }

  private async handleCreate(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    const skill = data?.skill as SkillInput | undefined;
    if (!skill?.name || !skill?.instructions) {
      this.sendResponse(context, 'create', { success: false, error: 'Missing required fields: name, instructions' });
      return;
    }

    const result = createSkill(this.skillsDir, skill);
    this.sendResponse(context, 'create', result);
  }

  private async handleUpdate(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    const id = typeof data?.id === 'string' ? data.id : '';
    const updates = data?.updates as Partial<SkillInput> | undefined;

    if (!id) {
      this.sendResponse(context, 'update', { success: false, error: 'Missing skill id' });
      return;
    }

    const result = updateSkill(this.skillsDir, id, updates ?? {});
    this.sendResponse(context, 'update', result);
  }

  private async handleDelete(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      this.sendResponse(context, 'delete', { success: false, error: 'Missing skill id' });
      return;
    }

    const result = deleteSkill(this.skillsDir, id);
    this.sendResponse(context, 'delete', result);
  }

  private async handleEnable(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      this.sendResponse(context, 'enable', { success: false, error: 'Missing skill id' });
      return;
    }

    const result = setSkillEnabled(this.skillsDir, id, true);
    this.sendResponse(context, 'enable', result);
  }

  private async handleDisable(data: Record<string, unknown> | undefined, context: HandlerContext): Promise<void> {
    const id = typeof data?.id === 'string' ? data.id : '';
    if (!id) {
      this.sendResponse(context, 'disable', { success: false, error: 'Missing skill id' });
      return;
    }

    const result = setSkillEnabled(this.skillsDir, id, false);
    this.sendResponse(context, 'disable', result);
  }

  private sendResponse(context: HandlerContext, action: string, payload: Record<string, unknown>): void {
    context.sendEvent({
      type: 'response',
      data: {
        success: true,
        content: '',
        metadata: { kind: 'skills', payload: { action, ...payload } },
      },
    });
  }
}
```

#### 2.3 Similar patterns for:
- `HooksHandler` - hooks CRUD operations
- `ModelsHandler` - model selection and hidden models
- `SessionHandler` - init, fork, close, list
- `ContextHandler` - context compaction
- `RalphHandler` - Ralph loop functionality (fix the truncation!)

---

### Phase 3: Update BridgeGateway

```typescript
// bridge_gateway.ts (refactored)
import path from 'path';
import { type BusServer, BRIDGE_COMMAND_CHANNEL, runChannel, sessionChannel } from 'comms-bus';
import { CommandRouter } from './utils/command_router.js';
import { AuthHandler } from './handlers/auth_handler.js';
import { SkillsHandler } from './handlers/skills_handler.js';
import { HooksHandler } from './handlers/hooks_handler.js';
import { ModelsHandler } from './handlers/models_handler.js';
import { SessionHandler } from './handlers/session_handler.js';
import { ContextHandler } from './handlers/context_handler.js';
import { RalphHandler } from './handlers/ralph_handler.js';

export class BridgeGateway {
  private readonly bus: BusServer;
  private readonly harness: HarnessLike;
  private readonly workingDir: string;
  private readonly router: CommandRouter;

  // Handler instances
  private readonly authHandler: AuthHandler;
  private readonly skillsHandler: SkillsHandler;
  private readonly hooksHandler: HooksHandler;
  private readonly modelsHandler: ModelsHandler;
  private readonly sessionHandler: SessionHandler;
  private readonly contextHandler: ContextHandler;
  private readonly ralphHandler: RalphHandler;

  private connections = new Map<string, ConnectionState>();

  constructor(bus: BusServer, harness: HarnessLike, workingDir: string, authService?: AuthService | null) {
    this.bus = bus;
    this.harness = harness;
    this.workingDir = workingDir;

    // Initialize handler paths
    const config = harness.getConfig();
    const skillsDir = config.skills.directory
      ? path.resolve(this.workingDir, config.skills.directory)
      : path.resolve(this.workingDir, 'config/skills');
    const hooksDir = config.hooks.directory
      ? path.resolve(this.workingDir, config.hooks.directory)
      : path.resolve(this.workingDir, 'config/hooks');

    // Initialize handlers
    this.authHandler = new AuthHandler(authService ?? null, harness, workingDir);
    this.skillsHandler = new SkillsHandler(skillsDir);
    this.hooksHandler = new HooksHandler(hooksDir);
    this.modelsHandler = new ModelsHandler(harness, workingDir);
    this.sessionHandler = new SessionHandler(harness, workingDir);
    this.contextHandler = new ContextHandler(harness);
    this.ralphHandler = new RalphHandler(harness);

    // Initialize router
    this.router = new CommandRouter();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    // Auth commands
    this.router.register('auth_start', this.authHandler);
    this.router.register('auth_poll', this.authHandler);
    this.router.register('auth_verify', this.authHandler);
    this.router.register('auth_logout', this.authHandler);
    this.router.register('providers_list', this.authHandler);
    this.router.register('providers_save', this.authHandler);
    this.router.register('providers_delete', this.authHandler);
    this.router.register('providers_test', this.authHandler);

    // Skills commands
    this.router.register('skills_list', this.skillsHandler);
    this.router.register('skills_get', this.skillsHandler);
    this.router.register('skills_create', this.skillsHandler);
    this.router.register('skills_update', this.skillsHandler);
    this.router.register('skills_delete', this.skillsHandler);
    this.router.register('skills_enable', this.skillsHandler);
    this.router.register('skills_disable', this.skillsHandler);

    // Hooks commands
    this.router.register('hooks_list', this.hooksHandler);
    this.router.register('hooks_get', this.hooksHandler);
    this.router.register('hooks_create', this.hooksHandler);
    this.router.register('hooks_update', this.hooksHandler);
    this.router.register('hooks_delete', this.hooksHandler);
    this.router.register('hooks_enable', this.hooksHandler);
    this.router.register('hooks_disable', this.hooksHandler);

    // Model commands
    this.router.register('get_models', this.modelsHandler);
    this.router.register('models_delete', this.modelsHandler);
    this.router.register('set_model', this.modelsHandler);
    this.router.register('get_model', this.modelsHandler);

    // Session commands
    this.router.register('init', this.sessionHandler);
    this.router.register('session_fork', this.sessionHandler);
    this.router.register('session_close', this.sessionHandler);
    this.router.register('list_sessions', this.sessionHandler);

    // Context commands
    this.router.register('compact_context', this.contextHandler);

    // Ralph commands
    this.router.register('ralph_loop_start', this.ralphHandler);
    this.router.register('ralph_loop_cancel', this.ralphHandler);

    // Special commands (handled directly)
    this.router.register('send_text', this.createDirectHandler(this.handleSendText.bind(this)));
    this.router.register('user_prompt_response', this.createDirectHandler(this.handleUserPromptResponse.bind(this)));
    this.router.register('get_config', this.createDirectHandler(this.handleGetConfig.bind(this)));
    this.router.register('get_status', this.createDirectHandler(this.handleGetStatus.bind(this)));
    this.router.register('skills_run', this.createDirectHandler(() => this.handleDeferredResponse('skills_run')));
    this.router.register('voice_start', this.createDirectHandler(() => this.handleVoiceNotSupported()));
    this.router.register('voice_stop', this.createDirectHandler(() => this.handleVoiceNotSupported()));
    this.router.register('shutdown', this.createDirectHandler(() => this.handleShutdownNotSupported()));
  }

  private createDirectHandler(fn: (connectionId: string, data: Record<string, unknown> | undefined, state: ConnectionState) => void): CommandHandler {
    return {
      handle: async (data, context) => {
        const state = this.connections.get(context.connectionId);
        if (!state) {
          context.sendError('Connection state not found');
          return;
        }
        fn(context.connectionId, data, state);
      }
    };
  }

  handleDisconnect(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (state?.sessionKey) {
      const graphd = this.harness.getGraphD?.();
      if (graphd) {
        graphd.sessionUpdateStatus(state.sessionKey, 'inactive');
      }
      this.harness.closeSession?.(state.sessionKey);
    }
    this.connections.delete(connectionId);
  }

  async handlePublish(connectionId: string, channel: string, payload: unknown): Promise<void> {
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
      const context: HandlerContext = {
        connectionId,
        state,
        sendEvent: (event, channel) => this.sendEvent(connectionId, event, channel),
        sendError: (message) => this.sendError(connectionId, message),
      };

      await this.router.execute(command.type, context, command.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendEvent(connectionId, createErrorEvent(message, false));
    }
  }

  // ... helper methods (sendEvent, sendError, getOrCreateConnectionState, etc.)

  // Direct handlers (complex logic that doesn't fit in simple handlers)
  private handleSendText(connectionId: string, data: Record<string, unknown> | undefined, state: ConnectionState): void {
    // ... existing logic
  }

  private handleUserPromptResponse(connectionId: string, data: Record<string, unknown> | undefined, state: ConnectionState): void {
    // ... existing logic
  }

  private handleGetConfig(connectionId: string, _data: Record<string, unknown> | undefined, state: ConnectionState): void {
    // ... existing logic
  }

  private handleGetStatus(connectionId: string): void {
    // ... existing logic
  }

  private handleDeferredResponse(commandType: string): void {
    // ... existing logic
  }

  private handleVoiceNotSupported(): void {
    // ... existing logic
  }

  private handleShutdownNotSupported(): void {
    // ... existing logic
  }

  // Helper methods
  private sendEvent(connectionId: string, event: BridgeEvent, channel?: string): void {
    this.bus.send(connectionId, event, channel);
  }

  private sendError(connectionId: string, message: string): void {
    this.sendEvent(connectionId, createErrorEvent(message, false));
  }

  private getOrCreateConnectionState(connectionId: string): ConnectionState {
    if (!this.connections.has(connectionId)) {
      this.connections.set(connectionId, {
        sessionKey: null,
        workingDir: null,
        activeRequestId: null,
        planMode: false,
        ralphLoop: null,
      });
    }
    return this.connections.get(connectionId)!;
  }
}
```

---

## Benefits of This Refactoring

1. **Separation of Concerns**: Each handler is focused on a single domain
2. **Testability**: Handlers can be unit tested in isolation
3. **Maintainability**: Adding a new command means:
   - Create a handler or add a method to an existing handler
   - Register the route in `registerRoutes()`
   - No 700-line switch statement to modify
4. **Discoverability**: `router.listCommands()` shows all available commands
5. **Type Safety**: Each handler's `data` parameter can be typed specifically
6. **Better Error Handling**: Centralized error handling in router
7. **Easier to Extend**: New handlers can be added without touching existing code

---

## Migration Steps

1. Create `handlers/` directory structure
2. Create `utils/command_router.ts`
3. Create base handler interfaces
4. Implement handlers one at a time (start with `AuthHandler`)
5. Update `BridgeGateway` to use the router
6. Remove old switch statement cases as handlers are migrated
7. Add tests for each handler
8. Delete old `bridge_gateway.ts` backup

---

## Testing Strategy

### Unit Tests
```typescript
describe('AuthHandler', () => {
  it('should handle auth_start', async () => {
    const authService = mock<AuthService>();
    const handler = new AuthHandler(authService, null, mockHarness);
    const context = mockHandlerContext();

    await handler.handle({ _command: 'auth_start', device: 'test' }, context);

    expect(context.sendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'response',
      data: expect.objectContaining({
        metadata: { kind: 'auth_start' }
      })
    }));
  });
});
```

### Integration Tests
```typescript
describe('BridgeGateway', () => {
  it('should route commands to correct handlers', async () => {
    const gateway = new BridgeGateway(mockBus, mockHarness, workingDir);
    const payload = { type: 'auth_start', data: { device: 'test' } };

    await gateway.handlePublish('conn1', BRIDGE_COMMAND_CHANNEL, payload);

    // Verify auth handler was called
  });
});
```
