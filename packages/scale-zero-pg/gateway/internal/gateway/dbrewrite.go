package gateway

import "github.com/alpheya/scale-zero-pg/gateway/internal/proto"

// servedDatabaseRewriter is implemented by drivers (template / branch-per-app
// mode) that route by the client's logical database name but serve a single
// fixed physical database on each per-app branch. Optional: static/kubectl
// drivers don't implement it, so their startup packets are never touched.
type servedDatabaseRewriter interface {
	ServedDatabase() string
}

// rewriteStartupDatabase returns a StartupMessage whose "database" param is set
// to served, rebuilt from params (all other params preserved). It returns the
// ORIGINAL bytes untouched when served is empty or already equals the client's
// database — so the common (non-template) path stays a verbatim byte replay.
func rewriteStartupDatabase(original []byte, params map[string]string, served string) []byte {
	if served == "" || params["database"] == served {
		return original
	}
	rewritten := make(map[string]string, len(params))
	for k, v := range params {
		rewritten[k] = v
	}
	rewritten["database"] = served
	return proto.BuildStartup(rewritten)
}
