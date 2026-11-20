"""Per-id churn: every commit that changes a surface an experimental id owns or marks inline.

Usage: python3 -I churn2.py <repo> [ref=45591e97b3]   (reads attributed.json, writes churn2.json)
"""
import json, subprocess, re, sys, os
from collections import defaultdict
REPO = sys.argv[1]; REF = sys.argv[2] if len(sys.argv) > 2 else '45591e97b3'; SP='static/schemas/source/'
rows=json.load(open('attributed.json'))
def git(*a):
    return subprocess.run(['git','-C',REPO]+list(a),capture_output=True,text=True).stdout
def normpath(ptr):
    segs=ptr.strip('/').split('/') if ptr!='/' else []
    out=[];i=0
    while i<len(segs):
        s=segs[i]
        if s=='properties' and i+1<len(segs): out.append(segs[i+1]); i+=2; continue
        if s=='definitions' and i+1<len(segs): out.append('#'+segs[i+1]); i+=2; continue
        if s=='items': out.append('[]')
        elif s in('oneOf','anyOf','allOf') and i+1<len(segs): i+=2; continue
        i+=1
    return '/'.join(out)
root_exp={r['file'] for r in rows if r['ptr']=='/'}
surf=defaultdict(lambda:{'owned':set(),'inline':[],'nested':0,'markers':0})
for r in rows:
    s=surf[r['fid']]; s['markers']+=1
    if r['ptr']=='/': s['owned'].add(r['file'])
    elif r['file'] in root_exp: s['nested']+=1
    else:
        # nested under another marker in same file?
        anc=[x for x in rows if x['file']==r['file'] and x is not r and x['ptr']!='/' and r['ptr'].startswith(x['ptr']+'/')]
        if anc: s['nested']+=1; continue
        loc=('branch',r['ptr']) if re.search(r'/(oneOf|anyOf)/\d+$',r['ptr']) else ('prop',normpath(r['ptr']))
        s['inline'].append((r['file'],loc))
# manual extras for registry-listed unmarked surfaces
surf['trusted_match.verified_identity']['inline'] += [('trusted-match/identity-match-request.json',('prop','identities/[]/attestation')),('trusted-match/identity-match-request.json',('prop','sealed_credentials')),('brand.json',('prop','#brand/identity_relying_parties')),('brand.json',('prop','#house/identity_relying_parties')),('enums/uid-type.json',('enumval','world_id_nullifier'))]
surf['trusted_match.verified_identity']['owned'].add('enums/attestation-claim.json')
surf['media_buy.execution_requirements']['owned'] |= {'core/product-execution-requirement.json','error-details/execution-requirement-unmet.json'}
def find_nodes(doc, loc):
    kind,v=loc; res=[]
    def walk(n,ptr):
        if isinstance(n,dict):
            if kind=='prop' and normpath(ptr)==v and ptr.split('/')[-2:-1] in (['properties'],['definitions']): res.append(n)
            for k,x in n.items(): walk(x,ptr+'/'+k)
        elif isinstance(n,list):
            for i,x in enumerate(n): walk(x,ptr+'/'+str(i))
    if kind=='prop': walk(doc,'')
    elif kind=='enumval':
        def w2(n):
            if isinstance(n,dict):
                for k,x in n.items():
                    if k=='enum' and isinstance(x,list) and v in x: res.append(v)
                    elif k=='enumDescriptions' and isinstance(x,dict) and v in x: res.append(x[v])
                    else: w2(x)
            elif isinstance(n,list):
                for x in n: w2(x)
        w2(doc)
    return res
def branch_sig(doc,ptr):
    # use const values in the branch at HEAD as signature
    n=doc
    for s in ptr.strip('/').split('/'): n=n[int(s)] if isinstance(n,list) else n[s]
    return n
def find_branch(doc, sig):
    consts=set(re.findall(r'"const": "([^"]+)"',json.dumps(sig)))
    res=[]
    def walk(n):
        if isinstance(n,dict):
            for k in('oneOf','anyOf'):
                if k in n and isinstance(n[k],list):
                    for b in n[k]:
                        bc=set(re.findall(r'"const": "([^"]+)"',json.dumps(b)))
                        if consts and consts<=bc and len(json.dumps(b))<len(json.dumps(sig))*4: res.append(b)
            for x in n.values(): walk(x)
        elif isinstance(n,list):
            for x in n: walk(x)
    walk(doc); return res
def facts(n,p=''):
    F=set()
    if isinstance(n,dict):
        for k,v in (n.get('properties') or {}).items(): F.add(('prop',p+'/'+k)); F|=facts(v,p+'/'+k)
        for r in n.get('required') or []: F.add(('req',p+'/'+r))
        if isinstance(n.get('enum'),list):
            for e in n['enum']: F.add(('enum',p+'='+json.dumps(e)))
        if 'const' in n: F.add(('const',p+'='+json.dumps(n['const'])))
        if n.get('additionalProperties') is False: F.add(('closed',p))
        if '$ref' in n: F.add(('ref',p))
        for k in('items',):
            if isinstance(n.get(k),dict): F|=facts(n[k],p+'[]')
        for k in('oneOf','anyOf','allOf'):
            if isinstance(n.get(k),list):
                for b in n[k]: F|=facts(b,p)
        for k,v in (n.get('definitions') or {}).items(): F|=facts(v,p+'#'+k)
    return F
def nonadd(before,after):
    if before is None: return []
    issues=[]
    refs={f[1] for f in after if f[0]=='ref'}
    bpaths={f[1] for f in before if f[0]=='prop'}
    bconst={f[1].split('=')[0] for f in before if f[0]=='const'}
    for f in before-after:
        path=f[1].split('=')[0]
        if any(path==r or path.startswith(r+'/') or path.startswith(r+'[') for r in refs): continue
        if f[0]=='prop': issues.append('removed prop '+f[1])
        if f[0]=='enum': issues.append('removed enum '+f[1])
    for f in after-before:
        if f[0]=='req' and ('prop',f[1]) in before: issues.append('added required '+f[1])
        if f[0]=='closed' and (f[1] in bpaths or f[1]=='') and ('closed',f[1]) not in before: issues.append('closed '+f[1])
        if f[0]=='const' and f[1].split('=')[0] in bconst: issues.append('const changed '+f[1])
    return sorted(issues)  # set order varies between runs
def show(c,f):
    t=subprocess.run(['git','-C',REPO,'show',f'{c}:{SP}{f}'],capture_output=True,text=True)
    if t.returncode: return None
    try: return json.loads(t.stdout)
    except: return 'BAD'
nfiles_cache={}
def nfiles(c):
    if c not in nfiles_cache:
        nfiles_cache[c]=len([l for l in git('show','--name-only','--format=',c).splitlines() if l.startswith(SP)])
    return nfiles_cache[c]
HEADDOC={}
out={}
for fid,s in sorted(surf.items()):
    commits={}  # sha -> list of (file, change kind, issues)
    items=[(f,None) for f in sorted(s['owned'])]+s['inline']
    for f,loc in items:
        log=git('log','--reverse','--format=%H',REF,'--',SP+f).split()
        head=json.loads(git('show',f'{REF}:{SP}{f}'))
        sig=branch_sig(head,loc[1]) if loc and loc[0]=='branch' else None
        prev=None; created=False
        for c in log:
            doc=show(c,f)
            if doc is None or doc=='BAD':
                cur=None
            elif loc is None: cur=doc
            elif loc[0]=='branch': cur=find_branch(doc,sig) or None
            else: cur=find_nodes(doc,loc) or None
            if cur is None and prev is None: continue
            if json.dumps(cur,sort_keys=True)==json.dumps(prev,sort_keys=True): continue
            kind='create' if prev is None else ('delete' if cur is None else 'modify')
            iss=[]
            if kind=='modify':
                fb=facts(prev) if loc is None else set().union(*[facts(x) for x in prev]) if isinstance(prev,list) else set()
                fa=facts(cur) if loc is None else set().union(*[facts(x) for x in cur]) if isinstance(cur,list) else set()
                if loc and loc[0]=='enumval': fb=fa=set()
                iss=nonadd(fb,fa)
            if kind=='delete': iss=['deleted']
            commits.setdefault(c,[]).append((f,str(loc[1]) if loc else '',kind,iss))
            prev=cur
    out[fid]={'markers':s['markers'],'owned':sorted(s['owned']),'inline':[(f,str(l)) for f,l in s['inline']],'nested':s['nested'],
      'commits':{c:{'subj':git('log','-1','--format=%ad|%s','--date=short',c).strip(),'nfiles':nfiles(c),'changes':v} for c,v in commits.items()}}
    print(fid,len(commits),file=sys.stderr)
json.dump(out,open('churn2.json','w'),indent=1)
