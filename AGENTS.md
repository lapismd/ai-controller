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
