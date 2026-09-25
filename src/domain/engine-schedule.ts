import type { ControllerHost } from "./engine-host.js";
import { executeTurn } from "./engine-execute.js";

export function scheduleController(host: ControllerHost): void {
  if (host.scheduled || host.closing) return;
  host.scheduled = true;
  queueMicrotask(() => {
    host.scheduled = false;
    pumpController(host);
  });
}

export function pumpController(host: ControllerHost): void {
  if (host.closing) return;
  for (const turn of host.store.turns()) {
    if (host.active.size >= host.concurrency) break;
    if (
      !["queued", "prepared"].includes(turn.state) ||
      host.active.has(turn.id)
    )
      continue;
    const thread = host.store.thread(turn.threadId)!;
    const workspace = thread.workspace;
    if (
      host.store
        .turns()
        .some(
          (candidate) =>
            ["submission-unknown", "interrupted"].includes(candidate.state) &&
            host.store.thread(candidate.threadId)?.workspace === workspace,
        )
    )
      continue;
    if ([...host.active.values()].some((active) => active.workspace === workspace))
      continue;
    const abort = new AbortController();
    const promise = Promise.resolve()
      .then(() => executeTurn(host, thread, turn, abort.signal))
      .finally(() => {
        host.active.delete(turn.id);
        scheduleController(host);
      });
    host.active.set(turn.id, { promise, abort, workspace });
  }
}

export async function drainController(host: ControllerHost): Promise<void> {
  do {
    await Promise.resolve();
    await Promise.all([...host.active.values()].map((item) => item.promise));
  } while (host.scheduled || host.active.size > 0);
}

export async function closeController(host: ControllerHost): Promise<void> {
  host.closing = true;
  for (const active of host.active.values()) active.abort.abort();
  await Promise.all(
    [...host.providers.values()].map((provider) => provider.close()),
  );
  await drainController(host);
}
