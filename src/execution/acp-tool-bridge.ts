import type { AgentHostSink, AgentRuntimeExecutor, ToolBridgeCall } from "@lapismd/ai-host";
import { ControllerError, type Json } from "../contracts.js";
import type { ActiveSession } from "./acp.js";

export async function callAcpTool(executor: AgentRuntimeExecutor, sink: AgentHostSink, sessions: Map<string, ActiveSession>, call: ToolBridgeCall): Promise<void> {
    const session = sessions.get(call.bindingId);
    try {
      if (!session?.context || session.bridgeId !== call.bridgeId)
        throw new ControllerError(
          "tool_stale",
          "Tool binding is no longer live",
        );
      const result = await session.context.callTool(
        call.name,
        call.input as Json,
        call.callId,
      );
      executor.respondToolBridge(sink, {
        bridgeId: call.bridgeId,
        callId: call.callId,
        result,
      });
    } catch {
      try {
        executor.respondToolBridge(sink, {
          bridgeId: call.bridgeId,
          callId: call.callId,
          error: {
            code: "tool_failed",
            message: "Application tool did not complete",
          },
        });
      } catch {
        /* A dead MCP call cannot be resurrected. */
      }
    }
  }
