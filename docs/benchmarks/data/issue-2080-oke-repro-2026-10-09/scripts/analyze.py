#!/usr/bin/env python3
# Join each trial with the activator log (blackhole signature) and the pod/EPS watch.
import json, sys, glob, subprocess, datetime, statistics as st
CIDR = lambda ip: ('10.0.1.169' if ip and ip.startswith('10.244.0.') and int(ip.split('.')[-1])<128 else '10.0.1.118')
# activator log (whole run window)
since = sys.argv[1] if len(sys.argv)>1 else '3h'
raw = subprocess.run(['kubectl','--context','knext-oke-sa','-n','knative-serving','logs','deploy/activator','--since='+since],capture_output=True,text=True).stdout
open('run/activator.log','w').write(raw)
act=[]
for l in raw.splitlines():
    try:j=json.loads(l)
    except: continue
    if 'z2080' not in l: continue
    ts=datetime.datetime.fromisoformat(j['timestamp'].replace('Z','+00:00')).timestamp()*1000
    act.append((ts,j['caller'].split('/')[-1],j['message'],j.get('knative.dev/key','')))
trials=[]
for f in sorted(glob.glob('run/main-*.jsonl')):
    for l in open(f):
        r=json.loads(l)
        if 'ms' not in r: continue
        trials.append(r)
rows=[]
for r in trials:
    a=r['app']; t0,t1=r['t0'],r['t1']
    fails=[x for x in act if t0-200<=x[0]<=t1+200 and f'z2080-{a}-0' in x[3] and 'Failed probing pods' in x[2]]
    npod=[p for p in r['podsPost'] if not p['term']]
    newip=npod[0]['ip'] if npod else None
    pre_term=[p for p in r['podsPre'] if p['term']]
    rows.append(dict(app=a,mode=r['mode'],off=r.get('offsetActual'),offT=r.get('offsetTarget'),ms=r['ms'],code=r['code'],blackholeProbes=len(fails),
                     oldPresent=bool(pre_term),oldReadyAtFire=[p['ready'] for p in pre_term],newNode=CIDR(newip),probe=r.get('probe'),i=r['i']))
json.dump(rows,open('run/rows.json','w'),indent=1)
for a in ('node','bun','nodei','buni','nodei0','buni0'):
    for m in ('recent','settled'):
        rs=[x for x in rows if x['app']==a and x['mode']==m]
        if not rs: continue
        ms=sorted(x['ms'] for x in rs)
        print(f"{a:5s} {m:8s} n={len(rs):2d} median={st.median(ms):7.0f} min={ms[0]} max={ms[-1]}  >5s: {sum(x['ms']>5000 for x in rs)}  blackhole-signature: {sum(x['blackholeProbes']>0 for x in rs)}")
print()
for x in sorted(rows,key=lambda x:(x['app'],x['mode'],x['off'] or 0)):
    print(x['app'],x['mode'],'off',x['off'],'ms',x['ms'],'bh',x['blackholeProbes'],'old',x['oldPresent'],x['oldReadyAtFire'],'newnode',x['newNode'],'probe',(x['probe'] or {}).get('res'))

# ---- stats
import math, random
def mw(a,b):
    # exact-ish two-sided Mann-Whitney via normal approx with tie correction
    n1,n2=len(a),len(b); allv=sorted([(v,0) for v in a]+[(v,1) for v in b]); 
    ranks={}; i=0
    while i<len(allv):
        j=i
        while j+1<len(allv) and allv[j+1][0]==allv[i][0]: j+=1
        r=(i+j)/2+1
        for k in range(i,j+1): ranks.setdefault(allv[k][0],r)
        i=j+1
    R1=sum(ranks[v] for v in a); U=R1-n1*(n1+1)/2
    mu=n1*n2/2; N=n1+n2
    ties=sum((c**3-c) for c in __import__('collections').Counter(a+b).values())
    sd=math.sqrt(n1*n2/12*((N+1)-ties/(N*(N-1))))
    z=(U-mu)/sd if sd else 0
    return 2*(1-0.5*(1+math.erf(abs(z)/math.sqrt(2))))
print()
def get(a,m,pool=None): return [x['ms'] for x in rows if x['app']==a and x['mode']==m]
for A,B,m in [('node','bun','recent'),('nodei','buni','recent'),('node','nodei','recent'),('bun','buni','recent'),('nodei','nodei0','recent'),('buni','buni0','recent'),('node','node','settled')]:
    if A==B: 
        r,s_=get('node','recent'),get('node','settled'); print('node recent vs settled (unprimed)',round(mw(r,s_),3)); r,s_=get('bun','recent'),get('bun','settled'); print('bun recent vs settled (unprimed)',round(mw(r,s_),3)); continue
    a,b=get(A,m),get(B,m)
    if a and b: print(f'{A} vs {B} {m}: p={mw(a,b):.2g} medians {st.median(a):.0f} vs {st.median(b):.0f}')
