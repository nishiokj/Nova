# Permission UI Fix Spec

## Problem Statement

Permission requests are **not appearing** in the Dashboard UI and are **not accept/rejectable**. The TUI works correctly with permissions, but the Dashboard (web UI) has no support for handling permission requests.

## Root Cause Analysis

### Working Path: TUI
```
1. Agent requests permission (Bash/Write/Edit)
   ↓
2. PermissionChecker.check() returns { granted: 'ask' }
   ↓
3. Harness creates request and emits event via emit callback
   → Event goes to EventBus
   → Event goes to eventQueue (for TUI)
   → Event goes to BusServer (for clients)
   ↓
4. TUI BridgeClient receives event via TCP connection
   ↓
5. TUI handlePermissionRequest() is called
   → store.setActivePermissionRequest()
   → store.uiMode = 'permission'
   ↓
6. PermissionPrompt component renders
   ↓
7. User selects Allow/Always Allow/Deny
   ↓
8. TUI sends permission_response command via BridgeClient
   ↓
9. BridgeGateway.handlePermissionResponse() processes response
   → permissionChecker.handleResponse()
   → Resolves pending promise
   → Agent proceeds with blocked action
```

### Broken Path: Dashboard
```
1. Agent requests permission (Bash/Write/Edit)
   ↓
2. PermissionChecker.check() returns { granted: 'ask' }
   ↓
3. Harness creates request and emits event via emit callback
   → Event goes to EventBus
   ↓
4. BusServer publishes to 'events:all' channel (via eventBus.subscribeAll)
   ↓
5. ControlPlaneServer subscribes to 'events:all' via BusClient
   → SSE stream sends event to Dashboard
   ↓
6. Dashboard receives event via useEventStream hook
   → Event is passed to handleSseRefresh()
   → NO HANDLER for 'permission_request' type
   ↓
7. Event is silently ignored
   → No UI shows permission prompt
   → No way for user to accept/reject
   → Agent eventually times out (60s) and blocks
```

## Architecture Gap

### Current Dashboard Event Flow
The Dashboard's SSE event stream handler in `use-polling.ts`:
```typescript
const handleSseRefresh = async (event: CockpitEventStreamEvent | null) => {
  if (!event) return;

  // Handled event types:
  // - 'agent_message' → injectStreamChunk()
  // - 'response' → handleSseRefresh() → full reload
  // - 'progress' → update status
  // - 'status' → update status
  // - 'error' → update error
  // - 'transcription' → ignore

  // NOT handled:
  // - 'permission_request' → SILENTLY IGNORED
};
```

### Missing Dashboard Components

1. **No Permission Request Handler**
   - No state management for pending permission requests
   - No UI component to display permission prompts
   - No way to send permission responses back to harness

2. **No Permission Response API**
   - Dashboard needs to send commands like TUI does
   - No API endpoint for sending permission responses
   - No WebSocket or HTTP POST method to submit decisions

## Solution Design

### Phase 1: Permission Request UI

#### 1.1 Add Permission State to CockpitStore
```typescript
// packages/dashboard-control/src/hooks/use-cockpit-store.ts

export interface PermissionRequest {
  requestId: string;
  tool: 'Bash' | 'Write' | 'Edit';
  target: string;
  suggestedPattern: string;
  workingDirectory: string;
  description: string;
  sessionKey: string;
  timestamp: number;
}

export interface PermissionResponse {
  requestId: string;
  decision: 'allow' | 'always_allow' | 'deny';
  pattern?: string;
}

interface CockpitStoreState {
  // ... existing state
  pendingPermissions: PermissionRequest[];
  permissionDialogOpen: boolean;
}
```

#### 1.2 Handle permission_request Events
```typescript
// In handleSseRefresh()
case 'permission_request': {
  const permissionRequest = parsePermissionRequest(event);
  if (permissionRequest) {
    store.addPendingPermission(permissionRequest);
  }
  break;
}
```

#### 1.3 Create PermissionDialog Component
```typescript
// packages/dashboard-control/src/components/center/PermissionDialog.tsx

export function PermissionDialog() {
  const pendingPermissions = useCockpit(s => s.pendingPermissions);
  const dialogOpen = useCockpit(s => s.permissionDialogOpen);
  const currentRequest = pendingPermissions[0]; // Show oldest first

  return (
    <Dialog open={dialogOpen}>
      <DialogContent>
        <DialogTitle>Permission Required</DialogTitle>
        <ToolIcon tool={currentRequest.tool} />
        <TargetText>{currentRequest.target}</TargetText>
        <Description>{currentRequest.description}</Description>
        <SuggestedPattern>{currentRequest.suggestedPattern}</SuggestedPattern>
        <Actions>
          <Button onClick={() => respond('allow')}>
            Allow
          </Button>
          <Button onClick={() => respond('always_allow', currentRequest.suggestedPattern)}>
            Always Allow
          </Button>
          <Button onClick={() => respond('deny')}>
            Deny
          </Button>
        </Actions>
      </DialogContent>
    </Dialog>
  );
}
```

### Phase 2: Permission Response API

#### 2.1 Add API Endpoint for Permission Responses
```typescript
// packages/dashboard-control/src/lib/api/permissions.ts

export async function postPermissionResponse(
  sessionKey: string,
  response: PermissionResponse
): Promise<{ success: boolean }> {
  return postAPI(`/cockpit/permissions/response`, {
    session_key: sessionKey,
    ...response,
  });
}
```

#### 2.2 Add Control Plane Handler
```typescript
// packages/harness-daemon/src/harness/routes/cockpit.ts

export function handlePostPermissionResponse(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlPlaneContext
): void {
  const sessionKey = extractSessionKey(req);
  const requestId = extractParam(req, 'request_id');
  const decision = extractParam(req, 'decision');
  const pattern = extractParam(req, 'pattern');

  const sessionChecker = ctx.harness.getSessionPermissionChecker?.(sessionKey);
  if (!sessionChecker) {
    sendJson(res, { error: 'Session not found' }, 404);
    return;
  }

  sessionChecker.handleResponse({
    requestId,
    decision: decision as 'allow' | 'always_allow' | 'deny',
    pattern,
  });

  sendJson(res, { success: true });
}
```

### Phase 3: Integration

#### 3.1 Add Route Registration
```typescript
// packages/harness-daemon/src/harness/control_plane_routes.ts

if (pathname === '/control-plane/cockpit/permissions/response' && req.method === 'POST') {
  handlePostPermissionResponse(req, res, ctx);
  return true;
}
```

#### 3.2 Wire Dialog to API
```typescript
// In CockpitStore

async respondToPermission(
  requestId: string,
  decision: 'allow' | 'always_allow' | 'deny',
  pattern?: string
): Promise<void> {
  const sessionKey = this.state.focusData?.sessionKey;
  if (!sessionKey) return;

  try {
    await postPermissionResponse(sessionKey, {
      requestId,
      decision,
      pattern,
    });

    // Remove from pending permissions
    this.state.pendingPermissions = this.state.pendingPermissions.filter(
      p => p.requestId !== requestId
    );

    if (this.state.pendingPermissions.length === 0) {
      this.state.permissionDialogOpen = false;
    }
  } catch (error) {
    console.error('Failed to submit permission response:', error);
  }
}
```

## Implementation Checklist

- [ ] **Phase 1: Permission Request UI**
  - [ ] Add PermissionRequest type to types.ts
  - [ ] Add pendingPermissions state to CockpitStore
  - [ ] Add addPendingPermission() method to CockpitStore
  - [ ] Add permission_request handler to handleSseRefresh()
  - [ ] Create PermissionDialog component
  - [ ] Add dialog to App.tsx render tree

- [ ] **Phase 2: Permission Response API**
  - [ ] Create postPermissionResponse() API function
  - [ ] Create handlePostPermissionResponse() handler
  - [ ] Add route to control_plane_routes.ts
  - [ ] Add respondToPermission() method to CockpitStore

- [ ] **Phase 3: Testing**
  - [ ] Test permission dialog appears when agent requests Bash
  - [ ] Test permission dialog appears when agent requests Write
  - [ ] Test permission dialog appears when agent requests Edit
  - [ ] Test "Allow" response works
  - [ ] Test "Always Allow" response works
  - [ ] Test "Deny" response works
  - [ ] Test timeout handling (60s)
  - [ ] Test multiple queued permissions

## Edge Cases

1. **Multiple Pending Permissions**
   - Show one at a time, process sequentially
   - Queue maintains order of arrival

2. **Session Switch During Permission**
   - Clear pending permissions when switching sessions
   - Show warning if there are unhandled permissions

3. **Permission Timeout**
   - If agent times out (60s), remove from pending list
   - Show error message in dialog
   - Agent will be blocked anyway

4. **Network Failure**
   - If permission response fails to send, retry
   - Keep dialog open on error
   - Allow user to retry or cancel

5. **Permission State Persistence**
   - Pending permissions are session-specific
   - Lost on page refresh (acceptable for now)
   - Could persist to localStorage if needed

## Technical Notes

### Event Flow Comparison

| Aspect | TUI | Dashboard (Current) | Dashboard (Fixed) |
|--------|-----|-------------------|-------------------|
| Permission Request Event | TCP Bridge | SSE Stream | SSE Stream |
| Event Handler | handlePermissionRequest() | NONE | handlePermissionRequest() |
| State Store | TUIStore | CockpitStore | CockpitStore |
| UI Component | PermissionPrompt | NONE | PermissionDialog |
| Response Mechanism | TCP Command | NONE | HTTP POST |
| Response Handler | handlePermissionResponse() | NONE | handlePostPermissionResponse() |

### Why Dashboard Can't Use TUI's PermissionPrompt

1. **Different Rendering**: TUI uses Ink (terminal UI), Dashboard uses React (web)
2. **Different State**: TUI uses TUIStore, Dashboard uses CockpitStore
3. **Different Communication**: TUI uses TCP bridge, Dashboard uses HTTP/SSE
4. **Design Patterns**: Terminal modal vs web dialog require different UX

### Performance Considerations

1. **SSE Stream**: Already established, adding permission handler adds minimal overhead
2. **HTTP POST**: Permission responses are infrequent, HTTP overhead is negligible
3. **State Management**: Single pending permission array, O(n) operations on small n

### Security Considerations

1. **Authorization**: Only session owner can respond to permissions
2. **CSRF Protection**: Add CSRF token to permission responses if needed
3. **Session Validation**: Verify sessionKey belongs to authenticated user

## References

- Permission types: `packages/types/src/permissions.ts`
- PermissionChecker: `packages/harness-daemon/src/harness/permissions.ts`
- TUI PermissionPrompt: `packages/tui/components/PermissionPrompt.tsx`
- TUI permission handling: `packages/tui/index.tsx:728` (handlePermissionRequest)
- SSE stream: `packages/dashboard-control/src/hooks/use-polling.ts:45` (useEventStream)
- CockpitStore: `packages/dashboard-control/src/hooks/use-cockpit-store.ts`
