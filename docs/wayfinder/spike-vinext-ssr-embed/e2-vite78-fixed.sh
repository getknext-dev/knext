#!/bin/bash
# CORRECTED single-variable test: vite 7 vs vite 8, with EVERY other input pinned EXACTLY.
#
# Supersedes e2-vite78.sh, which varied `@vitejs/plugin-react` ^5 -> ^6 alongside vite and
# printed neither, so the confound was invisible in its output. @vitejs/plugin-react@5.2.0
# peer-accepts `vite ^4.2.0 || ^5 || ^6 || ^7 || ^8`, so ONE plugin-react version is valid on
# both arms; 6.x peer-requires vite ^8 AND pulls @rolldown/plugin-babel +
# babel-plugin-react-compiler, i.e. a different transform pipeline, not just a different bundler.
#
# Every dependency is an EXACT pin (no ranges, no lockfile drift), and the script does not
# merely assert "held fixed": it dumps the FULL resolved package set of each arm's node_modules
# and diffs them, so any input that differs between the arms is reported whether or not anyone
# thought to enumerate it. That diff is the evidence for the single-variable claim.
#
# usage: bash e2-vite78-fixed.sh [vinext-version] [plugin-react-version]
set -uo pipefail
SC=/private/tmp/claude-501/-Users-banna-alpheya-pocs-knext/2989138f-7d2a-4034-b420-39e8b43cb645/scratchpad
S="$SC/pcprobe"
V="${1:-0.0.30}"
PREACT="${2:-5.2.0}"
RSC=0.5.32
REACT=19.2.8
RSDW=19.2.8
VITE7=7.3.6
VITE8=8.2.0

dump_resolved() {  # $1 = app dir, $2 = out file — every package in the tree, name@version
  node -e '
    const fs=require("fs"),p=require("path");const root=p.join(process.argv[1],"node_modules");
    const out=[];
    (function walk(dir){
      if(!fs.existsSync(dir))return;
      for(const e of fs.readdirSync(dir,{withFileTypes:true})){
        if(e.name===".bin"||e.name===".package-lock.json")continue;
        const f=p.join(dir,e.name);
        if(e.name.startsWith("@")){walk(f);continue;}
        const pj=p.join(f,"package.json");
        if(fs.existsSync(pj)){
          try{const j=JSON.parse(fs.readFileSync(pj,"utf8"));if(j.name&&j.version)out.push(j.name+"@"+j.version);}catch{}
        }
        walk(p.join(f,"node_modules"));
      }
    })(root);
    console.log([...new Set(out)].sort().join("\n"));
  ' "$1" > "$2"
}

for pair in "7:$VITE7" "8:$VITE8"; do
  major="${pair%%:*}"; vite="${pair##*:}"
  D="$SC/fix78-$(echo "$V" | tr -d '.')-vite$major"
  rm -rf "$D"; mkdir -p "$D"
  cp -R "$S/app" "$D/" 2>/dev/null
  cp -R "$S/public" "$D/" 2>/dev/null
  cp "$S/next.config.ts" "$S/vite.config.ts" "$S/next-env.d.ts" "$D/" 2>/dev/null
  cat > "$D/package.json" <<EOF
{
  "name": "vinext-fix78-probe-$major",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "dependencies": {
    "@types/node": "26.1.2",
    "@types/react": "19.2.18",
    "@vitejs/plugin-react": "$PREACT",
    "@vitejs/plugin-rsc": "$RSC",
    "react": "$REACT",
    "react-dom": "$REACT",
    "react-server-dom-webpack": "$RSDW",
    "typescript": "7.0.2",
    "vinext": "$V",
    "vite": "$vite"
  }
}
EOF
  (cd "$D" && npm install --no-audit --no-fund --silent) > "/tmp/fix78-$V-$major.log" 2>&1
  (cd "$D" && NODE_ENV=production npx vinext build) >> "/tmp/fix78-$V-$major.log" 2>&1
  dump_resolved "$D" "/tmp/fix78-resolved-$major.txt"

  echo "===== ARM vite $major  (dir $D)"
  echo "-- resolved versions of every held-fixed input + the bundler each vite pulls"
  node -e '
    const fs=require("fs"),p=require("path");const d=process.argv[1];
    const names=["vinext","vite","@vitejs/plugin-react","@vitejs/plugin-rsc","react","react-dom",
      "react-server-dom-webpack","rolldown","rollup","esbuild","@rolldown/plugin-babel",
      "babel-plugin-react-compiler"];
    const all=fs.readFileSync(process.argv[2],"utf8").split("\n").filter(Boolean);
    for(const n of names){
      const hits=all.filter(x=>x.slice(0,x.lastIndexOf("@"))===n);
      console.log("   "+n.padEnd(30)+(hits.length?hits.map(h=>h.slice(h.lastIndexOf("@")+1)).join(", "):"ABSENT"));
    }
    const rb=all.filter(x=>x.startsWith("@rolldown/binding")||x.startsWith("@esbuild/")||x.startsWith("@rollup/rollup-"));
    console.log("   native bundler bindings        "+(rb.join(", ")||"none"));
  ' "$D" "/tmp/fix78-resolved-$major.txt"

  ssr="$D/dist/server/ssr/index.js"
  if [ -f "$ssr" ]; then
    n=$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const re=/\b[A-Za-z_$][\w$]*\((`|")react-dom\1\)/g;console.log((s.match(re)||[]).length)' "$ssr")
    cr=$(grep -o "createRequire" "$ssr" | wc -l | tr -d ' ')
    echo "-- ssrChunk=$(wc -c < "$ssr" | tr -d ' ') bytes  require(\"react-dom\")=$n  createRequire=$cr"
  else
    echo "-- BUILD-FAILED (see /tmp/fix78-$V-$major.log)"
  fi
done

echo
echo "===== FULL resolved-package diff between the two arms (< vite7 arm, > vite8 arm)"
echo "      Anything here other than vite itself and vite's own bundler deps is a confound."
diff /tmp/fix78-resolved-7.txt /tmp/fix78-resolved-8.txt
echo "(diff exit $?; 0 = identical trees, 1 = differences listed above)"
