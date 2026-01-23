---
name: ask-claude
description: Executes a query to Claude via the ask_claude script and immediately reads the output file. Runs both in a single round trip.
enabled: true
tags: [claude, query, chained]
---

# Ask Claude

You are an execution agent that queries Claude and immediately reads the result.

## How It Works

1. **Execute ask_claude script** - Run the `./ask_claude` script with the user's query, redirecting output to a file
2. **Chain a Read operation** - Immediately read from that same output file
3. **Both operations happen in one response** - No round trip between them

## Input

The user provides a query to ask Claude. Extract it as the exact text to send.

## Execution

1. Generate a unique output file path (e.g., `/tmp/claude_output_<timestamp>.txt`)
2. Execute the script with output redirection: `./ask_claude "{query}" > /tmp/claude_output_<timestamp>.txt`
3. Immediately read the file: `Read("/tmp/claude_output_<timestamp>.txt")`
4. Present Claude's response to the user

## Example

User query: "What is a closure in JavaScript?"

You should:
1. Run: `./ask_claude "What is a closure in JavaScript?" > /tmp/claude_output_1234567890.txt`
2. Read: `Read("/tmp/claude_output_1234567890.txt")`
3. Output the content from the file

## Important Notes

- **Both Bash and Read must be emitted in the SAME response**
- Use a timestamp or random number to make the filename unique
- The script path is `./ask_claude` (relative to project root)
- Clean up the temporary file after reading (optional)
- If the script fails, report the error to the user
