# Round 5 — exact confidential secret expiry

The independent examiner found a one-second expiry overrun at equality in SDK
client authentication. The shared plaintext-secret verifier now requires expiry
strictly greater than the current second before adapting the secret to its hash.
Permanent code/refresh/revocation boundary and reload tests pass. Structural
review and the independent Astra examiner recheck pass; all nineteen frozen
offline verification questions were answered YES. Historical review snapshot:
84 tests. Browser/header and direct-login changes followed under user direction
and have separate validation evidence and final pre-commit review.
