export interface LocalEmbeddingModel {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly uri: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly dimensions: number;
  readonly contextSize: number;
  readonly queryPrefix: string;
}

const revision = "d32f8c040ea3b516330eeb75b72bcc2d3a780ab7";
const sha256 = "ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514";

export const BGE_SMALL_EN_V15_Q8: LocalEmbeddingModel = {
  modelId: "bge-small-en-v1.5-q8_0",
  modelRevision: `${revision}:sha256:${sha256}:bge-query-v1`,
  uri:
    `https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/${revision}/bge-small-en-v1.5-q8_0.gguf`,
  fileName: "bge-small-en-v1.5-q8_0.gguf",
  sha256,
  dimensions: 384,
  contextSize: 512,
  queryPrefix: "Represent this sentence for searching relevant passages: ",
};

export function localEmbeddingModel(modelId: string): LocalEmbeddingModel {
  if (modelId === BGE_SMALL_EN_V15_Q8.modelId) return BGE_SMALL_EN_V15_Q8;
  throw new Error(`Unsupported local embedding model: ${modelId}`);
}
