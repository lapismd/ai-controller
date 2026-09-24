# Local policy validation

The effective-policy slice needs the unreleased host permission-status contract.
The source manifest and lockfile retain normal registry ranges. To validate:

1. Build and pack the verified ai-host checkout.
2. Copy this repository source, scripts, specification, manifest and TypeScript
   configuration into a disposable project.
3. Give only that disposable project pnpm workspace overrides for the packed
   ai-host and the validated agent-redaction tarball; install normally.
4. Run the exact effective-policy and approval-policy tests, then spec:check,
   check, test and build. Pack that build for downstream disposable acceptance.

2026-09-24: the native applied/unsupported/rejected/unreported regressions failed
four times before implementation and passed afterwards. Packaged validation
passed 134 tests, specification, TypeScript/browser boundary checks and build.
The canonical checkout still has the older installed host declarations; its
check reports permissionMode missing from AcpSessionStatus. No type shim or
installed dependency was edited. No service was installed or restarted.

## Real providers (2026-09-24)

Eight isolated provider turns passed: Ask and Allow all for native Codex, Codex
ACP, Cursor ACP and OpenCode ACP. Every turn completed and the acceptance process
independently verified the exact `POLICY_OK` plus newline bytes. Ask observed a
pending approval while the target file was still absent, then selected the
provider's offered allow-once choice. Allow all retained resolved interactions
with `resolution: automatic`. No task questions were auto-answered by this policy.

Codex ACP advertised and applied its native `read-only` mode; the test explicitly
requested shell escalation for the disposable relative file. OpenCode used a
workspace-local `permission: {"*":"ask"}` configuration so approvals were
observable. Cursor used its default approval-capable mode. Native Codex used the
controller's default native mode. These are execution-policy checks, not claims
about arbitrary model instruction compliance.

Earlier OpenCode attempts omitted the requested newline. External-path probes
were inconclusive because redaction replaced the requested path; they are not
counted as passes. Retrying with a relative file and an explicit shell write
proved the complete decision-and-effect path without relaxing the byte assertion.
The earlier Cursor probe checked file absence again for a later verification
approval; the final probe checks absence before the first approval only.

Scripts and machine-readable results are retained under
`/tmp/community-agent-alignment/aic/policy-provider-local-probe.mjs` and
`policy-local-probe-{codex,cursor,opencode}.json`; native Codex evidence is in
`policy-probe-codex-native.json`. Workspaces are disposable local directories;
no production repository task or installed service was run.

The source checkout now passes its normal TypeScript and boundary check against
the same verified packed host using
`pnpm --config.pnpmfile=/tmp/community-agent-alignment/aic-validation.pnpmfile.cjs install --lockfile=false`.
The hook also selects the redaction tarball; canonical package files are unchanged.
