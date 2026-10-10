import json,sys,re,glob
app,idx=sys.argv[1],int(sys.argv[2])
rec=[json.loads(l) for l in open(f'run/main-{app}.jsonl')][idx]
t0,t1=rec['t0'],rec['t1']
print(app,idx,rec['mode'],rec.get('offsetActual'),rec['ms'])
act=[]
import datetime
for l in open('run/activator.log'):
    try:j=json.loads(l)
    except: continue
    if f'z2080-{app}-0' not in l: continue
    ts=datetime.datetime.fromisoformat(j['timestamp'].replace('Z','+00:00')).timestamp()*1000
    if t0-1000<ts<t1+1500: act.append((ts,j['caller'].split('/')[-1],j['message'][:100]))
ev=[]
for l in open('run/watch.log'):
    ts,tag,rest=l.rstrip().split(' ',2); ts=int(ts)
    if f'z2080-{app}-' in rest and t0-1000<ts<t1+1500: ev.append((ts,tag+' '+re.sub(r'z2080-\w+-00001-','',rest)[:110]))
seen=0
for ts,k,m in sorted([(a,'ACT '+b,c) for a,b,c in act]+[(a,b,'') for a,b in ev]):
    if 'Failed probing' in m or 'Failed to probe' in m:
        seen+=1
        if seen>2: continue
    print(f"{(ts-t0)/1000:+7.2f} {k} {m}")
print('probe failures',seen)
