"""Inline experimental markers in stable schemas, and the stable files that host them.

Usage: python3 -I hosts.py <static/schemas/source dir>   (reads attributed.json, writes hosts_per_id.json)

A marker at a schema root means the id owns the file. Any other marker, in a file the id doesn't
own, is inline in a stable host. A marker under another marker in the same file is nested and
doesn't count.
"""
import json, os, sys
from collections import defaultdict
SRC = sys.argv[1]
CAPS = 'protocol/get-adcp-capabilities-response.json'
rows = json.load(open('attributed.json'))
allf = [os.path.relpath(os.path.join(r, f), SRC) for r, _, fs in os.walk(SRC) for f in fs if f.endswith('.json')]
root = {r['file'] for r in rows if r['ptr'] == '/'}
inl = [r for r in rows if r['ptr'] != '/' and r['file'] not in root]
def nested(r):
    return any(x is not r and x['file'] == r['file'] and x['ptr'] != '/' and r['ptr'].startswith(x['ptr'] + '/') for x in rows)
inl = [r for r in inl if not nested(r)]
hosts = defaultdict(set)
for r in inl: hosts[r['file']].add(r['fid'])
caps = [r for r in inl if r['file'] == CAPS]
print(f"schema files {len(allf)}; files an id owns {len(root)}; stable files {len(allf) - len(root)}")
print(f"inline markers in stable files: {len(inl)} in {len(hosts)} files")
print(f"inline markers in {CAPS}: {len(caps)} from {len({r['fid'] for r in caps})} ids")
for h, s in sorted(hosts.items(), key=lambda x: (-len(x[1]), x[0])):
    print(' ', h, len([r for r in inl if r['file'] == h]), sorted(s))
per = defaultdict(set)
for r in inl: per[r['fid']].add(r['file'])
json.dump({k: sorted(v) for k, v in sorted(per.items())}, open('hosts_per_id.json', 'w'), indent=1)
