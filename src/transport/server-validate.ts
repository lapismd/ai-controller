import type { Json } from "../contracts.js";

export function validContext(block: Json): boolean {
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  return (
    typeof block.id === "string" &&
    typeof block.revision === "string" &&
    typeof block.content === "string" &&
    block.content.length <= 100_000 &&
    ["instructions", "handoff", "memory", "application"].includes(
      String(block.kind),
    ) &&
    ["instructions", "reference"].includes(String(block.trust))
  );
}

export function validCandidate(item: Json): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  return (
    typeof item.ref === "string" &&
    typeof item.revision === "string" &&
    typeof item.content === "string" &&
    item.content.length <= 100_000 &&
    typeof item.active === "boolean" &&
    typeof item.curated === "boolean" &&
    ["owner", "agent", "untrusted", "system"].includes(String(item.origin)) &&
    Array.isArray(item.provenance) &&
    item.provenance.every((value) => typeof value === "string")
  );
}
