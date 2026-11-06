/**
 * Reader converters for the CycloneDX 2.0 document sections other than the
 * inventories: metadata, compositions, annotations, vulnerabilities,
 * citations and formulation. Each frozen spec is the allowlist of the
 * members 1.x carries; everything else is a loss. Every converted section
 * entry is kept as a shadow, so a read-then-render round trip restores the
 * 2.0 members the 1.x model has no field for while the entry is unchanged.
 */

import { isObjectRecord, reverseEnvironmentVars } from "./cyclonedx20Common.js";
import {
  ATTACHMENT_RULE,
  LICENSES_RULE,
  PROPERTIES_RULE,
  reverseContact,
  reverseEntity,
  reverseExternalReference,
} from "./cyclonedx20ReadCommon.js";
import {
  keepComponentShadow,
  readComponentEntry,
} from "./cyclonedx20ReadComponents.js";
import {
  addLoss,
  jsonPointer,
  listOf,
  objectOf,
  registerShadow,
  reverseFields,
  reverseList,
  reverseObject,
  withoutComponentShadows,
} from "./cyclonedx20ReadContext.js";
import {
  AGGREGATE_20_TO_1X,
  FORMULA_COMPONENT_REFS_PROPERTY,
  SCORE_METHODS_1X,
} from "./cyclonedx20Tables.js";

/** Read `original` with `spec` and keep it as a shadow of the result. */
function readShadowed(ctx, kind, original, pointer, spec) {
  const internal = withoutComponentShadows(ctx, () =>
    reverseObject(ctx, kind, original, pointer, spec),
  );
  if (internal !== undefined) {
    registerShadow(ctx, kind, internal, original);
  }
  return internal;
}

/** tools.components → the 1.x tools {components, services}. */
function reverseToolComponents(ctx, value, pointer) {
  const tools = {};
  reverseList(ctx, value, pointer, (_ctx, entry, entryPointer) => {
    const read = readComponentEntry(ctx, entry, entryPointer);
    if (read) {
      keepComponentShadow(ctx, read);
      (tools[read.isService ? "services" : "components"] ||= []).push(
        read.internal,
      );
    }
    return undefined;
  });
  return tools;
}

/** A `tools` member holding `{components}`. */
const TOOLS_RULE = objectOf("tools", {
  components: Object.freeze({ spread: true, convert: reverseToolComponents }),
});

const METADATA_SPEC = Object.freeze({
  timestamp: true,
  lifecycles: true,
  manufacturer: Object.freeze({ convert: reverseEntity }),
  authors: listOf(reverseContact),
  supplier: Object.freeze({ convert: reverseEntity }),
  licenses: LICENSES_RULE,
  distributionConstraints: true,
  properties: PROPERTIES_RULE,
});

/**
 * metadata → 1.x metadata without `component` (the inventory subject) and
 * `tools` (read separately, so each tool component has its own shadow).
 *
 * @param {object} ctx Reader context
 * @param {object} metadata 2.0 metadata
 * @returns {object} 1.x metadata
 */
export function readMetadata(ctx, metadata) {
  if (!isObjectRecord(metadata)) {
    return {};
  }
  const { tools, ...rest } = metadata;
  const internal = reverseFields(
    ctx,
    "metadata",
    rest,
    "/metadata",
    METADATA_SPEC,
  );
  registerShadow(ctx, "metadata", internal, rest);
  if (tools !== undefined) {
    const converted = TOOLS_RULE.convert(ctx, tools, "/metadata/tools");
    if (converted && Object.keys(converted).length) {
      internal.tools = converted;
    }
  }
  return internal;
}

/** One composition target; an inventory refId names the inventory subject. */
function compositionTarget(ctx, target, pointer, inventorySubjects) {
  if (!inventorySubjects.has(target)) {
    return target;
  }
  const subjectRef = inventorySubjects.get(target);
  if (subjectRef === undefined) {
    addLoss(ctx, pointer, "the inventory's subject has no refId for 1.x");
  }
  return subjectRef;
}

const COMPOSITION_KIND_FIELDS = Object.freeze({
  components: "assemblies",
  dependencies: "dependencies",
  vulnerabilities: "vulnerabilities",
});

/**
 * One composition → 1.x composition: kind `components` → `assemblies`,
 * `dependencies` and `vulnerabilities` keep their names, every target is
 * read. Other kinds and aggregates 1.x does not spell are losses.
 */
function readComposition(ctx, composition, pointer, inventorySubjects) {
  if (!isObjectRecord(composition)) {
    addLoss(ctx, pointer, "composition is not an object");
    return undefined;
  }
  const aggregate = Object.hasOwn(AGGREGATE_20_TO_1X, composition.aggregate)
    ? AGGREGATE_20_TO_1X[composition.aggregate]
    : undefined;
  const field =
    typeof composition.kind === "string" &&
    Object.hasOwn(COMPOSITION_KIND_FIELDS, composition.kind)
      ? COMPOSITION_KIND_FIELDS[composition.kind]
      : undefined;
  if (!aggregate || !field) {
    addLoss(
      ctx,
      pointer,
      aggregate
        ? `composition kind '${JSON.stringify(composition.kind)}' has no 1.x equivalent`
        : `composition aggregate '${composition.aggregate}' has no 1.x equivalent`,
    );
    // Kept for 2.0 output; the renderer appends it to the compositions.
    (ctx.carriedCompositions ||= []).push(composition);
    return undefined;
  }
  const internal = reverseFields(ctx, "composition", composition, pointer, {
    refId: "bom-ref",
    aggregate: Object.freeze({ convert: () => aggregate }),
    kind: Object.freeze({ convert: () => undefined }),
    targets: Object.freeze({
      to: field,
      convert: (_ctx, targets, targetsPointer) =>
        reverseList(ctx, targets, targetsPointer, (_c, target, targetPointer) =>
          compositionTarget(ctx, target, targetPointer, inventorySubjects),
        ),
    }),
  });
  registerShadow(ctx, "composition", internal, composition);
  return internal;
}

/**
 * compositions → 1.x compositions.
 *
 * @param {object} ctx Reader context
 * @param {Array} compositions 2.0 compositions
 * @param {Map<string, string|undefined>} inventorySubjects inventory refId →
 *   subject refId
 * @returns {Array|undefined} 1.x compositions
 */
export function readCompositions(ctx, compositions, inventorySubjects) {
  return reverseList(
    ctx,
    compositions,
    "/compositions",
    (_ctx, entry, pointer) =>
      readComposition(ctx, entry, pointer, inventorySubjects),
  );
}

/** annotator: an annotator component may be a reference to any component. */
function reverseAnnotator(ctx, value, pointer) {
  if (!isObjectRecord(value)) {
    addLoss(ctx, pointer, "annotator is not an object");
    return undefined;
  }
  return reverseFields(ctx, "annotator", value, pointer, {
    organization: Object.freeze({ convert: reverseEntity }),
    individual: Object.freeze({ convert: reverseContact }),
    component: Object.freeze({
      spread: true,
      convert: (_ctx, entry, entryPointer) => {
        const read = readComponentEntry(ctx, entry, entryPointer);
        if (!read) {
          return undefined;
        }
        return read.isService
          ? { service: read.internal }
          : { component: read.internal };
      },
    }),
  });
}

const ANNOTATION_SPEC = Object.freeze({
  refId: "bom-ref",
  subjects: true,
  annotator: Object.freeze({ convert: reverseAnnotator }),
  timestamp: true,
  text: true,
});

/** annotations → 1.x annotations. */
export function readAnnotations(ctx, annotations) {
  return reverseList(ctx, annotations, "/annotations", (_ctx, entry, pointer) =>
    readShadowed(ctx, "annotation", entry, pointer, ANNOTATION_SPEC),
  );
}

/** A CWE number from a weakness identifier value `CWE-<n>`. */
function cweNumber(value) {
  if (typeof value !== "string" || !value.startsWith("CWE-")) {
    return undefined;
  }
  const digits = value.slice(4);
  if (!digits.length || [...digits].some((char) => char < "0" || char > "9")) {
    return undefined;
  }
  return Number.parseInt(digits, 10);
}

/** One weakness (or reference) → its CWE numbers; the rest are losses. */
function weaknessCwes(ctx, entry, pointer) {
  let weakness = entry;
  let weaknessPointer = pointer;
  if (isObjectRecord(entry) && typeof entry.ref === "string") {
    const declared = (ctx.doc.definitions?.weaknesses || []).findIndex(
      (candidate) => isObjectRecord(candidate) && candidate.refId === entry.ref,
    );
    if (declared < 0) {
      addLoss(
        ctx,
        pointer,
        `weakness reference '${entry.ref}' could not be resolved`,
      );
      return [];
    }
    weakness = ctx.doc.definitions.weaknesses[declared];
    weaknessPointer = jsonPointer("/definitions/weaknesses", declared);
  }
  if (!isObjectRecord(weakness)) {
    addLoss(ctx, pointer, "weakness is not an object");
    return [];
  }
  const cwes = [];
  for (const [key, value] of Object.entries(weakness)) {
    if (key === "kind" && value === "flaw") {
      continue;
    }
    if (key !== "identifiers" || !Array.isArray(value)) {
      addLoss(
        ctx,
        jsonPointer(weaknessPointer, key),
        `weakness.${key} has no 1.x field`,
      );
      continue;
    }
    value.forEach((identifier, index) => {
      const cwe =
        identifier?.scheme === "cwe" ? cweNumber(identifier.value) : undefined;
      if (cwe === undefined) {
        addLoss(
          ctx,
          jsonPointer(weaknessPointer, key, index),
          "only CWE weakness identifiers have a 1.x field (cwes)",
        );
      } else {
        cwes.push(cwe);
      }
    });
  }
  return cwes;
}

/** weaknesses → the 1.x `cwes` numbers. */
function reverseWeaknesses(ctx, value, pointer) {
  const cwes = [];
  (Array.isArray(value) ? value : []).forEach((entry, index) => {
    cwes.push(...weaknessCwes(ctx, entry, jsonPointer(pointer, index)));
  });
  const unique = [...new Set(cwes)];
  return unique.length ? unique : undefined;
}

const RATING_SPEC = Object.freeze({
  source: objectOf("rating.source", { url: true, name: true }),
  score: true,
  severity: true,
  method: Object.freeze({
    convert: (ctx, value, pointer) => {
      if (SCORE_METHODS_1X.has(value)) {
        return value;
      }
      addLoss(ctx, pointer, "rating method is not a 1.x score method");
      return undefined;
    },
  }),
  vector: true,
  justification: true,
});

const VULNERABILITY_SPEC = Object.freeze({
  refId: "bom-ref",
  id: true,
  source: objectOf("vulnerability.source", { url: true, name: true }),
  references: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "vulnerability.reference", value, pointer, {
      id: true,
      source: objectOf("reference.source", { url: true, name: true }),
    }),
  ),
  ratings: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "rating", value, pointer, RATING_SPEC),
  ),
  weaknesses: Object.freeze({ to: "cwes", convert: reverseWeaknesses }),
  description: true,
  detail: true,
  recommendation: true,
  workaround: true,
  proofOfConcept: objectOf("proofOfConcept", {
    reproductionSteps: true,
    environment: true,
    supportingMaterial: listOf((ctx, value, pointer) =>
      ATTACHMENT_RULE.convert(ctx, value, pointer),
    ),
  }),
  advisories: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "advisory", value, pointer, { title: true, url: true }),
  ),
  created: true,
  published: true,
  updated: true,
  rejected: true,
  credits: objectOf("credits", {
    organizations: listOf(reverseEntity),
    individuals: listOf(reverseContact),
  }),
  tools: TOOLS_RULE,
  analysis: objectOf("analysis", {
    state: true,
    justification: true,
    response: true,
    detail: true,
    firstIssued: true,
    lastUpdated: true,
  }),
  affects: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "affects", value, pointer, {
      ref: true,
      versions: listOf((c, version, versionPointer) =>
        reverseObject(c, "affects.version", version, versionPointer, {
          version: true,
          range: true,
          status: true,
        }),
      ),
    }),
  ),
  properties: PROPERTIES_RULE,
});

/** vulnerabilities → 1.x vulnerabilities. */
export function readVulnerabilities(ctx, vulnerabilities) {
  return reverseList(
    ctx,
    vulnerabilities,
    "/vulnerabilities",
    (_ctx, entry, pointer) =>
      readShadowed(ctx, "vulnerability", entry, pointer, VULNERABILITY_SPEC),
  );
}

/** A 2.0 citation JSONPath expression → its 1.x form. */
export function reverseCitationExpression(expression) {
  if (typeof expression !== "string") {
    return expression;
  }
  if (expression === "$.inventories") {
    return "$.components";
  }
  for (const prefix of [
    "$.inventories[0].components",
    "$.definitions.components",
  ]) {
    if (expression.startsWith(prefix)) {
      return `$.components${expression.slice(prefix.length)}`;
    }
  }
  return expression;
}

const CITATION_SPEC = Object.freeze({
  refId: "bom-ref",
  pointers: true,
  expressions: Object.freeze({
    convert: (_ctx, value) =>
      Array.isArray(value) ? value.map(reverseCitationExpression) : value,
  }),
  timestamp: true,
  attributedTo: true,
  process: true,
  note: true,
});

/** citations → 1.x citations. */
export function readCitations(ctx, citations) {
  return reverseList(ctx, citations, "/citations", (_ctx, entry, pointer) =>
    readShadowed(ctx, "citation", entry, pointer, CITATION_SPEC),
  );
}

const RESOURCE_REFERENCE_SPEC = Object.freeze({
  ref: true,
  externalReference: Object.freeze({ convert: reverseExternalReference }),
});
const RESOURCE_RULE = objectOf("resourceReference", RESOURCE_REFERENCE_SPEC);
const RESOURCE_REFERENCES_RULE = listOf((ctx, value, pointer) =>
  RESOURCE_RULE.convert(ctx, value, pointer),
);
const ENVIRONMENT_VARS_RULE = Object.freeze({
  convert: (_ctx, value) => reverseEnvironmentVars(value),
});
const INPUT_SPEC = Object.freeze({
  source: RESOURCE_RULE,
  target: RESOURCE_RULE,
  resource: RESOURCE_RULE,
  parameters: true,
  environmentVars: ENVIRONMENT_VARS_RULE,
  data: ATTACHMENT_RULE,
  properties: PROPERTIES_RULE,
});
const OUTPUT_SPEC = Object.freeze({ type: true, ...INPUT_SPEC });
const IO_RULES = Object.freeze({
  inputs: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "input", value, pointer, INPUT_SPEC),
  ),
  outputs: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "output", value, pointer, OUTPUT_SPEC),
  ),
});
const DEPENDENCY_RULE = listOf((ctx, value, pointer) =>
  reverseObject(ctx, "dependency", value, pointer, {
    ref: true,
    dependsOn: true,
    provides: true,
  }),
);
const STEP_SPEC = Object.freeze({
  name: true,
  description: true,
  commands: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "command", value, pointer, {
      executed: true,
      properties: PROPERTIES_RULE,
    }),
  ),
  properties: PROPERTIES_RULE,
});
const WORKSPACE_SPEC = Object.freeze({
  refId: "bom-ref",
  uid: true,
  name: true,
  aliases: true,
  description: true,
  resourceReferences: RESOURCE_REFERENCES_RULE,
  accessMode: true,
  mountPath: true,
  managedDataType: true,
  volumeRequest: true,
  volume: true,
  properties: PROPERTIES_RULE,
});
const TRIGGER_SPEC = Object.freeze({
  refId: "bom-ref",
  uid: true,
  name: true,
  description: true,
  resourceReferences: RESOURCE_REFERENCES_RULE,
  type: true,
  event: objectOf("event", {
    uid: true,
    description: true,
    timeReceived: true,
    data: ATTACHMENT_RULE,
    source: RESOURCE_RULE,
    target: RESOURCE_RULE,
    properties: PROPERTIES_RULE,
  }),
  conditions: true,
  timeActivated: true,
  ...IO_RULES,
  properties: PROPERTIES_RULE,
});

/** workspaces: a workspace reference has no 1.x form. */
function reverseWorkspace(ctx, value, pointer) {
  if (isObjectRecord(value) && typeof value.ref === "string") {
    addLoss(ctx, pointer, "workspace reference has no 1.x form");
    return undefined;
  }
  return reverseObject(ctx, "workspace", value, pointer, WORKSPACE_SPEC);
}

const TASK_SPEC = Object.freeze({
  refId: "bom-ref",
  uid: true,
  name: true,
  description: true,
  resourceReferences: RESOURCE_REFERENCES_RULE,
  taskTypes: true,
  trigger: objectOf("trigger", TRIGGER_SPEC),
  steps: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "step", value, pointer, STEP_SPEC),
  ),
  ...IO_RULES,
  timeStart: true,
  timeEnd: true,
  workspaces: listOf(reverseWorkspace),
  runtimeTopology: DEPENDENCY_RULE,
  properties: PROPERTIES_RULE,
});
const WORKFLOW_SPEC = Object.freeze({
  ...TASK_SPEC,
  tasks: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "task", value, pointer, TASK_SPEC),
  ),
  taskDependencies: DEPENDENCY_RULE,
});
const FORMULA_SPEC = Object.freeze({
  refId: "bom-ref",
  workflows: listOf((ctx, value, pointer) =>
    reverseObject(ctx, "workflow", value, pointer, WORKFLOW_SPEC),
  ),
  properties: PROPERTIES_RULE,
});

/**
 * formulation → 1.x formulas without their components (the reader puts the
 * formula components back from definitions afterwards).
 *
 * @param {object} ctx Reader context
 * @param {Array} formulation 2.0 formulation
 * @returns {Array|undefined} 1.x formulas
 */
export function readFormulation(ctx, formulation) {
  return reverseList(
    ctx,
    formulation,
    "/formulation",
    (_ctx, entry, pointer) => {
      const formula = reverseObject(
        ctx,
        "formula",
        entry,
        pointer,
        FORMULA_SPEC,
      );
      const internal = formula || {};
      // The component list of a subject-less document's formula is read
      // into the formula's components (see formulaMembership in
      // cyclonedx20Read.js), not kept as a property.
      if (Array.isArray(internal.properties)) {
        internal.properties = internal.properties.filter(
          (property) => property?.name !== FORMULA_COMPONENT_REFS_PROPERTY,
        );
        if (!internal.properties.length) {
          delete internal.properties;
        }
      }
      registerShadow(ctx, "formula", internal, entry);
      return internal;
    },
  );
}
