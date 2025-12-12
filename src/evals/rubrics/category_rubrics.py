"""
Standardized rubrics for each task category.

All rubrics are designed for:
- Discrete point assignment (summing to 100)
- Reproducible scoring
- Binary yes/no evaluation where possible
- Automated checks before LLM judgment
"""

from ..eval_task import GradingRubric, RubricCriterion


# Multi-Step Reasoning Rubric
MULTI_STEP_REASONING_RUBRIC = GradingRubric(
    rubric_id="multi_step_v1",
    criteria=[
        RubricCriterion(
            criterion_id="correct_answer",
            description="Final answer is factually correct and complete",
            points=40,
            eval_type="llm_judge",
            judge_question="Is the final answer factually correct and complete?"
        ),
        RubricCriterion(
            criterion_id="shows_reasoning",
            description="Response demonstrates clear step-by-step reasoning",
            points=20,
            eval_type="llm_judge",
            judge_question="Does the response show clear step-by-step reasoning with intermediate steps?"
        ),
        RubricCriterion(
            criterion_id="uses_tools_appropriately",
            description="Agent used appropriate tools to gather information",
            points=20,
            eval_type="llm_judge",
            judge_question="Did the agent use appropriate tools (web search, calculator, etc.) to gather necessary information?"
        ),
        RubricCriterion(
            criterion_id="no_hallucination",
            description="Response does not contain unsupported claims or fabricated information",
            points=20,
            eval_type="llm_judge",
            judge_question="Are all claims in the response either supported by evidence from tools or common knowledge? (Answer NO if there are any unsupported or fabricated claims)"
        )
    ],
    pass_threshold=70
)


# Code Generation Rubric
CODE_GENERATION_RUBRIC = GradingRubric(
    rubric_id="code_gen_v1",
    criteria=[
        RubricCriterion(
            criterion_id="file_created",
            description="Code file was created at the specified location",
            points=20,
            eval_type="file_exists",
            eval_config={"path": "${file_path}"}  # Will be templated per task
        ),
        RubricCriterion(
            criterion_id="code_runs",
            description="Code executes without errors",
            points=30,
            eval_type="llm_judge",
            judge_question="Does the evidence suggest the code runs without errors? (Check for execution confirmation, test results, or absence of error messages)"
        ),
        RubricCriterion(
            criterion_id="meets_requirements",
            description="Code meets the specified functional requirements",
            points=30,
            eval_type="llm_judge",
            judge_question="Does the code meet all the functional requirements specified in the task?"
        ),
        RubricCriterion(
            criterion_id="code_quality",
            description="Code is readable, well-structured, and follows good practices",
            points=20,
            eval_type="llm_judge",
            judge_question="Is the code clean, readable, properly structured, and following good practices? (Consider: naming, structure, comments if needed for complex logic)"
        )
    ],
    pass_threshold=70
)


# Code Debug Rubric
CODE_DEBUG_RUBRIC = GradingRubric(
    rubric_id="code_debug_v1",
    criteria=[
        RubricCriterion(
            criterion_id="bug_identified",
            description="The bug or issue was correctly identified",
            points=25,
            eval_type="llm_judge",
            judge_question="Did the agent correctly identify the bug or issue in the code?"
        ),
        RubricCriterion(
            criterion_id="fix_applied",
            description="A fix was applied to the code",
            points=25,
            eval_type="llm_judge",
            judge_question="Did the agent apply a fix to the code (either by modifying the file or providing corrected code)?"
        ),
        RubricCriterion(
            criterion_id="fix_correct",
            description="The fix correctly resolves the issue",
            points=35,
            eval_type="llm_judge",
            judge_question="Does the fix correctly resolve the identified issue without introducing new bugs?"
        ),
        RubricCriterion(
            criterion_id="preserves_functionality",
            description="Existing functionality is preserved",
            points=15,
            eval_type="llm_judge",
            judge_question="Does the fix preserve the existing intended functionality of the code?"
        )
    ],
    pass_threshold=70
)


# File Operations Rubric
FILE_OPERATIONS_RUBRIC = GradingRubric(
    rubric_id="file_ops_v1",
    criteria=[
        RubricCriterion(
            criterion_id="files_created",
            description="Required files/directories were created",
            points=30,
            eval_type="llm_judge",
            judge_question="Were all required files and/or directories created as specified in the task?"
        ),
        RubricCriterion(
            criterion_id="correct_content",
            description="File content is correct and complete",
            points=35,
            eval_type="llm_judge",
            judge_question="Is the content of the created/modified files correct and complete according to the task requirements?"
        ),
        RubricCriterion(
            criterion_id="correct_structure",
            description="File structure and organization is correct",
            points=20,
            eval_type="llm_judge",
            judge_question="Is the file/directory structure organized correctly as specified?"
        ),
        RubricCriterion(
            criterion_id="task_acknowledged",
            description="Agent confirmed completion of the task",
            points=15,
            eval_type="llm_judge",
            judge_question="Did the agent explicitly acknowledge completing the file operation task in their response?"
        )
    ],
    pass_threshold=70
)


# Search and Synthesis Rubric
SEARCH_SYNTHESIS_RUBRIC = GradingRubric(
    rubric_id="search_synth_v1",
    criteria=[
        RubricCriterion(
            criterion_id="used_search",
            description="Agent used web search or fast_answer to gather information",
            points=20,
            eval_type="contains",
            eval_config={"required_tools": ["web_search", "fast_answer"]}
        ),
        RubricCriterion(
            criterion_id="information_accurate",
            description="Information provided is accurate and current",
            points=35,
            eval_type="llm_judge",
            judge_question="Is the information provided accurate and appears to be current/up-to-date?"
        ),
        RubricCriterion(
            criterion_id="complete_answer",
            description="Response completely addresses the question or request",
            points=25,
            eval_type="llm_judge",
            judge_question="Does the response completely address all parts of the question or request?"
        ),
        RubricCriterion(
            criterion_id="well_synthesized",
            description="Information is well-organized and synthesized (not just copy-paste)",
            points=20,
            eval_type="llm_judge",
            judge_question="Is the information well-organized and properly synthesized into a coherent response (rather than just copy-pasted from sources)?"
        )
    ],
    pass_threshold=70
)


# Simple Factual Q&A Rubric (for baseline tasks)
SIMPLE_QA_RUBRIC = GradingRubric(
    rubric_id="simple_qa_v1",
    criteria=[
        RubricCriterion(
            criterion_id="answer_correct",
            description="Answer is factually correct",
            points=60,
            eval_type="llm_judge",
            judge_question="Is the answer factually correct?"
        ),
        RubricCriterion(
            criterion_id="answer_complete",
            description="Answer is complete and addresses the question",
            points=25,
            eval_type="llm_judge",
            judge_question="Does the answer completely address the question asked?"
        ),
        RubricCriterion(
            criterion_id="answer_clear",
            description="Answer is clear and well-communicated",
            points=15,
            eval_type="llm_judge",
            judge_question="Is the answer clearly communicated and easy to understand?"
        )
    ],
    pass_threshold=70
)


# Calculation/Math Rubric
CALCULATION_RUBRIC = GradingRubric(
    rubric_id="calc_v1",
    criteria=[
        RubricCriterion(
            criterion_id="final_answer_correct",
            description="Final numerical answer is correct",
            points=50,
            eval_type="llm_judge",
            judge_question="Is the final numerical answer mathematically correct?"
        ),
        RubricCriterion(
            criterion_id="work_shown",
            description="Calculation steps or work is shown",
            points=25,
            eval_type="llm_judge",
            judge_question="Did the agent show the calculation steps or explain how they arrived at the answer?"
        ),
        RubricCriterion(
            criterion_id="logic_correct",
            description="The calculation logic and approach is correct",
            points=25,
            eval_type="llm_judge",
            judge_question="Is the calculation logic and approach mathematically sound?"
        )
    ],
    pass_threshold=70
)


def create_custom_rubric(
    rubric_id: str,
    criteria: list,
    pass_threshold: int = 70
) -> GradingRubric:
    """
    Helper function to create custom rubrics for specific tasks.

    Args:
        rubric_id: Unique identifier for the rubric
        criteria: List of RubricCriterion objects
        pass_threshold: Minimum score to pass (default 70)

    Returns:
        GradingRubric instance

    Example:
        rubric = create_custom_rubric(
            "custom_001",
            [
                RubricCriterion("crit1", "Description", 50, "llm_judge",
                               judge_question="Question?"),
                RubricCriterion("crit2", "Description", 50, "exact_match",
                               eval_config={"expected_value": "42"})
            ]
        )
    """
    return GradingRubric(
        rubric_id=rubric_id,
        criteria=criteria,
        pass_threshold=pass_threshold
    )
