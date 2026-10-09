#!/usr/bin/env python3
# Z2080 re-wake driver. usage: driver.py <node|bun> <out.jsonl> <plan> [lock-file-dir]
# plan = comma list of  recent:<offsetSeconds>[:diag]  |  settled
import calendar, json, subprocess, sys, time, threading, fcntl, os
app, out, plan = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
SVC = f'z2080-{app}'
K = ['kubectl','--context','knext-oke-sa','-n','z2080-repro']
URL = f'http://{SVC}.z2080-repro.svc.cluster.local/api/health'
LOCKF = open('/tmp/z2080.lock','w')
def kc(*a, inp=None):
    return subprocess.run(K+list(a), capture_output=True, text=True, input=inp)
def pods():
    r = kc('get','pods','-l',f'serving.knative.dev/service={SVC}','-o','json')
    if r.returncode: return None
    res=[]
    for p in json.loads(r.stdout)['items']:
        m=p['metadata']; st=p['status']
        rd=[c['status'] for c in st.get('conditions',[]) if c['type']=='Ready']
        dts=m.get('deletionTimestamp')
        ts=None
        if dts:
            ts = calendar.timegm(time.strptime(dts,'%Y-%m-%dT%H:%M:%SZ')) - m.get('deletionGracePeriodSeconds',0)
        res.append(dict(name=m['name'][-12:],full=m['name'],ip=st.get('podIP'),phase=st.get('phase'),ready=rd[0] if rd else None,term=bool(dts),termStart=ts))
    return res
def exec_req(max_s=120):
    r = kc('exec','z2080-drv','--','node','/tmp/req.js',URL,str(max_s*1000))
    try: return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception: return dict(code=-1,err=r.stdout+r.stderr)
def fire(hold_lock_s=7):
    # serialise request *initiation* across arms so cold starts do not overlap
    fcntl.flock(LOCKF, fcntl.LOCK_EX)
    th = threading.Timer(hold_lock_s, lambda: fcntl.flock(LOCKF, fcntl.LOCK_UN)); th.start()
    return exec_req()
def live(ps): return [p for p in ps if not p['term']]
def wait(cond, to, step=1.0):
    t=time.time()
    while time.time()-t<to:
        ps=pods()
        if ps is not None and cond(ps): return ps
        time.sleep(step)
    return None
def log(rec):
    with open(out,'a') as f: f.write(json.dumps(rec)+'\n')
    print(app, json.dumps({k:rec[k] for k in ('i','mode','offsetTarget','offsetActual','ms','code') if k in rec}), flush=True)
for i,item in enumerate(plan):
    parts=item.split(':'); mode=parts[0]; off=float(parts[1]) if len(parts)>1 else None; diag='diag' in parts
    ps=pods() or []
    if not live(ps) and not any(p['term'] for p in ps):
        fire()  # wake it (not recorded)
    ps=wait(lambda ps: len(live(ps))>=1 and all(p['ready']=='True' for p in live(ps)), 120)
    # now wait for Knative's own scale-down
    ps=wait(lambda ps: len(live(ps))==0 and len(ps)>=0, 900, 1.0)
    if ps is None: log(dict(i=i,mode=mode,err='no scale-down in 900s')); continue
    tobs=time.time()
    old=[p for p in ps if p['term']]
    rec=dict(i=i,app=app,mode=mode,offsetTarget=off,oldBefore=old,tObserved=int(tobs*1000))
    if mode=='recent':
        ts=min((p['termStart'] for p in old if p['termStart']), default=tobs)
        rec['termStartMs']=int(ts*1000)
        wait_s=ts+off-time.time()
        if wait_s>0: time.sleep(wait_s)
    else:
        w=wait(lambda ps: len(ps)==0, 300, 0.5)
        if w is None: rec['err']='old pod never vanished'
        time.sleep(1.0)
    pre=pods() or []
    rec['podsPre']=pre
    probe=None
    def diagprobe():
        global probe
        time.sleep(5)
        ips=[f"{p['ip']}:3000" for p in pre if p['term'] and p['ip']]
        if ips:
            r=kc('exec','z2080-drv','--','node','/tmp/probe.js',*ips)
            try: probe=json.loads(r.stdout.strip().splitlines()[-1])
            except Exception: probe=dict(err=r.stdout+r.stderr)
    dt=threading.Thread(target=diagprobe) if diag else None
    if dt: dt.start()
    res=fire()
    if dt: dt.join()
    rec.update(res)
    rec['macT1']=int(time.time()*1000)
    if rec.get('termStartMs') and rec.get('t0'): rec['offsetActual']=round((rec['t0']-rec['termStartMs'])/1000,1)
    rec['podsPost']=pods() or []
    if probe: rec['probe']=probe
    log(rec)
