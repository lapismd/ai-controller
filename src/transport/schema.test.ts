import { expect, it } from "vitest";
import { validateRequest } from "./schema.js";

it("validates the VCS identity while rejecting arbitrary environment injection", () => {
  const request = (vcsIdentity: unknown) => ({ provider: "codex", workspace: "repo", configuration: { vcsIdentity } });
  expect(() => validateRequest("threads.create", request({ name: "Nyra", email: "nyra@nostr.invalid" }))).not.toThrow();
  for (const identity of [{ name: "Nyra\nOther", email: "a@b" }, { name: "", email: "a@b" }, { name: "Nyra", email: "a@b", env: { SECRET: "bad" } }])
    expect(() => validateRequest("threads.create", request(identity))).toThrow();
});

it("accepts a generic approval policy separately from the native mode", () => {
  const request = (approvalPolicy: string) => ({ provider: "codex", workspace: "repo", configuration: { approvalPolicy, permissionMode: "native-mode" } });
  expect(() => validateRequest("threads.create", request("allow-all"))).not.toThrow();
  expect(() => validateRequest("threads.create", request("ask"))).not.toThrow();
  expect(() => validateRequest("threads.create", request("invented"))).toThrow();
});
