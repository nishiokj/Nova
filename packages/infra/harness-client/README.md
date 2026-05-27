# @nova/client

TypeScript client for a Nova daemon or private Nova service.

The client speaks the public Nova protocol over WebSocket. It depends on `@nova/protocol` and `ws`; it does not depend on daemon internals.

## Install

```bash
npm install @nova/client
```

## Connect

```ts
import { HarnessClient } from '@nova/client';

const nova = new HarnessClient({
  host: '127.0.0.1',
  port: 9555,
  authToken: process.env.NOVA_SERVICE_TOKEN,
  requestTimeout: 120_000,
});

await nova.connect();
```

`authToken` is optional for local unauthenticated daemons. Private deployments should set `NOVA_SERVICE_TOKEN` on the daemon and pass the same value to the client.

## Health

```ts
console.log(await nova.health());
console.log(await nova.readiness());
```

## Run a task

```ts
await nova.initSession({ workingDir: process.cwd() });

const response = await nova.runToCompletion({
  text: 'Summarize this repository in 5 bullets.',
  workingDir: process.cwd(),
});

console.log(response.content);
nova.close();
```

## Lower-level APIs

The ergonomic helpers are built on top of the raw bridge and RPC surfaces:

```ts
nova.send({ type: 'init', data: { working_dir: process.cwd() } });
const sessions = await nova.rpc.call('session.list', { limit: 20 });
```

Use the raw APIs when building custom clients that need full control over event handling.
