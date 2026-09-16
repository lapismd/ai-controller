import {
  createAgentRuntimeExecutor,
  type AgentRuntimeExecutor,
  type AgentHostSink,
} from "@lapismd/ai-host";
import { AsyncEventQueue } from "./compat/event-queue.js";
import type {
  AgentProcessHost,
  AgentProcessMessage,
} from "./compat/process-host.js";

/** Process lifecycle stays in ai-host; this adapter only exposes the portable port. */
export function executionProcessHost(
  executor: AgentRuntimeExecutor = createAgentRuntimeExecutor(),
  sink?: AgentHostSink,
): AgentProcessHost & { close(): Promise<void> } {
  return {
    available: true,
    async spawn(options) {
      const messages = new AsyncEventQueue<AgentProcessMessage>();
      const started = executor.spawnProcess(
        {
          connectionId: "controller-native",
          sendRuntimeEvent: () => {},
          ...sink,
          sendProcessMessage(event: {
            type: string;
            data?: string;
            exitCode?: number;
          }) {
            if (event.type === "exit") {
              messages.push({ type: "exit", exitCode: event.exitCode ?? 1 });
              messages.close();
            } else if (event.type === "stdout" || event.type === "stderr")
              messages.push({ type: event.type, data: event.data ?? "" });
          },
        },
        options,
      );
      return {
        id: started.processId,
        messages: () => messages,
        write: async (data) => executor.writeProcess(started.processId, data),
        kill: async () => {
          executor.killProcess(started.processId);
          messages.close();
        },
      };
    },
    close: () => executor.close(),
  };
}
