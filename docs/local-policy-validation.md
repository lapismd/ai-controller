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
