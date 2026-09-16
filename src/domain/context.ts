import {
  ControllerError,
  type ContextBlock,
  type Preparation,
  type Thread,
  type Turn,
} from "../contracts.js";
import type { ContextSource } from "./ports.js";

export async function prepareTurn(
  thread: Thread,
  turn: Turn,
  sources: Map<string, ContextSource>,
  signal: AbortSignal,
): Promise<Preparation> {
  const blocks: ContextBlock[] = [];
  const omitted: string[] = [];
  for (const id of sourceIds(thread)) {
    const source = sources.get(`${thread.owner}:${id}`);
    if (!source) {
      if (id === memorySourceId(thread)) {
        omitted.push(`${id}:unavailable`);
        continue;
      }
      throw new ControllerError(
        "context_unavailable",
        "Registered context source is unavailable",
      );
    }
    try {
      const resolved = await bounded(
        source.resolve(thread, turn, signal),
        5000,
        signal,
      );
      const items = Array.isArray(resolved) ? resolved : resolved.blocks;
      if (!Array.isArray(resolved) && resolved.omitted)
        omitted.push(`${id}:${resolved.omitted}`);
      blocks.push(...items.map((block) => ({ ...block, sourceId: id })));
    } catch (error) {
      if (source.required || signal.aborted) throw error;
      omitted.push(id);
    }
  }
  const unique = [
    ...new Map(
      blocks.map((block) => [`${block.id}:${block.revision}`, block]),
    ).values(),
  ];
  const order = { instructions: 0, handoff: 1, memory: 2, application: 3 };
  unique.sort((a, b) => order[a.kind] - order[b.kind]);
  const selected: ContextBlock[] = [];
  let characters = 0;
  for (const block of unique) {
    if (characters + block.content.length > 100_000) {
      if (block.required)
        throw new ControllerError(
          "context_budget",
          "Required context exceeds budget",
        );
      omitted.push(block.id);
      continue;
    }
    characters += block.content.length;
    selected.push(block);
  }
  return {
    version: 1,
    text: turn.text ?? "",
    blocks: selected,
    omitted,
    configuration: thread.configuration ?? {},
  };
}
export async function authorizePreparation(
  thread: Thread,
  preparation: Preparation,
  sources: Map<string, ContextSource>,
  signal: AbortSignal,
): Promise<void> {
  for (const id of sourceIds(thread)) {
    const blocks = preparation.blocks.filter((block) => block.sourceId === id);
    if (
      !blocks.length &&
      preparation.omitted.some(
        (reason) => reason === id || reason.startsWith(`${id}:`),
      )
    )
      continue;
    const source = sources.get(`${thread.owner}:${id}`);
    if (
      !source ||
      !(await bounded(source.authorize(thread, blocks, signal), 5000, signal))
    )
      throw new ControllerError(
        "context_revoked",
        "Prepared context is no longer authorized",
      );
  }
}
export function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      finish(() =>
        reject(new ControllerError("cancelled", "Operation cancelled")),
      );
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new ControllerError("timeout", "Operation timed out")),
        ),
      milliseconds,
    );
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback();
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
export function memorySourceId(thread: Thread): string | undefined {
  return thread.memoryEndpoint
    ? `__memory.${thread.memoryEndpoint}`
    : undefined;
}
function sourceIds(thread: Thread): string[] {
  return [
    ...new Set([
      ...(thread.contextSources ?? []),
      ...[memorySourceId(thread)].filter((id): id is string => Boolean(id)),
    ]),
  ];
}
