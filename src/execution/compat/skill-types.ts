export interface SkillSnapshotEntry {
  skillId: string;
  name: string;
  description: string;
  version: string;
  userInvocable: boolean;
  modelInvocable: boolean;
  argumentHint?: string;
}

export interface SkillSnapshot {
  id: string;
  createdAt: string;
  skills: readonly SkillSnapshotEntry[];
}

export interface SkillActivation {
  skillId: string;
  skillName: string;
  version: string;
  source: "user" | "model" | "app";
  arguments?: string;
  instructions: string;
}

export interface NativeAgentCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}
