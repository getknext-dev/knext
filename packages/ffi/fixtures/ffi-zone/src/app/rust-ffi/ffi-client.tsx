'use client';

// Calls the Rust-backed Server Actions from the browser, the way an app does.
// It is also what registers the actions in server-reference-manifest.json,
// where the FFI e2e reads their ids.

import { useState } from 'react';
import {
  checkedGreetAction,
  explodeAction,
  type FfiResult,
  greetAction,
  pauseAction,
} from './actions';

export function FfiClient() {
  const [result, setResult] = useState<FfiResult | null>(null);
  return (
    <div>
      <button type="button" onClick={async () => setResult(await greetAction('browser'))}>
        greet
      </button>
      <button type="button" onClick={async () => setResult(await checkedGreetAction(''))}>
        checked_greet (Err)
      </button>
      <button
        type="button"
        onClick={async () => setResult(await explodeAction('from the browser'))}
      >
        explode (panic)
      </button>
      <button type="button" onClick={async () => setResult(await pauseAction(100))}>
        pause (slow call)
      </button>
      <pre data-knext-ffi-result>{result === null ? '' : JSON.stringify(result)}</pre>
    </div>
  );
}
