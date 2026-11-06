#!/usr/bin/env node
/**
 * Print the standing known-red list as markdown, for the alert issue body (#2499).
 * Labels only; it changes nothing about which provers run or whether the lane
 * passes. See `scripts/lib/known-red-provers.mjs`.
 */

import { knownRedMarkdown } from './lib/known-red-provers.mjs';

console.log(knownRedMarkdown());
