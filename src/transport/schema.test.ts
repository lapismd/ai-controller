import { expect, it } from "vitest";
import { validateRequest } from "./schema.js";

it("validates the VCS identity while rejecting arbitrary environment injection", () => {
  const request = (vcsIdentity: unknown) => ({ provider: "codex", workspace: "repo", configuration: { vcsIdentity } });
  expect(() => validateRequest("threads.create", request({ name: "Nyra", email: "nyra@nostr.invalid" }))).not.toThrow();
  for (const identity of [{ name: "Nyra\nOther", email: "a@b" }, { name: "", email: "a@b" }, { name: "Nyra", email: "a@b", env: { SECRET: "bad" } }])
    expect(() => validateRequest("threads.create", request(identity))).toThrow();
});
