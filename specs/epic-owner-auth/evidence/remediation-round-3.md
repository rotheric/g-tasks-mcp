# Fresh adversarial remediation, round 3

F1: prune permanently inactive grants plus their access/refresh entries before
capacity checks. This cannot restore old tokens: an existing family is never
reactivated, unknown hashes reject, and new families use independent random IDs
and tokens. Active families keep every spent hash for replay detection. The
plan's no-early-discard promise protects necessary replay evidence; a permanently
revoked family has no remaining authorization and needs no such evidence.

Executable recovery matrix performs 105 production issue/retire cycles for token
revocation, owner client revocation and disconnect/reconnect, then issues fresh
access. All old access/refresh tokens remain invalid after reload. Existing
per-family capacity test now reauthorizes successfully; active replay detection
also runs across cleanup of an unrelated retired family.

F2: reject zero CIDR prefixes, matching the installed Express proxy parser.
Existing configuration table adds IPv4 and IPv6 /0 cases. Explicit broad proxy
trust remains an operator deployment boundary: hosted backend access must be
limited to genuinely trusted proxies that set forwarded protocol correctly.

Continuing structural review is CLEAN after independently rerunning all 80 tests, typecheck and build. A new fresh Astra pass is reviewing the corrected snapshot. Host/Google/harness and independent examiner remain pending.
