#!/usr/bin/env python3
# Follow queue-proxy + user-container logs of every z2080 pod as it appears; stamp each line with epoch-ms.
import subprocess, sys, threading, time, os, json
outdir = sys.argv[1]; os.makedirs(outdir, exist_ok=True)
K = ['kubectl','--context','knext-oke-sa','-n','z2080-repro']
seen = set()
def follow(pod, c):
    f = open(f'{outdir}/{pod}.{c}.log','a',buffering=1)
    while True:
        p = subprocess.Popen(K+['logs','-f','--timestamps=false','--tail=-1',pod,'-c',c], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        for l in p.stdout: f.write(f"{int(time.time()*1000)} {l.rstrip()}\n")
        p.wait()
        r = subprocess.run(K+['get','pod',pod,'-o','name'],capture_output=True,text=True)
        if r.returncode!=0 or 'NotFound' in r.stderr: return
        time.sleep(0.5)
while True:
    r = subprocess.run(K+['get','pods','-l','serving.knative.dev/service','-o','json'],capture_output=True,text=True)
    try:
        for it in json.loads(r.stdout)['items']:
            n = it['metadata']['name']
            if n not in seen:
                seen.add(n)
                for c in ('queue-proxy','user-container'):
                    threading.Thread(target=follow,args=(n,c),daemon=True).start()
    except Exception: pass
    time.sleep(1)
