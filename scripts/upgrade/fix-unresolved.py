"""Fix the "Could not resolve" imports the upgrade merge leaves behind.

Why: the fork deletes whole product surfaces (hosted server, auth, cloud client,
the auto-updater), so every file upstream rewrote to *use* one of those modules
fails the bundler. For each such file the fork's own version is the right answer —
it is the one that stopped referencing the deleted module — unless the fork never
touched that file, in which case the import has to be removed by hand.

Loop: build -> parse `Could not resolve '<spec>' in <file>` -> take
local/mind-p0:<file> when that version no longer mentions <spec> -> rebuild.

Usage: python fix-unresolved.py [--rounds N] [--app apps/stage-tamagotchi]
Exit 0 when a build passes; prints the per-round decisions.
"""
import re
import subprocess
import sys
import os

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def run_build(app):
    env = dict(os.environ)
    env['PATH'] = os.path.join(REPO, '.cache', 'bin') + os.pathsep + env.get('PATH', '')
    env['npm_config_verify_deps_before_run'] = 'false'
    turbo = os.path.join(REPO, 'node_modules', '.bin', 'turbo.CMD')
    cmd = [os.environ.get('COMSPEC', 'cmd.exe'), '/c', turbo, 'run', 'build', '-F=' + app, '--force']
    r = subprocess.run(cmd, cwd=REPO, capture_output=True, env=env)
    return r.returncode, r.stdout.decode('utf-8', 'replace') + r.stderr.decode('utf-8', 'replace')


def ours_text(path):
    r = subprocess.run(['git', '-C', REPO, 'show', 'local/mind-p0:' + path], capture_output=True)
    return r.stdout.decode('utf-8', 'replace') if r.returncode == 0 else None


def main():
    rounds = 6
    if '--rounds' in sys.argv:
        rounds = int(sys.argv[sys.argv.index('--rounds') + 1])
    app = 'apps/stage-tamagotchi'
    if '--app' in sys.argv:
        app = sys.argv[sys.argv.index('--app') + 1]

    for i in range(1, rounds + 1):
        code, out = run_build(app)
        if code == 0:
            print('  round %d: build OK' % i)
            return 0
        pairs = sorted(set(re.findall(r"Could not resolve '([^']+)' in (src/\S+)", out)))
        if not pairs:
            print('  round %d: build failed with no unresolved-import error' % i)
            print('\n'.join(l for l in out.splitlines() if 'error' in l.lower())[:2000])
            return 1
        fixed = 0
        for spec, rel in pairs:
            path = os.path.join(app, rel)
            ours = ours_text(path)
            if ours is not None and spec not in ours:
                open(os.path.join(REPO, path), 'w', encoding='utf-8', newline='').write(ours)
                print('  round %d: take ours  %-62s (drops %s)' % (i, rel, spec))
                fixed += 1
            else:
                print('  round %d: MANUAL       %-62s (imports %s)' % (i, rel, spec))
        if not fixed:
            print('  round %d: %d unresolved import(s) need a human' % (i, len(pairs)))
            return 1
    print('  still failing after %d rounds' % rounds)
    return 1


if __name__ == '__main__':
    sys.exit(main())
