---
"@getknext/core": patch
---

1.0 contract prep: adds a frozen, machine-checked CLI contract
(`cli/contract.ts`) covering every verb's flags and exit codes, cross-checked
against each verb's own parser/source so a flag or exit-code change without a
matching contract update fails a test. Documents exit codes for every verb in
the CLI reference (previously 3 of 12); no behaviour changed.
