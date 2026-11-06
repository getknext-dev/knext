---
"@getknext/core": patch
---

Harden the generated runtime contract's bearer-token check. The `checkBearer` helper in the app and zone runtime-contract templates now compares the presented token with `timingSafeEqual` after a length check, instead of a hand-rolled comparison, so a caller cannot learn the token one byte at a time from response timing.
