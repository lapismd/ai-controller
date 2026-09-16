import { describe, expect, it } from "vitest";
import {
  RPC_REQUIRED_SCOPES,
  assertCompleteScopeMap,
  narrowScopes,
  requireScope,
  requiredScopeForRpcMethod,
} from "./scopes.js";
import { requestMethods } from "../transport/schema.js";

describe("RPC scope map", () => {
  it("declares a scope for every schema method", () => {
    expect(() => assertCompleteScopeMap()).not.toThrow();
    for (const method of requestMethods())
      expect(RPC_REQUIRED_SCOPES).toHaveProperty(method);
    expect(requiredScopeForRpcMethod("turns.submit")).toBe("threads:operate");
    expect(requiredScopeForRpcMethod("events.subscribe")).toBe("threads:read");
  });
  it("rejects a missing scope and refuses to widen a grant", () => {
    expect(() =>
      requireScope({ scopes: ["threads:read"] }, "turns.submit"),
    ).toThrow(/Missing required scope/);
    expect(() =>
      narrowScopes(["threads:read"], ["threads:operate"]),
    ).toThrow(/exceed the credential grant/);
    expect(narrowScopes(["threads:read", "threads:operate"], ["threads:read"])).toEqual(
      ["threads:read"],
    );
  });
});
