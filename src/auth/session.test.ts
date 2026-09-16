import { describe, expect, it } from "vitest";
import { ControllerStore } from "../persistence/store.js";
import { AuthSessionStore } from "./session.js";

const token = "bootstrap-credential-with-enough-length";

describe("AuthSessionStore", () => {
  it("issues, resumes, and rejects expired session bearers", () => {
    const store = new ControllerStore(":memory:");
    let now = 1_000;
    const sessions = new AuthSessionStore(store, () => now, 1_000);
    const credentials = [
      {
        token,
        principal: {
          id: "local",
          providers: ["fake"],
          workspaces: ["root"],
        },
      },
    ];
    try {
      const first = sessions.hello(token, credentials);
      expect(first.token).toBeTruthy();
      const resumed = sessions.hello(token, credentials);
      expect(resumed.session.id).toBe(first.session.id);
      expect(resumed.token).toBeUndefined();
      const viaBearer = sessions.hello(first.token!, credentials);
      expect(viaBearer.session.id).toBe(first.session.id);
      now = 10_000;
      expect(() => sessions.hello(first.token!, credentials)).toThrow(
        /Handshake rejected/,
      );
      const replacement = sessions.hello(token, credentials);
      expect(replacement.session.id).not.toBe(first.session.id);
      expect(replacement.token).toBeTruthy();
      sessions.revoke(replacement.session.id);
      expect(() => sessions.hello(replacement.token!, credentials)).toThrow(
        /Handshake rejected/,
      );
      expect(() => sessions.issueWebSocketToken(replacement.session.id)).toThrow(
        /not issued/,
      );
    } finally {
      store.close();
    }
  });
});
