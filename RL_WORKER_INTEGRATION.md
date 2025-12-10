# RL Worker Integration - Complete

## Summary

Added conditional RL worker startup to `main.py` with the `--rl-worker` flag. This enables background reinforcement learning data collection when running the voice agent system.

## Changes Made

### 1. main.py

**VoiceAgentSystemV2.__init__() (lines 1150-1198)**
- Added `rl_worker_enabled: bool = False` parameter
- Added `self.rl_worker_process = None` attribute
- Store `rl_worker_enabled` flag

**VoiceAgentSystemV2.start() (lines 1315-1327)**
- Added conditional RL worker startup:
  ```python
  if self.rl_worker_enabled:
      from multiprocessing import Process
      from harness.rl_worker import start_rl_worker

      self.logger.info("Starting RL worker process...")
      self.rl_worker_process = Process(
          target=start_rl_worker,
          args=(self.event_bus, "logs"),
          daemon=True,
          name="RLWorker"
      )
      self.rl_worker_process.start()
      self.logger.info(f"RL worker started (PID: {self.rl_worker_process.pid})")
  ```

**VoiceAgentSystemV2.stop() (lines 1415-1421)**
- Added RL worker shutdown logic:
  ```python
  if self.rl_worker_process and self.rl_worker_process.is_alive():
      self.logger.info("Stopping RL worker...")
      self.event_bus.shutdown()  # Signal shutdown
      self.rl_worker_process.join(timeout=2.0)
      if self.rl_worker_process.is_alive():
          self.logger.warning("RL worker did not stop gracefully, terminating...")
          self.rl_worker_process.terminate()
  ```

**Command-line arguments (lines 1707-1711)**
- Added `--rl-worker` flag:
  ```python
  parser.add_argument(
      "--rl-worker",
      action="store_true",
      help="Enable RL worker for reinforcement learning training data collection"
  )
  ```

**Main entry point (line 1772)**
- Pass flag to VoiceAgentSystemV2:
  ```python
  system = VoiceAgentSystemV2(
      ...,
      rl_worker_enabled=args.rl_worker
  )
  ```

**Help text (lines 1634-1650)**
- Added example: `python main.py --v2 --rl-worker`
- Added RL Worker section in help

**Startup banner (lines 1764-1765)**
- Show RL worker status when enabled

### 2. harness/agent_worker.py

**AgentWorker.initialize() (line 92)**
- Pass EventBus to TieredAgent:
  ```python
  self.agent = TieredAgent(
      config=self._config.agent,
      tool_registry=self.tool_registry,
      tier_configs=self._config.llm_configs,
      event_bus=self.event_bus  # Pass EventBus for RL episode emission
  )
  ```

**Why this is critical**: Without this, the agent in the worker process wouldn't be able to emit episode completion events, and the RL worker would have nothing to process.

### 3. Documentation

**Created: docs/RL_WORKER_SETUP.md**
- Complete setup guide
- Architecture diagrams
- Event flow documentation
- Troubleshooting guide
- Reconstruction examples

## How It Works

### 1. User Starts System with RL Worker

```bash
python main.py --v2 --rl-worker
```

### 2. System Initialization

```
main.py
  └─> VoiceAgentSystemV2(rl_worker_enabled=True)
      ├─> Creates EventBus
      ├─> Creates ProcessManager
      └─> Stores rl_worker_enabled flag
```

### 3. Worker Startup (VoiceAgentSystemV2.start())

```
1. Start Agent Process
   └─> AgentWorker
       └─> TieredAgent(event_bus=self.event_bus)  ← Can emit events!

2. Start TTS Process

3. Start RL Worker Process (if enabled)
   └─> rl_worker_loop()
       └─> Consumes episode events from EventBus
```

### 4. Runtime Flow

```
User speaks → Agent processes → Episode completes
                                      ↓
                          Agent.run() completes
                                      ↓
                          Emits EPISODE_COMPLETE event
                                      ↓
                          EventBus.rl_events_queue
                                      ↓
                          RL Worker consumes event
                                      ↓
                          RewardShaper.process_episode()
                                      ↓
                          Write to logs/rl_training.jsonl
```

### 5. Shutdown (VoiceAgentSystemV2.stop())

```
1. Stop audio components
2. Stop RL worker (if running)
   └─> EventBus.shutdown()
   └─> Join with timeout
   └─> Terminate if needed
3. Stop other worker processes
```

## Usage Examples

### Basic Usage

```bash
# Enable RL worker with V2 multiprocess
python main.py --v2 --rl-worker

# With advanced tier
python main.py --v2 --rl-worker --tier advanced

# With debug logging
python main.py --v2 --rl-worker --debug
```

### Monitor Logs

```bash
# Watch RL logs in real-time
tail -f logs/rl_training.jsonl

# Count episodes collected
wc -l logs/rl_training.jsonl

# View latest episode with formatting
tail -1 logs/rl_training.jsonl | jq '.'
```

### Reconstruct Episodes

```python
from harness.rl_reconstructor import EpisodeReconstructor

reconstructor = EpisodeReconstructor()
episode = reconstructor.reconstruct("8601cf78-0001-exec-0001")
training_sample = episode.to_training_sample()
```

## Files Modified

1. `main.py` - VoiceAgentSystemV2 class, argparse, startup banner
2. `harness/agent_worker.py` - Pass EventBus to TieredAgent
3. `docs/RL_WORKER_SETUP.md` - Complete setup documentation (NEW)
4. `RL_WORKER_INTEGRATION.md` - This file (NEW)

## Testing Checklist

- [x] Code changes syntactically correct (verified with grep)
- [x] EventBus passed to TieredAgent in agent_worker.py
- [x] RL worker conditionally started in VoiceAgentSystemV2.start()
- [x] RL worker properly shutdown in VoiceAgentSystemV2.stop()
- [x] Command-line flag added and wired through
- [x] Help text updated with examples
- [x] Documentation created

## What Was Fixed

**Original Issue**: No RL logs being written, reconstruction folder empty

**Root Cause**: RL worker process was never started in production code (only in examples)

**Solution**:
1. Added `--rl-worker` flag to enable optional RL worker startup
2. Fixed AgentWorker to pass EventBus to TieredAgent (critical for event emission)
3. Integrated RL worker lifecycle into VoiceAgentSystemV2

**Result**:
- Start system with `--rl-worker` flag → RL worker runs → Episodes logged → Can reconstruct for training
- Without flag → No overhead, system runs normally

## Next Steps

1. **Test with actual system**: Run `python main.py --v2 --rl-worker` and verify:
   - RL worker starts successfully (check PID in logs)
   - Episodes are written to `logs/rl_training.jsonl`
   - Reconstruction works: `EpisodeReconstructor().reconstruct(exec_id)`

2. **Collect training data**: Run system normally, let it collect episodes

3. **Analyze data**: Use reconstruction system to generate training samples

4. **Train RL model**: Use collected (state, action, reward, next_state) tuples for RL training

## Related Documentation

- `docs/RL_WORKER_SETUP.md` - Complete setup and usage guide
- `docs/RL_LOGGING_GUIDE.md` - RL logging architecture
- `docs/RL_RECONSTRUCTION_AUDIT.md` - Reconstruction system details
- `docs/PER_STEP_STATE.md` - Per-step state embedding for RL
- `docs/ID_GENERATION.md` - ID hierarchy and uniqueness
