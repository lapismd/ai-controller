export type AgentProcessSpawnOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  appToolBridgeId?: string;
};

export type AgentProcessMessage =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number };

export interface AgentProcessHandle {
  readonly id: string;
  messages(): AsyncIterable<AgentProcessMessage>;
  write(data: string): Promise<void>;
  kill(): Promise<void>;
}

export interface AgentProcessHost {
  readonly available: boolean;
  spawn(options: AgentProcessSpawnOptions): Promise<AgentProcessHandle>;
}

export class UnavailableAgentProcessHost implements AgentProcessHost {
  readonly available = false;

  async spawn(_options: AgentProcessSpawnOptions): Promise<AgentProcessHandle> {
    throw new Error(
      "Live agent runtimes require the desktop agent-runtime capability.",
    );
  }
}
