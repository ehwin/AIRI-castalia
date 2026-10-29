"""Three-way tree merge for the vendored AIRI fork.

Why not `git merge` / `git apply`:
  the fork is a vendored snapshot lineage (no common ancestor with upstream), so
  `git merge` sees every file as a conflict, and a plain patch from the vendor base
  fails wherever upstream also touched the file (`D` hunks carry content that no
  longer matches). This tidies it up at blob level:

    ours   = local/mind-p0 (the fork)
    theirs = v0.13.1      (new vendor snapshot)
    base   = d6e8fe5      (previous vendored snapshot, the fork's parent)

  decision per path (content compared by blob oid, so no content is read unless needed):
    ours == base      -> take theirs            (upstream change)
    theirs == base    -> take ours              (our change, including deletions)
    ours == theirs    -> take either
    otherwise         -> line-level `git merge-file`, else keep ours + report

Usage: python three-way-merge.py <repo> <ours-ref> <theirs-ref> <base-ref> [--apply]
Without --apply it only reports the plan.
"""
import subprocess
import sys
import os
import tempfile

def git(repo, *args, **kw):
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, **kw)

def tree(ref, repo):
    """path -> (mode, blob-oid)"""
    out = git(repo, 'ls-tree', '-r', '-z', ref).stdout.decode('utf-8', 'surrogateescape')
    m = {}
    for rec in out.split('\0'):
        if not rec:
            continue
        meta, path = rec.split('\t', 1)
        mode, _type, oid = meta.split()
        m[path] = (mode, oid)
    return m

def blob(repo, oid):
    return git(repo, 'cat-file', 'blob', oid).stdout

def main():
    repo, ours_ref, theirs_ref, base_ref = sys.argv[1:5]
    apply_changes = '--apply' in sys.argv
    ours, theirs, base = tree(ours_ref, repo), tree(theirs_ref, repo), tree(base_ref, repo)

    plan = {'take_theirs': [], 'take_ours': [], 'delete': [], 'conflict': [], 'same': 0}
    conflicts = []
    for path in sorted(set(ours) | set(theirs) | set(base)):
        o = ours.get(path, (None, None))[1]
        t = theirs.get(path, (None, None))[1]
        b = base.get(path, (None, None))[1]
        if o == t:
            plan['same'] += 1
            continue
        if o == b:                      # untouched by us -> upstream wins
            if t is None:
                plan['delete'].append(path)      # upstream removed it
            else:
                plan['take_theirs'].append(path)
        elif t == b:                    # untouched upstream -> we win
            if o is None:
                plan['delete'].append(path)
            else:
                plan['take_ours'].append(path)
        else:
            conflicts.append((path, o, t, b))

    print('  上游改动(采用): %d   我们的改动(保留): %d   删除: %d   相同: %d   冲突: %d'
          % (len(plan['take_theirs']), len(plan['take_ours']), len(plan['delete']),
             plan['same'], len(conflicts)))

    resolved, unresolved = [], []
    if apply_changes:
        written = 0
        for path in plan['take_theirs'] + plan['take_ours']:
            src = theirs.get(path) or ours.get(path) or ('100644', '')
            oid = src[1]
            full = os.path.join(repo, path)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            open(full, 'wb').write(blob(repo, oid))
            written += 1
        removed = 0
        for path in plan['delete']:
            full = os.path.join(repo, path)
            if os.path.exists(full):
                os.remove(full)
                removed += 1
        print('  已写入 %d 个文件, 删除 %d 个' % (written, removed))

        for path, o, t, b in conflicts:
            tmp = tempfile.mkdtemp()
            po = os.path.join(tmp, 'o'); pt = os.path.join(tmp, 't'); pb = os.path.join(tmp, 'b')
            open(po, 'wb').write(blob(repo, o) if o else b'')
            open(pt, 'wb').write(blob(repo, t) if t else b'')
            open(pb, 'wb').write(blob(repo, b) if b else b'')
            r = git(repo, 'merge-file', '-p', po, pb, pt)   # -p: print merged to stdout
            if r.returncode == 0:
                full = os.path.join(repo, path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                open(full, 'wb').write(r.stdout)
                resolved.append(path)
            else:
                full = os.path.join(repo, path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                src = o if o is not None else t
                open(full, 'wb').write(blob(repo, src))
                unresolved.append(path)
        print('  冲突自动合并成功: %d, 需要人工: %d' % (len(resolved), len(unresolved)))
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'unresolved.txt'), 'w') as f:
            f.write('\n'.join(unresolved))
        for p in unresolved:
            print('    ! ' + p)
    else:
        for p, *_ in conflicts[:20]:
            print('    * ' + p)
    return 0

if __name__ == '__main__':
    sys.exit(main())
