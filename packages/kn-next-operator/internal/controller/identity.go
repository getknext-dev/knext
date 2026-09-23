/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

// OperatorFieldManager is the operator's stable, self-identifying name for
// every write it makes to the Kubernetes API — Create, Update, Patch, and
// status-subresource writes alike (#1215).
//
// cmd/main.go sets this as rest.Config.UserAgent on the manager's config,
// which every client built from that config (mgr.GetClient(), the cache, and
// any REST client derived from it) inherits. The API server's field-manager
// derivation (BuildManagerIdentifier) reads the request's User-Agent header
// when no field manager is explicitly supplied, so this string becomes the
// literal `managedFields[].manager` recorded against each write.
//
// BEFORE this identity existed, rest.Config.UserAgent was left unset. The
// operator binary is built as `/manager` (see the Dockerfile), so client-go
// fell back to its os.Args[0]-derived default and every operator write
// appeared in managedFields as the bare, ANONYMOUS "manager" — indistinguishable
// from any other client-go tool that happens to share that binary name. That
// made attributing an out-of-boundary write to the operator a name-based
// guess, not a provable fact — precisely the gap the AppDatabase
// data-sovereignty check (../../test/e2e/szpg_boundary.go) had to work around
// by allowlisting the bare "manager" name.
//
// Deliberately UNVERSIONED (no "/vX.Y.Z" suffix). A versioned identity would
// change the literal manager string on every release, churning managedFields
// history and any allowlist/rejectlist keyed on it — the same stability
// argument cmd/main.go already makes for leaderElectionID. The running
// binary's version stays observable elsewhere (image digest, /metrics
// build_info), just not folded into the field-manager identity.
const OperatorFieldManager = "kn-next-operator"
