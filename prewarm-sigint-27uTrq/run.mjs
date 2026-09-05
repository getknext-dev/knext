import { readFileSync, writeFileSync } from 'node:fs';
       import { withRestore } from "/private/tmp/rev966/repo/benchmarks/image-prewarm-oke/lib.mjs";
       await withRestore({
         read: () => readFileSync("/Users/banna/alpheya/pocs/knext/prewarm-sigint-27uTrq/imagePrewarm", 'utf8') === 'true',
         write: (v) => writeFileSync("/Users/banna/alpheya/pocs/knext/prewarm-sigint-27uTrq/imagePrewarm", String(v)),
         log: (m) => console.log(m),
         body: async () => {
           writeFileSync("/Users/banna/alpheya/pocs/knext/prewarm-sigint-27uTrq/imagePrewarm", 'true');  // the arm the run leaves set
           writeFileSync("/Users/banna/alpheya/pocs/knext/prewarm-sigint-27uTrq/ready", 'go');
           // A long run. The interval is what KEEPS IT RUNNING: a signal
           // listener is not a libuv handle, so without in-flight work node
           // would exit on an empty loop and prove nothing. The real harness is
           // never idle here — it is inside kubectl/fetch.
           await new Promise(() => setInterval(() => {}, 1000));
         },
       });