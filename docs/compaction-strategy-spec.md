# Intelligent Context Compaction Specification

## 1. Purpose and Scope
This specification defines a pragmatic, cache-aware compaction strategy for large language model (LLM) context windows. It synthesizes recent insights about cache hit/miss dynamics, the exponential loss function that governs model performance under heavy token loads, and two distinct degradation modes—**naive-naive** and **naive-aware**—that emerge when context is pruned too aggressively. The goal is to help the orchestrator maintain decision-quality context while minimizing waste across the three scarce resources: **tokens, iterations, and latency**.

## 2. Operating Realities
### 2.1 Cache hit/miss dynamics
- **Mutation penalty**: Any full rewrite of the non-system context (e.g., compressing 100k tokens into a 25k summary) forces the next turn to be a cache miss because the prompt hash changes. The immediate cost equals the entire rewritten portion.
- **Amortization via divisor _D_**: If compaction reduces the window by a factor of `D`, the one-turn cache miss cost amortizes after roughly `D` turns. Even small `D` (e.g., 4) pays back quickly in active conversations.
- **Trigger heuristic**: Prefer compaction when `current_tokens × (1 - 1/D)` is less than the expected cumulative savings from `Q × M`, where `Q` is cached-vs-uncached token delta per turn and `M` is estimated remaining turns.

### 2.2 Exponential loss function
- Empirically, response quality does not degrade linearly with token count; beyond a model-specific comfort band (≈40–70% of max window) loss accelerates exponentially.
- Maintaining headroom (e.g., only fill 70% of window) is therefore higher-leverage than squeezing incremental context into a near-capacity prompt.
- The compaction engine must treat **context fullness** as a first-class signal, not just absolute token count.

### 2.3 Resource budget alignment
- **Tokens**: cache misses, summaries, and rediscovery queries all consume tokens.
- **Iterations**: naive-aware recovery loops cost extra turns.
- **Latency**: summarization and follow-up tool calls stall users. Compaction decisions must quote expected latency impact alongside token savings.

## 3. Error Taxonomy & Guardrails
### 3.1 Naive-naive failure
- **Definition**: The agent loses essential state and does not realize it, leading to confident but wrong work.
- **Symptoms**: Missing constraints, stale assumptions, or reintroducing previously fixed bugs.
- **Guardrails**:
  - Preserve high-scoring artifacts (references, summaries, plans) alongside file snippets.
  - Require dual confirmation before evicting any item tied to the active goal or most recent instructions.
  - Emit a “context integrity checksum” (hash of critical facts) before compaction and verify after.

### 3.2 Naive-aware failure
- **Definition**: The agent notices missing context and re-discovers it via extra tool calls.
- **Cost**: Wasted tokens/iterations/latency but recoverable accuracy.
- **Mitigations**:
  - Cache pointers to evicted artifacts (titles, hashes) so the agent can request them explicitly rather than re-search blindly.
  - Add low-cost retrieval stubs in the summary (“If you need details of X, reload Y”).
  - Track rediscovery rate; if >15% of turns trigger re-fetch, loosen compaction aggressiveness.

## 4. Decision Model
### 4.1 Core variables
| Symbol | Meaning | Typical Source |
|--------|---------|----------------|
| `C` | Current non-system context tokens | `ContextWindow.estimateTokenUsage()` |
| `D` | Compaction divisor (`C / compacted_size`) | Historical compression ratio |
| `Q` | Token delta between cached and uncached turns | Telemetry on prompt caching |
| `M` | Estimated remaining turns | Turn-history estimator |
| `L` | Loss slope from fullness | Empirical decay curve |
| `P_nn`, `P_na` | Probability of naive-naive / naive-aware | Classifier over past mistakes |

### 4.2 Expected value heuristic
```
EV_compact = -C(1 - 1/D)
             + (Q × M × cache_hit_confidence)
             + L(headroom_gain)
             - penalty_naive
```
Compact when `EV_compact > 0`, where `penalty_naive = (P_nn × catastrophic_cost) + (P_na × rediscovery_cost)`.

### 4.3 Safety thresholds
1. **Context fullness**: Always compact when window >80% full _and_ EV is not strongly negative.
2. **Turn minimum**: Defer compaction until at least 5 turns or `M ≥ 3` to avoid premature cache misses.
3. **Cooldown**: Block repeated compactions within 3 turns unless fullness >95%.

## 5. Cache-Aware Heuristics
1. **Cache miss budgeting**: Track cumulative cache miss debt. Allow at most one forced miss per `max(4, D)` turns.
2. **Stable prefix preservation**: Leave system prompts and invariant instructions untouched to salvage partial cache hits.
3. **Delta mode**: Prefer append-only updates plus targeted deletions over wholesale rewrites to reduce cache invalidations.
4. **Compaction staging**: When `C` is extreme, apply two-step compaction (light prune + full summarize later) so only one turn is a complete miss.

## 6. Implementation Phases
| Phase | Objective | Key Deliverables |
|-------|-----------|------------------|
| **0. Observability** | Capture the data needed for intelligent decisions | Token accounting (C, cache hits), loss curve sampling, naive-naive vs naive-aware incident tagging |
| **1. Deterministic Heuristics** | Encode the cache + fullness thresholds | Threshold-based `shouldCompact()` with D-aware amortization math and basic guardrails |
| **2. Semantic Scoring Integration** | Prioritize what to keep | Plug `DefaultItemScorer` (recency + interaction + artifact + task relevance) into compaction ordering |
| **3. Decision Engine** | Move from heuristics to EV model | Estimator modules for Q, D, M; penalty model for naive states; explanation strings for observability |
| **4. Adaptive Optimization** | Continuously learn optimal aggressiveness | Multi-armed bandit or contextual policy that tunes D targets, preservation rules, and cooldown intervals based on telemetry |

Each phase is incremental and can ship independently; later phases refine earlier signals rather than replacing them.

## 7. Key Metrics & Alerts
| Metric | Description | Target / Alert |
|--------|-------------|----------------|
| **Cache Hit Rate** | % of turns served from KV cache | Target >70%; alert <50% sustained |
| **Cache Miss Penalty** | Tokens paid per forced miss | Track rolling avg; alert if >C/2 |
| **Effective Compaction Ratio** | `C_before / C_after` | Goal 3–6×; investigate <2× |
| **Headroom Reserve** | 1 - fullness | Maintain ≥30%; alert <15% |
| **Summary Distortion Score** | Embedding similarity between raw vs summary | Alert <0.8 cosine for high-priority files |
| **Naive-Naive Incidents** | Count per 100 turns | Target <1; auto-relax if spiking |
| **Naive-Aware Recovery Cost** | Extra tokens/latency spent rediscovering | Target <10% of turn budget |
| **Rediscovery Rate** | % of turns with “need more context” tool use | Alert >15% |
| **Latency Overhead** | Δ latency when compaction triggered | Alert if >1.5× baseline |

## 8. Architectural Recommendations
1. **Observability Layer**: Extend `TurnHistory` to log cache hits, miss penalties, headroom, and naive incident tags (manual or automatic).
2. **Compaction Decision Engine**:
   - Stateless interface: `decide({C, fullness, Q, D, M, risks}) → {action, rationale, confidence}`.
   - Pluggable estimators for Q/D/M so experimentation does not touch compaction core.
3. **Semantic Retention Pipeline**:
   - Use the multi-dimensional scoring system to rank removal candidates.
   - Introduce “critical shard” annotations for instructions, recent plans, and unresolved TODOs; these bypass eviction.
4. **Cache-Conscious Mutation API**:
   - Provide `contextWindow.diffApply()` so summarization can replace only changed sections.
   - Keep canonical chunk ordering stable to maximize cache reuse.
5. **Naivete Monitors**:
   - Lightweight classifier on agent outputs to detect hedges like “I’m missing context.”
   - Hook into decision engine to adjust penalties dynamically.
6. **Rollback + Snapshotting**:
   - Snapshot context before major compaction; allow automatic rollback if post-compaction evaluation fails similarity checks.

## 9. Operational Guidelines
- **Pre-flight checklist** before compaction: (a) confirm artifacts linked to in-progress work, (b) ensure recent tool outputs are summarized, (c) capture user instructions verbatim in retained section.
- **Post-compaction validation**: auto-run a “context sanity” query that lists retained objectives and blockers; compare against previous turn.
- **User transparency**: Log compaction decisions (tokens saved, expected cache payback, risk flags) for debugging and user trust.
- **Emergency mode**: If fullness ≥95% and compaction risk is high, fall back to incremental summarization (summarize only oldest quartile) to buy time without a full cache miss.

## 10. Summary
An intelligent compaction strategy balances cache economics, exponential performance decay, and error prevention:
1. **Always account for cache hit/miss amortization via divisor D and delta Q.**
2. **Treat context fullness as a multiplicative risk due to exponential loss curves.**
3. **Mitigate naive-naive failures through preservation rules and integrity checks; manage naive-aware costs via rediscovery hints and telemetry.**
4. **Progress through phased implementation to add observability, heuristics, semantic scoring, and adaptive policies.**
5. **Instrument key metrics so aggressive compaction can be tuned rather than guessed.**

Adhering to this specification yields a context window that stays lean, cache-friendly, and aligned with the agent’s true information needs without sacrificing correctness or user trust.
