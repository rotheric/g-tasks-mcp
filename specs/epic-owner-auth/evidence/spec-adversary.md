# Fresh spec adversary review

Date: 2026-10-05. Scope: pre-implementation planning gate only. Reviewed `spec.md`, `acceptance-criteria.md`, `architecture.md`, both story `verification.json` files, and `AUTH-REFACTOR-PLAN.md`. No implementation or live interoperability was evaluated. No secrets were accessed.

Disposition: **revise the acceptance and verification commitments before source implementation**. The incorporated plan retains the substantive security requirements; the findings below concern contradictions and evidence gaps in turning that plan into independently examinable stories. They do not reopen the prior plan review or require generic implementation approval.

## SA-1 — Make successful authorization observable and distinguish remembered approval

Priority: high. References: `acceptance-criteria.md:3`, `acceptance-criteria.md:18`; plan browser steps and remembered approval policy, lines 153–190.

AC-AUTH-1 is almost entirely negative: an implementation that always denies authorization satisfies its literal observable. AC-FLOW-1 lists operations but never expressly requires an authorized owner to obtain a usable token and execute a Tasks operation. Also, “explicit client consent [is] mandatory” can be interpreted as requiring a new approval POST on every authorization, whereas the plan permits remembered approval for an unchanged tuple with a valid owner session.

Correction: preserve the AC IDs and require an assembled successful path: unapproved registered client plus usable stored Google credentials yields no code; provisional acknowledgement and identity login still yield no code; authenticated owner approval permits the exact approved client/resource/redirect/permissions to obtain and exchange a code; its resulting token executes a representative Tasks operation. Specify remembered approval as previously recorded explicit approval, reusable only with a valid owner session and unchanged approval tuple. A changed tuple requires fresh approval. An already approved client with no owner browser session must not receive a code from stored upstream credentials alone. Add matching pre-implementation verification questions rather than relying on the generic “satisfy access boundaries” question.

## SA-2 — Commit to a generated interleaving assertion, including allowed outcomes

Priority: high. References: AC-AUTH-2, AC-FLOW-2; `VQ-S1-027`, `VQ-S2-024`; plan lines 217–235 and mandatory tests in its acceptance matrix.

The current questions can be answered YES using a single disconnect example even though the ACs quantify over asynchronous success/failure and logout/revocation interleavings. “Transient failures preserve state” also needs a bounded meaning: security-relevant committed owner/account/grant state is preserved, while consuming a callback state or recording an error can be legitimate. “Never restore access” must not prohibit intentional fresh authorization after client revocation.

Correction: freeze a test generator/table of applicable orderings before implementation. Inputs should cover identity/provisioning exchange, Google refresh success, confirmed invalid_grant and transient failure; suspension before final commit; intervening disconnect/reconnect, client revocation/new authorization, browser logout, expiry boundary and competing credential revision; then resumption. Assert over the real assembled flow and reloaded store that obsolete work cannot issue usable codes/tokens, restore old credentials or revoke a newer account, while transient failures do not erase committed credentials/grants and intentional fresh authorization remains possible. Cover concurrent identity callbacks for separate tabs and exact `now == expiry`. Explicitly retain the plan's allowance that an already-started Tasks request may complete. S1 may establish transition tests, but S2 must exercise the real application/Google/auth integration rather than restating those unit tests.

## SA-3 — Separate host transport reachability from OAuth identity in the manual gate

Priority: high for live validation; does not prevent offline source implementation once recorded. References: `spec.md:5`, `architecture.md:3`, AC-AUTH-5, MV-1/MV-2; plan lines 97–129 and HTTP/deployment policy.

“May use host.lima.internal” plus “prefer a loopback tunnel” leaves a material operational ambiguity. A host service bound only to 127.0.0.1 is not necessarily reachable at the host's VM-facing address. Directly substituting `http://host.lima.internal` as BASE_URL would violate the plan's local-only URL/bind policy and change issuer/resource/callback identity. Overriding an HTTP Host header for one probe would not prove that browser redirects and a real harness follow the canonical URLs successfully.

Correction: state that host.lima.internal is only a possible transport destination after the user updates the host. Keep a pending route-validation record containing the host listener/bind, sandbox-to-host forwarding route, exact canonical issuer/resource, actual browser's runtime/setup Google callbacks and harness callback location. For local mode, require a demonstrated forwarding arrangement preserving localhost OAuth identity and loopback binding; if unavailable, keep the live checks blocked or use an independently authorized hosted HTTPS configuration. Do not silently add an insecure remote HTTP mode or broaden host/origin allowlists. The precise forwarding command can be selected after inspecting host capabilities; it should not be claimed proven now.

## SA-4 — Keep the live release matrix distinguishable; one harness is insufficient

Priority: medium. References: MV-1/MV-2 and the plan's live release matrix.

MV-2's singular “Real harness” could be marked passed after one client test despite the incorporated plan requiring evidence separately for Claude Code localhost, Desktop local bridge, Desktop hosted connector, and another harness or SDK test client. Host-only routing cannot demonstrate Anthropic-cloud reachability for a hosted connector. MV-1 also does not expressly retain cancellation, actual granted scopes, upstream refresh and real invalid_grant evidence. These requirements survive incorporation but could disappear from the closure checklist.

Correction: expand the manual rows or attach a required per-path checklist with version/date, approve/deny, refresh, restart, revoke/reconnect and observed callback/token-storage behavior as appropriate. Retain the full Google checklist. Keep each unsupported or unexecuted path pending/blocked for that path; do not let a successful localhost run satisfy hosted HTTPS evidence. Any narrowing of claimed supported paths or waiver of the incorporated release checks needs explicit disposition, not an inferred pass.

## SA-5 — Replace generic examination prompts with a traceable evidence checklist

Priority: medium. References: both `verification.json` files, AC-AUTH-3/4/5, and the plan's acceptance/mandatory-test matrix.

The five generic category questions and verbatim AC questions do not identify which production behaviors must be demonstrated. An examiner could report “atomic persistence ... explicit and tested” after a normal write/reload test, or “wrong-owner ... boundaries enforced” after mocked identity acceptance, omitting the deliberately required fault injection and real signature verification.

Correction: preserve existing pre-implementation questions and append concrete commitments or a required linked checklist mapping all plan acceptance/mandatory-test rows to story, AC and expected evidence. At minimum name: signed fixture JWT validation through the real verification library; fault injection before/after replacement for provisioning/disconnect/rotation/migration; restart rejecting pending codes while preserving valid committed grants; public/confidential client authentication and secret verifiers; omitted/empty scopes; raw issuer equality on SDK-generated redirectable errors; spent refresh revocation and bounded replay history; host/origin/preflight protections and bounded registration. Positive observations and rejection-without-unrelated-mutation observations should both be specified. This is traceability for existing scope, not a request for additional features.

## Gate resolution

The lead can resolve SA-1, SA-2 and SA-5 through concrete pre-implementation AC/question amendments, and SA-3/SA-4 through explicit pending host/Google/harness evidence records. Implementation is already authorized; a host update and genuine manual observations remain necessary before claiming the corresponding live release gates. Recheck amended commitments before marking this adversary review dispositioned.

## Focused amendment recheck

Date: 2026-10-05. Re-read the amended acceptance criteria, both story verification files and `evidence/host-route.md`. **Planning gate disposition: PASS; implementation may proceed.** This supersedes the initial revise disposition above and does not certify implementation or live release readiness.

- SA-1 resolved: AC-AUTH-1 now requires code issuance, usable token exchange and a representative Tasks operation, with recorded approval and unchanged-tuple/owner-session constraints. Read its final clause in conjunction with the incorporated plan: missing session requires owner login; a changed tuple requires fresh approval. Previously recorded unchanged approval can remain reusable after authentication.
- SA-2 resolved as a frozen verification commitment: the explicit generator covers suspended operations, success/failure outcomes, intervening security transitions, expiry, credential revisions and two-tab races, with assertions over production composition and reloaded state. Tests and examination must still demonstrate those combinations; listing them is not execution evidence.
- SA-3 resolved for planning: the pending host-route record distinguishes transport from issuer, prohibits direct remote HTTP substitution and requires actual listener/forwarding/callback observations after the user's host update.
- SA-4 resolved: manual checks now retain independently pending client paths and the Google observations; local success cannot close hosted-cloud evidence.
- SA-5 resolved for planning: the mandatory checklist and VQ-S1-090/VQ-S2-090 require concrete production evidence and mapping to actual tests. During implementation, allocate those checks to their owning stories and cite evidence explicitly; the shared checklist is not a blanket YES for either story.

Remaining host/Google/harness checks are release gates, explicitly pending rather than waived. No additional broad plan review or generic user approval is required by this recheck.
