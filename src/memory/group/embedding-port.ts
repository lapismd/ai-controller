export type EmbeddingPurpose = "document" | "query";

export interface EmbeddingProvider {
  readonly modelId: string;
  readonly modelRevision: string;
  embed(
    texts: readonly string[],
    purpose?: EmbeddingPurpose,
  ): Promise<number[][]>;
  close(): Promise<void>;
}
