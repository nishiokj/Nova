# nova-client

Python client for a Nova daemon or private Nova service.

The client speaks the public Nova WebSocket/RPC protocol. It is intentionally independent from daemon internals and mirrors the TypeScript `@nova/client` surface where practical.

## Install

```bash
pip install nova-client
```

For local development from this repository:

```bash
python3 -m pip install -e packages/clients/python
```

## Connect

```python
from nova_client import NovaClient

client = NovaClient(
    host="127.0.0.1",
    port=9555,
    auth_token="replace-me",
)

client.connect()
print(client.health())
print(client.readiness())
client.close()
```

`auth_token` is optional for local unauthenticated daemons. Private deployments should set `NOVA_SERVICE_TOKEN` on the daemon and pass the same value to the client.

## Run a Task

```python
from nova_client import NovaClient

client = NovaClient("127.0.0.1", 9555, auth_token="replace-me")
client.connect()

client.init_session(working_dir="/workspace/app")
response = client.run_to_completion(
    "Summarize this repository in 5 bullets.",
    working_dir="/workspace/app",
)

print(response.get("content"))
client.close()
```

## Lower-Level APIs

```python
client.send({"type": "init", "data": {"working_dir": "/workspace/app"}})
sessions = client.request("session.list", {"limit": 20})
```

Use the lower-level APIs when you need direct event handling or custom protocol flows.
