import { describe, expect, it } from "vitest";
import {
  transcriptEntryHash,
  transcriptRangeHash,
} from "./conversation-hashes.js";
import { buildConversationContextHandoff } from "./context-handoff.js";
import {
  CONVERSATION_SCHEMA_VERSION,
  type TranscriptEntry,
} from "./conversation-types.js";

const base = {
  schemaVersion: CONVERSATION_SCHEMA_VERSION,
  createdAt: "2026-08-16T00:00:00.000Z",
};

describe("buildConversationContextHandoff", () => {
  it("keeps verbatim messages and atomic sanitized tool evidence", async () => {
    const transcript: TranscriptEntry[] = [
      {
        ...base,
        id: "u1",
        type: "message",
        role: "user",
        text: "Fix\nthis",
        agentBindingId: "binding-codex",
      },
      { ...base, id: "r1", type: "thinking.summary", text: "private plan" },
      {
        ...base,
        id: "t1",
        type: "tool",
        toolId: "tool-1",
        name: "shell",
        state: "completed",
        input: "pnpm test",
        output: "all passed",
        redacted: true,
      },
      {
        ...base,
        id: "a1",
        type: "message",
        role: "assistant",
        text: "Done",
        agentBindingId: "binding-codex",
      },
    ];

    const handoff = await buildConversationContextHandoff(transcript, {
      conversationId: "conversation-1",
      targetBindingId: "binding-cursor",
      bindings: [
        {
          ...base,
          id: "binding-codex",
          type: "binding.created",
          runtime: "acp",
          agent: "codex",
        },
      ],
    });

    expect(handoff?.block.content).toContain("[User]\nFix\nthis");
    expect(handoff?.block.content).toContain(
      "Input:\npnpm test\nOutput:\nall passed",
    );
    expect(handoff?.block.content).toContain("[Assistant (codex)]\nDone");
    expect(handoff?.block.content).not.toContain("private plan");
    expect(handoff?.throughEntryHash).toBe(
      await transcriptEntryHash(transcript[3]!),
    );
  });

  it("projects only the verified delta and trims deterministically", async () => {
    const transcript: TranscriptEntry[] = [
      { ...base, id: "u1", type: "message", role: "user", text: "older" },
      { ...base, id: "a1", type: "message", role: "assistant", text: "newer" },
      { ...base, id: "u2", type: "message", role: "user", text: "latest" },
    ];
    const after = {
      entryId: "u1",
      entryHash: await transcriptEntryHash(transcript[0]!),
    };

    const first = await buildConversationContextHandoff(transcript, {
      conversationId: "conversation-1",
      targetBindingId: "binding-1",
      after,
      maxTokens: 7,
    });
    const second = await buildConversationContextHandoff(transcript, {
      conversationId: "conversation-1",
      targetBindingId: "binding-1",
      after,
      maxTokens: 7,
    });

    expect(first).toEqual(second);
    expect(first?.mode).toBe("delta");
    expect(first?.block.content).toContain("latest");
    expect(first?.omittedEntryCount).toBeGreaterThan(0);
    expect(first?.block.content).not.toContain("[User]\nolder");
  });

  it("fails closed for a modified cursor", async () => {
    const transcript: TranscriptEntry[] = [
      { ...base, id: "u1", type: "message", role: "user", text: "evidence" },
    ];
    await expect(
      buildConversationContextHandoff(transcript, {
        after: { entryId: "u1", entryHash: "0".repeat(64) },
      }),
    ).rejects.toThrow(/hash does not match/u);
  });

  it("uses a valid bounded summary with a recent verbatim tail", async () => {
    const transcript: TranscriptEntry[] = [
      {
        ...base,
        id: "u1",
        type: "message",
        role: "user",
        text: "old evidence",
      },
      {
        ...base,
        id: "a1",
        type: "message",
        role: "assistant",
        text: "recent answer",
      },
    ];
    const handoff = await buildConversationContextHandoff(transcript, {
      conversationId: "conversation-1",
      targetBindingId: "binding-1",
      summaries: [
        {
          ...base,
          type: "handoff.summary.created",
          id: "summary-1",
          conversationId: "conversation-1",
          fromEntryId: "u1",
          throughEntryId: "u1",
          sourceHash: await transcriptRangeHash(transcript.slice(0, 1)),
          summary: "Earlier, the user supplied old evidence.",
          processor: { runtime: "acp", agent: "codex", model: "pinned" },
          estimatedTokens: 10,
        },
      ],
    });

    expect(handoff?.mode).toBe("summary-tail");
    expect(handoff?.block.content).toContain("Earlier, the user supplied");
    expect(handoff?.block.content).toContain("recent answer");
    expect(handoff?.block.content).not.toContain("[User]\nold evidence");
  });
});
