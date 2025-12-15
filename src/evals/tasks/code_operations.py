"""
Code operations tasks for evaluation.

These tasks test the agent's ability to:
- Generate working code from specifications
- Debug and fix broken code
- Write code that passes test cases
- Transform and refactor code
- Implement algorithms
"""

from evals.eval_task import EvalTask
from evals.rubrics.category_rubrics import CODE_GENERATION_RUBRIC, CODE_DEBUG_RUBRIC
from evals.rubrics.rubric_templates import template_file_path


# Task 1: Simple function generation
TASK_CODE_001 = EvalTask(
    task_id="code_001",
    category="code_ops",
    difficulty="standard",
    prompt="""Write a Python function called 'is_palindrome' that checks if a string is a palindrome.
Save it to a file called 'palindrome.py'.

Requirements:
- Function should ignore spaces
- Function should be case-insensitive
- Return True if palindrome, False otherwise

Example: is_palindrome("A man a plan a canal Panama") should return True""",
    expected_behavior="Create palindrome.py with working is_palindrome function",
    success_criteria=[
        "File palindrome.py exists",
        "Contains function named is_palindrome",
        "Function handles spaces correctly",
        "Function is case-insensitive",
        "Function works for test cases"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "palindrome.py"),
    requires_tools=["file_write", "python_execute"],
    timeout_seconds=120,
    tags=["code_generation", "string_manipulation", "python"]
)


# Task 2: Bug fix
TASK_CODE_002 = EvalTask(
    task_id="code_002",
    category="code_ops",
    difficulty="standard",
    prompt="""The following Python function has a bug. Find and fix it, then save the corrected version to 'fixed_average.py':

```python
def calculate_average(numbers):
    total = 0
    for num in numbers:
        total += num
    return total / len(numbers)
```

The bug: This function crashes when given an empty list. Fix it to return 0 for empty lists.""",
    context={
        "files": {
            "buggy_average.py": """def calculate_average(numbers):
    total = 0
    for num in numbers:
        total += num
    return total / len(numbers)
"""
        }
    },
    expected_behavior="Identify division by zero bug, fix it, save corrected version",
    success_criteria=[
        "Identifies the division by zero error",
        "Fixes code to handle empty list",
        "Returns 0 for empty list",
        "Preserves existing functionality for non-empty lists",
        "Saves to fixed_average.py"
    ],
    rubric=CODE_DEBUG_RUBRIC,
    requires_tools=["file_read", "file_write", "python_execute"],
    timeout_seconds=120,
    tags=["debugging", "edge_cases", "python"]
)


# Task 3: List manipulation
TASK_CODE_003 = EvalTask(
    task_id="code_003",
    category="code_ops",
    difficulty="standard",
    prompt="""Write a Python function called 'remove_duplicates' that takes a list and returns
a new list with duplicates removed, preserving the original order.

Save it to 'remove_duplicates.py'.

Example: remove_duplicates([1, 2, 2, 3, 1, 4]) should return [1, 2, 3, 4]""",
    expected_behavior="Create remove_duplicates.py with working function",
    success_criteria=[
        "File created",
        "Function removes duplicates",
        "Preserves original order",
        "Works with various data types",
        "Handles edge cases (empty list, all duplicates)"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "remove_duplicates.py"),
    requires_tools=["file_write", "python_execute"],
    timeout_seconds=120,
    tags=["code_generation", "list_manipulation", "python"]
)


# Task 4: File I/O
TASK_CODE_004 = EvalTask(
    task_id="code_004",
    category="code_ops",
    difficulty="standard",
    prompt="""Write a Python script called 'word_count.py' that:
1. Reads a file called 'input.txt'
2. Counts the number of words in the file
3. Prints the count to the console

Handle the case where the file doesn't exist gracefully.""",
    context={
        "files": {
            "input.txt": "The quick brown fox jumps over the lazy dog. The dog was not amused."
        }
    },
    expected_behavior="Create word_count.py that reads file and counts words",
    success_criteria=[
        "File word_count.py created",
        "Script reads input.txt",
        "Correctly counts words (should be 14 for the sample)",
        "Handles missing file gracefully",
        "Prints result"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "word_count.py"),
    requires_tools=["file_read", "file_write", "python_execute"],
    timeout_seconds=120,
    tags=["file_io", "text_processing", "python"]
)


# Task 5: Fibonacci
TASK_CODE_005 = EvalTask(
    task_id="code_005",
    category="code_ops",
    difficulty="simple",
    prompt="""Write a Python function called 'fibonacci' that returns the nth Fibonacci number.
Save it to 'fibonacci.py'.

Use any approach you like (recursive, iterative, or memoized).

Example: fibonacci(10) should return 55""",
    expected_behavior="Create fibonacci.py with working fibonacci function",
    success_criteria=[
        "File created",
        "Function correctly computes Fibonacci numbers",
        "fibonacci(10) returns 55",
        "Handles edge cases (n=0, n=1)"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "fibonacci.py"),
    requires_tools=["file_write", "python_execute"],
    timeout_seconds=120,
    tags=["algorithms", "recursion", "python"]
)


# Task 6: JSON parsing
TASK_CODE_006 = EvalTask(
    task_id="code_006",
    category="code_ops",
    difficulty="standard",
    prompt="""Write a Python script called 'parse_json.py' that:
1. Reads 'data.json'
2. Extracts all the 'name' fields
3. Writes them to 'names.txt', one per line

Handle JSON parsing errors gracefully.""",
    context={
        "files": {
            "data.json": """[
    {"name": "Alice", "age": 30},
    {"name": "Bob", "age": 25},
    {"name": "Charlie", "age": 35}
]"""
        }
    },
    expected_behavior="Create parse_json.py that extracts names from JSON",
    success_criteria=[
        "Script created",
        "Reads and parses JSON correctly",
        "Extracts name fields",
        "Writes to names.txt with correct format",
        "Handles errors gracefully"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "parse_json.py"),
    requires_tools=["file_read", "file_write", "python_execute"],
    timeout_seconds=120,
    tags=["json", "data_processing", "python"]
)


# Task 7: Class implementation
TASK_CODE_007 = EvalTask(
    task_id="code_007",
    category="code_ops",
    difficulty="advanced",
    prompt="""Write a Python class called 'BankAccount' with the following features:
- Constructor that takes initial balance
- deposit(amount) method
- withdraw(amount) method that prevents overdraft
- get_balance() method

Save it to 'bank_account.py'.

The withdraw method should return False if insufficient funds, True if successful.""",
    expected_behavior="Create bank_account.py with BankAccount class",
    success_criteria=[
        "File created with BankAccount class",
        "Constructor initializes balance",
        "deposit() adds to balance",
        "withdraw() checks for sufficient funds",
        "withdraw() prevents overdraft",
        "get_balance() returns current balance"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "bank_account.py"),
    requires_tools=["file_write", "python_execute"],
    timeout_seconds=150,
    tags=["oop", "classes", "python"]
)


# Task 8: Sorting implementation
TASK_CODE_008 = EvalTask(
    task_id="code_008",
    category="code_ops",
    difficulty="advanced",
    prompt="""Implement the quicksort algorithm in Python.

Save it to 'quicksort.py' with a function called 'quicksort' that takes a list
and returns a new sorted list.

Example: quicksort([3, 1, 4, 1, 5, 9, 2, 6]) should return [1, 1, 2, 3, 4, 5, 6, 9]""",
    expected_behavior="Create quicksort.py with working quicksort implementation",
    success_criteria=[
        "File created",
        "Implements quicksort algorithm",
        "Correctly sorts lists",
        "Handles edge cases (empty, single element)",
        "Returns new list (doesn't modify original)"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "quicksort.py"),
    requires_tools=["file_write", "python_execute"],
    timeout_seconds=150,
    tags=["algorithms", "sorting", "python"]
)


# Task 9: Regular expressions
TASK_CODE_009 = EvalTask(
    task_id="code_009",
    category="code_ops",
    difficulty="standard",
    prompt="""Write a Python function called 'validate_email' that uses regular expressions
to validate email addresses.

Save it to 'email_validator.py'.

Valid email format: username@domain.extension
- Username: alphanumeric and underscores
- Domain: alphanumeric and hyphens
- Extension: 2-4 letters

Return True if valid, False otherwise.""",
    expected_behavior="Create email_validator.py with regex-based validation",
    success_criteria=[
        "File created",
        "Uses regular expressions",
        "Correctly validates valid emails",
        "Correctly rejects invalid emails",
        "Handles edge cases"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "email_validator.py"),
    requires_tools=["file_write", "python_execute"],
    timeout_seconds=120,
    tags=["regex", "validation", "python"]
)


# Task 10: Exception handling
TASK_CODE_010 = EvalTask(
    task_id="code_010",
    category="code_ops",
    difficulty="standard",
    prompt="""Fix this code to properly handle exceptions. Save the fixed version to 'safe_division.py':

```python
def divide(a, b):
    return a / b

result = divide(10, 0)
print(result)
```

The code should:
- Catch division by zero
- Print an error message
- Return None for invalid operations""",
    context={
        "files": {
            "unsafe_division.py": """def divide(a, b):
    return a / b

result = divide(10, 0)
print(result)
"""
        }
    },
    expected_behavior="Add exception handling for division by zero",
    success_criteria=[
        "Adds try/except block",
        "Catches ZeroDivisionError",
        "Returns None for division by zero",
        "Prints helpful error message",
        "Saves to safe_division.py"
    ],
    rubric=CODE_DEBUG_RUBRIC,
    requires_tools=["file_read", "file_write", "python_execute"],
    timeout_seconds=120,
    tags=["exception_handling", "error_handling", "python"]
)


# Task 11: Data structure implementation
TASK_CODE_011 = EvalTask(
    task_id="code_011",
    category="code_ops",
    difficulty="advanced",
    prompt="""Implement a simple Stack class in Python with the following methods:
- push(item): Add item to top
- pop(): Remove and return top item
- peek(): Return top item without removing
- is_empty(): Return True if stack is empty

Save it to 'stack.py'.

Raise an exception if pop() or peek() are called on an empty stack.""",
    expected_behavior="Create stack.py with Stack class implementation",
    success_criteria=[
        "File created with Stack class",
        "push() adds items",
        "pop() removes and returns items (LIFO)",
        "peek() returns top without removing",
        "is_empty() works correctly",
        "Raises exception for invalid operations"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "stack.py"),
    requires_tools=["file_write", "python_execute"],
    timeout_seconds=150,
    tags=["data_structures", "stack", "python"]
)


# Task 12: String manipulation
TASK_CODE_012 = EvalTask(
    task_id="code_012",
    category="code_ops",
    difficulty="simple",
    prompt="""Write a Python function called 'reverse_words' that reverses the order of words
in a sentence.

Save it to 'reverse_words.py'.

Example: reverse_words("Hello World Python") should return "Python World Hello" """,
    expected_behavior="Create reverse_words.py with working function",
    success_criteria=[
        "File created",
        "Function splits sentence into words",
        "Reverses word order",
        "Joins back with spaces",
        "Handles edge cases (empty string, single word)"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "reverse_words.py"),
    requires_tools=["file_write", "python_execute"],
    timeout_seconds=90,
    tags=["string_manipulation", "python"]
)


# Task 13: List comprehension
TASK_CODE_013 = EvalTask(
    task_id="code_013",
    category="code_ops",
    difficulty="standard",
    prompt="""Write a Python function called 'filter_evens' that takes a list of integers
and returns a new list containing only the even numbers, using list comprehension.

Save it to 'filter_evens.py'.

Example: filter_evens([1, 2, 3, 4, 5, 6]) should return [2, 4, 6]""",
    expected_behavior="Create filter_evens.py using list comprehension",
    success_criteria=[
        "File created",
        "Uses list comprehension",
        "Correctly filters even numbers",
        "Returns new list",
        "Works with various inputs"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "filter_evens.py"),
    requires_tools=["file_write", "python_execute"],
    timeout_seconds=90,
    tags=["list_comprehension", "filtering", "python"]
)


# Task 14: Dictionary operations
TASK_CODE_014 = EvalTask(
    task_id="code_014",
    category="code_ops",
    difficulty="standard",
    prompt="""Write a Python function called 'merge_dicts' that takes two dictionaries
and returns a new dictionary with combined keys. If a key exists in both, sum the values.

Save it to 'merge_dicts.py'.

Example: merge_dicts({'a': 1, 'b': 2}, {'b': 3, 'c': 4}) should return {'a': 1, 'b': 5, 'c': 4}""",
    expected_behavior="Create merge_dicts.py with dictionary merging logic",
    success_criteria=[
        "File created",
        "Merges dictionaries correctly",
        "Sums values for duplicate keys",
        "Handles non-overlapping keys",
        "Returns new dictionary"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "merge_dicts.py"),
    requires_tools=["file_write", "python_execute"],
    timeout_seconds=120,
    tags=["dictionaries", "data_structures", "python"]
)


# Task 15: Generator function
TASK_CODE_015 = EvalTask(
    task_id="code_015",
    category="code_ops",
    difficulty="advanced",
    prompt="""Write a Python generator function called 'prime_generator' that yields
prime numbers indefinitely.

Save it to 'prime_generator.py'.

The generator should efficiently generate primes one at a time.
Include a comment explaining your approach.""",
    expected_behavior="Create prime_generator.py with generator function",
    success_criteria=[
        "File created",
        "Uses yield (is a generator)",
        "Correctly identifies primes",
        "Efficient algorithm",
        "Includes explanatory comment"
    ],
    rubric=template_file_path(CODE_GENERATION_RUBRIC, "prime_generator.py"),
    requires_tools=["file_write", "python_execute"],
    timeout_seconds=150,
    tags=["generators", "algorithms", "python"]
)


# Registry of all code operations tasks
CODE_TASKS = [
    TASK_CODE_001,
    TASK_CODE_002,
    TASK_CODE_003,
    TASK_CODE_004,
    TASK_CODE_005,
    TASK_CODE_006,
    TASK_CODE_007,
    TASK_CODE_008,
    TASK_CODE_009,
    TASK_CODE_010,
    TASK_CODE_011,
    TASK_CODE_012,
    TASK_CODE_013,
    TASK_CODE_014,
    TASK_CODE_015,
]
