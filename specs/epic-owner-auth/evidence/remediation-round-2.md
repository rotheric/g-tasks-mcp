# Structural remediation, round 2

SR-11: one persisted-file JSON/schema reader emits a fixed actionable recovery
message and never exposes parser diagnostics. Versioned state, legacy client
records and writer-lock records use it. Spawned startup/migration tests place a
secret sentinel in malformed JSON and invalid enum data; commands fail, stderr
contains the generic message, the sentinel is absent, and the writer lock is
released.

SR-12: hosted mode requires a nonempty explicit trusted proxy IP/subnet list.
Every supplied entry is validated as IPv4/IPv6 with an optional valid numeric
prefix. The reverse proxy must preserve the canonical Host and forward HTTPS
protocol. Unsupported symbolic trust shortcuts are rejected. Configuration and
HTTP tests distinguish accepted configuration from an untrusted peer.

Checks: 77/77 behavioral tests, source/test TypeScript checking, build, diff check.
Continuing structural final disposition CLEAN, independently rerun 77/77 tests, typecheck and build. Fresh Astra adversarial review running. Manual host/Google/harness and
independent examiner substitution remain pending.
