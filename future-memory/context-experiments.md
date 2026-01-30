# Context Selection Experiments

## 1. Treat Context Selection as a Black-Box Control Problem

If your objective is:
- Highest task success rate
- Fewest turns
- Fewest tokens
- High accuracy

...then you don't need "context precision/recall" at all to optimize. You can treat the agent as a black box and learn a policy that chooses context based on outcomes only.

### Contextual Bandit Framing

This is the cleanest "first principles" answer.

- **State**: task features (error strings, touched files, test names, user goal, repo metadata)
- **Action**: choose a subset of candidate evidence items
- **Reward**: +1 for success, minus token cost, minus turn penalty, minus time penalty

You can optimize this with:
- Thompson sampling / UCB (simple, robust)
- Offline replay evaluation from logs (if you log candidate sets and chosen sets)
- Pairwise learning-to-rank for evidence items using implicit feedback (success/fail)

This avoids brittle proxy metrics entirely. You measure only what matters: **did it work, at what cost.**

**What you lose**: interpretability.
**What you gain**: an objective function that matches reality and doesn't pretend you can read the model's mind.

### Single KPI

If you want a single KPI that aligns with your goal:

```
Score = 1[success] - α·turns - β·tokens
```

Track distribution, not just mean (tails matter a lot in agent systems).

---

## 2. Measure Counterfactual Dependence, Not "Used"

If you want something "precision-like" and "recall-like" for debugging your packer, don't ask "did it use it"; ask:

> "Was this context item necessary (or helpful) for success?"

That is measurable without introspection.

### A) Necessity: Delta Debugging / Minimization ("Effective Context Size")

Given a context pack that succeeded:

1. Remove one evidence item at a time (or groups)
2. Re-run the exact same agent call (same temperature, same tools disabled/enabled)
3. If it fails, that item was **necessary** (in that run distribution)
4. Greedy iterate to find a small "core" set that preserves success

This yields:
- **Minimal successful subset size** (a precision-ish signal: how much was redundant)
- **Redundancy profile** (which types of items tend to be useless ballast)

Yes it costs extra runs, but you only need it on a sampled evaluation set to guide system design. It's not "brittle guesstimation"; it's an empirical counterfactual.

### B) Helpfulness: Dropout Curves ("Marginal Utility")

Randomly drop k% of evidence items and measure success rate vs k.

- If success falls off a cliff with small dropout → your packs contain a few critical needles (good to know)
- If success degrades smoothly → you're overfeeding redundant but somewhat useful context

You can also compute approximate Shapley-style contributions if you want, but even a dropout curve is already extremely informative.

---

## 3. Structured Citation with Auditing

Self-report is unreliable, but structured citation with auditing is not the same thing.

Change your interface so that every retrieved snippet is labeled:

```
E17: path/to/file.ts:L120-155 (commit abc123)
E18: test output excerpt ...
```

Require that:
- Final answer includes references like `[E17]` for factual claims / design constraints
- Code edits must cite the evidence they're based on (at least for nontrivial changes)

Then you can compute:
- **Evidence utilization rate**: fraction of provided evidence IDs that get cited
- **Grounded claim rate**: fraction of claims that cite something
- **Contradiction rate**: claims that cite evidence that doesn't support them (audit via deterministic checks or a separate verifier)

This still doesn't prove "the model used it internally," but it measures something you actually care about:
- Whether your pack contains lots of irrelevant junk
- Whether the agent can justify actions with provided evidence
- Whether it's hallucinating beyond evidence

And because each citation points to a line-range + commit hash, you can audit automatically.

This is not brittle if you use it as a diagnostic, not a sacred truth.

---

## 4. Oracle Coverage for Code/Ops Domains

In many agent tasks, "what's needed" is partly objective:
- Failing test file + assertion
- Stack trace frames + the referenced symbols
- Config keys referenced in logs
- API endpoint handler for the route being discussed
- The schema migration that touches the table mentioned in the error

You can define an **oracle set** without human labeling by using deterministic extraction:
- Parse stack traces → list of files/symbols
- Parse compiler errors → symbol + file
- Parse test runner output → test name + file
- Parse route tables / dependency graph → handler symbol
- Parse git diff / blame if task references a specific change

Then "recall" becomes:

> Did the packed context include the oracle items?

This isn't perfect (some tasks need higher-level intent), but it is high signal and cheap. And it directly addresses the "whole file blocks are naive" complaint: you're measuring whether you included the structurally necessary hooks.

---

## 5. Request Pressure (Better Than "Recall")

Instead of "recall", measure:

- **Follow-up request rate**: how often the agent asks for more context/tools
- **First-call solve rate**: success without additional retrieval turns
- **Clarification burden**: number of questions asked to user

These are brutally honest metrics that track "did we provide enough".

If you're optimizing for few turns, this is more aligned than any attempt to infer internal usage.

---

## 6. Precision vs Distraction: Measure Harm, Not Irrelevance

Even if an item is "unused," it may be harmless. The real enemy is **distracting context** that causes wrong decisions.

### A) Decoy Sensitivity Tests (Eval Only)

Inject a plausible-but-wrong decoy evidence item (clearly labeled as evidence, not "model text") and see if error rate increases.

If it does, your packer + prompting is letting irrelevant evidence steer decisions. That's a concrete failure mode you can fix:
- Better ranking/diversity constraints
- Stricter "evidence precedence" rules
- Stronger verification steps

### B) Attention Tax Proxy

Track:
- Latency vs context size (easy)
- Error rate vs context size (harder but measurable)
- "Waffle tokens" vs context size (often rises when overloaded)

This tells you whether bigger packs are actually costing accuracy, not just money.
