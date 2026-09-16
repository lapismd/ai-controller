export interface EmbeddingProvider {
  readonly modelId: string;
  readonly modelRevision: string;
  embed(texts: readonly string[]): Promise<number[][]>;
  close(): Promise<void>;
}
