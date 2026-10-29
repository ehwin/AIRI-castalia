#!/usr/bin/env python3
"""Report fork features that the upgrade silently dropped.

The build only proves the tree type-checks. A merge that takes upstream's version of a file the
fork had changed can delete a *call* (a service wiring, a store method) with no compile error --
the app then starts with the feature missing, or dies at runtime with "X is not a function".
This walks the fork's own delta and checks, per file, that the symbols the fork added are still
there.

Usage:
  python scripts/upgrade/verify-fork-features.py [--ref local/mind-p0] [--base <vendor-commit>] [--fix]

Exit code 1 when something is missing (unless --fix restored it).
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Symbols that belong to this fork's own work (memory backend, persona, safety). A file that has
# one of these in the fork's blob must still have it on disk.
MARKERS = (
    'castalia',
    'attachRemote',
    'setupCastaliaMemoryService',
    'resolveCastaliaEngineOptions',
    'createCastaliaEngineMemory',
    'scanRetention',
    'advanceDrives',
    'blindSense',
    'composeThought',
    'crisisWatch',
    'relationalPolicy',
    'selfInitiatedSpeech',
    'personaPolicy',
)
# Deployment / generated trees are not source.
SKIP = re.compile(r'^(node_modules|castalia|lobehub|_legacy-0\.11|AIRI|viz|\.git|out|dist)/'
                  r'|/(node_modules|out|dist)/')


def git(*args: str, text: bool = False):
    r = subprocess.run(['git', '-C', REPO, *args], capture_output=True)
    if r.returncode != 0:
        return '' if text else None
    return r.stdout.decode('utf-8', 'replace') if text else r.stdout


def changed_paths(ref: str, base: str) -> list[str]:
    out = git('diff', '--name-only', '--diff-filter=AM', f'{base}..{ref}', text=True)
    return [p for p in out.splitlines() if p and not SKIP.search(p)]


def blob(ref: str, path: str) -> str | None:
    r = subprocess.run(['git', '-C', REPO, 'show', f'{ref}:{path}'], capture_output=True)
    return r.stdout.decode('utf-8', 'replace') if r.returncode == 0 else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref', default='local/mind-p0')
    ap.add_argument('--base', default=None, help='vendor commit; read from git log when omitted')
    ap.add_argument('--fix', action='store_true', help='restore the fork blob when a marker is lost')
    args = ap.parse_args()

    base = args.base
    if not base:
        log = git('log', '--oneline', '-20', args.ref, text=True) or ''
        for line in log.splitlines():
            if line.lower().startswith(('d6e8fe5',)) or ' vendor:' in line.lower() or line.split(' ', 1)[-1].lower().startswith('vendor'):
                base = line.split(' ')[0]
                break
    if not base:
        print('  cannot determine the vendor base commit -- pass --base')
        return 2

    paths = changed_paths(args.ref, base)
    lost: list[tuple[str, list[str]]] = []
    missing_file: list[str] = []
    for path in paths:
        ours = blob(args.ref, path)
        if ours is None:
            continue                      # the fork deleted it on purpose
        want = sorted({m for m in MARKERS if m in ours})
        if not want:
            continue
        disk_path = os.path.join(REPO, path)
        if not os.path.exists(disk_path):
            missing_file.append(path)
            continue
        disk = open(disk_path, encoding='utf-8', errors='replace').read()
        gone = [m for m in want if m not in disk]
        if gone:
            lost.append((path, gone))

    print(f'  fork 改动文件: {len(paths)}')
    print(f'  丢符号: {len(lost)} 个文件    整文件缺失: {len(missing_file)}')
    for path, gone in lost:
        print(f'    LOST  {path}  ->  {", ".join(gone)}')
    for path in missing_file:
        print(f'    MISSING  {path}')

    if args.fix and (lost or missing_file):
        fixed = 0
        for path, _ in lost:
            ours = blob(args.ref, path)
            if ours is None:
                continue
            with open(os.path.join(REPO, path), 'w', encoding='utf-8', newline='') as fh:
                fh.write(ours)
            fixed += 1
        print(f'  --fix 恢复: {fixed} 个文件（重跑一次确认）')

    return 1 if (lost or missing_file) else 0


if __name__ == '__main__':
    sys.exit(main())
