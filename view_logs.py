#!/usr/bin/env python3
"""Pretty-print worker/wizard logs from health.jsonl"""
import json
import sys
from pathlib import Path

def main():
    log_file = Path("tui/logs/health.jsonl")
    if not log_file.exists():
        print(f"Log file not found: {log_file}")
        sys.exit(1)

    # Get last N lines (default 100)
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100

    lines = log_file.read_text().strip().split('\n')
    lines = lines[-n:]  # Last N lines

    print(f"\n{'='*80}")
    print(f"LAST {len(lines)} LOG ENTRIES (worker/wizard/llm only)")
    print(f"{'='*80}\n")

    for line in lines:
        try:
            entry = json.loads(line)
            svc = entry.get("svc", "")

            # Only show worker, wizard, llm logs
            if svc not in ("worker", "wizard", "llm"):
                continue

            ts = entry.get("ts", "")[-12:-1]  # Just time portion
            evt = entry.get("evt", "")
            data = entry.get("data", {})

            # Color coding
            if svc == "worker":
                color = "\033[36m"  # Cyan
            elif svc == "wizard":
                color = "\033[33m"  # Yellow
            elif svc == "llm":
                color = "\033[32m"  # Green
            else:
                color = ""
            reset = "\033[0m"

            # Print main line
            print(f"{color}[{ts}] [{svc:6}]{reset} {evt}")

            # Print full_message if present (for long content)
            if "full_message" in data:
                full = data["full_message"]
                # Indent and wrap
                for line in full.split('\n'):
                    print(f"           {line}")
                print()

        except json.JSONDecodeError:
            continue

if __name__ == "__main__":
    main()
