#!/usr/bin/env python3
"""Upsert a mate entry into workshop.yaml as TEXT.

No yaml library is available in this environment (yaml-parse.sh hand-parses),
and we must preserve the owner's comments/formatting. So this touches ONLY the
target lines: it never re-serializes the document.

usage: yaml-upsert-mate.py <yaml> <name> <cwd>
  - <name> already present under `mates:` → replace just its `cwd:` line.
  - otherwise → append a new mate block at the end of the `mates:` block
    (default: false, so it doesn't join the default `ka workshop` launch set).

Exit 0 on success; prints a one-line summary of what it did to stderr.
"""
import re
import sys


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: yaml-upsert-mate.py <yaml> <name> <cwd>", file=sys.stderr)
        return 2
    yaml_path, name, cwd = sys.argv[1], sys.argv[2], sys.argv[3]

    with open(yaml_path) as f:
        lines = f.readlines()

    # locate the `mates:` block (top-level key).
    mates_idx = None
    for i, ln in enumerate(lines):
        if re.match(r"^mates:\s*$", ln):
            mates_idx = i
            break
    if mates_idx is None:
        # no mates block yet → create one at EOF.
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        lines.append("\nmates:\n")
        mates_idx = len(lines) - 1

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

    if target_at is not None:
        # replace the cwd line inside this entry (entry ends at next `- name`).
        entry_end = block_end
        for i in range(target_at + 1, block_end):
            if re.match(r"^\s*-\s*name:", lines[i]):
                entry_end = i
                break
        replaced = False
        for i in range(target_at + 1, entry_end):
            if re.match(r"^\s*cwd:\s*", lines[i]):
                indent = re.match(r"^(\s*)", lines[i]).group(1)
                lines[i] = f"{indent}cwd: {cwd}\n"
                replaced = True
                break
        if not replaced:
            # entry had no cwd line → insert one right after the name line,
            # matching the name line's indent + 2 spaces.
            name_indent = re.match(r"^(\s*)", lines[target_at]).group(1)
            field_indent = name_indent + "  "
            lines.insert(target_at + 1, f"{field_indent}cwd: {cwd}\n")
        sys.stderr.write(f"replaced cwd for mate '{name}' -> {cwd}\n")
    else:
        # append a new mate block at the end of the mates block. Match the
        # indentation style of existing entries (2-space list, 4-space fields).
        block = (
            f"  - name: {name}\n"
            f"    cwd: {cwd}\n"
            f"    description: added by `ka workshop spawn-mates`\n"
            f"    default: false\n"
        )
        # make sure the line we insert after ends with a newline.
        if block_end > 0 and not lines[block_end - 1].endswith("\n"):
            lines[block_end - 1] += "\n"
        lines.insert(block_end, block)
        sys.stderr.write(f"added mate '{name}' -> {cwd} (default=false)\n")

    with open(yaml_path, "w") as f:
        f.writelines(lines)
    return 0


if __name__ == "__main__":
    sys.exit(main())
