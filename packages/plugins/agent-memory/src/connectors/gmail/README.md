# Gmail Connector

Connector for Gmail API v1. Enables syncing email messages into the agent-memory canonical entity model.

## Features

- **Backfill Sync**: Fetch all historical emails
- **Incremental Sync**: Real-time sync via Gmail History API
- **Pub/Sub Webhooks**: Push notifications for instant updates
- **Entity Mapping**: Emails → `Message` entities, Contacts → `Identity` entities
- **Rate Limiting**: Respects Gmail's 100 queries per 100 seconds limit

## Setup

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable Gmail API:
   - Navigate to APIs & Services → Library
   - Search for "Gmail API"
   - Click "Enable"

### 2. Create OAuth 2.0 Credentials

1. Go to APIs & Services → Credentials
2. Click "Create Credentials" → "OAuth client ID"
3. Select "Web application" or "Desktop application"
4. Configure consent screen (if prompted):
   - User type: External
   - Add app name, developer contact email
   - Add scopes:
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.metadata`
5. Configure OAuth client:
   - Name: "Agent Memory Gmail Connector"
   - Authorized redirect URIs: Add your app's callback URL
   - Click "Create"
6. Save the **Client ID** and **Client Secret**

### 3. Configure Environment Variables

Add the following to your environment. These are **centralized Google OAuth credentials** used by all Google connectors (Gmail, Calendar, Drive, etc.):

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

### 4. (Optional) Set Up Pub/Sub Push

For real-time webhook notifications:

1. Create a Pub/Sub topic:
   ```bash
   gcloud pubsub topics create gmail-notifications
   ```

2. Create a Pub/Sub subscription:
   ```bash
   gcloud pubsub subscriptions create gmail-subscription \
     --topic=gmail-notifications \
     --push-endpoint=https://your-domain.com/webhooks/gmail
   ```

3. Configure Gmail watch (via API):
   ```bash
   POST https://gmail.googleapis.com/gmail/v1/users/me/watch
   {
     "topicName": "projects/your-project/topics/gmail-notifications",
     "labelIds": ["INBOX"]
   }
   ```

## Usage

### Creating the Connector

```typescript
import { createGmailConnector } from '@agent-memory/connectors'

// OAuth credentials are managed centrally via OAuthProviderRegistry
// (loaded from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars)
const connector = createGmailConnector({
  rateLimit: 10,  // Requests per second
  labels: ['INBOX', 'IMPORTANT'],  // Labels to sync
  excludeLabels: ['SPAM', 'TRASH'],  // Labels to exclude
})
```

### OAuth Flow

#### 1. Get Authorization URL

```typescript
const state = 'random-state-string'  // Generate and store
const redirectUri = 'https://your-app.com/callback'

const authUrl = connector.getAuthorizationUrl(state, redirectUri)

// Redirect user to authUrl
```

#### 2. Handle Callback

```typescript
const code = req.query.code // From callback URL
const tokens = await connector.exchangeCodeForTokens(code, redirectUri)

// tokens.accessToken - for API calls
// tokens.refreshToken - for refreshing access
```

#### 3. Refresh Tokens

```typescript
if (tokens.expiresAt && Date.now() > tokens.expiresAt) {
  const newTokens = await connector.refreshTokens(tokens.refreshToken)
}
```

### Backfill Sync

Fetch historical emails:

```typescript
import type { ConnectorContext } from '@agent-memory/connector/sdk'

const ctx: ConnectorContext = {
  accountId: 'user-account-id',
  accessToken: tokens.accessToken,
  credentials: undefined,
  config: {},
}

let cursor: string | undefined
let hasMore = true

while (hasMore) {
  const result = await connector.fetchPage(ctx, {
    cursor,
    limit: 50,
    entityTypes: ['message'],
  })

  // Process SourceItems
  for (const item of result.items) {
    console.log(`Syncing message ${item.source_id}`)
    // Map to canonical entity:
    const mapper = connector.getMapper(item.entity_type)
    const mapped = mapper?.map(item.raw_data, { accountId: ctx.accountId, ... })
  }

  cursor = result.nextCursor
  hasMore = result.hasMore
}
```

### Incremental Sync

Sync changes via History API:

```typescript
import type { FetchChangesOptions } from '@agent-memory/connector/sdk'

let historyId = '1' // Start from beginning, or store last sync

const result = await connector.fetchChanges(ctx, {
  since: historyId,
  limit: 100,
})

for (const item of result.items) {
  // Process added/deleted messages
  if (item.raw_data?.deleted) {
    console.log(`Message ${item.source_id} was deleted`)
  } else {
    console.log(`Message ${item.source_id} was added/modified`)
  }
}

// Store new historyId for next sync
historyId = result.nextHistoryId ?? historyId
```

### Webhook Handling

Handle Pub/Sub push notifications:

```typescript
import type { WebhookEvent } from '@agent-memory/connector/sdk'

app.post('/webhooks/gmail', async (req, res) => {
  const event: WebhookEvent = {
    deliveryId: 'unique-id',
    eventType: 'gmail.notification',
    payload: req.body,
    headers: req.headers,
    signature: req.headers['x-goog-signature'] || '',
    receivedAt: new Date(),
  }

  // Parse webhook payload
  const items = await connector.parseWebhookPayload(event)

  // Process changed messages
  for (const item of items) {
    console.log(`Webhook: changed message ${item.source_id}`)
    // Fetch full message data and process
  }

  res.status(200).send('OK')
})
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `rateLimit` | `number` | `10` | Max API requests per second (Gmail limit: 100/100s) |
| `labels` | `string[]` | `[]` | Specific labels to sync (empty = all labels) |
| `excludeLabels` | `string[]` | `['SPAM', 'TRASH']` | Labels to exclude from sync |

> **Note**: OAuth credentials (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) are managed centrally by the `OAuthProviderRegistry`, not passed to individual connectors.

## Supported Entity Types

| Source Type | Target Entity | Description |
|-------------|---------------|-------------|
| `message` | `Message` | Email messages with body, headers, attachments |
| `thread` | `Message` | Email thread messages (derived) |
| `identity` | `Identity` | Email contacts (sender/recipient mapping) |

## Message Entity Mapping

Gmail messages map to canonical `Message` entities:

| Gmail Field | Message Field | Notes |
|------------|---------------|-------|
| `id` | `source_refs[0].source_id` | Message ID |
| `threadId` | `platform_thread_id` | Thread identifier |
| `payload.headers['Subject']` | `subject` | Email subject |
| `payload.headers['From']` | `sender_identity_id` | Mapped to Identity |
| `payload.headers['To']` | `recipient_identity_ids[]` | Mapped to Identities |
| `payload.body` / `parts[]` | `body_text` | Plain text content |
| `payload.parts[]` (text/html) | `body_html` | HTML content |
| `internalDate` | `sent_at`, `received_at` | Timestamp (ms → ISO) |
| `labelIds` | `labels` | Gmail labels |
| `labelIds.includes('UNREAD')` | `is_read` | Read status |
| `payload.parts[]` (attachments) | `attachment_ids[]` | Attachment references |

## Identity Entity Mapping

Email addresses from headers map to canonical `Identity` entities:

| Email Field | Identity Field | Notes |
|-------------|----------------|-------|
| Email address | `email` | Full email address |
| Display name | `display_name` | From "Name <email>" format |
| `gmail` | `platform` | Fixed platform value |
| Email (lowercased) | `platform_user_id` | Stable user identifier |

## Rate Limiting

Gmail API enforces quotas:

- **User rate limit**: 100 queries per 100 seconds per user
- **Daily quota**: Varies by project

The connector respects rate limits via:
- Token bucket rate limiter (configurable via `rateLimit`)
- Exponential backoff with jitter on errors
- Circuit breaker to prevent cascading failures

## Pagination Strategy

### Message List (Backfill)

- Uses `pageToken` for pagination
- Default page size: 50 messages (configurable via `limit`)
- Each message requires a separate fetch for full data

### History API (Incremental)

- Uses `startHistoryId` to fetch changes
- Returns all changes since given history ID
- No pagination for history requests

## Error Handling

The connector uses resilient HTTP client with:

| Error Type | Strategy |
|------------|----------|
| Rate limit (429) | Exponential backoff with jitter |
| Server error (5xx) | Retry up to 3 times |
| Network error | Retry up to 3 times |
| Invalid response | Circuit breaker opens after failures |

## Testing

Run unit tests:

```bash
pnpm test -- packages/plugins/agent-memory/src/connectors/gmail/mappers.test.ts
pnpm test -- packages/plugins/agent-memory/src/connectors/gmail/index.test.ts
```

## API References

- [Gmail REST API](https://developers.google.com/gmail/api/reference/rest)
- [Gmail API Scopes](https://developers.google.com/gmail/api/auth/reference)
- [Gmail History API](https://developers.google.com/gmail/api/reference/rest/v1/users.history)
- [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)

## Troubleshooting

### "Invalid client" error
- Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars are set correctly
- Check OAuth consent screen is configured in GCP Console

### "Insufficient Permission" error
- Verify API scopes are enabled in GCP Console
- Ensure user authorized the required scopes

### "Quota exceeded" error
- Reduce `rateLimit` in connector config
- Check project quota in GCP Console

### Webhook not receiving events
- Verify Pub/Sub subscription is active
- Check Gmail watch is configured correctly
- Ensure webhook endpoint is publicly accessible

## Future Enhancements

Out of scope for MVP:

- [ ] Write operations (send email, reply)
- [ ] Contacts sync via People API
- [ ] Full attachment download and storage
- [ ] Gmail labels/folders management
- [ ] Smart inbox features (important categorization)
- [ ] Draft message sync
- [ ] Search filters integration
