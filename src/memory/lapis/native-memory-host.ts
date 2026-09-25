import type { MemoryCapture } from "./capture-port.js";
import type { MemoryDatabase } from "./database-port.js";
import type { EvidenceRepository } from "./evidence-port.js";
import type { MemoryRecordStore } from "./memory-record-store.js";
import type { MemoryConsolidationProvider } from "./types.js";

export type NativeMemoryServiceOptions = {
  capture?: MemoryCapture;
  now?: () => Date;
  yieldToApp?: () => Promise<void>;
  recordStore?: MemoryRecordStore;
  consolidationProvider?:
    | MemoryConsolidationProvider
    | (() => MemoryConsolidationProvider | undefined);
};

export type NativeMemoryHost = {
  repository: EvidenceRepository;
  database: MemoryDatabase;
  now: () => Date;
  yieldToApp: () => Promise<void>;
  recordStore: MemoryRecordStore;
  consolidationProvider?: NativeMemoryServiceOptions["consolidationProvider"];
};
