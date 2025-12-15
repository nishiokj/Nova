#!/usr/bin/env python3
import json
import sys
from pathlib import Path

def collect_names(obj):
    names = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == 'name' and isinstance(v, str):
                names.append(v)
            names.extend(collect_names(v))
    elif isinstance(obj, list):
        for item in obj:
            names.extend(collect_names(item))
    return names

def main():
    data_file = Path('data.json')
    out_file = Path('names.txt')
    if not data_file.exists():
        print(f'Error: {data_file} not found.', file=sys.stderr)
        # create/overwrite an empty output file to keep behavior predictable
        out_file.write_text('')
        sys.exit(1)
    try:
        with data_file.open('r', encoding='utf-8') as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f'Error: Failed to parse JSON: {e}', file=sys.stderr)
        out_file.write_text('')
        sys.exit(1)
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        out_file.write_text('')
        sys.exit(1)
    names = collect_names(data)
    try:
        with out_file.open('w', encoding='utf-8') as f:
            for name in names:
                f.write(f'{name}\n')
    except Exception as e:
        print(f'Error writing output: {e}', file=sys.stderr)
        sys.exit(1)
    print(f'Wrote {len(names)} name(s) to {out_file}')

if __name__ == '__main__':
    main()
