import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BGE_SMALL_EN_V15_Q8 } from "./model.js";
import { embeddingInput, verifyModelFile } from "./native-runtime.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("native embedding runtime", () => {
  it("uses distinct BGE query and document inputs", () => {
    expect(embeddingInput(BGE_SMALL_EN_V15_Q8, "hello", "document"))
      .toBe("hello");
    expect(embeddingInput(BGE_SMALL_EN_V15_Q8, "hello", "query"))
      .toBe(`${BGE_SMALL_EN_V15_Q8.queryPrefix}hello`);
  });

  it("accepts verified files and deletes a corrupt cached model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "embedding-model-"));
    directories.push(directory);
    const path = join(directory, "model.gguf");
    const bytes = new TextEncoder().encode("verified model bytes");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path, bytes);

    await expect(
      verifyModelFile(path, checksum, new AbortController().signal),
    ).resolves.toBeUndefined();
    await expect(
      verifyModelFile(path, "0".repeat(64), new AbortController().signal),
    ).rejects.toThrow("checksum verification");
    await expect(access(path)).rejects.toThrow();
  });
});
