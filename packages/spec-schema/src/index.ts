export * from "./canonical-json.js";
export * from "./hash.js";
export * from "./problem.js";
export * from "./identity.js";
export * from "./blocks.js";
export * from "./block-props.js";
export * from "./validate.js";
export * from "./defaults.js";
export { SCHEMA_BASE, DIALECT } from "./schemas/common.js";
export {
  siteSpecSchema,
  specEnvelopeSchema,
  compileRequestSchema,
  buildRequestSchema,
  buildResultSchema,
  batchJobSchema,
  batchResultSchema,
  allSchemas,
  SPEC_VERSION_ID,
} from "./schemas/index.js";

export const SPEC_SCHEMA_VERSION = "1.0.0";
export const SPEC_SCHEMA_MAJOR = "1";
