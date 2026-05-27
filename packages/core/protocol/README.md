# @nova/protocol

Language-neutral Nova wire protocol types and validators.

This package is the contract surface for clients in any language. It contains:

- bus message types and channel helpers
- bridge command/event types and guards
- RPC request/response/procedure types and guards
- `fixtures/conformance.json` for non-TypeScript client validation

It deliberately does not contain daemon runtime code or a WebSocket transport.

## Install

```bash
npm install @nova/protocol
```

## Usage

```ts
import {
  BRIDGE_COMMAND_CHANNEL,
  isBridgeCommand,
  isBridgeEvent,
  isRpcRequest,
  isRpcResponse,
  runChannel,
  sessionChannel,
} from '@nova/protocol';
```

## Conformance

The published package includes JSON fixtures:

```text
fixtures/conformance.json
```

Use these fixtures to validate clients in Python, Go, Rust, or other runtimes without depending on TypeScript implementation details.
