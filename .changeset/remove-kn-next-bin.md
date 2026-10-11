---
"@getknext/core": major
---

The `kn-next` command is removed. `@getknext/core` now installs one command, `knext`, with the same verbs and flags.

- **What changes for you.** A script, CI step, Kubernetes Job or Makefile that still calls `kn-next` fails with `command not found`. Change the name to `knext`. To run the CLI without installing it, use `npx @getknext/core <command>`.
- **Nothing else moves.** `knext init-ci`, the GitHub Action and the `knext create` scaffolds already use the new name, and the one-line deprecation notice that `kn-next` printed is gone with the command.
- **How to migrate.** See "The `kn-next` command is gone" in the Upgrading guide.
