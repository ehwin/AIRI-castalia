"""Apply the "take our version" fix for every unresolved import in a build log.

The vendor-style upgrade leaves one recurring shape: upstream 0.13 rewrote files to
import a module the fork deleted (`product-signals`, `use-analytics`,
`services/airi/auth`, `cloud-client`, ...). For each such file the fork's own blob is
the correct answer — it is the version that stopped importing the deleted module.

Input: a build log. For each `Could not resolve '<spec>' in <file>` (or the
UNLOADABLE_DEPENDENCY form) the script resolves <file> against the app dir, checks
`local/mind-p0:<file>`, and writes it when that blob no longer mentions <spec>.
Everything it cannot decide mechanically is printed as MANUAL.

Usage: python apply-ours-if-clean.py <build.log> [--app apps/stage-tamagotchi] [--dry]
"""
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
APP = 'apps/stage-tamagotchi'
LOG = sys.argv[1]
DRY = '--dry' in sys.argv
if '--app' in sys.argv:
    APP = sys.argv[sys.argv.index('--app') + 1]

PATTERNS = [
    re.compile(r"Could not resolve '([^']+)' in (\S+)"),
    re.compile(r"\[UNLOADABLE_DEPENDENCY\] Could not load (\S+)"),
]


def ours(path):
    r = subprocess.run(['git', '-C', REPO, 'show', 'local/mind-p0:' + path], capture_output=True)
    return r.stdout.decode('utf-8', 'replace') if r.returncode == 0 else None


def norm(spec, where):
    """(repo-relative importer path, the string that must be absent from our blob)"""
    where = where.rstrip('.,)')
    p = os.path.normpath(os.path.join(APP, where)).replace('\\', '/')
    # the spec may be written as '../../packages/...' — resolve it for the containment test
    if spec.startswith('.'):
        spec_abs = os.path.normpath(os.path.join(os.path.dirname(p), spec)).replace('\\', '/')
    else:
        spec_abs = spec
    return p, spec_abs


pairs, manual = [], []
pending = None          # 缺失模块，等下面那行 code frame 给出它的导入者
FRAME = re.compile(r"╭─\[ (.+?):(\d+):(\d+)")   # the closing "]" is often cut by the box width
UNLOAD = re.compile(r"(?:Could not load|Couldn't load) (\S+)")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
for line in open(LOG, encoding='utf-8', errors='replace'):
    line = ANSI.sub('', line)          # rolldown colourises every box character
    m = re.search(r"Could not resolve '([^']+)' in (\S+)", line)
    if m:
        spec, where = m.group(1), m.group(2).rstrip('.,)')
        p = os.path.normpath(os.path.join(APP, where)).replace('\\', '/')
        pending = None
    else:
        u = UNLOAD.search(line)
        if u:
            pending = u.group(1).rstrip('.,)"')
            continue
        me = re.search(r'\[MISSING_EXPORT\] "([^"]+)" is not exported', line)
        if me:
            pending = '#' + me.group(1)      # 符号名，靠下面 frame 找到导入者
            continue
        f = FRAME.search(line)
        if not (f and pending):
            continue
        spec = pending
        pending = None
        # 帧里的路径可能是相对 app 目录，也可能已含包路径
        p = os.path.normpath(os.path.join(APP, f.group(1))).replace('\\', '/')
    if spec.startswith('#'):
        spec_abs = spec[1:]              # 符号名：判断"我们那份是否还引用它"
    elif spec.startswith('.'):
        spec_abs = os.path.normpath(os.path.join(os.path.dirname(p), spec)).replace('\\', '/')
    else:
        spec_abs = spec
    # vite/rolldown report Vue SFC sub-requests as `foo.vue?vue&type=script...` -- strip the query
    p = p.split('?')[0]
    pairs.append((p, spec, spec_abs))

seen = set()
fixed = 0
for p, spec, spec_abs in pairs:
    if (p, spec) in seen:
        continue
    seen.add((p, spec))
    blob = ours(p)
    if blob is None:
        manual.append((p, spec, 'our tree has no such file'))
        continue
    tail = spec_abs.split('/')[-1]
    if tail in blob:                      # our version still references the deleted module
        manual.append((p, spec, 'our blob still mentions it'))
        continue
    full = os.path.join(REPO, p)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    if not DRY:
        open(full, 'w', encoding='utf-8', newline='').write(blob)
    print('  take ours  %-70s (drops %s)' % (p.replace(APP + '/', ''), spec))
    fixed += 1

print('  ---')
print('  可自动修复: %d   需人工: %d' % (fixed, len(manual)))
for p, spec, why in manual:
    print('  MANUAL %-56s imports %s (%s)' % (p.replace(APP + '/', ''), spec, why))
sys.exit(0 if not manual else 2)
