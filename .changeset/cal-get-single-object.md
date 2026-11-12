---
'zele': patch
---

`cal get` now fetches only the requested event instead of listing the whole calendar first, and a missing event reports `not found` with exit code 1 instead of `API call failed`.

On a 2052-object Google calendar a single read drops from about 7.5s to 1.7s, and a transient list failure no longer breaks reads for other events.
