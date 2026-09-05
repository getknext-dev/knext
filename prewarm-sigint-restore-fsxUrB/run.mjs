import { readFileSync, writeFileSync } from 'node:fs';
       import { withRestore } from "/Users/banna/alpheya/pocs/knext/.claude/worktrees/agent-ab7e2245dd4826e2b/benchmarks/image-prewarm-oke/lib.mjs";
       await withRestore({
         read: () => readFileSync("/Users/banna/alpheya/pocs/knext/prewarm-sigint-restore-fsxUrB/imagePrewarm", 'utf8') === 'true',
         write: (v) => {
           // Announce that the restoring write has STARTED, then block for a
           // while: this is the slow synchronous kubectl patch.
           writeFileSync("/Users/banna/alpheya/pocs/knext/prewarm-sigint-restore-fsxUrB/restoring", 'now');
           const until = Date.now() + 3000;
           while (Date.now() < until) {}
           writeFileSync("/Users/banna/alpheya/pocs/knext/prewarm-sigint-restore-fsxUrB/imagePrewarm", String(v));
         },
         log: (m) => console.log(m),
         body: async () => { writeFileSync("/Users/banna/alpheya/pocs/knext/prewarm-sigint-restore-fsxUrB/imagePrewarm", 'true'); },
       });