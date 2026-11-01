# Dependency bot activation

The generated version PR uses a short-lived repository-scoped App token. The
activation variable gates preparation, and checkout does not retain credentials.
Publication remains outside this workflow. The App token allows generated PRs
to start ordinary functional CI; GitHub token-authored PR workflows otherwise
require manual approval on supported GitHub versions.

Validation: frozen pnpm installation, actionlint, spec:check (four lanes),
check (types, architecture and boundaries), test (196 Node tests and seven
Deno runtime tests), and build pass on Node 24.15.0. Live App-token workflow
execution is a separate activation check; no package was published.
