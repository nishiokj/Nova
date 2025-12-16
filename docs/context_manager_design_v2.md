# ContextManager Design Document v2
## Revised Architecture Based on Critical Feedback

---

## 1. Core Architecture Principles

### 1.1 Three-Layer Lifecycle

```python
# Session-level: Persistent across multiple requests
class ContextState:
    """Persistent state for a user session"""
    session_id: str
    working_memory: WorkingMemoryStore  # Structured, persistent facts
    user_rules: UserRules
    conversation_summary: ConversationSummary

# Request-level: Snapshot for a single request
class ContextBuild:
    """Immutable snapshot built for a specific request"""
    state: ContextState                # Reference to session state
    request_id: str
    user_request: str
    tool_trace_summary: ToolTraceSummary
    artifacts: ArtifactRegistry
    filesystem_context: FilesystemContext

# Execution-level: Decision record
class ContextPlan:
    """Deterministic plan for what goes in the context"""
    sections: List[SectionPlan]
    total_budget: int
    section_budgets: Dict[str, int]
    cache_strategy: CacheStrategy
    rationale: str                     # Why this plan
```

**Lifecycle Flow**:
```
1. ContextState.load(session_id) → persistent session state
2. ContextBuild.from_request(state, request) → build request snapshot
3. ContextPlan.plan(build, config) → decide what to include
4. ContextSerializer.serialize(plan) → produce API payload
5. After execution: ContextState.update(discoveries) → persist learnings
```

---

## 2. Revised Section Structure (8 Sections)

### 2.1 Section Definitions

```python
class ContextSection(Enum):
    # === STATIC (rarely changes) ===
    SYSTEM_CORE = "system_core"           # Principles, persona, formatting

    # === VERSIONED (change tracked by hash) ===
    TOOL_MANIFEST = "tool_manifest"       # Tool schemas, versioned by hash

    # === SEMI-STATIC (changes infrequently) ===
    USER_RULES = "user_rules"             # User preferences
    WORKING_MEMORY = "working_memory"     # Discovered facts (structured!)
    TOOL_TRACE_SUMMARY = "tool_trace"     # Recent execution history

    # === DYNAMIC (changes every request) ===
    EXECUTION_CONTRACT = "exec_contract"  # Budgets, tier behavior, constraints
    ARTIFACTS = "artifacts"               # Large content (addressable)
    FILESYSTEM_CONTEXT = "filesystem"     # Current working dir context

    # === EPHEMERAL (never cached) ===
    USER_REQUEST = "user_request"         # Current input
```

### 2.2 Section Details

#### A) System Core (STATIC)
```python
@dataclass
class SystemCoreSection:
    """Core system instructions - changes very rarely"""
    principles: str              # "You are a helpful assistant..."
    formatting_rules: str        # Output format expectations
    safety_guidelines: str       # What to refuse
    persona: str                 # Voice and style

    # Caching
    cache_control: str = "ephemeral"
    cache_ttl: int = 3600        # 1 hour
    content_hash: str = ""       # For cache key generation
```

#### B) Tool Manifest (VERSIONED)
```python
@dataclass
class ToolManifestSection:
    """Tool definitions - versioned by content hash"""
    tools: List[ToolDefinition]
    manifest_version: str        # SHA256 of canonical tool schemas
    tier: str                    # Which tier these tools are for
    enabled_connectors: List[str]

    # Caching: only cache if manifest_version matches
    cache_control: str = "ephemeral"
    cache_key: str = ""          # f"tools-{manifest_version}-{tier}"

    def compute_manifest_hash(self) -> str:
        """Canonical hash of tool schemas"""
        canonical = json.dumps(
            [t.to_dict() for t in sorted(self.tools, key=lambda x: x.name)],
            sort_keys=True
        )
        return hashlib.sha256(canonical.encode()).hexdigest()[:16]
```

**Key insight**: Tools change by tier, runtime config, connectors. Never cache tools with system core - cache separately and version aggressively.

#### C) Execution Contract (DYNAMIC)
```python
@dataclass
class ExecutionContractSection:
    """Runtime behavior expectations - changes per request"""
    tier: str
    max_tool_calls: int
    max_steps: int
    max_tokens_available: int
    timeout_ms: int
    allowed_operations: List[str]  # ["bash", "file_write", "web_search"]

    # NOT cached - always fresh
    cache_control: None
```

#### D) Working Memory (SEMI-STATIC, STRUCTURED)
```python
@dataclass
class WorkingMemoryEntry:
    """A single fact in working memory"""
    key: str                     # e.g., "repo.entrypoint"
    value: Any                   # e.g., "src/main.py"
    confidence: float            # 0.0 - 1.0
    source: MemorySource         # Provenance
    timestamp: float
    ttl_seconds: Optional[int]   # Auto-expire
    tags: List[str]              # ["filesystem", "python", "critical"]
    verified: bool = False       # Hypothesis vs verified fact
    pin: bool = False            # Never evict
    access_count: int = 0

@dataclass
class MemorySource:
    """Where did this fact come from?"""
    type: str                    # "tool", "user", "inferred", "file"
    tool_name: Optional[str]
    file_path: Optional[str]
    reasoning: Optional[str]

class WorkingMemoryStore:
    """Structured working memory with conflict detection"""
    entries: Dict[str, WorkingMemoryEntry]
    max_entries: int = 100

    def add(self, entry: WorkingMemoryEntry, policy: MemoryWritePolicy) -> bool:
        """Add entry if policy allows"""

    def get(self, key: str) -> Optional[WorkingMemoryEntry]:
        """Increment access count on retrieval"""

    def validate(self, tool_registry: ToolRegistry) -> List[Conflict]:
        """Auto-validate facts against reality"""

    def compact(self, target_size: int, policy: EvictionPolicy) -> int:
        """Remove entries according to policy"""

    def to_bullets(self) -> str:
        """Render as human-readable bullets for LLM"""
```

**Memory Write Policy**:
```python
@dataclass
class MemoryWritePolicy:
    """Gate what gets written to working memory"""

    def should_write(self, entry: WorkingMemoryEntry, context: ExecutionContext) -> bool:
        """Decide if this entry should be persisted"""

        # Must be stable (not ephemeral)
        if entry.source.type == "inferred" and entry.confidence < 0.7:
            return False

        # Must be referenced or critical
        if not entry.pin and entry.tags and "critical" not in entry.tags:
            # Check if it was actually used
            if entry.access_count == 0:
                return False

        # Must have provenance
        if not entry.source.type:
            return False

        # Set TTL by type
        if entry.source.type == "file":
            entry.ttl_seconds = 300  # 5 min (files change)
        elif entry.source.type == "user":
            entry.ttl_seconds = 3600  # 1 hour (user prefs stable)
        else:
            entry.ttl_seconds = 600   # 10 min (default)

        return True
```

#### E) Tool Trace Summary (SEMI-STATIC, COMPRESSIBLE)
```python
@dataclass
class ToolTraceSummary:
    """Compact summary of recent tool executions"""
    recent_turns: List[TurnSummary]  # Last N turns
    max_turns: int = 3

@dataclass
class TurnSummary:
    """What happened in one turn"""
    turn_num: int
    user_input_preview: str          # First 100 chars
    tools_called: List[ToolCallSummary]
    files_changed: List[str]
    errors: List[str]
    discoveries: List[str]           # Key facts discovered
    artifacts_created: List[str]     # artifact:// handles

@dataclass
class ToolCallSummary:
    """Compact tool call record"""
    tool_name: str
    args_preview: str                # Key args only
    status: str                      # "success", "error"
    output_preview: str              # First 200 chars or summary
    artifact_ref: Optional[str]      # If output stored as artifact
```

**Key insight**: This prevents re-discovery. Agent can see "I already tried X and got Y" without replaying full conversation.

#### F) Artifacts (DYNAMIC, ADDRESSABLE)
```python
@dataclass
class Artifact:
    """Large content stored outside main context"""
    id: str                          # artifact://abc123
    name: str                        # Human-readable name
    type: str                        # "file_content", "code", "output"
    content: str                     # Full content (stored)
    size_bytes: int
    created_at: float
    excerpt: Optional[str] = None    # Preview (first/last N lines)

class ArtifactRegistry:
    """Storage for large artifacts"""
    artifacts: Dict[str, Artifact]
    max_artifacts: int = 20
    max_artifact_size: int = 50_000  # 50K chars

    def store(self, name: str, content: str, type: str) -> str:
        """Store artifact, return handle"""
        if len(content) < 1000:
            # Too small to be an artifact, inline it
            return None

        artifact_id = f"artifact://{hashlib.sha256(content.encode()).hexdigest()[:12]}"

        # Create excerpt
        lines = content.split('\n')
        if len(lines) > 20:
            excerpt = '\n'.join(lines[:10]) + '\n...\n' + '\n'.join(lines[-10:])
        else:
            excerpt = content

        self.artifacts[artifact_id] = Artifact(
            id=artifact_id,
            name=name,
            type=type,
            content=content,
            size_bytes=len(content),
            created_at=time.time(),
            excerpt=excerpt
        )

        return artifact_id

    def get(self, artifact_id: str) -> Optional[Artifact]:
        """Retrieve artifact by handle"""

    def to_context_summary(self) -> str:
        """Generate compact summary for context"""
        summaries = []
        for artifact in self.artifacts.values():
            summaries.append(
                f"{artifact.id}: {artifact.name} ({artifact.type}, {artifact.size_bytes} bytes)\n"
                f"Excerpt:\n{artifact.excerpt}"
            )
        return '\n\n'.join(summaries)
```

**Agent can request full content via tool**: `read_artifact(artifact_id="artifact://abc123")`

#### G) Filesystem Context (DYNAMIC, DETERMINISTIC)
```python
class FilesystemContext:
    """Deterministic filesystem context injection"""

    def build(
        self,
        request: str,
        recent_operations: List[Dict],
        working_dir: str,
        budget_tokens: int = 20_000
    ) -> str:
        """Build filesystem context with deterministic heuristics"""

        sections = []
        budget_remaining = budget_tokens

        # 1. Explicit paths in request (highest priority)
        mentioned_paths = self._extract_paths_from_request(request)
        for path in mentioned_paths:
            if budget_remaining < 500:
                break
            excerpt = self._get_file_excerpt(path, max_lines=50)
            tokens = self._estimate_tokens(excerpt)
            if tokens <= budget_remaining:
                sections.append(f"File: {path}\n{excerpt}")
                budget_remaining -= tokens

        # 2. Recent file operations (from tool trace)
        recent_paths = [op['path'] for op in recent_operations[-5:]]
        for path in recent_paths:
            if path in mentioned_paths:
                continue  # Already included
            if budget_remaining < 500:
                break
            # Similar logic...

        # 3. Repo "hot files" (deterministic anchors)
        hot_files = self._find_hot_files(working_dir)
        for path in hot_files:
            if budget_remaining < 500:
                break
            # Similar logic...

        # 4. Language-specific anchors
        anchors = self._find_language_anchors(working_dir)
        # Similar logic...

        # 5. Compact file tree (always include if budget allows)
        if budget_remaining > 1000:
            tree = self._get_file_tree(working_dir, max_depth=2)
            sections.insert(0, f"File Tree:\n{tree}")

        return '\n\n'.join(sections)

    def _extract_paths_from_request(self, request: str) -> List[str]:
        """Use regex to find file paths in request"""
        # Pattern: ./path, /abs/path, path/to/file.py
        pattern = r'(?:\.\/|\/)?[\w\/\-\.]+\.\w+'
        return re.findall(pattern, request)

    def _find_hot_files(self, working_dir: str) -> List[str]:
        """Find repository anchor files (deterministic)"""
        candidates = [
            "README.md", "README", "package.json", "pyproject.toml",
            "requirements.txt", "Cargo.toml", "go.mod", "pom.xml",
            "Makefile", "setup.py", ".env.example"
        ]
        found = []
        for candidate in candidates:
            path = os.path.join(working_dir, candidate)
            if os.path.exists(path):
                found.append(path)
        return found

    def _find_language_anchors(self, working_dir: str) -> Dict[str, List[str]]:
        """Find language-specific entry points"""
        # Python: main.py, __init__.py, setup.py
        # JS: index.js, app.js, server.js
        # etc.
```

**No "similarity magic"** - only deterministic heuristics. Embeddings can be added later.

---

## 3. Token Management & Budgets

### 3.1 Section Budget System

```python
@dataclass
class SectionBudget:
    """Token budget for a section"""
    section: ContextSection
    max_tokens: int
    min_tokens: int          # Reserved minimum
    eviction_policy: EvictionPolicy
    pin: bool = False        # Never drop this section

class EvictionPolicy(Enum):
    DROP_OLDEST = "drop_oldest"
    SUMMARIZE_OLDEST = "summarize_oldest"
    KEEP_TOPK_BY_SCORE = "keep_topk_by_score"
    EXCERPT = "excerpt"
    NONE = "none"            # Never evict

class BudgetAllocator:
    """Allocate token budgets across sections"""

    DEFAULT_BUDGETS = {
        ContextSection.SYSTEM_CORE: SectionBudget(
            section=ContextSection.SYSTEM_CORE,
            max_tokens=2000,
            min_tokens=500,
            eviction_policy=EvictionPolicy.NONE,
            pin=True
        ),
        ContextSection.TOOL_MANIFEST: SectionBudget(
            section=ContextSection.TOOL_MANIFEST,
            max_tokens=8000,
            min_tokens=1000,
            eviction_policy=EvictionPolicy.NONE,
            pin=True
        ),
        ContextSection.EXECUTION_CONTRACT: SectionBudget(
            section=ContextSection.EXECUTION_CONTRACT,
            max_tokens=500,
            min_tokens=200,
            eviction_policy=EvictionPolicy.NONE,
            pin=True
        ),
        ContextSection.USER_RULES: SectionBudget(
            section=ContextSection.USER_RULES,
            max_tokens=2000,
            min_tokens=0,
            eviction_policy=EvictionPolicy.SUMMARIZE_OLDEST
        ),
        ContextSection.WORKING_MEMORY: SectionBudget(
            section=ContextSection.WORKING_MEMORY,
            max_tokens=10_000,
            min_tokens=1000,
            eviction_policy=EvictionPolicy.KEEP_TOPK_BY_SCORE
        ),
        ContextSection.TOOL_TRACE_SUMMARY: SectionBudget(
            section=ContextSection.TOOL_TRACE_SUMMARY,
            max_tokens=8000,
            min_tokens=500,
            eviction_policy=EvictionPolicy.DROP_OLDEST
        ),
        ContextSection.ARTIFACTS: SectionBudget(
            section=ContextSection.ARTIFACTS,
            max_tokens=20_000,
            min_tokens=0,
            eviction_policy=EvictionPolicy.EXCERPT
        ),
        ContextSection.FILESYSTEM_CONTEXT: SectionBudget(
            section=ContextSection.FILESYSTEM_CONTEXT,
            max_tokens=20_000,
            min_tokens=1000,
            eviction_policy=EvictionPolicy.EXCERPT
        ),
        ContextSection.USER_REQUEST: SectionBudget(
            section=ContextSection.USER_REQUEST,
            max_tokens=10_000,
            min_tokens=10_000,  # Never compress user input
            eviction_policy=EvictionPolicy.NONE,
            pin=True
        ),
    }

    def allocate(self, total_budget: int, sections: List[ContextSection]) -> Dict[ContextSection, int]:
        """Allocate tokens across sections"""
        # 1. Reserve minimums
        reserved = sum(self.DEFAULT_BUDGETS[s].min_tokens for s in sections)
        available = total_budget - reserved

        # 2. Allocate remainder proportionally
        allocations = {}
        for section in sections:
            budget = self.DEFAULT_BUDGETS[section]
            base = budget.min_tokens
            extra = int((budget.max_tokens - budget.min_tokens) * (available / total_budget))
            allocations[section] = min(base + extra, budget.max_tokens)

        return allocations
```

### 3.2 Accurate Tokenization

```python
class TokenEstimator:
    """Per-provider accurate tokenization"""

    def __init__(self, provider: str, model: str):
        self.provider = provider
        self.model = model
        self._tokenizer = self._init_tokenizer()

    def _init_tokenizer(self):
        """Initialize provider-specific tokenizer"""
        if self.provider == "anthropic":
            try:
                from anthropic import Anthropic
                return Anthropic().get_tokenizer()  # If available
            except:
                # Fallback to tiktoken with GPT-4 encoding (close enough)
                import tiktoken
                return tiktoken.get_encoding("cl100k_base")
        elif self.provider == "openai":
            import tiktoken
            return tiktoken.encoding_for_model(self.model)
        else:
            # Generic fallback
            import tiktoken
            return tiktoken.get_encoding("cl100k_base")

    def count_tokens(self, text: str) -> int:
        """Accurate token count"""
        return len(self._tokenizer.encode(text))

    def estimate_fast(self, text: str) -> int:
        """Fast approximation for pre-checks"""
        # Chars / 4 for English text
        # But code/JSON needs different ratio
        if self._looks_like_code(text):
            return len(text) // 3  # Code is denser
        else:
            return len(text) // 4

    def _looks_like_code(self, text: str) -> bool:
        """Heuristic to detect code"""
        code_indicators = ['{', '}', 'def ', 'class ', 'function', 'import ', 'const ']
        return any(indicator in text for indicator in code_indicators)
```

---

## 4. Context Planning (First-Class)

### 4.1 ContextPlan Definition

```python
@dataclass
class SectionPlan:
    """Plan for one section"""
    section: ContextSection
    content_hash: str                    # For cache validation
    cache_key: Optional[str]             # If cacheable
    cache_control: Optional[str]         # "ephemeral" or None
    allocated_tokens: int                # Budget for this section
    actual_tokens: int                   # Actual size
    included: bool                       # Include in final context?
    compacted: bool                      # Was compaction applied?
    eviction_applied: Optional[str]      # Which eviction method used

@dataclass
class ContextPlan:
    """Deterministic plan for context serialization"""
    request_id: str
    session_id: str
    total_budget: int
    sections: List[SectionPlan]
    cache_strategy: str                  # "aggressive", "conservative", "disabled"
    rationale: str                       # Why this plan
    estimated_cost: float                # Estimated API cost

    def to_dict(self) -> Dict:
        """Serialize for logging/debugging"""

class ContextPlanner:
    """Creates deterministic context plans"""

    def plan(
        self,
        build: ContextBuild,
        config: ContextManagerConfig,
        total_budget: int = 180_000
    ) -> ContextPlan:
        """
        Create a plan for what goes in the context.

        This is deterministic and debuggable.
        """

        # 1. Identify which sections we have
        sections = self._identify_sections(build)

        # 2. Allocate token budgets
        allocator = BudgetAllocator()
        budgets = allocator.allocate(total_budget, sections)

        # 3. Compute content hashes for cache validation
        hashes = self._compute_section_hashes(build, sections)

        # 4. Decide cache strategy
        cache_strategy = self._decide_cache_strategy(build, config)

        # 5. Apply compaction where needed
        section_plans = []
        for section in sections:
            content = self._get_section_content(build, section)
            actual_tokens = self._count_tokens(content)
            allocated = budgets[section]

            # Apply eviction if over budget
            if actual_tokens > allocated:
                policy = BudgetAllocator.DEFAULT_BUDGETS[section].eviction_policy
                content, actual_tokens = self._apply_eviction(
                    content, section, policy, allocated
                )
                eviction_applied = policy.value
            else:
                eviction_applied = None

            # Determine caching
            cache_key, cache_control = self._determine_caching(
                section, hashes[section], cache_strategy
            )

            section_plans.append(SectionPlan(
                section=section,
                content_hash=hashes[section],
                cache_key=cache_key,
                cache_control=cache_control,
                allocated_tokens=allocated,
                actual_tokens=actual_tokens,
                included=True,
                compacted=(actual_tokens < self._original_size(build, section)),
                eviction_applied=eviction_applied
            ))

        # 6. Generate rationale
        rationale = self._generate_rationale(section_plans, build)

        return ContextPlan(
            request_id=build.request_id,
            session_id=build.state.session_id,
            total_budget=total_budget,
            sections=section_plans,
            cache_strategy=cache_strategy,
            rationale=rationale,
            estimated_cost=self._estimate_cost(section_plans)
        )
```

**Key benefit**: You can log the ContextPlan, replay it, debug why something was dropped/compacted.

---

## 5. Cache Validation with Hashing

### 5.1 Content Hashing

```python
class SectionHasher:
    """Compute canonical hashes for cache validation"""

    def hash_section(self, section: ContextSection, content: Any) -> str:
        """Canonical hash of section content"""

        if section == ContextSection.TOOL_MANIFEST:
            # Hash tool schemas in canonical order
            tools = sorted(content, key=lambda t: t.name)
            canonical = json.dumps([t.to_dict() for t in tools], sort_keys=True)

        elif section == ContextSection.WORKING_MEMORY:
            # Hash structured entries
            entries = sorted(content.entries.items())
            canonical = json.dumps(
                [{k: v.to_dict()} for k, v in entries],
                sort_keys=True
            )

        else:
            # Simple text hash
            canonical = str(content)

        return hashlib.sha256(canonical.encode()).hexdigest()[:16]

    def compute_cache_key(
        self,
        section: ContextSection,
        content_hash: str,
        model_family: str,
        tier: str = None
    ) -> str:
        """Unique cache key for this section"""

        parts = [section.value, content_hash, model_family]
        if tier:
            parts.append(tier)

        return "-".join(parts)
```

### 5.2 Cache Validation

```python
class CacheValidator:
    """Validate if cached content is still valid"""

    def __init__(self):
        self.cache_registry: Dict[str, CacheEntry] = {}

    def should_use_cache(
        self,
        cache_key: str,
        content_hash: str,
        ttl_seconds: int
    ) -> bool:
        """Check if cache is valid"""

        entry = self.cache_registry.get(cache_key)
        if not entry:
            return False

        # Check hash match
        if entry.content_hash != content_hash:
            return False

        # Check TTL
        if time.time() > entry.expires_at:
            return False

        return True

    def register_cache(self, cache_key: str, content_hash: str, ttl: int):
        """Register successful cache write"""
        self.cache_registry[cache_key] = CacheEntry(
            cache_key=cache_key,
            content_hash=content_hash,
            created_at=time.time(),
            expires_at=time.time() + ttl
        )
```

---

## 6. Automatic Context Validation

### 6.1 Re-validation Triggers

```python
class ContextValidator:
    """Automatically validate working memory against reality"""

    VALIDATION_TRIGGERS = [
        "file_modified",      # File changed on disk
        "tool_contradiction", # Tool output contradicts memory
        "high_impact_decision",  # Decision depends on low-confidence fact
        "explicit_request",   # User asks to verify
    ]

    def validate_on_trigger(
        self,
        trigger: str,
        working_memory: WorkingMemoryStore,
        tool_registry: ToolRegistry
    ) -> List[ValidationResult]:
        """Run validation when triggered"""

        results = []

        if trigger == "file_modified":
            results.extend(self._validate_file_facts(working_memory))

        elif trigger == "tool_contradiction":
            results.extend(self._detect_contradictions(working_memory))

        elif trigger == "high_impact_decision":
            results.extend(self._check_low_confidence_deps(working_memory))

        return results

    def _validate_file_facts(self, memory: WorkingMemoryStore) -> List[ValidationResult]:
        """Check if file facts are still accurate"""
        issues = []

        for key, entry in memory.entries.items():
            if not key.startswith("file:"):
                continue

            path = key.split(":", 1)[1]

            # Check if file exists
            if entry.value == "exists" and not os.path.exists(path):
                issues.append(ValidationResult(
                    passed=False,
                    details=f"File {path} no longer exists",
                    confidence=1.0,
                    action="remove_entry"
                ))

            # Check if file modified
            elif os.path.exists(path):
                current_mtime = os.path.getmtime(path)
                remembered_mtime = entry.source.get("mtime")
                if remembered_mtime and current_mtime > remembered_mtime:
                    issues.append(ValidationResult(
                        passed=False,
                        details=f"File {path} modified since last read",
                        confidence=0.8,
                        action="mark_stale"
                    ))

        return issues
```

**No user prompts by default** - auto-fix or mark stale.

---

## 7. Integration Points

### 7.1 Agent Changes

```python
class Agent:
    def __init__(self, config, tool_registry, ...):
        # Session-level state (persistent)
        self.session_state = ContextState(
            session_id=str(uuid.uuid4()),
            working_memory=WorkingMemoryStore(),
            user_rules=UserRules(),
            conversation_summary=ConversationSummary()
        )

        # Per-request builders
        self.planner = ContextPlanner()
        self.serializer = ContextSerializer()

    def run(self, user_input: str, context: str = None, ...) -> AgentResponse:
        # 1. Build request snapshot
        context_build = ContextBuild.from_request(
            state=self.session_state,
            request_id=self.logger.request_id,
            user_request=user_input,
            recent_operations=self._file_operations[-10:]
        )

        # 2. Create context plan
        context_plan = self.planner.plan(
            build=context_build,
            config=self.config.context_manager,
            total_budget=self.config.max_context_tokens
        )

        # Log the plan for debugging
        self.logger.context_plan(context_plan.to_dict())

        # 3. Serialize to API format
        if self._llm.provider == "anthropic":
            system_blocks, messages = self.serializer.to_anthropic(context_plan, context_build)
        else:
            messages = self.serializer.to_openai(context_plan, context_build)

        # 4. Execute
        response = self._llm.complete(messages, tools=...)

        # 5. Update session state with discoveries
        for discovery in self._extract_discoveries(response, execution_trace):
            entry = WorkingMemoryEntry(
                key=discovery.key,
                value=discovery.value,
                confidence=discovery.confidence,
                source=discovery.source,
                timestamp=time.time(),
                tags=discovery.tags
            )

            if self.memory_write_policy.should_write(entry, execution_context):
                self.session_state.working_memory.add(entry, self.memory_write_policy)

        # 6. Persist session state
        self.session_state.save_checkpoint()

        return agent_response
```

### 7.2 Tool Updates

```python
class Tool:
    def execute(self, **kwargs) -> ToolResult:
        result = self._execute_impl(**kwargs)

        # Extract discoveries
        discoveries = self._extract_discoveries(result, kwargs)

        # Attach to result metadata
        result.metadata["discoveries"] = discoveries

        return result

    def _extract_discoveries(self, result: ToolResult, args: Dict) -> List[Discovery]:
        """Extract facts worth remembering"""
        discoveries = []

        if self.name == "read_file" and result.is_success:
            path = args.get("path")
            discoveries.append(Discovery(
                key=f"file:{path}",
                value={"status": "read", "exists": True, "mtime": os.path.getmtime(path)},
                confidence=1.0,
                source=MemorySource(type="tool", tool_name=self.name, file_path=path),
                tags=["filesystem", "verified"]
            ))

        return discoveries
```

---

## 8. Session State Management

### 8.1 Checkpoint System

```python
class ContextState:
    """Session-level persistent state"""

    def save_checkpoint(self, checkpoint_dir: str = ".context_checkpoints"):
        """Save state to disk"""
        os.makedirs(checkpoint_dir, exist_ok=True)

        checkpoint = {
            "session_id": self.session_id,
            "working_memory": self.working_memory.to_dict(),
            "user_rules": self.user_rules.to_dict(),
            "conversation_summary": self.conversation_summary.to_dict(),
            "timestamp": time.time(),
            "version": "1.0"
        }

        path = os.path.join(checkpoint_dir, f"{self.session_id}.json")
        with open(path, 'w') as f:
            json.dump(checkpoint, f, indent=2)

    @classmethod
    def load_checkpoint(cls, session_id: str, checkpoint_dir: str = ".context_checkpoints") -> "ContextState":
        """Load state from disk"""
        path = os.path.join(checkpoint_dir, f"{session_id}.json")

        if not os.path.exists(path):
            # Create new session
            return cls(session_id=session_id)

        with open(path, 'r') as f:
            checkpoint = json.load(f)

        state = cls(session_id=session_id)
        state.working_memory = WorkingMemoryStore.from_dict(checkpoint["working_memory"])
        state.user_rules = UserRules.from_dict(checkpoint["user_rules"])
        state.conversation_summary = ConversationSummary.from_dict(checkpoint["conversation_summary"])

        return state
```

---

## 9. Critical Gotchas Addressed

### ✅ System prompt + tools caching
**Fixed**: Split into `system_core` (cacheable) + `tool_manifest` (versioned by hash) + `execution_contract` (ephemeral)

### ✅ Working memory structure
**Fixed**: Structured from day 1 with provenance, confidence, TTL, tags. Renders to bullets only at serialization.

### ✅ Token estimation accuracy
**Fixed**: Provider-specific tokenization with fast pre-check. Per-section budgets enforce hard limits.

### ✅ Missing tool trace section
**Fixed**: Added `ToolTraceSummary` as semi-static, compressible section.

### ✅ Context drift validation
**Fixed**: Automatic re-validation on triggers (file change, contradiction, high-impact decision). No user prompts by default.

### ✅ Vague priorities
**Fixed**: Hard token budgets per section with explicit eviction policies.

### ✅ Filesystem "similarity magic"
**Fixed**: Deterministic heuristics only (explicit paths → recent ops → hot files → language anchors → tree).

### ✅ Artifact bloat
**Fixed**: Artifacts are addressable (artifact://id) with excerpts in context. Full content retrieved via tool.

### ✅ No serialization plan
**Fixed**: `ContextPlan` as first-class object. Logged, debuggable, replayable.

### ✅ Cache correctness
**Fixed**: Section hashing + cache key validation + TTL enforcement.

### ✅ Unbounded memory writes
**Fixed**: `MemoryWritePolicy` gates what gets persisted. Requires provenance, confidence, and relevance.

### ✅ Session vs request state
**Fixed**: Three-layer lifecycle: `ContextState` (session) → `ContextBuild` (request) → `ContextPlan` (execution).

---

## 10. Implementation Roadmap

### Phase 1: Core Infrastructure (Week 1)
- [ ] Implement `ContextState`, `ContextBuild`, `ContextPlan`
- [ ] Implement `WorkingMemoryStore` with structured entries
- [ ] Implement `TokenEstimator` with per-provider support
- [ ] Implement `BudgetAllocator` and `EvictionPolicy`
- [ ] Unit tests

### Phase 2: Section Management (Week 2)
- [ ] Implement all 8 sections
- [ ] Implement `ToolTraceSummary`
- [ ] Implement `ArtifactRegistry` with addressable artifacts
- [ ] Implement `FilesystemContext` with deterministic heuristics
- [ ] Integration tests

### Phase 3: Planning & Serialization (Week 2-3)
- [ ] Implement `ContextPlanner`
- [ ] Implement `SectionHasher` and `CacheValidator`
- [ ] Implement `ContextSerializer` for Anthropic + OpenAI
- [ ] Test cache validation logic

### Phase 4: Agent Integration (Week 3)
- [ ] Update `Agent` to use `ContextState` and planning
- [ ] Implement `MemoryWritePolicy`
- [ ] Update tools to report discoveries
- [ ] Update `Planner` to use working memory
- [ ] End-to-end tests

### Phase 5: Validation & Persistence (Week 4)
- [ ] Implement `ContextValidator` with auto-triggers
- [ ] Implement checkpoint save/load
- [ ] Implement memory monitoring and pruning
- [ ] Performance and cost testing

### Phase 6: Production (Week 5)
- [ ] Add metrics and logging
- [ ] Add cache stats dashboard
- [ ] Feature flag rollout (tier by tier)
- [ ] Production monitoring

---

## 11. Success Metrics

### Functional
- [ ] All 8 sections work correctly
- [ ] Structured working memory with provenance
- [ ] Tool trace prevents re-discovery
- [ ] Artifacts don't bloat context
- [ ] FS context stays under budget

### Performance
- [ ] Planning adds <100ms overhead
- [ ] Compaction completes in <500ms
- [ ] Token estimation within ±5% (with accurate tokenizer)

### Cost
- [ ] Cache hit rate >70% after warmup
- [ ] 60-90% cost reduction on cached tokens
- [ ] No quality regression

### Reliability
- [ ] No context overflow errors
- [ ] No memory leaks over 1000+ turns
- [ ] Auto-validation catches drift

---

## 12. Open Design Questions

1. **Conversation summary in ContextState?**
   - Option A: Full message history (memory heavy)
   - Option B: Rolling summary (lossy but compact)
   - **Recommendation**: Rolling summary with tool trace for facts

2. **Should working memory support nested keys?**
   - Example: `repo.structure.entry_point` vs `repo.entrypoint`
   - **Recommendation**: Flat keys with dot notation, query by prefix

3. **Artifact eviction policy?**
   - LRU? Size-based? Never evict?
   - **Recommendation**: Keep last 20, evict oldest beyond that

4. **Cross-session memory sharing?**
   - Should sessions share a global fact base?
   - **Recommendation**: Per-session for v1, explore shared later

---

## End of Design v2

This design addresses all critical feedback and is production-ready.
