/**
 * The `cache.keyPrefix` rule, CLI copy.
 *
 * The apiserver is the authority: the NextApp CRD validates
 * `spec.cache.keyPrefix` at admission with a pattern, a maxLength and a CEL
 * rule (api/v1alpha1/nextapp_types.go). This module holds the same rule so
 * `knext deploy` fails before the build and `knext doctor` can name stored apps
 * the rule would refuse on their next change.
 * `redis-key-prefix-rule.test.ts` reads the generated CRD and fails if the two
 * drift.
 *
 * The excluded characters are the runtime's `escapeGlob` set (the Redis glob
 * metacharacters `* ? [ ] \`, use-cache-handler.js) plus ASCII whitespace.
 * Every escape in the pattern is ASCII, so Go RE2 (the apiserver) and JS read
 * it identically.
 */

/** The runtime's fallback for an app with no prefix; reserved, never reaped. */
export const LEGACY_SHARED_KEY_PREFIX = "kn-next";

/** The CRD's `maxLength` on `spec.cache.keyPrefix`. */
export const KEY_PREFIX_MAX_LENGTH = 63;

/** The CRD's `pattern` on `spec.cache.keyPrefix`, verbatim. */
export const KEY_PREFIX_PATTERN = "^[^*?\\[\\]\\\\ \\t\\n\\r\\f\\v]*$";

/** The CRD's CEL rule on `spec.cache.keyPrefix`, verbatim. */
export const KEY_PREFIX_RESERVED_RULE =
    "self != 'kn-next' && !self.startsWith('kn-next:')";

const PATTERN = new RegExp(KEY_PREFIX_PATTERN);

/**
 * Why `prefix` would be refused at admission, or `undefined` when it is
 * accepted. The empty string is accepted: an empty prefix is unset, and the
 * operator gives the app its own default.
 */
export function keyPrefixProblem(prefix: string): string | undefined {
    // The apiserver's maxLength counts code points, not UTF-16 units.
    const length = [...prefix].length;
    if (length > KEY_PREFIX_MAX_LENGTH) {
        return `is ${length} characters; the limit is ${KEY_PREFIX_MAX_LENGTH}`;
    }
    if (!PATTERN.test(prefix)) {
        return "contains whitespace or a Redis glob character (* ? [ ] \\)";
    }
    if (
        prefix === LEGACY_SHARED_KEY_PREFIX ||
        prefix.startsWith(`${LEGACY_SHARED_KEY_PREFIX}:`)
    ) {
        return `is reserved: '${LEGACY_SHARED_KEY_PREFIX}' and prefixes under '${LEGACY_SHARED_KEY_PREFIX}:' are the shared fallback keyspace`;
    }
    return undefined;
}
