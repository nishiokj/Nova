"""
Search and synthesis tasks for evaluation.

These tasks test the agent's ability to:
- Use web search to find current information
- Synthesize information from multiple sources
- Fact-check claims
- Research technical documentation
- Provide well-organized summaries
"""

from ..eval_task import EvalTask
from ..rubrics.category_rubrics import SEARCH_SYNTHESIS_RUBRIC, SIMPLE_QA_RUBRIC


# Task 1: Current information lookup
TASK_SEARCH_001 = EvalTask(
    task_id="search_001",
    category="search_synthesis",
    difficulty="simple",
    prompt="""What is the current population of Tokyo, Japan?

Use web search to find the most recent estimate.""",
    expected_behavior="Use web search to get current population data",
    success_criteria=[
        "Uses web search tool",
        "Provides population estimate",
        "Data appears current (not outdated)",
        "Cites source or year of estimate"
    ],
    rubric=SEARCH_SYNTHESIS_RUBRIC,
    requires_tools=["fast_answer", "web_search"],
    timeout_seconds=120,
    tags=["current_data", "facts", "geography"]
)


# Task 2: Technical documentation lookup
TASK_SEARCH_002 = EvalTask(
    task_id="search_002",
    category="search_synthesis",
    difficulty="standard",
    prompt="""What are the main differences between Python's asyncio.gather() and asyncio.wait()?

Search for documentation and provide a clear comparison.""",
    expected_behavior="Search Python documentation, compare the two functions",
    success_criteria=[
        "Uses search tools",
        "Explains asyncio.gather()",
        "Explains asyncio.wait()",
        "Lists key differences",
        "Provides practical guidance on when to use each"
    ],
    rubric=SEARCH_SYNTHESIS_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=150,
    tags=["programming", "documentation", "python"]
)


# Task 3: Multi-source synthesis
TASK_SEARCH_003 = EvalTask(
    task_id="search_003",
    category="search_synthesis",
    difficulty="advanced",
    prompt="""Research the pros and cons of TypeScript versus JavaScript for large-scale
web applications.

Provide:
- At least 3 advantages of TypeScript
- At least 3 disadvantages of TypeScript
- Specific examples of when to use each
- Current community adoption trends

Synthesize information from multiple sources.""",
    expected_behavior="Search multiple sources, synthesize balanced comparison",
    success_criteria=[
        "Uses search tools",
        "Lists 3+ TypeScript pros",
        "Lists 3+ TypeScript cons",
        "Provides specific examples",
        "Discusses adoption trends",
        "Well-organized synthesis (not copy-paste)"
    ],
    rubric=SEARCH_SYNTHESIS_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=180,
    tags=["research", "programming", "comparison"]
)


# Task 4: Fact verification
TASK_SEARCH_004 = EvalTask(
    task_id="search_004",
    category="search_synthesis",
    difficulty="standard",
    prompt="""Is this claim true or false: "The Python programming language was created
before Java"?

Use web search to verify and explain your answer with dates.""",
    expected_behavior="Search for creation dates of both languages, verify claim",
    success_criteria=[
        "Uses search tools",
        "Finds Python creation date (1991)",
        "Finds Java creation date (1995)",
        "Correctly identifies claim as TRUE",
        "Provides dates as evidence"
    ],
    rubric=SEARCH_SYNTHESIS_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=120,
    tags=["fact_checking", "verification", "history"]
)


# Task 5: News and current events
TASK_SEARCH_005 = EvalTask(
    task_id="search_005",
    category="search_synthesis",
    difficulty="standard",
    prompt="""What are the top 3 programming languages according to the most recent TIOBE index?

Search for the latest TIOBE index and list them.""",
    expected_behavior="Search for current TIOBE index, list top 3",
    success_criteria=[
        "Uses search tools",
        "Finds recent TIOBE index",
        "Lists top 3 languages",
        "Mentions the month/year of the index",
        "Information appears current"
    ],
    rubric=SEARCH_SYNTHESIS_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=120,
    tags=["current_data", "programming", "trends"]
)


# Task 6: Tutorial/how-to synthesis
TASK_SEARCH_006 = EvalTask(
    task_id="search_006",
    category="search_synthesis",
    difficulty="advanced",
    prompt="""Research how to implement rate limiting in a REST API.

Provide:
1. What rate limiting is and why it's important
2. Common algorithms (token bucket, leaky bucket, etc.)
3. A practical example with pseudocode
4. Best practices

Synthesize from multiple sources into a coherent explanation.""",
    expected_behavior="Research rate limiting, synthesize comprehensive guide",
    success_criteria=[
        "Uses search tools",
        "Explains rate limiting purpose",
        "Describes common algorithms",
        "Provides practical example or pseudocode",
        "Lists best practices",
        "Well-organized synthesis"
    ],
    rubric=SEARCH_SYNTHESIS_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=180,
    tags=["research", "api_design", "tutorial"]
)


# Task 7: Historical data lookup
TASK_SEARCH_007 = EvalTask(
    task_id="search_007",
    category="search_synthesis",
    difficulty="simple",
    prompt="""When was the first iPhone released (month and year)?

Search for the exact release date.""",
    expected_behavior="Search for iPhone release date, provide accurate answer",
    success_criteria=[
        "Uses search tools",
        "Provides correct date (June 2007)",
        "Answer is specific and accurate",
        "Cites source or confirms accuracy"
    ],
    rubric=SEARCH_SYNTHESIS_RUBRIC,
    requires_tools=["fast_answer", "web_search"],
    timeout_seconds=90,
    tags=["history", "facts", "technology"]
)


# Task 8: Comparative research
TASK_SEARCH_008 = EvalTask(
    task_id="search_008",
    category="search_synthesis",
    difficulty="advanced",
    prompt="""Compare Docker and Podman container technologies.

Research and provide:
1. What each technology is
2. Key similarities
3. Key differences
4. Security considerations
5. When to use each

Cite specific technical details.""",
    expected_behavior="Research both technologies, provide detailed comparison",
    success_criteria=[
        "Uses search tools",
        "Explains both Docker and Podman",
        "Lists similarities",
        "Lists key differences (rootless, daemonless, etc.)",
        "Discusses security",
        "Provides usage recommendations"
    ],
    rubric=SEARCH_SYNTHESIS_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=180,
    tags=["research", "containers", "comparison"]
)


# Task 9: Definition and explanation
TASK_SEARCH_009 = EvalTask(
    task_id="search_009",
    category="search_synthesis",
    difficulty="standard",
    prompt="""What is "edge computing" and how does it differ from cloud computing?

Research and provide:
1. A clear definition of edge computing
2. How it differs from traditional cloud computing
3. Use cases where edge computing is beneficial
4. Real-world examples""",
    expected_behavior="Search for edge computing information, provide clear explanation",
    success_criteria=[
        "Uses search tools",
        "Defines edge computing clearly",
        "Contrasts with cloud computing",
        "Provides use cases (IoT, low latency, etc.)",
        "Gives real-world examples",
        "Well-organized explanation"
    ],
    rubric=SEARCH_SYNTHESIS_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=150,
    tags=["research", "cloud", "architecture"]
)


# Task 10: Best practices research
TASK_SEARCH_010 = EvalTask(
    task_id="search_010",
    category="search_synthesis",
    difficulty="advanced",
    prompt="""Research and summarize best practices for API versioning.

Include:
1. Why API versioning is important
2. Common versioning strategies (URL, header, query param)
3. Pros and cons of each approach
4. Industry recommendations
5. Examples from popular APIs

Synthesize into a comprehensive guide.""",
    expected_behavior="Research API versioning, synthesize best practices guide",
    success_criteria=[
        "Uses search tools",
        "Explains importance of versioning",
        "Describes multiple versioning strategies",
        "Analyzes pros/cons of each",
        "Provides industry recommendations",
        "Cites examples from real APIs",
        "Well-organized and comprehensive"
    ],
    rubric=SEARCH_SYNTHESIS_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=180,
    tags=["research", "api_design", "best_practices"]
)


# Registry of all search and synthesis tasks
SEARCH_TASKS = [
    TASK_SEARCH_001,
    TASK_SEARCH_002,
    TASK_SEARCH_003,
    TASK_SEARCH_004,
    TASK_SEARCH_005,
    TASK_SEARCH_006,
    TASK_SEARCH_007,
    TASK_SEARCH_008,
    TASK_SEARCH_009,
    TASK_SEARCH_010,
]
