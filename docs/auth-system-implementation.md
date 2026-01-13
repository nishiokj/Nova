# Auth System & Provider Management Implementation

## Overview

This document describes the implementation of Google OAuth authentication and encrypted API key management for the Harness TUI. Users must authenticate on startup, and their provider API keys are stored encrypted in GraphD, tied to their user ID.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         User's Machine                          │
├─────────────────────────────────────────────────────────────────┤
│  ~/.config/harness/                                             │
│    ├── session.json   ← Device session token (persistent login) │
│    └── master.key     ← Encryption key for API keys             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────┐    JSONL/TCP     ┌──────────────────┐              │
│  │   TUI   │ ◄──────────────► │  Harness Daemon  │              │
│  └─────────┘     :9555        │    (Event Bus)   │              │
│       │                       └────────┬─────────┘              │
│       │                                │                        │
│       │ (startup auth check)           │                        │
│       ▼                                ▼                        │
│  ┌──────────────┐              ┌─────────────┐                  │
│  │ Auth Service │              │   GraphD    │                  │
│  │   :9556      │              │   :9444     │                  │
│  └──────┬───────┘              └─────────────┘                  │
│         │                            │                          │
│         │ OAuth callback             │ SQLite                   │
│         ▼                            ▼                          │
│    Browser ──►                  .graphd/graph.db                │
│    Google OAuth                 (users, sessions, credentials)  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Components Implemented

### 1. GraphD Schema Changes (v5)

**File:** `packages/graphd/src/schema.ts`

Added three new tables:

```sql
-- Users table (Google OAuth)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,           -- Google 'sub' claim
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    picture_url TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

-- Device sessions (persistent login tokens)
CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,           -- Random UUID (session token)
    user_id TEXT NOT NULL,
    device_name TEXT,
    created_at REAL NOT NULL,
    last_used_at REAL NOT NULL,
    expires_at REAL,               -- NULL = never expires
    revoked INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Encrypted provider credentials (API keys)
CREATE TABLE IF NOT EXISTS provider_credentials (
    id TEXT PRIMARY KEY,           -- Random UUID
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,        -- 'anthropic', 'openai', etc.
    encrypted_key TEXT NOT NULL,   -- AES-256-GCM encrypted
    iv TEXT NOT NULL,              -- Initialization vector (base64)
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, provider)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_revoked ON user_sessions(revoked);
CREATE INDEX IF NOT EXISTS idx_provider_credentials_user_id ON provider_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_provider_credentials_user_provider ON provider_credentials(user_id, provider);
```

**File:** `packages/graphd/src/types.ts`

Added TypeScript interfaces:

```typescript
export interface UserRecord {
  id: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UserSessionRecord {
  id: string;
  userId: string;
  deviceName: string | null;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number | null;
  revoked: boolean;
}

export interface ProviderCredentialRecord {
  id: string;
  userId: string;
  provider: string;
  encryptedKey: string;
  iv: string;
  createdAt: number;
  updatedAt: number;
}

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'openai-compat'
  | 'gemini'
  | 'cerebras'
  | 'together'
  | 'groq'
  | 'fireworks';
```

**File:** `packages/graphd/src/store.ts`

Added CRUD methods:

- `upsertUser(id, email, name?, pictureUrl?)` - Create/update user
- `getUser(id)` / `getUserByEmail(email)` - Retrieve user
- `deleteUser(id)` - Delete user (cascades)
- `createUserSession(id, userId, deviceName?, expiresAt?)` - Create session
- `getUserSession(id)` - Get session by token
- `validateUserSession(id)` - Validate and update last_used_at
- `revokeUserSession(id)` / `revokeAllUserSessions(userId)` - Revoke sessions
- `listUserSessions(userId, includeRevoked?)` - List user's sessions
- `cleanupExpiredUserSessions()` - Remove expired sessions
- `upsertProviderCredential(id, userId, provider, encryptedKey, iv)` - Store encrypted key
- `getProviderCredential(userId, provider)` - Get credential
- `listProviderCredentials(userId)` - List all credentials for user
- `deleteProviderCredential(userId, provider)` - Remove credential
- `hasProviderCredential(userId, provider)` - Check if exists

---

### 2. Auth Service

**Location:** `apps/auth-service/`

```
apps/auth-service/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # Entry point
    ├── server.ts             # HTTP server
    ├── types.ts              # TypeScript types
    └── services/
        ├── crypto.ts         # AES-256-GCM encryption
        ├── google.ts         # Google OAuth client
        └── graphd-client.ts  # GraphStore wrapper
```

**HTTP Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/auth/google` | Start OAuth (returns auth URL + state token) |
| GET | `/auth/google/callback` | OAuth callback from Google |
| POST | `/auth/verify` | Verify session token |
| POST | `/auth/logout` | Revoke session |
| GET | `/providers` | List user's configured providers |
| POST | `/providers/:provider` | Save encrypted API key |
| DELETE | `/providers/:provider` | Remove API key |
| POST | `/providers/:provider/test` | Test API key validity |

**OAuth Flow:**

1. TUI calls `GET /auth/google?device=hostname`
2. Auth service returns `{ authUrl, stateToken }`
3. TUI opens browser to `authUrl`
4. User signs in with Google
5. Google redirects to `/auth/google/callback?code=...&state=...`
6. Auth service:
   - Validates state token
   - Exchanges code for tokens
   - Fetches user info from Google
   - Creates/updates user in GraphD
   - Creates device session
   - Returns success page with session token
7. TUI polls local session file or auth service
8. Once authenticated, TUI proceeds to main UI

**Encryption:**

- Algorithm: AES-256-GCM (authenticated encryption)
- Key source (in order):
  1. `HARNESS_ENCRYPTION_KEY` environment variable (derived via scrypt)
  2. `~/.config/harness/master.key` file (generated if not exists)
- Each API key gets a unique IV (initialization vector)

---

### 3. Config Types

**File:** `apps/harness-daemon/src/harness/config_types.ts`

Added:

```typescript
export interface AuthConfigSection {
  enabled: boolean;
  host: string;
  port: number;
  session_expiry_days?: number | null; // null = never expires
}

export const DEFAULT_AUTH_CONFIG: AuthConfigSection = {
  enabled: true,
  host: '127.0.0.1',
  port: 9556,
  session_expiry_days: null,
};
```

Updated `HarnessConfigFile` and `FullHarnessConfig` to include `auth` section.

---

### 4. TUI Utilities

**File:** `apps/tui/utils/session.ts`

Local session storage at `~/.config/harness/session.json`:

```typescript
export interface LocalSession {
  sessionToken: string;
  userId: string;
  email: string;
  name?: string;
  createdAt: number;
}

export function loadLocalSession(): LocalSession | null;
export function saveLocalSession(session: LocalSession): void;
export function clearLocalSession(): void;
export function hasLocalSession(): boolean;
```

**File:** `apps/tui/utils/auth-client.ts`

Auth service client:

```typescript
export class AuthClient {
  constructor(config?: { host?: string; port?: number });

  isAvailable(): Promise<boolean>;
  startLogin(deviceName?: string): Promise<{ authUrl: string; stateToken: string }>;
  verifySession(sessionToken: string): Promise<{ valid: boolean; user?: {...} }>;
  logout(sessionToken: string): Promise<boolean>;
  listProviders(sessionToken: string): Promise<ProviderInfo[]>;
  saveProviderKey(sessionToken: string, provider: string, apiKey: string): Promise<{ success: boolean; error?: string }>;
  deleteProviderKey(sessionToken: string, provider: string): Promise<boolean>;
  testProviderKey(sessionToken: string, provider: string): Promise<{ valid: boolean; error?: string }>;
  checkLocalSession(): Promise<{ valid: boolean; session: LocalSession | null; user?: {...} }>;
  saveSession(sessionToken: string, userId: string, email: string, name?: string): void;
}
```

---

### 5. TUI Components

**File:** `apps/tui/components/AuthGate.tsx`

Wraps the main app and handles authentication:

- On mount: Checks local session, validates with auth service
- If unauthenticated: Shows sign-in prompt
- On Enter: Starts OAuth flow, opens browser
- Polls for completion, then renders children

**File:** `apps/tui/components/ProvidersView.tsx`

Provider management UI:

- Lists all supported providers with configured status
- Add/update API keys (masked input)
- Delete API keys (with confirmation)
- Test API key validity
- Keyboard navigation

**File:** `apps/tui/commands.ts`

Added `/providers` to `SLASH_COMMANDS` and `HELP_LINES`.

**File:** `apps/tui/types.ts`

Added `"providers"` to `UIMode` type.

---

## Integration with index.tsx

The following changes need to be made to `apps/tui/index.tsx`:

### Step 1: Add Imports

At the top of the file, add:

```typescript
import { AuthGate } from "./components/AuthGate.js";
import { ProvidersView } from "./components/ProvidersView.js";
import { loadLocalSession, type LocalSession } from "./utils/session.js";
```

### Step 2: Add Auth State to App

In the `App` component, add state for the authenticated session:

```typescript
// Around line 152, after other useState declarations
const [authSession, setAuthSession] = useState<LocalSession | null>(null);
```

### Step 3: Add /providers Handler

In the `handleSlashCommand` function (around line 1102), add a case for `/providers`:

```typescript
case "/providers":
  store.setUIMode("providers");
  return;
```

### Step 4: Add Store Method for providers Mode

In `apps/tui/store.ts`, ensure `setUIMode` supports `"providers"`:

```typescript
// This should already work since UIMode includes "providers"
setUIMode(mode: UIMode) {
  this.snapshot.uiMode = mode;
  this.notify();
}
```

### Step 5: Render ProvidersView

In the main return statement of `App` (around line 1388), add a condition for providers mode. Before the existing JSX:

```typescript
// After the helpVisible check (around line 1374)
if (snapshot.uiMode === "providers") {
  return (
    <ProvidersView
      width={width}
      onClose={() => store.setUIMode("chat")}
    />
  );
}
```

### Step 6: Handle Escape in providers Mode

In the `useInput` handler, add escape handling for providers mode:

```typescript
// In the useInput callback, add:
if (snapshot.uiMode === "providers") {
  if (key.escape) {
    store.setUIMode("chat");
    return;
  }
  // Let ProvidersView handle other inputs
  return;
}
```

### Step 7: Wrap with AuthGate

At the bottom of the file, wrap the render call:

```typescript
// Replace the existing render call (around line 1528)
render(
  <AuthGate
    onAuthenticated={(session) => {
      // Session is now available globally if needed
      console.log(`Authenticated as ${session.email}`);
    }}
  >
    <App options={options} />
  </AuthGate>
);
```

### Step 8: Export Session for Use in Commands

If you need the session in the App component (e.g., for passing to ProvidersView), modify the AuthGate to use a context or prop drilling:

**Option A: Use a wrapper component**

```typescript
function AuthenticatedApp({ options }: { options: AppOptions }) {
  const [session, setSession] = useState<LocalSession | null>(null);

  return (
    <AuthGate onAuthenticated={setSession}>
      {session && <App options={options} session={session} />}
    </AuthGate>
  );
}

render(<AuthenticatedApp options={options} />);
```

**Option B: Load session in App**

Since the session is stored locally, App can load it directly:

```typescript
// In App component
const session = useMemo(() => loadLocalSession(), []);
```

---

## Environment Variables

### Required

```bash
# Google OAuth credentials (from Google Cloud Console)
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
```

### Optional

```bash
# Auth service configuration
AUTH_SERVICE_HOST=127.0.0.1      # Default: 127.0.0.1
AUTH_SERVICE_PORT=9556            # Default: 9556
GOOGLE_REDIRECT_URI=http://127.0.0.1:9556/auth/google/callback

# Database path
GRAPHD_DB_PATH=~/.graphd/graphd.db  # Default

# Encryption (if not set, generates master.key file)
HARNESS_ENCRYPTION_KEY=your_secret_key
HARNESS_MASTER_KEY_PATH=~/.config/harness/master.key  # Default
```

---

## Google Cloud Console Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the Google+ API (or Google Identity)
4. Go to **APIs & Services > Credentials**
5. Click **Create Credentials > OAuth client ID**
6. Select **Web application**
7. Add authorized redirect URI: `http://127.0.0.1:9556/auth/google/callback`
8. Copy the Client ID and Client Secret
9. Set them as environment variables

---

## Running the System

### 1. Start GraphD (if not embedded)

```bash
cd packages/graphd
bun run start
```

### 2. Start Auth Service

```bash
cd apps/auth-service
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=xxx bun run start
```

### 3. Start Harness Daemon

```bash
cd apps/harness-daemon
bun run start
```

### 4. Start TUI

```bash
cd apps/tui
bun run start
```

---

## Verification Tests

### Auth Flow Test

1. Start all services
2. Start TUI → should show auth prompt
3. Press Enter → browser opens Google sign-in
4. Complete sign-in → return to TUI
5. TUI should show authenticated state
6. Quit and restart TUI → should remain authenticated

### Provider Management Test

1. (Authenticated) Run `/providers`
2. Should show provider list with none configured
3. Select a provider, press Enter
4. Enter API key → should save
5. Press T to test → should show valid/invalid
6. Press D to delete → confirm → should remove

### Persistence Test

1. Add provider key
2. Quit TUI
3. Restart TUI → should still be authenticated
4. Run `/providers` → should show saved provider
5. Run agent that uses provider → should work without env var

### Multi-Device Test

1. Authenticate on device A
2. Authenticate on device B (same Google account)
3. Both should have independent sessions
4. Provider keys should be accessible from both

---

## Security Considerations

1. **Session tokens** are random 256-bit values, stored locally with restricted file permissions (0600)
2. **API keys** are encrypted with AES-256-GCM before storage
3. **Master key** is stored with restricted permissions or derived from environment variable
4. **OAuth state tokens** are short-lived (10 minutes) and single-use
5. **Sessions can be revoked** server-side, invalidating all devices
6. **Cascading deletes** ensure user deletion removes all sessions and credentials

---

## Files Changed/Created

### New Files

- `apps/auth-service/` (entire package)
- `apps/tui/utils/session.ts`
- `apps/tui/utils/auth-client.ts`
- `apps/tui/components/AuthGate.tsx`
- `apps/tui/components/ProvidersView.tsx`

### Modified Files

- `packages/graphd/src/schema.ts` - Added v5 migration
- `packages/graphd/src/store.ts` - Added auth CRUD methods
- `packages/graphd/src/types.ts` - Added auth types
- `apps/harness-daemon/src/harness/config_types.ts` - Added AuthConfigSection
- `apps/tui/commands.ts` - Added /providers command
- `apps/tui/types.ts` - Added "providers" to UIMode

### Files Requiring Manual Integration

- `apps/tui/index.tsx` - See "Integration with index.tsx" section above
