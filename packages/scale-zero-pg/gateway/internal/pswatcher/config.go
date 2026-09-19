package pswatcher

// RoutedTenants derives the routed-tenant set (the promotion scope) from the two
// tenant ids the watcher is configured with. Extracted from cmd/pswatcher so the
// ordering + de-duplication contract is unit-tested rather than implied by a few
// lines of wiring code (#1098 review, FIX 3).
//
// Ordering is load-bearing: the BASE tenant is always first, because failover()
// treats element 0 as the tenant that may never be skipped (every compute reads
// through it) and as the tenant whose generation view seeds/heals the ledger.
//
// apps is OPTIONAL — empty on a base-only plane. An apps id equal to the base id is
// de-duplicated so a copy-paste in the manifests cannot make the watcher promote the
// same tenant twice.
func RoutedTenants(base, apps string) []string {
	if base == "" {
		return nil
	}
	tenants := []string{base}
	if apps != "" && apps != base {
		tenants = append(tenants, apps)
	}
	return tenants
}
