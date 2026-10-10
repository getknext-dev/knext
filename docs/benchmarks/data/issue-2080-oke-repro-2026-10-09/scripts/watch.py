#!/usr/bin/env python3
# Stamp every line of two kubectl watches (pods, endpointslices) with epoch-ms.
import subprocess, sys, threading, time
out = open(sys.argv[1], 'a', buffering=1)
lock = threading.Lock()
def run(tag, args):
    p = subprocess.Popen(['kubectl','--context','knext-oke-sa','-n','z2080-repro']+args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in p.stdout:
        with lock:
            out.write(f"{int(time.time()*1000)} {tag} {line.rstrip()}\n")
pod_cols = 'custom-columns=NAME:.metadata.name,PH:.status.phase,READY:.status.conditions[?(@.type=="Ready")].status,DEL:.metadata.deletionTimestamp,IP:.status.podIP,CS:.status.containerStatuses[*].ready'
eps_cols = 'custom-columns=NAME:.metadata.name,ADDR:.endpoints[*].addresses[0],READY:.endpoints[*].conditions.ready,SERVING:.endpoints[*].conditions.serving,TERM:.endpoints[*].conditions.terminating'
ts = [threading.Thread(target=run, args=('POD',['get','pods','-w','--no-headers','-o',pod_cols]), daemon=True),
      threading.Thread(target=run, args=('EPS',['get','endpointslices','-w','--no-headers','-o',eps_cols]), daemon=True)]
for t in ts: t.start()
while True: time.sleep(3600)
