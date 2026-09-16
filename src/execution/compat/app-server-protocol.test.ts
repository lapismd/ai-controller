import { describe, expect, it } from "vitest";
import {
  approvalRequestFromServerRequest,
  approvalReplyForServerRequest,
  approvalResponseForOption,
  mapCodexNotification,
  userInputReplyForServerRequest,
  userInputRequestFromServerRequest,
} from "./app-server-protocol.js";

describe("Codex app-server protocol mapper", () => {
  it("maps deltas, tools, completion, and errors", () => {
    expect(
      mapCodexNotification({
        method: "item/agentMessage/delta",
        params: { text: "hi" },
      }),
    ).toEqual({ type: "text", text: "hi" });
    expect(
      mapCodexNotification({
        method: "item/started",
        params: {
          item: {
            id: "1",
            type: "mcpToolCall",
            tool: "read",
            arguments: { path: "a" },
          },
        },
      }),
    ).toEqual({
      type: "tool.start",
      id: "1",
      name: "read",
      input: { path: "a" },
    });
    expect(
      mapCodexNotification({ method: "turn/completed", params: {} }),
    ).toEqual({
      type: "completed",
      result: {},
    });
  });

  it("maps approval requests without leaking RPC types on the public shape", () => {
    const message = {
      id: "a1",
      method: "item/commandExecution/requestApproval",
      params: {
        reason: "Run npm install",
        command: "npm install",
      },
    };
    const request = approvalRequestFromServerRequest(message);
    expect(request).toMatchObject({
      id: "a1",
      kind: "execute",
      title: "Run npm install",
    });
    expect(request?.metadata).toBeUndefined();
    expect(approvalResponseForOption("allow-always")).toEqual({
      decision: "acceptForSession",
    });
    expect(approvalReplyForServerRequest(message, "deny-once")).toEqual({
      result: { decision: "decline" },
    });
  });

  it("maps current reasoning and command completion notifications", () => {
    expect(
      mapCodexNotification({
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            total: { totalTokens: 41_200 },
            last: { totalTokens: 2_100 },
            modelContextWindow: 258_400,
          },
        },
      }),
    ).toEqual({
      type: "usage",
      usage: { used: 41_200, limit: 258_400 },
    });
    expect(
      mapCodexNotification({
        method: "item/reasoning/summaryTextDelta",
        params: { delta: { text: "Summary" } },
      }),
    ).toEqual({ type: "thinking", text: "Summary", kind: "summary" });
    expect(
      mapCodexNotification({
        method: "item/completed",
        params: {
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "pwd",
            aggregatedOutput: "/vault",
          },
        },
      }),
    ).toEqual({
      type: "tool.end",
      id: "cmd-1",
      name: "command",
      server: undefined,
      output: "/vault",
      error: undefined,
    });
  });

  it("maps request_user_input questions and their answer payload", () => {
    const message = {
      id: "q1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [
          {
            id: "approach",
            header: "Approach",
            question: "How should I proceed?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Minimal", description: "Change only this file." },
              { label: "Refactor", description: "Clean up nearby code." },
            ],
          },
        ],
        autoResolutionMs: null,
      },
    };
    expect(userInputRequestFromServerRequest(message)).toEqual({
      id: "q1",
      title: "Agent needs input",
      questions: [
        {
          id: "approach",
          header: "Approach",
          prompt: "How should I proceed?",
          allowOther: true,
          secret: false,
          options: [
            {
              id: "approach-option-1",
              label: "Minimal",
              description: "Change only this file.",
            },
            {
              id: "approach-option-2",
              label: "Refactor",
              description: "Clean up nearby code.",
            },
          ],
        },
      ],
    });
    expect(
      userInputReplyForServerRequest(message, { approach: ["Minimal"] }),
    ).toEqual({
      result: { answers: { approach: { answers: ["Minimal"] } } },
    });
  });
});
