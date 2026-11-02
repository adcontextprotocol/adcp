import json, os, re, sys
SRC = sys.argv[1]
ids = re.findall(r'^\| `([a-z_]+\.[a-z_]+)` \|', open(sys.argv[2]).read(), re.M)
idre = re.compile(r'\b(' + '|'.join(re.escape(i) for i in sorted(ids, key=len, reverse=True)) + r')\b')
out = []
def walk(node, ptr, f, anc_desc):
    if isinstance(node, dict):
        d = node.get('description', '') if isinstance(node.get('description'), str) else ''
        if node.get('x-status') == 'experimental':
            text = d
            hits = idre.findall(text)
            ahits = idre.findall(' '.join(anc_desc))
            out.append(dict(file=f, ptr=ptr or '/', ids=sorted(set(hits)), anc_ids=sorted(set(ahits)), desc=d[:300], added=node.get('x-added-in')))
        for k, v in node.items():
            walk(v, ptr + '/' + str(k), f, anc_desc + ([d] if d else []))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, ptr + '/' + str(i), f, anc_desc)
for root, _, files in os.walk(SRC):
    for fn in files:
        if fn.endswith('.json'):
            p = os.path.join(root, fn); rel = os.path.relpath(p, SRC)
            try: doc = json.load(open(p))
            except Exception as e: continue
            walk(doc, '', rel, [])
json.dump(dict(ids=ids, markers=out), open('markers.json', 'w'), indent=1)
print(len(ids), len(out), sum(1 for m in out if m['ids']), sum(1 for m in out if not m['ids'] and m['anc_ids']), sum(1 for m in out if not m['ids'] and not m['anc_ids']))
