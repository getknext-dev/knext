# 90-second demo script — draft

**DRAFT.** A 90-second demo: scaffold -> deploy -> scale to zero -> wake, using the file-manager
reference app. Commands below were verified against the published release-candidate CLI (see
"Command verification" at the bottom). **Recording the actual GIF requires a live cluster and is a
founder/lead step** — this file provides the script and the recording steps, not a recorded asset.

## Prerequisites (not part of the 90 seconds)

- A Kubernetes cluster with Knative Serving and the knext operator installed.
- `kubectl` pointed at that cluster.
- Node.js or Bun on PATH.

## Script (~90 seconds of terminal time)

```sh
# 1. Scaffold a new app (or point at the existing file-manager reference app)
npx @getknext/core create my-app
cd my-app

# 2. Fill in knext.config.ts (registry, bucket, database — see the Quick Start guide),
#    then deploy: build, push, and apply the NextApp CR
npx @getknext/core deploy

# 3. Watch it come up
npx @getknext/core status --watch

# 4. Let it go idle, then check status again — it should show zero running pods
#    once Knative's idle window elapses
kubectl get pods -l serving.knative.dev/service=my-app

# 5. Wake it: hit the URL from `status`, and watch a pod appear again
curl -s -o /dev/null -w '%{http_code}\n' https://<app-url-from-status>
kubectl get pods -l serving.knative.dev/service=my-app
```

For the file-manager reference app specifically, substitute step 1 with the existing checkout at
`apps/file-manager` and run `npx @getknext/core deploy` from that directory instead of scaffolding
a fresh app.

## What to say on camera (beat by beat)

1. "This is a stock Next.js app." (show `knext.config.ts`, note it's the only new file)
2. "One command builds it with the official Next.js adapter, pushes the image, and applies a
   NextApp custom resource." (`knext deploy`)
3. "The operator reconciles that into a Knative Service." (`knext status --watch` until Ready)
4. "When traffic stops, Knative scales it to zero — no running pods, no compute cost." (`kubectl
   get pods` showing none)
5. "The next request wakes it back up." (curl the URL, show a pod appear)

Do not narrate a specific cold-start number on camera — see the honesty note below.

## Recording the GIF (founder/lead step — not done here)

1. Prepare a real cluster with the file-manager reference app already scaffolded and its
   `knext.config.ts` filled in against real credentials (registry, bucket, database).
2. Use a terminal-recording tool that produces a GIF, for example [vhs](https://github.com/charmbracelet/vhs).
   A starting tape (`demo.tape`) would look like:

   ```tape
   Output docs/release/demo.gif
   Set Shell "bash"
   Set FontSize 16
   Set Width 1200
   Set Height 650

   Type "npx @getknext/core deploy"
   Enter
   Sleep 30s

   Type "npx @getknext/core status --watch"
   Enter
   Sleep 15s

   Type "kubectl get pods -l serving.knative.dev/service=file-manager"
   Enter
   Sleep 2s

   Type "curl -s -o /dev/null -w '%{http_code}\\n' https://<app-url>"
   Enter
   Sleep 5s

   Type "kubectl get pods -l serving.knative.dev/service=file-manager"
   Enter
   Sleep 2s
   ```

3. Run `vhs demo.tape` against the live cluster and review the output before publishing.
4. **This step is not run as part of this issue** — it needs a live cluster and produces a binary
   asset; a lead or the founder records it separately.

## Honesty note

Do not narrate or caption a specific millisecond cold-start number in the recording. The only
cluster-level cold-start comparison to date measured a tie between build targets, not a number
worth publishing; say "optimized for scale-to-zero" instead.

## Command verification

Every `npx @getknext/core <verb>` command above matches the published release-candidate CLI's own
`--help` output, checked in a clean temp directory against the `rc` dist-tag:

```sh
npx --yes -p @getknext/core@rc knext --help
```

That listing confirms `create`, `deploy` (default), and `status` (with `--watch`) exist with the
flags used above. `deploy` and `status --watch` themselves were not run end-to-end here (they need
a live cluster, which this task does not have) — only their `--help` contracts were checked.
