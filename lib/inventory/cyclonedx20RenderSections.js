/**
 * Render the CycloneDX 2.0 sections that sit beside the inventory:
 * compositions, annotations, citations, vulnerabilities and formulation.
 * Each converter restores an entry readCycloneDx20 kept as a shadow while
 * the entry is unchanged.
 */

import {
  clone,
  convertEnvironmentVars,
  copyDefined,
  countDrop,
  countUnmapped,
  isNonEmptyString,
  isObjectRecord,
  setDefined,
  takeShadow,
  uniqueByValue,
} from "./cyclonedx20Common.js";
import { toCommonContact, toCommonEntity } from "./cyclonedx20Parties.js";
import {
  convertAttachment,
  convertComponent,
  convertService,
  convertTools,
} from "./cyclonedx20RenderComponents.js";
import { AGGREGATE_1X_TO_20 } from "./cyclonedx20Tables.js";

/** A unique list of the non-empty string refs of a 1.x composition field. */
function compositionRefs(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter(isNonEmptyString))]
    : [];
}

/**
 * Map one 1.x composition onto 2.0 compositions, one per scope: `assemblies`
 * → kind `components` (the inventory when the list is only the subject),
 * `dependencies` → kind `dependencies`, `vulnerabilities` → kind
 * `vulnerabilities` (kind enum in
 * #/$defs/cyclonedx-composition-2.0/$defs/composition). A composition with no
 * scope describes the inventory, as cdxgen's autoCompositions emits it.
 */
function compositionsFor(composition, aggregate, inventory, stats) {
  const scoped = [];
  const assemblies = compositionRefs(composition.assemblies);
  if (assemblies.length) {
    const onlySubject =
      inventory.inventoryRefId &&
      assemblies.length === 1 &&
      assemblies[0] === inventory.subjectRef;
    scoped.push({
      kind: "components",
      aggregate,
      targets: onlySubject ? [inventory.inventoryRefId] : assemblies,
    });
  }
  for (const kind of ["dependencies", "vulnerabilities"]) {
    const targets = compositionRefs(composition[kind]);
    if (targets.length) {
      scoped.push({ kind, aggregate, targets });
    }
  }
  if (scoped.length) {
    return scoped;
  }
  if (inventory.inventoryRefId) {
    return [
      { kind: "components", aggregate, targets: [inventory.inventoryRefId] },
    ];
  }
  countDrop(stats, "composition (no target in a subject-less document)");
  return [];
}

/**
 * Render compositions (#/$defs/cyclonedx-composition-2.0/$defs/composition,
 * required `[kind, aggregate, targets]`). The composition's own 1.x
 * `bom-ref` (cdxgen sets it to the subject's bom-ref) is not carried, so it
 * cannot collide with the subject's refId.
 */
export function renderCompositions(compositions, inventory, carried, stats) {
  // Compositions a 2.0 read could not express in 1.x (licenses,
  // certifications or custom kinds) come back after the converted ones.
  const carriedCompositions = Array.isArray(carried) ? clone(carried) : [];
  if (
    (!Array.isArray(compositions) || !compositions.length) &&
    !carriedCompositions.length
  ) {
    return undefined;
  }
  const converted = [];
  for (const composition of Array.isArray(compositions) ? compositions : []) {
    const shadow = takeShadow(stats, "composition", composition);
    if (shadow) {
      converted.push(shadow);
      continue;
    }
    const aggregate =
      isObjectRecord(composition) &&
      typeof composition.aggregate === "string" &&
      Object.hasOwn(AGGREGATE_1X_TO_20, composition.aggregate)
        ? AGGREGATE_1X_TO_20[composition.aggregate]
        : undefined;
    if (!aggregate) {
      countDrop(stats, "composition (aggregate outside the 2.0 enum)");
      continue;
    }
    converted.push(
      ...compositionsFor(composition, aggregate, inventory, stats),
    );
    countUnmapped(
      stats,
      "composition",
      composition,
      new Set(["aggregate", "assemblies", "dependencies", "vulnerabilities"]),
    );
  }
  converted.push(...carriedCompositions);
  const unique = uniqueByValue(converted);
  return unique.length ? unique : undefined;
}

/**
 * Convert an annotator. 2.0 allows `organization`, `individual` or
 * `component` (#/$defs/cyclonedx-annotation-2.0/$defs/annotation/properties/annotator),
 * so a 1.x `service` annotator becomes a component of type `service`.
 */
function convertAnnotator(annotator, stats) {
  if (!isObjectRecord(annotator)) {
    return undefined;
  }
  if (isObjectRecord(annotator.component)) {
    return { component: convertComponent(annotator.component, stats) };
  }
  if (isObjectRecord(annotator.service)) {
    return { component: convertService(annotator.service, stats) };
  }
  if (isObjectRecord(annotator.organization)) {
    return { organization: toCommonEntity(annotator.organization, stats) };
  }
  const individual = toCommonContact(annotator.individual, stats);
  return individual ? { individual } : undefined;
}

/**
 * Render annotations (#/$defs/cyclonedx-annotation-2.0/$defs/annotation,
 * required `[subjects, annotator, timestamp, text]`). Subjects are checked
 * against the declared refIds once the whole document exists
 * (see resolveAnnotationSubjects).
 */
export function renderAnnotations(annotations, stats) {
  if (!Array.isArray(annotations) || !annotations.length) {
    return undefined;
  }
  const converted = [];
  for (const annotation of annotations) {
    if (!isObjectRecord(annotation)) {
      continue;
    }
    const shadow = takeShadow(stats, "annotation", annotation);
    if (shadow) {
      converted.push(shadow);
      continue;
    }
    const annotator = convertAnnotator(annotation.annotator, stats);
    if (!annotator) {
      countDrop(stats, "annotation (no annotator)");
      continue;
    }
    const entry = {};
    if (isNonEmptyString(annotation["bom-ref"])) {
      entry.refId = annotation["bom-ref"];
    }
    entry.subjects = (annotation.subjects || []).filter(isNonEmptyString);
    entry.annotator = annotator;
    entry.timestamp = annotation.timestamp;
    entry.text = annotation.text;
    if (annotation.signature !== undefined) {
      countDrop(stats, "annotation.signature");
    }
    converted.push(entry);
  }
  return converted.length ? converted : undefined;
}

/**
 * Rewrite a 1.x citation JSONPath expression to the 2.0 document shape. The
 * plain inventory statement path and component-targeting paths both start at
 * `$.components` in 1.x and move under inventories (or definitions, when the
 * document has no subject component).
 */
function convertCitationExpression(expression, usesInventory) {
  if (typeof expression !== "string") {
    return expression;
  }
  if (expression === "$.components") {
    return usesInventory ? "$.inventories" : "$.definitions.components";
  }
  if (expression.startsWith("$.components")) {
    return usesInventory
      ? `$.inventories[0].components${expression.slice("$.components".length)}`
      : `$.definitions.components${expression.slice("$.components".length)}`;
  }
  if (expression === "$.services") {
    return usesInventory
      ? "$.inventories[0].components[?(@.type=='service')]"
      : "$.definitions.components[?(@.type=='service')]";
  }
  return expression;
}

/**
 * Render citations (#/$defs/cyclonedx-citation-2.0/$defs/citation).
 * `attributedTo` is a refLinkType, so it names a declared object's refId; the
 * cdxgen tool's bom-ref becomes exactly that refId. A citation may carry
 * `attributedTo`, `process` or both, so only the ref rename and the
 * expression rewrite are targeted.
 */
export function renderCitations(citations, usesInventory, stats) {
  if (!Array.isArray(citations) || !citations.length) {
    return undefined;
  }
  return citations.filter(isObjectRecord).map((citation) => {
    const shadow = takeShadow(stats, "citation", citation);
    if (shadow) {
      return shadow;
    }
    const converted = clone(citation);
    if (converted["bom-ref"]) {
      converted.refId = converted["bom-ref"];
      delete converted["bom-ref"];
    }
    if (Array.isArray(converted.expressions)) {
      converted.expressions = converted.expressions.map((expression) =>
        convertCitationExpression(expression, usesInventory),
      );
    }
    return converted;
  });
}

/**
 * 1.x `cwes` numbers as 2.0 weaknesses
 * (#/$defs/cyclonedx-weakness-2.0/$defs/weakness, kind `flaw`, identifier
 * scheme `cwe` with the `CWE-<n>` value).
 */
function cwesToWeaknesses(cwes, stats) {
  const weaknesses = [];
  for (const cwe of Array.isArray(cwes) ? cwes : []) {
    if (Number.isInteger(cwe) && cwe >= 0) {
      weaknesses.push({
        kind: "flaw",
        identifiers: [{ scheme: "cwe", value: `CWE-${cwe}` }],
      });
    } else {
      countDrop(stats, "vulnerability.cwes (not a CWE number)");
    }
  }
  return uniqueByValue(weaknesses);
}

// 1.x vulnerability members whose 2.0 form is the same
// (#/$defs/cyclonedx-vulnerability-2.0/$defs/vulnerability).
const VULNERABILITY_COPY_FIELDS = [
  "id",
  "source",
  "references",
  "ratings",
  "description",
  "detail",
  "recommendation",
  "workaround",
  "advisories",
  "created",
  "published",
  "updated",
  "rejected",
  "analysis",
  "affects",
  "properties",
];
const VULNERABILITY_HANDLED_FIELDS = new Set([
  ...VULNERABILITY_COPY_FIELDS,
  "bom-ref",
  "cwes",
  "credits",
  "proofOfConcept",
  "tools",
]);

/** Credits: organizations and individuals take the 2.0 common shapes. */
function convertCredits(credits, stats) {
  if (!isObjectRecord(credits)) {
    countDrop(stats, "vulnerability.credits (not an object)");
    return undefined;
  }
  const converted = {};
  const organizations = (
    Array.isArray(credits.organizations) ? credits.organizations : []
  )
    .map((organization) => toCommonEntity(organization, stats))
    .filter((organization) => organization && Object.keys(organization).length);
  if (organizations.length) {
    converted.organizations = organizations;
  }
  const individuals = (
    Array.isArray(credits.individuals) ? credits.individuals : []
  )
    .map((individual) => toCommonContact(individual, stats))
    .filter(Boolean);
  if (individuals.length) {
    converted.individuals = individuals;
  }
  countUnmapped(
    stats,
    "vulnerability.credits",
    credits,
    new Set(["organizations", "individuals"]),
  );
  return Object.keys(converted).length ? converted : undefined;
}

/** Proof of concept: the supporting material is a list of attachments. */
function convertProofOfConcept(proofOfConcept, stats) {
  if (!isObjectRecord(proofOfConcept)) {
    countDrop(stats, "vulnerability.proofOfConcept (not an object)");
    return undefined;
  }
  const converted = {};
  copyDefined(converted, proofOfConcept, ["reproductionSteps", "environment"]);
  if (Array.isArray(proofOfConcept.supportingMaterial)) {
    const material = proofOfConcept.supportingMaterial
      .map((attachment) =>
        convertAttachment(
          attachment,
          stats,
          "vulnerability.proofOfConcept.supportingMaterial",
        ),
      )
      .filter(Boolean);
    if (material.length) {
      converted.supportingMaterial = material;
    }
  }
  countUnmapped(
    stats,
    "vulnerability.proofOfConcept",
    proofOfConcept,
    new Set(["reproductionSteps", "environment", "supportingMaterial"]),
  );
  return Object.keys(converted).length ? converted : undefined;
}

/**
 * Render vulnerabilities: `bom-ref` → `refId`, `cwes` → `weaknesses`, the
 * tools object, credits as 2.0 organizations and contacts and the proof of
 * concept's attachments. Members 2.0 has no field for are counted; `affects`
 * references are resolved once every refId is known (resolveAffectsRefs).
 */
export function renderVulnerabilities(vulnerabilities, stats) {
  if (!Array.isArray(vulnerabilities) || !vulnerabilities.length) {
    return undefined;
  }
  return vulnerabilities.map((vulnerability) => {
    if (!isObjectRecord(vulnerability)) {
      return clone(vulnerability);
    }
    const shadow = takeShadow(stats, "vulnerability", vulnerability);
    if (shadow) {
      return shadow;
    }
    const converted = {};
    if (isNonEmptyString(vulnerability["bom-ref"])) {
      converted.refId = vulnerability["bom-ref"];
    }
    for (const [key, value] of Object.entries(vulnerability)) {
      if (value === undefined || !VULNERABILITY_HANDLED_FIELDS.has(key)) {
        continue;
      }
      if (VULNERABILITY_COPY_FIELDS.includes(key)) {
        converted[key] = clone(value);
      } else if (key === "cwes") {
        const weaknesses = cwesToWeaknesses(value, stats);
        if (weaknesses.length) {
          converted.weaknesses = weaknesses;
        }
      } else if (key === "credits") {
        setDefined(converted, "credits", convertCredits(value, stats));
      } else if (key === "proofOfConcept") {
        setDefined(
          converted,
          "proofOfConcept",
          convertProofOfConcept(value, stats),
        );
      } else if (key === "tools") {
        setDefined(converted, "tools", convertTools(value, stats));
      }
    }
    countUnmapped(
      stats,
      "vulnerability",
      vulnerability,
      VULNERABILITY_HANDLED_FIELDS,
    );
    return converted;
  });
}

/** Convert formulation inputs/outputs, whose entries may carry env vars. */
function convertFormulationIo(entries, stats) {
  return entries.map((entry) => {
    const converted = clone(entry);
    if (isObjectRecord(converted) && converted.environmentVars !== undefined) {
      converted.environmentVars = convertEnvironmentVars(
        converted.environmentVars,
        stats,
      );
    }
    return converted;
  });
}

/**
 * formulation → workflows/tasks/triggers with refId renames. The 2.0 formula
 * allows only refId, properties and workflows
 * (#/$defs/cyclonedx-formulation-2.0/$defs/formula), so the 1.x
 * formula.components move to definitions.components (upstream's
 * valid-formulation-2.0.json declares them there too) and are collected in
 * `stats.formulaComponents`.
 */
export function convertFormulation(formulation, stats) {
  if (!Array.isArray(formulation)) {
    return clone(formulation);
  }
  const refIdSubjects = (entry) => {
    if (!isObjectRecord(entry)) {
      return clone(entry);
    }
    const converted = {};
    if (entry["bom-ref"]) {
      converted.refId = entry["bom-ref"];
    }
    for (const [key, value] of Object.entries(entry)) {
      if (key === "bom-ref") {
        continue;
      }
      if (key === "components" && Array.isArray(value)) {
        stats.formulaComponents.push(
          ...value.map((c) => convertComponent(c, stats)),
        );
      } else if (key === "services" && Array.isArray(value)) {
        stats.formulaComponents.push(
          ...value.map((s) => convertService(s, stats)),
        );
      } else if (FORMULATION_LIST_KEYS.has(key) && Array.isArray(value)) {
        converted[key] = value.map(refIdSubjects);
      } else if (key === "trigger" && isObjectRecord(value)) {
        converted.trigger = refIdSubjects(value);
      } else if (key === "environmentVars") {
        converted.environmentVars = convertEnvironmentVars(value, stats);
      } else if (
        (key === "inputs" || key === "outputs") &&
        Array.isArray(value)
      ) {
        converted[key] = convertFormulationIo(value, stats);
      } else {
        converted[key] = clone(value);
      }
    }
    return converted;
  };
  return formulation.map((formula, index) => {
    if (!isObjectRecord(formula)) {
      return clone(formula);
    }
    // A formula read from 2.0 is restored while unchanged; its components
    // still go to definitions. The refIds of each formula's components are
    // kept in stats.formulaMembership for a subject-less document (see
    // cyclonedx20Render.js).
    const start = stats.formulaComponents.length;
    const { components, services, ...own } = formula;
    const shadow = takeShadow(stats, "formula", own);
    let converted;
    if (shadow) {
      refIdSubjects({ components, services });
      converted = shadow;
    } else {
      converted = refIdSubjects(formula);
    }
    stats.formulaMembership[index] = stats.formulaComponents.slice(start);
    return converted;
  });
}

// Formulation members holding lists of objects that carry a bom-ref.
const FORMULATION_LIST_KEYS = Object.freeze(
  new Set(["workflows", "tasks", "triggers", "workspaces"]),
);
