import type {
  AgentUsage,
  AiThinkingLevel,
  ApprovalKind,
  ApprovalOption,
  ModelRef,
  UserInputQuestion,
} from "../../execution/compat/types.js";

export const CONVERSATION_SCHEMA_VERSION = 3 as const;
export const PREVIOUS_CONVERSATION_SCHEMA_VERSION = 2 as const;
export const LEGACY_CONVERSATION_SCHEMA_VERSION = 1 as const;
export type ConversationSchemaVersion =
  | typeof LEGACY_CONVERSATION_SCHEMA_VERSION
  | typeof PREVIOUS_CONVERSATION_SCHEMA_VERSION
  | typeof CONVERSATION_SCHEMA_VERSION;
export const CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ConversationLocation = {
  scopeDir: string;
  conversationId: string;
};

export type ConversationApprovalDecision = "allow-always" | "deny-always";

export type ConversationApprovalGrant = {
  name: string;
  decision: ConversationApprovalDecision;
};

export type ConversationMetadata = {
  schemaVersion: ConversationSchemaVersion;
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  launchContext?: {
    notePath?: string;
  };
  workspace?: {
    path: string;
  };
  activeAgentBindingId?: string;
  approvalGrants?: ConversationApprovalGrant[];
  pinned?: boolean;
  status: "active" | "archived";
};

export type AgentBindingCreatedRecord = {
  schemaVersion: ConversationSchemaVersion;
  type: "binding.created";
  id: string;
  createdAt: string;
  runtime: string;
  agent?: string;
  model?: ModelRef;
  thinking?: AiThinkingLevel;
  nativeSessionId?: string;
  executionHostId?: string;
  handoffThroughEntryId?: string;
  replacesBindingId?: string;
};

export type AgentUsageRecord = {
  schemaVersion: ConversationSchemaVersion;
  type: "usage.updated";
  id: string;
  createdAt: string;
  agentBindingId: string;
  turnId?: string;
  usage: AgentUsage;
};

export type HandoffProjectionMode = "full" | "delta" | "summary-tail";

export type AgentBindingContextUpdatedRecord = {
  schemaVersion: ConversationSchemaVersion;
  type: "binding.context.updated";
  id: string;
  createdAt: string;
  agentBindingId: string;
  throughEntryId: string;
  throughEntryHash: string;
  cause: "native-turn" | "handoff";
  handoffId?: string;
  projectionMode?: HandoffProjectionMode;
  omittedEntryCount?: number;
};

export type AgentBindingConfigUpdatedRecord = {
  schemaVersion: ConversationSchemaVersion;
  type: "binding.config.updated";
  id: string;
  createdAt: string;
  agentBindingId: string;
  model?: ModelRef;
  thinking?: AiThinkingLevel;
};

export type HandoffSummaryCreatedRecord = {
  schemaVersion: ConversationSchemaVersion;
  type: "handoff.summary.created";
  id: string;
  createdAt: string;
  conversationId: string;
  fromEntryId: string;
  throughEntryId: string;
  sourceHash: string;
  summary: string;
  processor: { runtime: string; agent?: string; model?: string };
  estimatedTokens: number;
};

export type AgentBindingRecord =
  | AgentBindingCreatedRecord
  | AgentUsageRecord
  | AgentBindingContextUpdatedRecord
  | AgentBindingConfigUpdatedRecord
  | HandoffSummaryCreatedRecord;

export type RuntimeEventProvenance = {
  sessionId: string;
  runId: string;
  sequence: number;
};

type TranscriptEntryBase = {
  schemaVersion: ConversationSchemaVersion;
  id: string;
  createdAt: string;
  parentId?: string;
  agentBindingId?: string;
  source?: RuntimeEventProvenance;
  provenance?: {
    originClass: "owner" | "agent" | "untrusted" | "system";
    sourceKind:
      | "user-message"
      | "assistant-message"
      | "runtime-output"
      | "owner-response"
      | "app-system";
  };
};

export type TranscriptEntry =
  | (TranscriptEntryBase & {
      type: "message";
      role: "user" | "assistant";
      text: string;
    })
  | (TranscriptEntryBase & {
      type: "thinking.summary";
      text: string;
      kind?: "summary" | "plan";
    })
  | (TranscriptEntryBase & {
      type: "tool";
      toolId: string;
      name: string;
      server?: string;
      state: "completed" | "error" | "cancelled";
      input?: string;
      output?: string;
      redacted?: boolean;
      truncated?: boolean;
    })
  | (TranscriptEntryBase & {
      type: "approval.request";
      requestId: string;
      kind: ApprovalKind;
      title: string;
      tool?: { name: string; input?: string };
      options: ApprovalOption[];
      redacted?: boolean;
      truncated?: boolean;
    })
  | (TranscriptEntryBase & {
      type: "approval.response";
      requestId: string;
      option: { id: string; label: string };
    })
  | (TranscriptEntryBase & {
      type: "question.request";
      requestId: string;
      title: string;
      questions: UserInputQuestion[];
    })
  | (TranscriptEntryBase & {
      type: "question.response";
      requestId: string;
      status: "answered" | "cancelled";
    })
  | (TranscriptEntryBase & {
      type: "agent.switch";
      fromBindingId?: string;
      toBindingId: string;
      handoffId?: string;
      handoffMode?: HandoffProjectionMode;
      handoffThroughEntryId?: string;
      omittedEntryCount?: number;
    })
  | (TranscriptEntryBase & {
      type: "agent.config";
      model?: ModelRef;
      thinking?: AiThinkingLevel;
    })
  | (TranscriptEntryBase & {
      type: "system.notice";
      text: string;
      layout?: "report" | "inventory";
      inventory?: {
        kind: "skills" | "tools";
        items: Array<{
          name: string;
          description?: string;
          path?: string;
          kind: "skill" | "tool";
        }>;
      };
    })
  | (TranscriptEntryBase & {
      type: "cancelled";
      text?: string;
      requestId?: string;
      interactionType?: "approval" | "question";
    })
  | (TranscriptEntryBase & {
      type: "error";
      message: string;
      retryable?: boolean;
    })
  | (TranscriptEntryBase & {
      type: "command";
      command: string;
      origin: "app" | "extension" | "skill" | "native-agent";
      arguments?: string;
      status: "completed" | "failed" | "cancelled";
    })
  | (TranscriptEntryBase & {
      type: "skill-activation";
      skillId: string;
      skillName: string;
      version: string;
      origin: "user" | "model" | "app";
      arguments?: string;
    });

export type ConversationReadWarning = {
  file: "agents.jsonl" | "transcript.jsonl";
  line: number;
  message: string;
};

export type ConversationSnapshot = {
  location: ConversationLocation;
  metadata: ConversationMetadata;
  agents: AgentBindingRecord[];
  transcript: TranscriptEntry[];
  warnings: ConversationReadWarning[];
};

export class ConversationUnavailableError extends Error {
  constructor(
    readonly location: ConversationLocation,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConversationUnavailableError";
  }
}
