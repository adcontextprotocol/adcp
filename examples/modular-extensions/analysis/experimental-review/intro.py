"""Stable schemas that each experimental id's introducing change edited.

Usage: python3 -I intro.py <repo>   (reads attributed.json and regdates.txt, writes intro.json)

INTRO lists the commits on main that introduced each id (one PR may land as several commits).
A file counts as stable when it existed before the commit and no experimental id owns it.
index.json is ignored. sponsored_intelligence.core predates the window and has no entry.
"""
import json, subprocess, sys
REPO = sys.argv[1]; SP = 'static/schemas/source/'
INTRO = {
 'protocol.principal': ['877f6a20a0', '9753caade3'], 'account.change_feed': ['2fecc3e916'],
 'brand.rights_lifecycle': ['fc149400b2'], 'governance.campaign': ['9c2a978c3a'],
 'measurement.core': ['12bfb06511'], 'measurement.gateway': ['2ec0882127'],
 'trusted_match.core': ['8bc089239b'], 'trusted_match.verified_identity': ['cdfe3ad45b'],
 'creative.evaluator': ['5fc5283c66'], 'creative.signal_fanout': ['e5c269489e'],
 'media_buy.audience_activation': ['dc349b0854', '172dae75d9'],
 'media_buy.execution_requirements': ['2b80738b9d'], 'media_buy.product_identity': ['17162cf8aa'],
 'media_buy.spot_lifecycle': ['be785cf0da'],
 'media_buy.reporting_delivery': ['b7b6ba9171', 'dd6ab0bce3', '388e78e63e'],
 'media_buy.hold_extension': ['66bb73322f'], 'creative.broadcast_loudness': ['9ac7d9cff5'],
 'media_buy.daypart_granularity': ['e6e8fa5543'], 'media_buy.delegated_composition': ['a828a8152a'],
 'media_buy.hold_policy': ['68c487e0b4'], 'media_buy.hold_ranking': ['ad0c1011cf'],
 'media_buy.collection_catalog': ['15df9e107e'], 'media_buy.installment_holds': ['96a6e09b19'],
 'identity.trust_json': ['9a5f7f2b11'], 'media_buy.collection_cards': ['b528b43a32', '9486c57183'],
 'brand.collection_links': ['6506011b93'],
}
def git(*a): return subprocess.run(['git', '-C', REPO] + list(a), capture_output=True, text=True).stdout
rows = json.load(open('attributed.json'))
root = {r['file'] for r in rows if r['ptr'] == '/'}
out = {}
for fid, cs in INTRO.items():
    st, new, adds, dels, docs = set(), set(), 0, 0, set()
    for c in cs:
        for l in git('show', '--numstat', '--format=', c).splitlines():
            a, b, f = l.split('\t')
            if f.startswith('docs/'): docs.add(f)
            if not f.startswith(SP): continue
            adds += int(a) if a != '-' else 0; dels += int(b) if b != '-' else 0
            rel = f[len(SP):]
            if rel == 'index.json': continue
            existed = subprocess.run(['git', '-C', REPO, 'cat-file', '-e', f'{c}^:{f}'], capture_output=True).returncode == 0
            if not existed: new.add(rel)
            elif rel not in root: st.add(rel)
    out[fid] = dict(stable_mod=sorted(st), new=len(new), adds=adds, dels=dels, docs=len(docs))
json.dump(out, open('intro.json', 'w'), indent=1)
october = [l.split('|')[0] for l in open('regdates.txt') if '|2026-10' in l]
alls = set().union(*(set(v['stable_mod']) for v in out.values()))
octs = set().union(*(set(out.get(k, {}).get('stable_mod', [])) for k in october))
print(f"ids with an introducing change: {len(out)}; distinct stable schemas edited: {len(alls)}")
print(f"ids registered in October 2026: {len(october)}; distinct stable schemas they edited: {len(octs)}")
