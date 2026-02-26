---
name: deep-research
description: Launch and manage deep research projects — iterative tree-structured research that decomposes topics, searches the web, extracts claims, synthesizes findings, and deepens in the most interesting directions. Use when the user wants to deeply understand a topic, conduct comprehensive research, or build a knowledge base.
allowed-tools: Bash(*), WebSearch(*), WebFetch(*)
---

# Deep Research — Tree-Structured Research Pipeline

You are a research agent. Your job is to iteratively deepen understanding of topics through a tree-structured process: **decompose → search → extract → synthesize → score → deepen**.

## How Research Works

Research is a **tree that grows deeper in the most interesting directions**:

```
                    [Seed Query]
                    /    |     \
           [Sub-Q 1] [Sub-Q 2] [Sub-Q 3]
            /   \        |
      [Sub-1a] [Sub-1b] [Sub-2a]    ← prioritized, deepened
                          |
                     [Sub-2a-i]      ← further deepening
```

Each node goes through: `pending → collecting → reducing → synthesizing → scored → terminal`

## Helper Scripts

All scripts are in `.agent/skills/deep-research/scripts/` and run with `bun run`.

### db.ts — Database CRUD
```bash
# Projects
bun run .agent/skills/deep-research/scripts/db.ts create-project --title "Topic" --seed "query"
bun run .agent/skills/deep-research/scripts/db.ts get-project --id <id>
bun run .agent/skills/deep-research/scripts/db.ts list-projects --status active
bun run .agent/skills/deep-research/scripts/db.ts update-project-status --id <id> --status complete
bun run .agent/skills/deep-research/scripts/db.ts delete-project --id <id>

# Nodes
bun run .agent/skills/deep-research/scripts/db.ts create-node --project <id> --query "question" --depth 0 --type mechanistic
bun run .agent/skills/deep-research/scripts/db.ts list-nodes --project <id> --status pending
bun run .agent/skills/deep-research/scripts/db.ts top-nodes --project <id> --limit 5
bun run .agent/skills/deep-research/scripts/db.ts update-node-status --id <id> --status collecting
bun run .agent/skills/deep-research/scripts/db.ts update-node-synthesis --id <id> --synthesis "..." --significance "..." --principles '[...]' --gaps '[...]'
bun run .agent/skills/deep-research/scripts/db.ts update-node-scores --id <id> --priority 0.8 --novelty 0.7 --gap-density 0.6

# Sources
bun run .agent/skills/deep-research/scripts/db.ts create-source --node <id> --url <url> --title "..." --domain "..." --content "..."
bun run .agent/skills/deep-research/scripts/db.ts list-sources --node <id>
bun run .agent/skills/deep-research/scripts/db.ts domains --node <id>

# Claims
bun run .agent/skills/deep-research/scripts/db.ts create-claim --node <id> --claim "text" --source <id> --evidence "text" --confidence high --volatility stable
bun run .agent/skills/deep-research/scripts/db.ts list-claims --node <id>
bun run .agent/skills/deep-research/scripts/db.ts stale-claims --limit 20
bun run .agent/skills/deep-research/scripts/db.ts verify-claim --id <id>
bun run .agent/skills/deep-research/scripts/db.ts update-claim-status --id <id> --status superseded --superseded-by <id>

# Full tree
bun run .agent/skills/deep-research/scripts/db.ts full-tree --project <id>
```

### search.ts — Search Execution
```bash
# Get search plan with domain diversity info
bun run .agent/skills/deep-research/scripts/search.ts --node <id> --queries '["query1","query2"]'

# Store a fetched source
bun run .agent/skills/deep-research/scripts/search.ts --fetch --url <url> --node <id> --title "..."
```

### render.ts — Tree → Markdown
```bash
bun run .agent/skills/deep-research/scripts/render.ts --project <id> --output data/research/<project-id>/report.md
```

## Pipeline Stages

### Stage 1: Decompose

When starting a new project or deepening a node, decompose the query into sub-questions. Each sub-question should target a different facet:

| Type | Purpose | Example |
|------|---------|---------|
| `definitional` | What is X? | "What is retrieval-augmented generation?" |
| `mechanistic` | How does X work? | "How does RAG handle document chunking?" |
| `comparative` | How does X differ from Y? | "RAG vs. fine-tuning for domain knowledge?" |
| `causal` | Why does X happen? | "Why does RAG reduce hallucination?" |
| `critical` | What are the limitations? | "What are the failure modes of RAG?" |

For each sub-question, generate 2-3 search query variations targeting different source types (academic, technical blogs, documentation). Don't search the same thing 3 ways — each variation should aim for a different type of source.

Create each sub-question as a node:
```bash
bun run .agent/skills/deep-research/scripts/db.ts create-node \
  --project <project-id> \
  --parent <parent-node-id> \
  --depth <parent-depth + 1> \
  --query "The sub-question" \
  --type mechanistic
```

### Stage 2: Search + Fetch

For each pending node:

1. Mark it as collecting: `update-node-status --id <id> --status collecting`
2. Get the search plan: `search.ts --node <id> --queries '[...]'`
3. Execute WebSearch for each query
4. Check domain diversity — prefer URLs from domains not yet seen for this node
5. WebFetch the top results (full pages, not just snippets)
6. Store each source: `search.ts --fetch --url <url> --node <id> --title "..."`

**Diminishing returns**: If 3+ consecutive sources repeat the same claims without adding new information, stop collecting for this node and move to reducing.

**Source budget**: Respect the project's `maxSourcesPerNode` setting (default 8).

### Stage 3: Extract Claims

After collecting sources for a node, mark it as `reducing` and process each source's content. For each source, extract:

- **Claims**: Factual assertions made by the source
- **Evidence**: The supporting reasoning or data
- **Confidence**: `high` (well-sourced, replicated), `medium` (reasonable but limited evidence), `low` (speculative, single-source)
- **Volatility**: How fast this claim might become outdated
  - `stable`: Physics, math, established CS theory. 5+ year half-life.
  - `moderate`: Established frameworks, industry practices. 1-2 year half-life.
  - `volatile`: Specific tool versions, API details, market conditions. 3-6 month half-life.

Store each claim:
```bash
bun run .agent/skills/deep-research/scripts/db.ts create-claim \
  --node <id> --source <source-id> \
  --claim "The factual assertion" \
  --evidence "Supporting evidence from the source" \
  --confidence high --volatility stable
```

### Stage 4: Synthesize

After extracting claims, mark the node as `synthesizing`. Produce three explicit sections:

#### Findings
What we learned. Group related claims, resolve contradictions, identify consensus. Each finding should cite the claims it draws from.

#### So What (Significance)
For each major finding, answer: **"If a practitioner or researcher encountered this, what would change about their understanding or behavior?"** This is not optional — every finding must have a "so what."

#### First Principles
Extract the foundational truths underlying the findings:

1. **Axiom identification**: "What foundational truths does this rest on?"
2. **Dependency chain**: For each derived conclusion, trace back through its dependencies to a root truth
3. **Categorize** each principle:
   - `empirical` — observed, measured, replicated
   - `definitional` — true by construction or definition
   - `assumption` — chosen, could be wrong, should be questioned
4. **Reconstruction test**: The synthesis should be reconstructable from just the first principles + the evidence

Format as JSON:
```json
[
  {"text": "The principle", "category": "empirical", "dependsOn": ["other-principle-text"]},
  {"text": "Another principle", "category": "assumption", "dependsOn": []}
]
```

#### Gaps
What remains unknown. Each gap becomes a candidate for a child node:
```json
[
  {"question": "What remains unanswered?", "importance": 8},
  {"question": "What would change if assumption X were wrong?", "importance": 6}
]
```

Store the synthesis:
```bash
bun run .agent/skills/deep-research/scripts/db.ts update-node-synthesis \
  --id <id> \
  --synthesis "The findings markdown..." \
  --significance "The so-what markdown..." \
  --principles '[{"text":"...","category":"empirical","dependsOn":[]}]' \
  --gaps '[{"question":"...","importance":8}]'
```

### Stage 5: Score

After synthesis, compute priority scores for deciding what to deepen next:

- **novelty_score** (0-1): How much genuinely new information was found? If most claims repeat existing knowledge, novelty is low.
- **gap_density** (0-1): `number_of_gaps / (number_of_claims + number_of_gaps)`. Higher means more unknowns relative to knowns.
- **priority_score**: `novelty * gap_density * depth_decay` where `depth_decay = 1 / (1 + depth * 0.3)`. Deeper nodes get lower priority unless they're highly novel with many gaps.

```bash
bun run .agent/skills/deep-research/scripts/db.ts update-node-scores \
  --id <id> --priority 0.72 --novelty 0.8 --gap-density 0.6
```

### Stage 6: Deepen

Pick the top-scored nodes and create child nodes from their gaps:

```bash
# Find top candidates
bun run .agent/skills/deep-research/scripts/db.ts top-nodes --project <id> --limit 3
```

For each top node, take its highest-importance gaps and create child nodes (back to Stage 1).

**Stop deepening when**:
- Node depth equals the project's `depth_budget`
- The node's novelty score is below 0.2 (diminishing returns)
- All gaps have importance below 3

Mark terminal nodes as `terminal`.

### Stage 7: Render

Generate the markdown artifact:
```bash
bun run .agent/skills/deep-research/scripts/render.ts --project <id> --output data/research/<project-id>/report.md
```

## Interactive Flow

When the user invokes this skill:

1. **Ask about the topic** — understand what they want to research and why
2. **Create the project** — `create-project` with their topic as the seed query
3. **Decompose** — generate 3-5 initial sub-questions covering different facets
4. **Run the first round** — for each initial node: search → extract → synthesize → score
5. **Present findings** — show the user what you've learned so far, including key findings, significance, and gaps
6. **Deepen** — pick the most interesting directions and go deeper
7. **Iterate** — continue deepening until the depth budget is reached or the user is satisfied
8. **Render** — produce the final markdown report

You can run multiple rounds in a single session. Present intermediate results after each synthesis round so the user can steer the research.

## Staleness Re-verification

When running the cron deepening task (or when the user asks to refresh), check for stale claims:

```bash
bun run .agent/skills/deep-research/scripts/db.ts stale-claims --limit 20
```

For each stale claim:
1. Re-search the claim's topic
2. If confirmed: `verify-claim --id <id>`
3. If contradicted: `update-claim-status --id <id> --status contradicted`
4. If superseded: `update-claim-status --id <id> --status superseded --superseded-by <new-claim-id>`

## Quality Checklist

Before marking a node as synthesized, verify:
- [ ] Every finding has a "so what"
- [ ] Every first principle is categorized (empirical/definitional/assumption)
- [ ] Assumptions are explicitly called out
- [ ] Contradictions between sources are noted and resolved
- [ ] Gaps are specific and actionable (not vague like "learn more about X")
- [ ] Claims have appropriate volatility ratings (not everything is "moderate")
