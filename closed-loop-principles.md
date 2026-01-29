# Closed-Loop Autonomous Agent: First Principles

## The 10 Principles

### 1. Feedback Loops

The system is a control loop: **Observe → Orient → Decide → Act → Observe**

Three required properties:
- **Reliable** — The loop must not break. A broken loop is a dead system.
- **Fast** — Latency between action and feedback determines learning rate. Slow loops = slow learning.
- **Expressive** — The feedback must contain enough information to guide improvement. "It failed" is useless. "It failed because X at line Y when processing Z" is useful.

**Critical addition:** Feedback loops need a **reference signal** — what are you comparing against? Without a target, you're just observing, not controlling. This connects to Alignment (9).

---

### 2. Self-Regeneration

The ability to modify its own code and restart is the competitive advantage. Most agents are static.

But regeneration is dangerous without:
- **Rollback** — Bad changes must be reversible
- **Gradual rollout** — Don't regenerate into a broken state all at once
- **Health checks** — Verify the new version is healthy before committing

Think of it like a cell: it can replicate, but it has DNA error-correction and apoptosis (kill itself if corrupted).

---

### 3. Everything Is a Signal

Everything is living, everything should be tracked, everything is a metric, everything is a signal.

**Signals have different frequencies and amplitudes:**

| Frequency | Example | How to process |
|-----------|---------|----------------|
| High (ms-s) | API responses, errors, latency | Stream processing, real-time alerts |
| Medium (min-hr) | Job completions, user interactions | Batch aggregation, windowed metrics |
| Low (day-week) | Behavioral patterns, preference shifts | Periodic analysis, trend detection |

**How to keep organized:**
- **Hierarchy** — Raw events → Aggregated metrics → Derived insights → Strategic indicators
- **Namespacing** — `system.health.db.latency` vs `user.behavior.email.response_time`
- **Decay** — Old signals lose relevance. Apply time-weighting.

---

### 4. Salience

Regularly ask "what matters" — drilling into tiny optimizations is poor use of resources and focus.

**Salience is contextual** — What matters depends on:
- Current goals (from Goal Stack)
- Recent failures (what's broken?)
- Time sensitivity (deadlines approaching?)
- User-expressed priorities

**Anti-pattern:** Optimizing what's easy to measure instead of what matters. Goodhart's Law.

**Implementation:** Salience scoring should be a first-class system, not an afterthought. Central to all decision-making.

---

### 5. Benchmarks

Benchmarks answer: "Did we actually improve, or did we just change things?"

Two types:
- **Absolute benchmarks** — Task completion rate, error rate, latency p99
- **Relative benchmarks** — Before/after comparisons for specific changes

**Critical insight:** Benchmarks must be **automated and continuous**. Manual benchmarking doesn't scale. Every regeneration should run a benchmark suite.

```
regenerate → health check → benchmark → compare to baseline → alert if regression
```

---

### 6. Fault Tolerance

Ridiculously crucial. Three levels:

1. **Graceful degradation** — If Gmail is down, keep working on other things
2. **Automatic recovery** — Transient failures retry, tokens refresh automatically
3. **Isolation** — One bad component doesn't take down the system

**The key metric:** Mean Time To Recovery (MTTR). Not "how often do things fail" but "how fast do we recover."

**Implementation:** Circuit breakers, health checks, watchdog with recovery playbooks.

---

### 7. Auditability

Easy to understand what changed and why. Every change must be:
- **Recorded** — What changed, when, why
- **Attributable** — Who/what made the decision
- **Reversible** — Can we undo it?
- **Explainable** — Reasoning chain, not just outcome

**Implementation:**
- Git for code changes
- Action log with reasoning traces
- Schema versioning with migration history
- Decision journal: "I chose X over Y because Z"
- Patch notes, summaries, documentation, work logs
- Respect interfaces/schemas → if you break it you must report it

---

### 8. Knobs

Nothing should block progress. Everything should be:
- **Configurable** — Thresholds, timeouts, limits
- **Bypassable** — Manual overrides when needed
- **Tunable at runtime** — No restart required for config changes

**Anti-pattern:** Hardcoded values buried in logic. Everything that might need adjustment should be a named, documented knob.

---

### 9. Alignment

Do the actors understand what they are optimizing for? Are they primed in their role?

The system must:
- **Understand the objective** — Not just "complete tasks" but "provide value"
- **Internalize constraints** — What's off-limits? What's encouraged?
- **Have skin in the game** — Care about outcomes, not just outputs

**The team analogy:** A good team member:
- Understands the mission
- Takes initiative within their domain
- Flags when something feels wrong
- Improves processes, not just outputs
- Takes pride in craft quality
- Wants to help out proactively
- Development is iterative — takes strides to meaningfully improve previous work
- Makes code as maintainable as possible — they are the maintainers

**How to achieve alignment:**
- Explicit objective function in the prompt/config
- Regular "alignment checks" — Am I still working toward the right thing?
- Feedback on alignment, not just task completion

---

### 10. Discretion

Not everything is a good idea. How to enable risky/creative ideas safely:

| Mechanism | When to use |
|-----------|-------------|
| **Git branches** | Code changes that might break things |
| **Shadow mode** | Run new logic in parallel, compare outputs, don't act |
| **Sandboxes** | Isolated environments for testing |
| **Feature flags** | Gradual rollout, instant rollback |
| **Experiments framework** | A/B testing with statistical rigor |
| **Human-in-the-loop** | Escalate uncertain decisions for approval |

**Key principle:** Separate **exploration** from **exploitation**. Explore in sandboxes. Exploit in production.

---

## Additional Principles

### 11. State Coherence

The system's understanding of reality must be consistent. When multiple components observe the world, they need a shared source of truth.

- Single canonical data model
- Event sourcing for state changes
- Consistency checks between components

---

### 12. Time Horizons

Short-term and long-term objectives conflict. The system needs explicit handling of:
- Immediate tasks (respond to this message)
- Medium-term goals (complete this project)
- Long-term optimization (improve overall efficiency)

**Implementation:** Goal Stack with explicit time horizons. Don't sacrifice long-term for short-term busy-work.

---

### 13. The Objective Function

What is the system actually optimizing for? This must be explicit.

Candidate objectives:
- Maximize user-expressed satisfaction
- Minimize time-to-resolution for tasks
- Maximize value delivered per unit cost
- Some weighted combination

**Without an explicit objective, the system will optimize for something implicit — and it might be the wrong thing.**

---

## Architecture Synthesis

```
┌─────────────────────────────────────────────────────────────────┐
│                     OBJECTIVE FUNCTION                          │
│            "Maximize value delivered to Jevin"                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      GOAL STACK                                 │
│   Strategic → Tactical → Operational objectives                 │
│   Time horizons: long → medium → short                          │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  OBSERVATION    │ │   SALIENCE      │ │   DECISION      │
│  Signal streams │ │   What matters? │ │   What to do?   │
│  Everything     │ │   Filter noise  │ │   Given goals   │
│  tracked        │ │   Prioritize    │ │   constraints   │
└─────────────────┘ └─────────────────┘ └─────────────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        ACTION                                    │
│   Execute decisions. Record everything.                         │
│   Knobs for all thresholds. Fault-tolerant.                     │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   BENCHMARK     │ │   AUDIT LOG     │ │   REGENERATION  │
│   Did we        │ │   What changed? │ │   Improve self  │
│   improve?      │ │   Why?          │ │   Rollback if   │
│                 │ │   Reversible?   │ │   broken        │
└─────────────────┘ └─────────────────┘ └─────────────────┘
              │               │               │
              └───────────────┼───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    FEEDBACK → LEARNING                          │
│   Update models. Adjust strategies. Refine salience.            │
│   → Back to OBSERVATION                                         │
└─────────────────────────────────────────────────────────────────┘

                    ┌─────────────────┐
                    │   DISCRETION    │
                    │   Sandboxes     │
                    │   Experiments   │
                    │   Feature flags │
                    │   (parallel to  │
                    │   main loop)    │
                    └─────────────────┘
```

---

## The One Thing

If building from scratch, the single most important thing to implement first:

**The Audit Log + Action Record**

Why?
- Foundation for benchmarks (can't measure improvement without history)
- Enables alignment verification (review what the system did)
- Required for debugging (understand failures)
- Data source for learning (what worked?)
- Cheap to implement, expensive to add later

Start logging everything now. Build intelligence on top later.

---

## Summary Table

| Principle | Core Question | Implementation |
|-----------|---------------|----------------|
| Feedback Loops | Is the loop fast, reliable, expressive? | Metrics, alerts, traces |
| Self-Regeneration | Can it improve and restart safely? | Git, rollback, health checks |
| Everything Is a Signal | Are we capturing what matters? | Hierarchical signal architecture |
| Salience | What actually matters right now? | Salience scoring system |
| Benchmarks | Did we measurably improve? | Automated benchmark suite |
| Fault Tolerance | How fast do we recover? | Circuit breakers, watchdog |
| Auditability | Can we understand what happened? | Audit log, decision journal |
| Knobs | Can we adjust without rebuilding? | Runtime config, feature flags |
| Alignment | Are we optimizing the right thing? | Explicit objective function |
| Discretion | Can we experiment safely? | Sandboxes, branches, experiments |
| State Coherence | Is our view of reality consistent? | Canonical data model |
| Time Horizons | Are we balancing short/long term? | Goal stack with horizons |
| Objective Function | What are we actually optimizing? | Explicit, measurable target |
