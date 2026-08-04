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

package validation

import (
	"fmt"

	"k8s.io/apimachinery/pkg/api/resource"
)

// #635 — resource.ParseQuantity is NOT a bounded computation on user input.
//
// MEASURED on this module's apimachinery (Apple M-series, go test):
//
//	"1e999999"                 ->  ~1 µs, accepted
//	"1e2147483647"             ->  ~1 µs, accepted
//	"1e2147483648"             ->  DOES NOT RETURN within 45 s, heap climbing
//	"1E2147483648" / "1e+2147483648" / "-1e2147483648" / "1e-2147483648"
//	                           ->  same
//	"1e00000002147483648"      ->  same (leading zeros do not shrink the magnitude)
//	1,000,000-digit mantissa   ->  ~1.2 s, accepted
//
// The parser's cliff is not monotone in the exponent (an int64-max exponent
// returns fast, a 2^31 one does not), so a guard pinned to the exact cliff would
// be pinned to an apimachinery implementation detail. These bounds sit five
// orders of magnitude BELOW the observed cliff instead.
//
// Why bounding here is not the "narrowing" ADR-0017 §2.1 forbids: a stored CR in
// this class does not reconcile today — the worker parks inside ParseQuantity
// before producing any ksvc/PVC/NetworkPolicy, forever and silently. Bounding
// turns an unbounded hang into a prompt, field-named rejection; nothing that
// reconciles today stops reconciling. What IS given up is expressiveness nobody
// has: 10^9999 is ~10^9980 times every CPU core and byte of memory in existence,
// so no value beyond the bound can size a container.
const (
	// MaxQuantityExponent is the largest |decimal exponent| a spec quantity may
	// carry, i.e. at most four significant exponent digits ("1e9999" is fine,
	// "1e10000" is not). Leading zeros do not count ("1e0000009" is 9).
	MaxQuantityExponent = 9999

	// maxQuantityExponentDigits is MaxQuantityExponent's digit count — the form
	// the check and the CLI's mirrored regex (`[eE][+-]?0*\d{1,4}`) both use.
	maxQuantityExponentDigits = 4

	// MaxQuantityLength bounds the whole string. The exponent bound does not
	// cover the other cost axis: a mantissa of a million digits carries no
	// exponent at all and still costs ~1.2 s to parse, and a CR field can hold
	// close to the whole ~1.5 MB object. The longest quantity anyone writes is
	// around 20 characters ("9223372036854775807Ki" is 21).
	MaxQuantityLength = 64
)

// ParseQuantityBounded is the ONLY way the operator may parse a quantity that
// came from a CR. It applies the cheap string-level bounds above BEFORE handing
// the value to resource.ParseQuantity, so the parse itself is always bounded.
//
// TestEveryQuantityParseOfCRInputGoesThroughTheBoundedHelper scans the operator's
// sources for any other resource.ParseQuantity/MustParse call on non-literal
// input, because a second unbounded call site reintroduces the hang whatever the
// validator does.
func ParseQuantityBounded(value string) (resource.Quantity, error) {
	if err := checkQuantityBounds(value); err != nil {
		return resource.Quantity{}, err
	}
	return resource.ParseQuantity(value)
}

// checkQuantityBounds reports why a value is out of bounds, or nil.
func checkQuantityBounds(value string) error {
	if len(value) > MaxQuantityLength {
		return fmt.Errorf(
			"is %d characters long; a Kubernetes quantity may be at most %d "+
				"(no real CPU/memory/storage size is longer, and parsing an arbitrarily "+
				"long one is not a bounded operation)",
			len(value), MaxQuantityLength,
		)
	}
	digits, ok := exponentDigits(value)
	if ok && digits > maxQuantityExponentDigits {
		return fmt.Errorf(
			"has a %d-digit decimal exponent; the exponent may be at most ±%d "+
				"(a larger one can never size a container, and parsing it is not a "+
				"bounded operation)",
			digits, MaxQuantityExponent,
		)
	}
	return nil
}

// exponentDigits returns the number of SIGNIFICANT digits in the value's decimal
// exponent (leading zeros stripped) and whether the value has one at all.
//
// The Kubernetes mantissa contains no 'e'/'E', so the first occurrence starts
// the suffix. That suffix is either a decimal exponent ("e3", "E-3") or the
// decimalSI/binarySI exa suffix ("E", "Ei"), which carries no digits and is
// reported as "no exponent". Whatever follows the digit run is left to
// resource.ParseQuantity to reject — the count is taken from the leading digit
// run so that a malformed tail ("1e2147483648Mi") cannot smuggle a huge exponent
// past the bound.
func exponentDigits(value string) (int, bool) {
	i := 0
	for ; i < len(value); i++ {
		if value[i] == 'e' || value[i] == 'E' {
			break
		}
	}
	if i == len(value) {
		return 0, false
	}
	i++
	if i < len(value) && (value[i] == '+' || value[i] == '-') {
		i++
	}
	for i < len(value) && value[i] == '0' {
		i++
	}
	digits := 0
	for i < len(value) && value[i] >= '0' && value[i] <= '9' {
		digits++
		i++
	}
	return digits, digits > 0
}
