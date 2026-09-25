import { deterministicId } from "./memory-constants.js";
import type { MemoryKind } from "./store-port.js";

export type ExtractedClaim = {
  kind: MemoryKind;
  claim: string;
  normalizedClaim: string;
  supersessionKey: string;
  explicit: boolean;
};

export function extractClaim(content: string): ExtractedClaim | undefined {
  const compact = content.trim().replace(/\s+/gu, " ").slice(0, 2_000);
  if (!compact) return undefined;
  const explicitMatch =
    /^(?:please\s+)?remember(?:\s+that)?\s*[:,-]?\s*(.+)$/iu.exec(compact);
  const explicit = Boolean(explicitMatch);
  const claim = (explicitMatch?.[1] ?? compact).trim();
  if (!claim) return undefined;

  const preference =
    /^(?:my\s+)?(?:preferred|preference\s+for)\s+(.+?)\s+is\s+(.+)$/iu.exec(
      claim,
    );
  const assignment = /^([^:=]{2,80})\s*(?:is|=)\s*(.+)$/iu.exec(claim);
  const decision =
    /^(?:we|i)\s+(?:have\s+)?decided\s+(?:that\s+|to\s+)?(.+)$/iu.exec(claim);
  const preferenceSentence = /^i\s+prefer\s+(.+)$/iu.exec(claim);
  const procedure = /^(?:procedure|workflow)\s*:\s*(.+)$/iu.exec(claim);
  const constraint = /^(?:constraint|requirement)\s*:\s*(.+)$/iu.exec(claim);
  if (
    !explicit &&
    !preference &&
    !decision &&
    !preferenceSentence &&
    !procedure &&
    !constraint
  )
    return undefined;

  const kind: MemoryKind =
    preference || preferenceSentence
      ? "preference"
      : decision
        ? "decision"
        : procedure
          ? "procedure"
          : constraint
            ? "constraint"
            : "fact";
  const normalizedClaim = normalizeClaim(claim);
  const subject = preference?.[1] ?? assignment?.[1];
  const supersessionMaterial = subject
    ? `${kind}:${normalizeClaim(subject)}`
    : `${kind}:${normalizedClaim}`;
  return {
    kind,
    claim,
    normalizedClaim,
    supersessionKey: deterministicId("supersession", supersessionMaterial),
    explicit,
  };
}

export function normalizeClaim(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function secretBearingReason(value: string): string | undefined {
  if (/\[(?:REDACTED|Capture omitted|EXTERNAL_PATH)\]/i.test(value))
    return "sanitized omission";
  const patterns: Array<[RegExp, string]> = [
    [/\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}\b/iu, "nostr private key"],
    [
      /\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*\S+/iu,
      "credential",
    ],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, "private key"],
    [/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/u, "API key"],
  ];
  return patterns.find(([pattern]) => pattern.test(value))?.[1];
}
