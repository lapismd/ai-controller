import { SynchronousRedaction } from "@lapismd/agent-redaction/node";
import type { Policy, SanitizationSummary, LogicalPath } from "@lapismd/agent-redaction";
import { ControllerError } from "../contracts.js";

const identifiers = ["id", "threadId", "turnId", "commandId", "attemptId", "owner", "application", "workspace", "provider", "nativeId", "nativeSessionId", "externalRef", "sourceId"];
/** Plain internal DTO projection: omit optional undefined fields without serializers. */
function dto(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new ControllerError("capture_rejected", "Capture payload rejected");
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => dto(item, depth + 1));
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ControllerError("capture_rejected", "Capture payload rejected");
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || key === "toJSON") throw new ControllerError("capture_rejected", "Capture payload rejected");
    if (descriptor.value !== undefined) output[key] = dto(descriptor.value, depth + 1);
  }
  return output;
}

export class CaptureBoundary {
  readonly #scope: SynchronousRedaction;
  constructor(policy: Omit<Policy, "detector"> = {}) { this.#scope = new SynchronousRedaction({ destination: "private-portable", ...policy }); }
  get policyId(): string { return this.#scope.policyId; }
  registerSecrets(values: readonly string[]): boolean { return this.#scope.registerSecrets(values); }
  scan<T>(value: T, protectIdentifiers = false): { value: T; summary: SanitizationSummary } {
    const input = dto(value);
    const result = this.#scope.value(input);
    if (result.status === "omitted") throw new ControllerError("capture_rejected", `Capture omitted: ${result.reason}`);
    if (protectIdentifiers && input && typeof input === "object" && !Array.isArray(input)) {
      const before = input as Record<string, unknown>, after = result.value as Record<string, unknown>;
      for (const key of identifiers) if (typeof before[key] === "string" && before[key] !== after[key]) throw new ControllerError("capture_identity_redacted", "Required capture identity was rejected");
    }
    return { value: result.value as T, summary: result.summary };
  }
  clean<T>(value: T, protectIdentifiers = false): T { return this.scan(value, protectIdentifiers).value; }
  path(value: string): LogicalPath {
    const result = this.#scope.path(value);
    if (result.status === "omitted") throw new ControllerError("capture_rejected", "Path capture omitted");
    return result.value;
  }
  close(): void { this.#scope.dispose(); }
}
