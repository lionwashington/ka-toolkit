#!/usr/bin/env python3
"""Remove a mate entry from workshop.yaml as TEXT.

Mirror of yaml-upsert-mate.py: no yaml library (yaml-parse.sh hand-parses), and
we must preserve the owner's comments/formatting for the OTHER entries. So this
deletes ONLY the target entry's lines; it never re-serializes the document.

usage: yaml-remove-mate.py <yaml> <name>
  - deletes the `- name: <name>` block under `mates:` (from its `- name:` line up
    to the next `- name:` at the same level, or the end of the mates block).
  - refuses to remove an entry marked `main: true` (the lead).

Exit 0 on success; 3 = name not found; 4 = refused (is main); 2 = usage.
Prints a one-line summary of what it did to stderr.
"""
import re
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: yaml-remove-mate.py <yaml> <name>", file=sys.stderr)
        return 2
    yaml_path, name = sys.argv[1], sys.argv[2]

    with open(yaml_path) as f:
        lines = f.readlines()

    # locate the `mates:` block (top-level key).
    mates_idx = None
    for i, ln in enumerate(lines):
        if re.match(r"^mates:\s*$", ln):
            mates_idx = i
            break
    if mates_idx is None:
        print(f"no `mates:` block in {yaml_path}", file=sys.stderr)
        return 3

    # the mates block runs until the next top-level (non-indented) key or EOF.
    block_end = len(lines)
    for i in range(mates_idx + 1, len(lines)):
        if re.match(r"^\S", lines[i]):
            block_end = i
            break

    # find the target `- name: <name>` entry within the block.
    target_at = None
    for i in range(mates_idx + 1, block_end):
        m = re.match(r"^\s*-\s*name:\s*(\S+)\s*$", lines[i])
        if m and m.group(1) == name:
            target_at = i
            break
    if target_at is None:
        print(f"mate '{name}' not found under `mates:` in {yaml_path}", file=sys.stderr)
        return 3

    # entry extent: from its `- name:` line up to the next `- name:` (any) or block end.
    entry_end = block_end
    for i in range(target_at + 1, block_end):
        if re.match(r"^\s*-\s*name:", lines[i]):
            entry_end = i
            break

    # refuse to remove the lead (main: true) inside this entry.
    for i in range(target_at, entry_end):
        if re.match(r"^\s*main:\s*true\s*$", lines[i]):
            print(f"refusing to remove '{name}': it is the lead (main: true)", file=sys.stderr)
            return 4

    del lines[target_at:entry_end]

    with open(yaml_path, "w") as f:
        f.writelines(lines)
    sys.stderr.write(f"removed mate '{name}' ({entry_end - target_at} line(s)) from {yaml_path}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
