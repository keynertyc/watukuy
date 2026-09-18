---
"watukuy": patch
---

`watukuy/testing` no longer imports `vitest`: the store contract suite lives only under
`watukuy/testing/store-contract`. A build-time check now guards every entry point against
importing another entry or vitest.
