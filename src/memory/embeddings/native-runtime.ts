import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmbeddingPurpose } from "../group/embedding-port.js";
import type { LocalEmbeddingModel } from "./model.js";

export interface NativeEmbeddingSession {
  embed(
    texts: readonly string[],
    purpose: EmbeddingPurpose,
  ): Promise<number[][]>;
  close(): Promise<void>;
}

export interface NativeEmbeddingLoadOptions {
  model: LocalEmbeddingModel;
  cacheDir?: string;
  signal: AbortSignal;
}

export type NativeEmbeddingLoader = (
  options: NativeEmbeddingLoadOptions,
) => Promise<NativeEmbeddingSession>;

export function defaultEmbeddingCacheDir(env = process.env): string {
  return join(
    env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
    "lapismd",
    "embeddings",
  );
}

export const loadNativeEmbedding: NativeEmbeddingLoader = async (options) => {
  const { model: profile, signal } = options;
  const cacheDir = options.cacheDir ?? defaultEmbeddingCacheDir();
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  signal.throwIfAborted();

  if (process.platform === "darwin") {
    process.env.GGML_METAL_NO_RESIDENCY ??= "1";
  }
  // @ts-ignore Resolved by the server consumer through the optional peer.
  const native = await import("node-llama-cpp");
  const modelPath = await native.resolveModelFile(profile.uri, {
    directory: cacheDir,
    fileName: profile.fileName,
    download: "auto",
    verify: true,
    cli: false,
    parallel: 1,
    signal,
    deleteTempFileOnCancel: true,
  });
  await verifyModelFile(modelPath, profile.sha256, signal);

  let llama: Awaited<ReturnType<typeof native.getLlama>> | undefined;
  let loadedModel: Awaited<
    ReturnType<Awaited<ReturnType<typeof native.getLlama>>["loadModel"]>
  > | undefined;
  let context: Awaited<
    ReturnType<NonNullable<typeof loadedModel>["createEmbeddingContext"]>
  > | undefined;
  try {
    llama = await native.getLlama({
      build: "never",
      skipDownload: true,
      gpu: "auto",
      progressLogs: false,
      logLevel: native.LlamaLogLevel.error,
    });
    loadedModel = await llama.loadModel({ modelPath });
    context = await loadedModel.createEmbeddingContext({
      contextSize: profile.contextSize,
      createSignal: signal,
    });
  } catch (error) {
    await context?.dispose().catch(() => undefined);
    await loadedModel?.dispose().catch(() => undefined);
    await llama?.dispose().catch(() => undefined);
    throw error;
  }

  const activeContext = context;
  const activeModel = loadedModel;
  const activeLlama = llama;
  return {
    async embed(texts, purpose) {
      const vectors: number[][] = [];
      for (const value of texts) {
        signal.throwIfAborted();
        const text = embeddingInput(profile, value, purpose);
        const tokens = activeModel.tokenize(text);
        const input = tokens.length > profile.contextSize
          ? activeModel.detokenize(tokens.slice(0, profile.contextSize))
          : text;
        const embedding = await activeContext.getEmbeddingFor(input);
        vectors.push(Array.from(embedding.vector));
      }
      return vectors;
    },
    async close() {
      await activeContext.dispose().catch(() => undefined);
      await activeModel.dispose().catch(() => undefined);
      await activeLlama.dispose().catch(() => undefined);
    },
  };
};

async function fileSha256(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    signal.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function embeddingInput(
  profile: LocalEmbeddingModel,
  text: string,
  purpose: EmbeddingPurpose,
): string {
  return purpose === "query" ? `${profile.queryPrefix}${text}` : text;
}

export async function verifyModelFile(
  path: string,
  expectedSha256: string,
  signal: AbortSignal,
): Promise<void> {
  const actualHash = await fileSha256(path, signal);
  if (actualHash === expectedSha256) return;
  await rm(path, { force: true });
  throw new Error("Downloaded embedding model failed checksum verification");
}
