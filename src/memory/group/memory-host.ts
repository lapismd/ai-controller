import type { CaptureBoundary } from "../../capture/boundary.js";
import type { EmbeddingProvider } from "./embedding-port.js";
import type { MemoryDefinition } from "./config.js";
import type { MemoryStorePort } from "./store-port.js";

export type ControllerMemoryHost = {
  store: MemoryStorePort;
  config: MemoryDefinition;
  capture: Pick<CaptureBoundary, "clean" | "close">;
  now: () => number;
  embedding?: EmbeddingProvider;
  embeddingQueue: Set<string>;
  embeddingDrain?: Promise<void>;
  embeddingStopped: boolean;
};
