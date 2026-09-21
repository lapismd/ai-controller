import { describe, expect, it } from "vitest";
import {
  extractToolCommand,
  mergeToolSnapshot,
  snapshotFromToolActivity,
  toolDisplayInput,
} from "./tool-snapshot.js";

describe("tool snapshot", () => {
  it("extracts command from raw input, executable plus args, and title backticks", () => {
    expect(extractToolCommand({ command: "npm install" })).toBe("npm install");
    expect(extractToolCommand({ executable: "git", args: ["status"] })).toBe(
      "git status",
    );
    expect(extractToolCommand({}, "Ran `ls -la`")).toBe("ls -la");
    expect(extractToolCommand("pwd")).toBe("pwd");
  });

  it("builds a display envelope instead of empty input", () => {
    expect(
      toolDisplayInput({
        kind: "execute",
        command: "npm test",
        locations: [{ path: "package.json" }],
      }),
    ).toEqual({
      command: "npm test",
      locations: [{ path: "package.json" }],
      kind: "execute",
    });
    expect(toolDisplayInput({ input: { path: "a.md" } })).toEqual({
      path: "a.md",
    });
    expect(toolDisplayInput({})).toBeUndefined();
  });

  it("merges a thin update onto the original invocation", () => {
    const start = snapshotFromToolActivity({
      id: "t1",
      title: "read",
      kind: "read",
      rawInput: { path: "Notes/a.md" },
    });
    const update = snapshotFromToolActivity({
      id: "t1",
      name: "acp_tool",
      status: "completed",
      output: "ok",
    });
    expect(mergeToolSnapshot(start, update)).toMatchObject({
      id: "t1",
      name: "read",
      kind: "read",
      input: { path: "Notes/a.md" },
      output: "ok",
    });
  });
});
