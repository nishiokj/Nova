"""
File operations tasks for evaluation.

These tasks test the agent's ability to:
- Create directory structures
- Read and parse data files
- Transform and process file content
- Search filesystems
- Perform multi-file operations
"""

from evals.eval_task import EvalTask
from evals.rubrics.category_rubrics import FILE_OPERATIONS_RUBRIC


# Task 1: Create project structure
TASK_FILE_001 = EvalTask(
    task_id="file_001",
    category="file_ops",
    difficulty="standard",
    prompt="""Create a project structure for a Python web application:
- Create a directory called 'myapp'
- Inside myapp, create subdirectories: models, views, controllers, tests
- Create an empty __init__.py file in each subdirectory
- Create a README.md in the myapp directory with a brief project description""",
    expected_behavior="Create directory structure with specified files",
    success_criteria=[
        "myapp/ directory exists",
        "models/, views/, controllers/, tests/ subdirectories exist inside myapp",
        "__init__.py files in all subdirectories",
        "README.md exists in myapp with content"
    ],
    rubric=FILE_OPERATIONS_RUBRIC,
    requires_tools=["bash_execute", "file_write", "list_files"],
    timeout_seconds=120,
    tags=["directory_structure", "project_setup"]
)


# Task 2: CSV parsing and transformation
TASK_FILE_002 = EvalTask(
    task_id="file_002",
    category="file_ops",
    difficulty="advanced",
    prompt="""Read the CSV file 'data.csv' and create a summary file 'summary.txt' with:
- Total number of entries
- Average score (rounded to 2 decimals)
- Highest score
- Lowest score

Format the output nicely in summary.txt.""",
    context={
        "files": {
            "data.csv": "name,score\nAlice,85\nBob,92\nCarol,78\nDave,95\nEve,88"
        }
    },
    expected_behavior="Read CSV, calculate statistics, write summary file",
    success_criteria=[
        "Reads data.csv successfully",
        "Calculates correct count (5)",
        "Calculates correct average (87.60)",
        "Identifies correct highest (95) and lowest (78)",
        "Creates summary.txt with formatted output"
    ],
    rubric=FILE_OPERATIONS_RUBRIC,
    requires_tools=["file_read", "file_write", "python_execute"],
    timeout_seconds=120,
    tags=["csv", "data_processing", "statistics"]
)


# Task 3: Find and replace in files
TASK_FILE_003 = EvalTask(
    task_id="file_003",
    category="file_ops",
    difficulty="standard",
    prompt="""You have a file 'config.txt' that contains the word "localhost" in several places.

Create a new file 'config_prod.txt' that is a copy of config.txt but with all
occurrences of "localhost" replaced with "production.server.com".""",
    context={
        "files": {
            "config.txt": """database_host=localhost
api_endpoint=http://localhost:8000/api
cache_server=localhost:6379
"""
        }
    },
    expected_behavior="Read config.txt, replace text, write new file",
    success_criteria=[
        "Reads config.txt",
        "Replaces all occurrences of localhost",
        "Creates config_prod.txt",
        "Preserves file structure",
        "All replacements correct"
    ],
    rubric=FILE_OPERATIONS_RUBRIC,
    requires_tools=["file_read", "file_write"],
    timeout_seconds=90,
    tags=["text_replacement", "file_manipulation"]
)


# Task 4: JSON to CSV conversion
TASK_FILE_004 = EvalTask(
    task_id="file_004",
    category="file_ops",
    difficulty="advanced",
    prompt="""Convert the JSON file 'users.json' to a CSV file 'users.csv'.

The CSV should have headers: name, email, age
Each JSON object should become a row in the CSV.""",
    context={
        "files": {
            "users.json": """[
    {"name": "Alice", "email": "alice@example.com", "age": 30},
    {"name": "Bob", "email": "bob@example.com", "age": 25},
    {"name": "Charlie", "email": "charlie@example.com", "age": 35}
]"""
        }
    },
    expected_behavior="Parse JSON, convert to CSV format, write file",
    success_criteria=[
        "Reads and parses JSON correctly",
        "Creates CSV with proper headers",
        "Converts all entries",
        "Proper CSV formatting",
        "Creates users.csv"
    ],
    rubric=FILE_OPERATIONS_RUBRIC,
    requires_tools=["file_read", "file_write", "python_execute"],
    timeout_seconds=120,
    tags=["json", "csv", "data_conversion"]
)


# Task 5: File filtering
TASK_FILE_005 = EvalTask(
    task_id="file_005",
    category="file_ops",
    difficulty="standard",
    prompt="""Read 'numbers.txt' which contains numbers, one per line.

Create a new file 'evens.txt' containing only the even numbers, maintaining the same format.""",
    context={
        "files": {
            "numbers.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n10"
        }
    },
    expected_behavior="Read file, filter even numbers, write new file",
    success_criteria=[
        "Reads numbers.txt",
        "Correctly identifies even numbers",
        "Creates evens.txt",
        "Writes numbers one per line",
        "Contains only 2, 4, 6, 8, 10"
    ],
    rubric=FILE_OPERATIONS_RUBRIC,
    requires_tools=["file_read", "file_write"],
    timeout_seconds=90,
    tags=["filtering", "text_processing"]
)


# Task 6: Directory listing
TASK_FILE_006 = EvalTask(
    task_id="file_006",
    category="file_ops",
    difficulty="simple",
    prompt="""List all files in the current directory and save the list to 'file_list.txt',
one filename per line.

Sort the filenames alphabetically.""",
    expected_behavior="List directory contents, sort, write to file",
    success_criteria=[
        "Lists files in current directory",
        "Sorts filenames alphabetically",
        "Creates file_list.txt",
        "One filename per line",
        "Excludes directories (only files)"
    ],
    rubric=FILE_OPERATIONS_RUBRIC,
    requires_tools=["bash_execute", "file_write", "list_files"],
    timeout_seconds=90,
    tags=["directory", "listing", "sorting"]
)


# Task 7: Log file parsing
TASK_FILE_007 = EvalTask(
    task_id="file_007",
    category="file_ops",
    difficulty="advanced",
    prompt="""Parse the log file 'app.log' and create a summary file 'log_summary.txt' with:
- Total number of lines
- Number of ERROR lines
- Number of WARNING lines
- Number of INFO lines

Also list all unique ERROR messages.""",
    context={
        "files": {
            "app.log": """2024-01-01 10:00:00 INFO Application started
2024-01-01 10:00:05 INFO User logged in: alice
2024-01-01 10:01:00 WARNING High memory usage: 85%
2024-01-01 10:02:00 ERROR Database connection failed
2024-01-01 10:02:30 INFO Retrying connection
2024-01-01 10:03:00 ERROR Database connection failed
2024-01-01 10:04:00 INFO Connection established
2024-01-01 10:05:00 WARNING Slow query detected: 2.5s
"""
        }
    },
    expected_behavior="Parse log file, count by level, extract error messages",
    success_criteria=[
        "Reads app.log",
        "Counts total lines (8)",
        "Counts ERRORs (2), WARNINGs (2), INFOs (4)",
        "Extracts unique error messages",
        "Creates log_summary.txt with findings"
    ],
    rubric=FILE_OPERATIONS_RUBRIC,
    requires_tools=["file_read", "file_write", "python_execute"],
    timeout_seconds=120,
    tags=["log_parsing", "text_processing", "analysis"]
)


# Task 8: File concatenation
TASK_FILE_008 = EvalTask(
    task_id="file_008",
    category="file_ops",
    difficulty="simple",
    prompt="""Concatenate the contents of 'part1.txt', 'part2.txt', and 'part3.txt'
into a single file called 'combined.txt'.

Maintain the order: part1, then part2, then part3.""",
    context={
        "files": {
            "part1.txt": "This is part one.\n",
            "part2.txt": "This is part two.\n",
            "part3.txt": "This is part three.\n"
        }
    },
    expected_behavior="Read all three files, concatenate, write combined file",
    success_criteria=[
        "Reads all three part files",
        "Concatenates in correct order",
        "Creates combined.txt",
        "Content is complete and correctly ordered",
        "No extra whitespace or formatting issues"
    ],
    rubric=FILE_OPERATIONS_RUBRIC,
    requires_tools=["file_read", "file_write"],
    timeout_seconds=90,
    tags=["file_concatenation", "text_processing"]
)


# Task 9: Markdown generation
TASK_FILE_009 = EvalTask(
    task_id="file_009",
    category="file_ops",
    difficulty="standard",
    prompt="""Create a markdown file 'documentation.md' with the following structure:

# Project Documentation

## Overview
Brief description of the project

## Installation
```bash
pip install requirements.txt
```

## Usage
Instructions for running the application

## License
MIT License

Make sure to use proper markdown formatting.""",
    expected_behavior="Create well-formatted markdown file",
    success_criteria=[
        "Creates documentation.md",
        "Has proper markdown headers (# and ##)",
        "Includes code block with bash",
        "All sections present",
        "Proper markdown syntax"
    ],
    rubric=FILE_OPERATIONS_RUBRIC,
    requires_tools=["file_write"],
    timeout_seconds=90,
    tags=["markdown", "documentation", "formatting"]
)


# Task 10: Text statistics
TASK_FILE_010 = EvalTask(
    task_id="file_010",
    category="file_ops",
    difficulty="standard",
    prompt="""Read 'article.txt' and create 'stats.txt' with the following statistics:
- Total characters (including spaces)
- Total words
- Total lines
- Average word length
- Most common word (case-insensitive)""",
    context={
        "files": {
            "article.txt": """The quick brown fox jumps over the lazy dog.
The dog was sleeping under a tree.
The fox was very quick and clever."""
        }
    },
    expected_behavior="Analyze text file, compute statistics, write results",
    success_criteria=[
        "Reads article.txt",
        "Calculates all required statistics correctly",
        "Identifies most common word ('the')",
        "Creates stats.txt with results",
        "Results are formatted clearly"
    ],
    rubric=FILE_OPERATIONS_RUBRIC,
    requires_tools=["file_read", "file_write", "python_execute"],
    timeout_seconds=120,
    tags=["text_analysis", "statistics", "nlp"]
)


# Task 11: Configuration file creation
TASK_FILE_011 = EvalTask(
    task_id="file_011",
    category="file_ops",
    difficulty="standard",
    prompt="""Create a configuration file 'app_config.ini' with the following structure:

[database]
host = localhost
port = 5432
name = myapp_db

[server]
host = 0.0.0.0
port = 8000
debug = false

[logging]
level = INFO
file = app.log

Use proper INI file format.""",
    expected_behavior="Create properly formatted INI configuration file",
    success_criteria=[
        "Creates app_config.ini",
        "Has three sections: database, server, logging",
        "All keys and values present",
        "Proper INI formatting",
        "Values are correctly formatted"
    ],
    rubric=FILE_OPERATIONS_RUBRIC,
    requires_tools=["file_write"],
    timeout_seconds=90,
    tags=["configuration", "ini", "formatting"]
)


# Task 12: Backup file creation
TASK_FILE_012 = EvalTask(
    task_id="file_012",
    category="file_ops",
    difficulty="simple",
    prompt="""Create a backup of 'important.txt' by copying it to 'important.txt.backup'.

Verify that both files have identical content.""",
    context={
        "files": {
            "important.txt": "This is very important data that must be backed up.\nDo not lose this information.\n"
        }
    },
    expected_behavior="Copy file to backup location",
    success_criteria=[
        "Reads important.txt",
        "Creates important.txt.backup",
        "Backup has identical content",
        "Both files exist",
        "Content integrity maintained"
    ],
    rubric=FILE_OPERATIONS_RUBRIC,
    requires_tools=["file_read", "file_write", "bash_execute"],
    timeout_seconds=90,
    tags=["backup", "file_copying"]
)


# Registry of all file operations tasks
FILE_TASKS = [
    TASK_FILE_001,
    TASK_FILE_002,
    TASK_FILE_003,
    TASK_FILE_004,
    TASK_FILE_005,
    TASK_FILE_006,
    TASK_FILE_007,
    TASK_FILE_008,
    TASK_FILE_009,
    TASK_FILE_010,
    TASK_FILE_011,
    TASK_FILE_012,
]
