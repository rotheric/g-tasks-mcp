# Architecture

Authentication module owns all auth rules and state, src/auth/, src/provider.ts, src/storage.ts, src/google.ts, src/setup.ts, src/config.ts. Application module assembles src/app.ts, src/index.ts and invokes Google through src/tools.ts. Functional policies plus serialized synchronous state transitions, async Google ports and thin HTTP adapters. No generic workflow engine. Domain data never bypasses store transitions. Tests inject clock/Google transport; production never uses mock Google responses. Canonical issuer is independent of network route.

A revoked grant family is permanently retired and can never be reactivated. Pruning may delete its access/refresh entries because all of them already deny access; this frees bounded capacity for new authorization. Active families retain every spent refresh hash until their fixed expiry (or permanent revocation), so cleanup never removes necessary replay evidence.
