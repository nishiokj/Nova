#!/bin/bash
# Simple test: Launch Claude Code as an agent from bash

# Method 1: Direct prompt argument
echo "=== Method 1: Direct prompt ==="
claude -p "What is 2+2? Reply with just the number."

echo ""
echo "=== Method 2: Piped input ==="
# Method 2: Pipe input to claude
echo "What is the capital of France? Reply with just the city name." | claude -p

echo ""
echo "=== Method 3: JSON output format ==="
# Method 3: Get structured JSON output
claude -p --output-format json "List 3 colors. Reply as a simple comma-separated list."
