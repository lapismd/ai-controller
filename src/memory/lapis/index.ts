export {
  NativeMemoryService,
  __memoryServiceInternals,
} from "./native-memory-service.js";
export type { NativeMemoryServiceOptions } from "./native-memory-service.js";
export { MemoryMaintenanceScheduler } from "./memory-scheduler.js";
export type { MemorySchedulerOptions } from "./memory-scheduler.js";
export {
  InMemoryMemoryRecordStore,
  MemoryRecordConflictError,
  serializeMemoryRecord,
  validateMemoryRecord,
  recordPath,
  recordDirectory,
  memoryRoot,
  __memoryRecordStoreInternals,
} from "./memory-record-store.js";
export type {
  MemoryRecordStore,
  MemoryRecordWriteOptions,
  StoredMemoryRecord,
} from "./memory-record-store.js";
export {
  extractDeterministicCandidates,
  isSecretBearingMemoryText,
  __candidateExtractorInternals,
} from "./candidate-extractor.js";
export type { CandidateExtractionResult, CandidateExtractionOptions } from "./candidate-extractor.js";
export {
  canonicalJson,
  deterministicMemoryId,
  sha256Text,
  transcriptEntryHash,
} from "./hashes.js";
export * from "./types.js";
export * from "./paths.js";
export type { MemoryDatabase } from "./database-port.js";
export type { EvidenceRepository } from "./evidence-port.js";

export { RuntimeMemoryConsolidationProvider } from "./runtime-consolidation-provider.js";
export type {
  RuntimeConsolidationConfiguration,
  RuntimeMemoryConsolidationProviderOptions,
} from "./runtime-consolidation-provider.js";
