export * from "./schema.js";
export {
  type SuiteMeta,
  type SummaryMeta,
  buildSummary,
  fromPlaywrightReport,
  fromVitestReport,
  outcomeFromTests,
} from "./aggregate.js";
// parseSummary is the only migration VALUE that is package API; upgradeV1 and
// verifySummaryV1Schema stay internal to migrate.ts (its own tests import them
// directly). The v1 TYPE is exported because verify-site's fixtures are
// deliberately v1 and should be typed as such — a type is not a runtime contract.
export { type VerifySummaryV1, parseSummary } from "./migrate.js";
export { type PiiFinding, type PiiKind, assertPiiFree, findPii } from "./pii-guard.js";
export {
  EVIDENCE_SCHEMA,
  type EvidenceStep,
  type JourneyEvidence,
  JOURNEY_SPEC_FILES,
  type JourneyRecord,
  journeyEvidenceSchema,
  parseEvidence,
  parseWalkthrough,
  STILL_MAX_HEIGHT_PX,
  type StillRecord,
  WALKTHROUGH_SCHEMA,
  type WalkthroughEvidence,
  type WalkthroughJourney,
} from "./evidence.js";
