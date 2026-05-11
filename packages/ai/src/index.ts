export * from './types.js'
export * from './errors.js'
export * from './namespacing.js'
export * from './embeddings.js'
export * from './rag.js'
export * from './memory.js'
export * from './agent-factory.js'
export * from './tools/index.js'
export { getLangfuseClient, withTrace, scoreLatency, type TraceArgs, type LangfuseTrace } from './langfuse.js'
export { dispatchAgent, type DispatchAgentArgs, type DispatchResult } from './dispatcher.js'
export {
  resolveCalcomConfig,
  type CalcomResolvedConfig,
  type CalcomClientBuilder,
} from './calcom-config.js'
export { chunkMarkdown, approxTokens, CHUNK_CHAR_LIMIT } from './kb-chunking.js'
export {
  createFactsExtractor,
  type FactsExtractor,
  type ExtractInput,
  type ExtractFactsOpts,
} from './patient-memory/extractor.js'
export {
  loadPatientFacts,
  upsertFacts,
  forgetFacts,
  touchFacts,
  type UpsertResult,
  type UpsertSourceIds,
} from './patient-memory/store.js'
export { buildPatientFactsContext } from './patient-memory/context.js'
export {
  ALLOWED_KEYS,
  MEDICAL_BLOCKLIST_RE,
  FactCategorySchema,
  ExtractedFactSchema,
  ExtractionOutputSchema,
  parseAiMemoryConfig,
  DEFAULT_AI_MEMORY_CONFIG,
  type FactCategory,
  type ExtractedFact,
  type PatientFact,
  type AiMemoryConfig,
} from './patient-memory/types.js'
export {
  parseDocument,
  KB_SUPPORTED_FORMATS,
  type ParseDocumentArgs,
  type ParseDocumentResult,
} from './kb-parser.js'
