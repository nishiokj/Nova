# Event Bus Usage Guide

## Which Event Bus Should I Use?

### For **EXISTING** Code (Backward Compatibility)
```python
from communication.event_bus import LegacyEventBus

# Create event bus
event_bus = LegacyEventBus()

# Use old familiar methods
event_bus.submit_agent_request(request)
event_bus.get_agent_response()
event_bus.submit_tts_request(request)
```

**Why `LegacyEventBus`?**
- Maintains 100% backward compatibility with old code
- Provides familiar methods: `submit_agent_request()`, `get_tts_request()`, etc.
- Internally uses the new mailbox pattern (so it's safe and modern under the hood)
- This is what `src/harness/__init__.py` exports as `EventBus`

### For **NEW** Code (Clean Mailbox Pattern)
```python
from communication.event_bus import EventBus
from communication.mailbox import Mailbox
from communication.events import EventType, TTSRequestedEvent

# Create event bus
event_bus = EventBus()

# Create mailbox for your worker
mailbox = Mailbox(worker_id="my_worker")

# Subscribe to events
mailbox.subscribe_to(event_bus, EventType.TTS_REQUESTED)

# Publish events
event = TTSRequestedEvent(request_id="001", text="Hello", priority=0)
event_bus.publish(event)

# Receive events
event = mailbox.receive(timeout=0.5)
```

**Why the new pattern?**
- Clean separation of concerns
- Type-safe event routing
- Process-safe by design
- Easy to add new event types
- No domain-specific logic in the bus

## Files Explained

### Current Implementation
- **`event_bus.py`**: Contains both `EventBus` (new) and `LegacyEventBus` (compatibility wrapper)
- **`mailbox.py`**: Core abstraction for worker communication
- **`events.py`**: All event type definitions (frozen dataclasses)
- **`event_bus_protocol.py`**: Interface definition

### Backup Files (DO NOT IMPORT)
- **`event_bus_old_backup.py`**: Backup of old implementation before refactoring
  - For reference only
  - Will be deleted in Phase 8 cleanup

## Migration Path

If you have old code using the event bus:

1. **Short term**: Use `LegacyEventBus` - it works exactly like the old `EventBus`
2. **Long term**: Migrate to new `EventBus` + `Mailbox` pattern when refactoring

## Architecture Summary

```
Old Pattern (Still works via LegacyEventBus):
Main Process → submit_agent_request() → EventBus → get_agent_request() → Worker

New Pattern:
Main Process → publish(Event) → EventBus → Mailbox → Worker.receive()
```

The `LegacyEventBus` is a bridge - it implements the old methods but uses mailboxes internally.
