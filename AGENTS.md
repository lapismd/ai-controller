# AI Controller

Own generic AI orchestration, context/memory policy, provider normalization,
the shared client, and the `lapis-ai-controller` Deno executable here.
Keep Lapis and Nostr domain authorization, source storage, and publication in
their consuming repositories. Reuse `@lapismd/ai-host` execution mechanics.

Read `spec/src/architecture.md` before changes. Update canonical requirements
and verification evidence with behavior changes. Run focused tests, then
`pnpm spec:check`, `pnpm check`, `pnpm test`, and `pnpm build` before committing
verified slices with Jujutsu. Preserve unrelated work. Publication and service
deployment require explicit approval. Never log credentials or private payloads.

## Source organisation

Inspect the owning `src/<feature>/` tree and
`docs/plans/typescript-architecture-and-enforcement.md` before adding files.
Do not grow files over 300 counted lines. Add behaviour in the owning
`src/<feature>/` module rather than a composition facade. Do not invent new
folder names. `cli` must not import `domain`, `memory`, or `persistence`.
`execution` must not import `transport`. `client` and `runtime` must stay
out of `persistence`. Internal modules import siblings directly, not
`src/index.ts`. Run `pnpm check:architecture` with the relevant tests.

### Completion checklist

- [ ] New/changed modules have one primary responsibility and a
      feature-specific name (not `utils` / `helpers` / `common`).
- [ ] Placement matches auth / capture / cli / domain / execution / memory /
      persistence / transport owners, or a residual public facade.
- [ ] Imports follow the dependency matrix; no cli→domain/memory; no
      execution→transport; no production→test imports.
- [ ] Counted lines: new files ≤ 300 (tests ≤ 500); existing hotspots did
      not grow, or the baseline budget dropped after extraction.
- [ ] Tests follow the extracted boundary; characterisation tests added
      before moving poorly covered behaviour.
- [ ] `pnpm check:architecture` and `pnpm check` passed.
