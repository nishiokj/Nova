#!/usr/bin/env python3
import sys


def main():
    try:
        with open('input.txt', 'r', encoding='utf-8') as f:
            text = f.read()
    except FileNotFoundError:
        print("Error: 'input.txt' not found.", file=sys.stderr)
        sys.exit(1)

    # Split on any whitespace to count words
    words = text.split()
    print(len(words))


if __name__ == '__main__':
    main()
