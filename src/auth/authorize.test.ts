import { describe, expect, it } from "vitest";
import {
  authorizeMemoryInput,
  endpointKey,
  requireResource,
} from "./authorize.js";
import type { AuthSession, Thread } from "../contracts.js";

const session: AuthSession = {
  id: "session",
  principalId: "owner",
  applicationId: "lapis",
  scopes: ["memory:read"],
  providers: ["fake"],
  workspaces: ["root"],
  createdAt: 1,
  expiresAt: 2,
};

const thread: Thread = {
  id: "thread",
  owner: "owner",
  application: "lapis",
  provider: "fake",
  workspace: "root",
  payloadPolicy: "durable",
  version: 1,
  createdAt: 1,
};

describe("resource and memory isolation", () => {
  it("rejects another application and strips client identity fields", () => {
    expect(() => requireResource(session, thread)).not.toThrow();
    expect(() =>
      requireResource(session, { ...thread, application: "nostr" }),
    ).toThrow(/not found/);
    expect(
      authorizeMemoryInput(
        {
          query: "auth",
          principalId: "other",
          applicationId: "nostr",
          workspaceId: "secret",
          owner: "other",
          scope: "all",
          partition: "wide",
          access: { threadId: "other-thread" },
        },
        {
          principalId: "owner",
          applicationId: "lapis",
          workspaceId: "root",
          threadId: "thread",
        },
      ),
    ).toEqual({
      query: "auth",
      access: {
        principalId: "owner",
        applicationId: "lapis",
        workspaceId: "root",
        threadId: "thread",
      },
    });
    expect(endpointKey("owner", "lapis", "tools")).toBe("owner:lapis:tools");
  });
});
