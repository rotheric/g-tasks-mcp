# Independent structural review — gpt-5.6-sol

Initial review found cross-profile revocation (provider called client-only Storage.revokeToken) and a mismatch between mandatory Origin criterion and permissive missing-Origin guard. Remediation adds optional resource constraint to Storage.revokeToken, passed by each production provider; same matrix checks access and refresh revocation in both directions. Cookie-authenticated forms now require canonical Origin and CSRF; public OAuth authorization POST retains absent-Origin protocol compatibility. Test helper sends realistic browser Origins. HTTP path guard covers case and trailing slash matching Express routing.

Re-review: clean. Reviewer independently ran test/vm-access.test.ts (8/8) and git diff --check. No remaining concrete structural/correctness/security finding.
