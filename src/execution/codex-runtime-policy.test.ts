import { expect, it } from "vitest";
import { AsyncEventQueue } from "./compat/event-queue.js";
import { CodexNativeRuntime } from "./compat/codex-runtime.js";
import type {
  AgentProcessHandle,
  AgentProcessHost,
  AgentProcessMessage,
  AgentProcessSpawnOptions,
} from "./compat/process-host.js";

class PolicyProcess implements AgentProcessHandle {
  readonly id = "policy-process";
  readonly writes: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  readonly #messages = new AsyncEventQueue<AgentProcessMessage>();

  messages() { return this.#messages; }
  async write(data: string) {
    const message = JSON.parse(data) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    this.writes.push(message);
    if (message.id === undefined) return;
    const result = message.method === "thread/start"
      ? { thread: { id: "thread-policy" } }
      : message.method === "turn/start"
        ? { turn: { id: "turn-policy" } }
        : {};
    this.#messages.push({
      type: "stdout",
      data: `${JSON.stringify({ id: message.id, result })}\n`,
    });
  }
  async kill() { this.#messages.close(); }
}

it("sends Codex full-access policy on both thread and turn", async () => {
  const process = new PolicyProcess();
  const host: AgentProcessHost = {
    available: true,
    spawn: async (_options: AgentProcessSpawnOptions) => process,
  };
  const session = await new CodexNativeRuntime(host).start({
    prompt: "",
    workspace: "/tmp",
    approvalPolicy: "allow-all",
  });
  await session.send("Work");
  const thread = process.writes.find((message) => message.method === "thread/start");
  const turn = process.writes.find((message) => message.method === "turn/start");
  expect(thread?.params).toMatchObject({
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  expect(turn?.params).toMatchObject({
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
  await session.close();
});
