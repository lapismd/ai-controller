export interface MemoryEmbeddingDefinition {
  enabled: boolean;
  modelId: string;
  cacheDir?: string;
  idleTimeoutMs?: number;
}

export interface MemoryGenerationDefinition {
  enabled: boolean;
  hostId: string;
  runtimeAgent: string;
  model: string;
  thinking?: "off" | "low" | "medium" | "high";
}

export interface MemoryDefinition {
  enabled: boolean;
  historyRetentionDays: number;
  backfillDays: number;
  embeddings: MemoryEmbeddingDefinition;
  generation?: MemoryGenerationDefinition;
}
