export * from "./schema.js";
export {
  type SuiteMeta,
  type SummaryMeta,
  buildSummary,
  fromPlaywrightReport,
  fromVitestReport,
  outcomeFromCounts,
} from "./aggregate.js";
export {
  type VerifySummaryV1,
  parseSummary,
  upgradeV1,
  verifySummaryV1Schema,
} from "./migrate.js";
export { type PiiFinding, type PiiKind, assertPiiFree, findPii } from "./pii-guard.js";
