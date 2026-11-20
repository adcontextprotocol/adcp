import json,re,sys
d=json.load(open('churn2.json'))
reg={l.split('|')[0]:l.split('|')[2] for l in open('regdates.txt').read().splitlines() if l}
for fid,v in sorted(d.items()):
    cs=sorted(v['commits'].items(),key=lambda x:x[1]['subj'])
    first=cs[0][1]['subj'][:10] if cs else ''
    rd=reg.get(fid,first)
    tot=0;post=0;sweep=0;fc=0;na=[]
    for c,x in cs:
        kinds={k for (_,_,k,_) in x['changes']}
        if kinds=={'create'}: continue
        tot+=1; fc+=sum(1 for ch in x['changes'] if ch[2]!='create')
        if x['nfiles']>=50: sweep+=1
        if x['subj'][:10]>=rd: post+=1
        iss=[i for ch in x['changes'] for i in ch[3]]
        if iss: na.append((c[:10],x['subj'][:90],x['nfiles'],iss[:6],len(iss)))
    prs=sorted({m for c,x in cs for m in re.findall(r'\(#(\d+)\)',x['subj'])},key=int)
    print(f"## {fid} markers={v['markers']} owned={len(v['owned'])} inline={len(v['inline'])} nested={v['nested']} first={first} reg={rd} changes={tot} filechanges={fc} sweeps={sweep} post_reg={post} PRs={','.join(prs)}")
    for n in na: print('   NA',*n)

# Totals over registered ids (UNREG: surfaces carry no feature id and are left out).
LARGE = ['governance.campaign', 'trusted_match.core', 'sponsored_intelligence.core', 'brand.rights_lifecycle', 'media_buy.reporting_delivery']
per = {}
for fid, v in d.items():
    if fid.startswith('UNREG:'): continue
    per[fid] = sum(1 for _, x in v['commits'].items() if {k for (_, _, k, _) in x['changes']} != {'create'})
total = sum(per.values()); large = sum(per[k] for k in LARGE)
print(f"TOTAL change commits over {len(per)} ids: {total}; five large areas: {large} ({100 * large / total:.0f}%); "
      f"other {len(per) - len(LARGE)} ids: {total - large}; ids with none: {sum(1 for v in per.values() if v == 0)}")
