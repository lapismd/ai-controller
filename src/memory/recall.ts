import type { ContextBlock } from "../contracts.js";
import { automaticRecallQuery } from "./ranking.js";
export type MemoryProfile = "lapis-v1" | "nostr-v1";
export interface MemoryCandidate {
  ref: string;
  revision: string;
  content: string;
  origin: "owner" | "agent" | "system" | "untrusted";
  active: boolean;
  curated: boolean;
  provenance: string[];
  kind?: string;
}
/** The adapter MUST restrict its retrieval partition before ranking or limiting. */
export interface MemoryPort {
  profile: MemoryProfile;
  candidates(query: string, signal: AbortSignal): Promise<MemoryCandidate[]>;
  authorize(
    candidates: MemoryCandidate[],
    signal: AbortSignal,
  ): Promise<boolean>;
}
export interface MemoryRecall {
  blocks: ContextBlock[];
  omitted: "empty" | "unavailable" | "deadline" | "revoked" | null;
}
export async function recallMemory(
  port: MemoryPort,
  query: string,
  signal?: AbortSignal,
): Promise<MemoryRecall> {
  if (!query.trim()) return { blocks: [], omitted: "empty" };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 150);
  try {
    const candidates = await deadline(
      port.candidates(
        port.profile === "lapis-v1"
          ? automaticRecallQuery(query)
          : query.trim(),
        controller.signal,
      ),
      controller.signal,
    );
    const eligible = candidates.filter(
      (item) => item.active && item.curated && item.origin === "owner",
    );
    // Nostr's adapter returns its three diversity-selected candidates; Lapis returns up to eight.
    const selected =
      port.profile === "nostr-v1" ? eligible.slice(0, 3) : eligible;
    const blocks: ContextBlock[] = [];
    let remaining = 900 * 4;
    for (const item of selected) {
      let content: string;
      if (port.profile === "lapis-v1") {
        content = `${item.content}\nProvenance: ${item.provenance.join(", ") || "owner-authored memory"}`;
        const cost = Math.ceil(content.length / 4) * 4;
        if (cost > remaining) continue;
        remaining -= cost;
      } else {
        const header = `<memory ref="${escapeAttribute(item.ref)}" kind="${escapeAttribute(item.kind ?? "fact")}" evidence="${escapeAttribute(item.provenance.join(","))}">`;
        const footer = "</memory>";
        const allowance = remaining - [...header].length - footer.length - 2;
        if (allowance <= 0) break;
        const chars = [...item.content];
        const text =
          chars.length <= allowance
            ? item.content
            : chars.slice(0, Math.max(0, allowance - 1)).join("") + "…";
        content = `${header}\n${text}\n${footer}`;
        remaining -= [...content].length + 2;
      }
      blocks.push({
        id: item.ref,
        revision: item.revision,
        kind: "memory",
        trust: "reference",
        content,
      });
      if (blocks.length === 3) break;
    }
    if (
      !(await deadline(
        port.authorize(
          selected.filter((item) =>
            blocks.some((block) => block.id === item.ref),
          ),
          controller.signal,
        ),
        controller.signal,
      ))
    )
      return { blocks: [], omitted: "revoked" };
    return { blocks, omitted: blocks.length ? null : "empty" };
  } catch {
    return {
      blocks: [],
      omitted: controller.signal.aborted ? "deadline" : "unavailable",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
function deadline<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void value.catch(() => {});
    return Promise.reject(new Error("Memory recall deadline"));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Memory recall deadline"));
    signal.addEventListener("abort", abort, { once: true });
    value
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
