"""
Multi-step reasoning tasks for evaluation.

These tasks test the agent's ability to:
- Break down complex problems into steps
- Chain reasoning across multiple operations
- Synthesize information from multiple sources
- Make decisions with trade-off evaluation
"""

from ..eval_task import EvalTask
from ..rubrics.category_rubrics import MULTI_STEP_REASONING_RUBRIC, CALCULATION_RUBRIC


# Task 1: Chain of calculations
TASK_MULTI_001 = EvalTask(
    task_id="multi_step_001",
    category="multi_step_reasoning",
    difficulty="standard",
    prompt="""A company has 3 factories.
Factory A produces 150 widgets per day.
Factory B produces 20% more than Factory A.
Factory C produces half as much as Factories A and B combined.

How many widgets do all three factories produce in 5 days?

Show your work step by step.""",
    expected_behavior="Calculate each factory's production, sum them, multiply by 5 days",
    success_criteria=[
        "Correctly calculates Factory B production (180 widgets/day)",
        "Correctly calculates Factory C production (165 widgets/day)",
        "Correctly calculates total daily production (495 widgets/day)",
        "Correctly calculates 5-day total (2,475 widgets)",
        "Shows calculation steps"
    ],
    rubric=CALCULATION_RUBRIC,
    timeout_seconds=90,
    tags=["math", "chain_of_thought", "calculation"]
)


# Task 2: Data structure comparison
TASK_MULTI_002 = EvalTask(
    task_id="multi_step_002",
    category="multi_step_reasoning",
    difficulty="advanced",
    prompt="""Compare binary search trees versus hash tables for the following operations:
insertion, deletion, and searching.

Provide:
1. Time complexity for each operation in both data structures
2. Space complexity considerations
3. Practical scenarios where you would choose one over the other
4. Trade-offs to consider

Be specific and cite examples.""",
    expected_behavior="Research both data structures, compare time complexities, provide practical guidance",
    success_criteria=[
        "Mentions O(log n) average for BST operations",
        "Mentions O(1) average for hash table operations",
        "Discusses trade-offs (ordering, memory, collisions, worst-case)",
        "Provides specific practical recommendations",
        "Cites concrete examples"
    ],
    rubric=MULTI_STEP_REASONING_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=180,
    tags=["research", "cs_fundamentals", "comparison"]
)


# Task 3: Multi-source synthesis
TASK_MULTI_003 = EvalTask(
    task_id="multi_step_003",
    category="multi_step_reasoning",
    difficulty="advanced",
    prompt="""Research and explain the CAP theorem in distributed systems.

Your answer should include:
1. What CAP stands for and what each component means
2. Why you can only achieve 2 out of 3 properties
3. Real-world examples of systems that prioritize different combinations
4. How modern systems approach this trade-off

Provide specific examples and cite your sources.""",
    expected_behavior="Search for CAP theorem information, synthesize explanation with examples",
    success_criteria=[
        "Correctly explains Consistency, Availability, Partition tolerance",
        "Explains the impossibility of all three",
        "Provides real system examples (e.g., Cassandra as AP, MongoDB as CP)",
        "Discusses modern approaches (eventual consistency, etc.)",
        "Well-organized and synthesized (not copy-paste)"
    ],
    rubric=MULTI_STEP_REASONING_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=180,
    tags=["research", "distributed_systems", "synthesis"]
)


# Task 4: Decision with trade-offs
TASK_MULTI_004 = EvalTask(
    task_id="multi_step_004",
    category="multi_step_reasoning",
    difficulty="advanced",
    prompt="""A startup needs to choose between serverless (AWS Lambda) and container-based
(Kubernetes) architecture for their new API service.

Analyze both options considering:
1. Cost at different scales (low, medium, high traffic)
2. Development complexity and team expertise needed
3. Performance and cold start considerations
4. Vendor lock-in concerns

Provide a recommendation with clear reasoning.""",
    expected_behavior="Analyze both options across multiple dimensions, provide reasoned recommendation",
    success_criteria=[
        "Analyzes cost implications at different scales",
        "Discusses development complexity and team requirements",
        "Addresses performance considerations (cold starts, latency)",
        "Mentions vendor lock-in and portability",
        "Provides clear recommendation with reasoning"
    ],
    rubric=MULTI_STEP_REASONING_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=180,
    tags=["decision_making", "architecture", "trade_offs"]
)


# Task 5: Problem decomposition
TASK_MULTI_005 = EvalTask(
    task_id="multi_step_005",
    category="multi_step_reasoning",
    difficulty="standard",
    prompt="""You have a string "abcabcbb". Find the length of the longest substring
without repeating characters.

Explain your approach step by step, show your reasoning, and provide the answer.""",
    expected_behavior="Decompose problem, explain sliding window or similar approach, provide correct answer",
    success_criteria=[
        "Explains the approach (sliding window or similar algorithm)",
        "Shows step-by-step reasoning through the string",
        "Correctly identifies longest substring (3: 'abc' or 'bca' or 'cab')",
        "Demonstrates understanding of the constraint (no repeating characters)"
    ],
    rubric=MULTI_STEP_REASONING_RUBRIC,
    timeout_seconds=120,
    tags=["algorithms", "problem_solving", "string_manipulation"]
)


# Task 6: Percentage calculations
TASK_MULTI_006 = EvalTask(
    task_id="multi_step_006",
    category="multi_step_reasoning",
    difficulty="simple",
    prompt="""A store is having a sale. A jacket originally costs $80.
It's on sale for 25% off. You have a coupon for an additional 10% off the sale price.

How much will you pay for the jacket after both discounts? Show your work.""",
    expected_behavior="Calculate successive discounts correctly",
    success_criteria=[
        "Calculates 25% off: $60",
        "Calculates additional 10% off the $60: $54",
        "Shows calculation steps",
        "Provides final answer of $54"
    ],
    rubric=CALCULATION_RUBRIC,
    timeout_seconds=90,
    tags=["math", "percentages", "real_world"]
)


# Task 7: Logical reasoning chain
TASK_MULTI_007 = EvalTask(
    task_id="multi_step_007",
    category="multi_step_reasoning",
    difficulty="standard",
    prompt="""If all roses are flowers, and some flowers fade quickly,
can we conclude that some roses fade quickly?

Explain your reasoning using logical principles.""",
    expected_behavior="Apply logical reasoning to determine validity of conclusion",
    success_criteria=[
        "Identifies this as invalid reasoning (or explains why it could be valid/invalid)",
        "Explains the logical structure",
        "Uses proper logical reasoning (universal vs particular statements)",
        "Provides clear explanation"
    ],
    rubric=MULTI_STEP_REASONING_RUBRIC,
    timeout_seconds=120,
    tags=["logic", "reasoning", "philosophy"]
)


# Task 8: Time complexity analysis
TASK_MULTI_008 = EvalTask(
    task_id="multi_step_008",
    category="multi_step_reasoning",
    difficulty="advanced",
    prompt="""Analyze the time complexity of this algorithm:

```python
def example(arr, target):
    for i in range(len(arr)):
        for j in range(i+1, len(arr)):
            if arr[i] + arr[j] == target:
                return True
    return False
```

1. What is the time complexity in Big O notation?
2. Explain why
3. How would you optimize this algorithm?
4. What would the optimized time complexity be?""",
    expected_behavior="Analyze complexity, explain reasoning, propose optimization",
    success_criteria=[
        "Correctly identifies O(n²) time complexity",
        "Explains the nested loop reasoning",
        "Proposes optimization (hash set approach)",
        "Correctly identifies O(n) optimized complexity",
        "Shows clear step-by-step reasoning"
    ],
    rubric=MULTI_STEP_REASONING_RUBRIC,
    timeout_seconds=120,
    tags=["algorithms", "complexity_analysis", "optimization"]
)


# Task 9: Research and summarize
TASK_MULTI_009 = EvalTask(
    task_id="multi_step_009",
    category="multi_step_reasoning",
    difficulty="advanced",
    prompt="""Research and explain what "Zero Trust Security" means in modern cybersecurity.

Include:
1. Core principles of Zero Trust
2. How it differs from traditional perimeter-based security
3. Key components of a Zero Trust architecture
4. Real-world implementation challenges""",
    expected_behavior="Search for Zero Trust information, synthesize comprehensive explanation",
    success_criteria=[
        "Explains core principles (never trust, always verify, least privilege)",
        "Contrasts with perimeter security model",
        "Describes key components (identity verification, micro-segmentation, etc.)",
        "Discusses implementation challenges",
        "Well-organized synthesis"
    ],
    rubric=MULTI_STEP_REASONING_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=180,
    tags=["research", "security", "synthesis"]
)


# Task 10: Sequence reasoning
TASK_MULTI_010 = EvalTask(
    task_id="multi_step_010",
    category="multi_step_reasoning",
    difficulty="standard",
    prompt="""What is the next number in this sequence?
2, 6, 12, 20, 30, ?

Explain the pattern and show how you arrived at your answer.""",
    expected_behavior="Identify pattern (differences increase by 2), calculate next number",
    success_criteria=[
        "Identifies the pattern (n*(n+1) or differences of 4,6,8,10...)",
        "Shows reasoning process",
        "Provides correct answer (42)",
        "Explains why this is the answer"
    ],
    rubric=MULTI_STEP_REASONING_RUBRIC,
    timeout_seconds=90,
    tags=["math", "patterns", "sequences"]
)


# Task 11: Pros and cons analysis
TASK_MULTI_011 = EvalTask(
    task_id="multi_step_011",
    category="multi_step_reasoning",
    difficulty="advanced",
    prompt="""Compare REST APIs versus GraphQL APIs.

Provide:
1. At least 3 advantages of each approach
2. At least 3 disadvantages of each approach
3. Specific scenarios where each is better suited
4. Your recommendation for a new social media application's API""",
    expected_behavior="Research both, provide balanced comparison with specific examples",
    success_criteria=[
        "Lists 3+ pros for REST",
        "Lists 3+ pros for GraphQL",
        "Lists 3+ cons for each",
        "Provides specific use case guidance",
        "Makes reasoned recommendation for the social media scenario"
    ],
    rubric=MULTI_STEP_REASONING_RUBRIC,
    requires_tools=["web_search", "fast_answer"],
    timeout_seconds=180,
    tags=["api_design", "comparison", "architecture"]
)


# Task 12: Compound interest calculation
TASK_MULTI_012 = EvalTask(
    task_id="multi_step_012",
    category="multi_step_reasoning",
    difficulty="standard",
    prompt="""You invest $1,000 at 5% annual interest, compounded monthly.
How much will you have after 3 years?

Show your calculation steps. Use the compound interest formula if needed:
A = P(1 + r/n)^(nt)""",
    expected_behavior="Apply compound interest formula correctly",
    success_criteria=[
        "Uses correct formula",
        "Correctly identifies: P=1000, r=0.05, n=12, t=3",
        "Shows calculation steps",
        "Provides answer close to $1,161.47"
    ],
    rubric=CALCULATION_RUBRIC,
    timeout_seconds=120,
    tags=["math", "finance", "formulas"]
)


# Task 13: Cause and effect analysis
TASK_MULTI_013 = EvalTask(
    task_id="multi_step_013",
    category="multi_step_reasoning",
    difficulty="standard",
    prompt="""Explain why database indexes improve query performance, but can slow down write operations.

Your explanation should cover:
1. How indexes work
2. Why they speed up reads
3. Why they slow down writes
4. Trade-offs to consider""",
    expected_behavior="Explain index mechanics and trade-offs clearly",
    success_criteria=[
        "Explains index data structure (B-tree or similar)",
        "Explains how indexes speed up lookups",
        "Explains why writes require index updates",
        "Discusses trade-offs (space, write performance vs read performance)",
        "Clear, logical explanation"
    ],
    rubric=MULTI_STEP_REASONING_RUBRIC,
    timeout_seconds=120,
    tags=["databases", "performance", "trade_offs"]
)


# Task 14: Algorithm selection
TASK_MULTI_014 = EvalTask(
    task_id="multi_step_014",
    category="multi_step_reasoning",
    difficulty="advanced",
    prompt="""You need to sort 1 million records that are already "almost sorted"
(most elements are in the right position, only a few are out of order).

1. What sorting algorithm would you choose and why?
2. What is its time complexity for this specific case?
3. Why is it better than other sorting algorithms for this scenario?""",
    expected_behavior="Identify insertion sort or similar, explain why it's optimal for nearly-sorted data",
    success_criteria=[
        "Identifies appropriate algorithm (Insertion Sort, Tim Sort, or explains adaptive sorting)",
        "Explains why it's efficient for nearly-sorted data",
        "Mentions O(n) best case for insertion sort on nearly-sorted data",
        "Contrasts with other algorithms (QuickSort, MergeSort)",
        "Shows understanding of algorithmic trade-offs"
    ],
    rubric=MULTI_STEP_REASONING_RUBRIC,
    timeout_seconds=150,
    tags=["algorithms", "sorting", "optimization"]
)


# Task 15: System design reasoning
TASK_MULTI_015 = EvalTask(
    task_id="multi_step_015",
    category="multi_step_reasoning",
    difficulty="advanced",
    prompt="""Design a URL shortening service (like bit.ly).

Explain your approach for:
1. Generating short URLs (algorithm/strategy)
2. Storing the mappings (database choice and schema)
3. Handling collisions
4. Scaling to billions of URLs

Provide reasoning for each decision.""",
    expected_behavior="Design system with clear reasoning for each component",
    success_criteria=[
        "Proposes URL generation strategy (base62, hashing, counter, etc.)",
        "Suggests database solution with justification",
        "Addresses collision handling",
        "Discusses scaling strategies (sharding, caching, etc.)",
        "Shows systems thinking and trade-off awareness"
    ],
    rubric=MULTI_STEP_REASONING_RUBRIC,
    timeout_seconds=180,
    tags=["system_design", "architecture", "scalability"]
)


# Registry of all multi-step reasoning tasks
MULTI_STEP_TASKS = [
    TASK_MULTI_001,
    TASK_MULTI_002,
    TASK_MULTI_003,
    TASK_MULTI_004,
    TASK_MULTI_005,
    TASK_MULTI_006,
    TASK_MULTI_007,
    TASK_MULTI_008,
    TASK_MULTI_009,
    TASK_MULTI_010,
    TASK_MULTI_011,
    TASK_MULTI_012,
    TASK_MULTI_013,
    TASK_MULTI_014,
    TASK_MULTI_015,
]
