/**
 * Render the 1.x-shaped internal model as a CycloneDX 2.0 document: the
 * document sections, reference integrity and the render report. The public
 * entry points are re-exported from cyclonedx20.js.
 */

import { thoughtLog } from "../core/logger.js";
import {
  clone,
  collectDeclaredRefIds,
  countDrop,
  countRewrite,
  createRenderStats,
  isBomLink,
  isNonEmptyString,
  isObjectRecord,
  referencesParty,
  setDefined,
  takeShadow,
} from "./cyclonedx20Common.js";
import { appendDerivedSections } from "./cyclonedx20Derived.js";
import { toCommonContact, toCommonEntity } from "./cyclonedx20Parties.js";
import {
  convertComponent,
  convertLicenses,
  convertService,
  convertTools,
} from "./cyclonedx20RenderComponents.js";
import {
  derivedPartyDeclarations,
  identityClaimContext,
} from "./cyclonedx20RenderEvidence.js";
import {
  convertFormulation,
  renderAnnotations,
  renderCitations,
  renderCompositions,
  renderVulnerabilities,
} from "./cyclonedx20RenderSections.js";
import {
  CDX20_INTERNAL_SECTIONS_KEY,
  COMPONENT_ENTRY_ARRAY_KEYS,
} from "./cyclonedx20Tables.js";

/**
 * Render metadata (#/$defs/cyclonedx-metadata-2.0/$defs/metadata). Every 1.x
 * field except `component` (the inventory subject) and the deprecated
 * `manufacture` has a 2.0 home; organizations and contacts rename `bom-ref`
 * to `refId`. Key order follows the input.
 */
function renderMetadata(metadata, stats) {
  if (!isObjectRecord(metadata)) {
    return undefined;
  }
  const { component: _component, tools, ...rest } = metadata;
  const shadow = takeShadow(stats, "metadata", rest);
  if (shadow) {
    const restoredTools = convertTools(tools, stats);
    if (restoredTools) {
      shadow.tools = restoredTools;
    }
    return Object.keys(shadow).length ? shadow : undefined;
  }
  const converted = {};
  for (const [key, value] of Object.entries(metadata)) {
    // 1.x builders sometimes leave explicit `undefined` members (addMetadata's
    // `supplier: undefined`); JSON drops them, so the render does too.
    if (value === undefined || key === "component") {
      continue;
    }
    if (key === "tools") {
      const tools = convertTools(value, stats);
      if (tools) {
        converted.tools = tools;
      }
    } else if (key === "supplier" || key === "manufacturer") {
      const entity = toCommonEntity(value, stats);
      if (entity) {
        converted[key] = entity;
      }
    } else if (key === "authors" && Array.isArray(value)) {
      const authors = value
        .map((contact) => toCommonContact(contact, stats))
        .filter(Boolean);
      if (authors.length) {
        converted.authors = authors;
      }
    } else if (key === "licenses") {
      converted.licenses = convertLicenses(value) ?? clone(value);
    } else if (
      [
        "timestamp",
        "lifecycles",
        "distributionConstraints",
        "properties",
      ].includes(key)
    ) {
      converted[key] = clone(value);
    } else {
      countDrop(stats, `metadata.${key}`);
    }
  }
  return Object.keys(converted).length ? converted : undefined;
}

/**
 * Render the inventory
 * (#/$defs/cyclonedx-component-2.0/$defs/inventory, required
 * `[subject, components]`). Root components and services become the
 * inventory's components; without a subject component (cbom/aibom style) the
 * entries are returned for the definitions registry instead.
 */
function renderInventory(source, stats) {
  const subject = isObjectRecord(source.metadata?.component)
    ? source.metadata.component
    : undefined;
  const subjectRef = isNonEmptyString(subject?.["bom-ref"])
    ? subject["bom-ref"]
    : undefined;
  const context = {
    hasSubject: Boolean(subject),
    subjectRef,
    inventoryRefId: subjectRef ? `inventory-${subjectRef}` : undefined,
    subjectlessEntries: [],
  };
  const entries = [
    ...(Array.isArray(source.components)
      ? source.components.map((c) => convertComponent(c, stats))
      : []),
    ...(Array.isArray(source.services)
      ? source.services.map((s) => convertService(s, stats))
      : []),
  ];
  if (!subject) {
    context.subjectlessEntries = entries;
    return context;
  }
  // A document read from 2.0 keeps its inventory's own members (refId,
  // properties, signatures); the renderer otherwise derives the refId.
  const own = takeShadow(stats, "inventory", subject);
  if (own) {
    context.inventoryRefId = isNonEmptyString(own.refId)
      ? own.refId
      : undefined;
  }
  const inventory = {
    subject: convertComponent(subject, stats),
    components: entries,
  };
  if (context.inventoryRefId) {
    inventory.refId = context.inventoryRefId;
  }
  if (own) {
    const { refId: _refId, ...members } = own;
    Object.assign(inventory, members);
  }
  context.inventories = [inventory];
  return context;
}

/**
 * Render dependencies (#/$defs/cyclonedx-dependency-2.0/$defs/dependency,
 * required `[ref]`); refs are refIds now, values unchanged. An empty
 * `dependsOn` says the component has no dependencies (a missing one says
 * nothing), so it is kept.
 */
function renderDependencies(dependencies) {
  if (!Array.isArray(dependencies) || !dependencies.length) {
    return undefined;
  }
  return dependencies
    .filter((dep) => isObjectRecord(dep) && typeof dep.ref === "string")
    .map((dep) => {
      const converted = { ref: dep.ref };
      if (Array.isArray(dep.dependsOn)) {
        converted.dependsOn = [...dep.dependsOn];
      }
      if (Array.isArray(dep.provides)) {
        converted.provides = [...dep.provides];
      }
      return converted;
    });
}

/**
 * Assemble the renderer's own definitions
 * (#/$defs/cyclonedx-definition-2.0/$defs/definitions): converted 1.x
 * definitions, the entries of a subject-less document (the way upstream's
 * valid-component-evidence-assertion-2.0.json declares its components) and
 * the formula components the 2.0 formula has no field for, after the
 * components a 2.0 read kept for 2.0 output. A subject-less document's
 * formula components are counted and dropped instead: they would share
 * definitions with the SBOM components, and 2.0 records no formula
 * membership. 2.0 definitions have no `services`, so 1.x definition
 * services become service components.
 */
function renderOwnDefinitions(
  sourceDefinitions,
  { subjectlessEntries, hasSubject },
  carriedComponents,
  stats,
) {
  const definitions = isObjectRecord(sourceDefinitions)
    ? clone(sourceDefinitions)
    : {};
  // Definitions components a 2.0 read kept for 2.0 output come first, the
  // order the reader expects (see cyclonedx20Read.js).
  const components = [
    ...(Array.isArray(carriedComponents) ? clone(carriedComponents) : []),
    ...(Array.isArray(definitions.components)
      ? definitions.components.map((c) => convertComponent(c, stats))
      : []),
  ];
  if (Array.isArray(definitions.services)) {
    components.push(
      ...definitions.services.map((s) => convertService(s, stats)),
    );
  }
  delete definitions.services;
  components.push(...subjectlessEntries);
  if (hasSubject) {
    components.push(...stats.formulaComponents);
  } else if (stats.formulaComponents.length) {
    // Without an inventory the subject-less entries live here too, and 2.0
    // records no formula membership, so a reader could not tell formula
    // components from SBOM components (see cyclonedx20Read.js).
    countDrop(
      stats,
      "formula component (subject-less document: no 2.0 place keeps it apart from the SBOM)",
      stats.formulaComponents.length,
    );
  }
  // An empty list read from 2.0 stays, so the round trip keeps it.
  if (components.length || Array.isArray(carriedComponents)) {
    definitions.components = components;
  } else {
    delete definitions.components;
  }
  return definitions;
}

/**
 * Make every refId unique (the 2.0 refIdType rule "Every `refId` shall be
 * unique within the document", which JSON Schema cannot check). Walks the
 * rendered sections in document order; a later component entry with an
 * already declared refId becomes a componentReference `{ref}`
 * (#/$defs/cyclonedx-component-2.0/$defs/componentReference), as does an
 * annotator component. Other duplicates have no reference form and are
 * counted.
 */
function dedupeRefIds(roots, stats) {
  const seen = new Set();
  const visit = (node, isEntrySlot, ownKey) => {
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) {
        node[index] = visit(node[index], isEntrySlot, ownKey);
      }
      return node;
    }
    if (!isObjectRecord(node)) {
      return node;
    }
    if (typeof node.refId === "string") {
      if (!seen.has(node.refId)) {
        seen.add(node.refId);
      } else if (isEntrySlot) {
        countRewrite(stats, "duplicate refId (rendered as a reference)");
        return { ref: node.refId };
      } else {
        // Outside a component-entry slot there is no reference form, and
        // some refIds are required (formula, workflow, task), so the
        // duplicate stays and is counted. Only input that already repeats a
        // bom-ref reaches this branch.
        countRewrite(stats, "duplicate refId (kept: no reference form)");
      }
    }
    for (const [key, value] of Object.entries(node)) {
      // A repeated party becomes a partyReference
      // (#/$defs/cyclonedx-party-2.0/$defs/partyReference) the same way.
      const entrySlot =
        ((COMPONENT_ENTRY_ARRAY_KEYS.has(key) || key === "parties") &&
          Array.isArray(value)) ||
        key === "subject" ||
        (key === "component" && ownKey === "annotator");
      node[key] = visit(value, entrySlot, key);
    }
    return node;
  };
  for (const root of roots) {
    visit(root, false, undefined);
  }
}

/**
 * Annotation subjects are elementLinks
 * (#/$defs/cyclonedx-common-2.0/$defs/elementLink): a refId declared in this
 * document or a BOM-Link into another one. A 1.x subject naming the document
 * serial number (cdxgen's own summary annotation) is retargeted to the
 * inventory; any other subject that resolves to nothing is dropped. An
 * annotation may end with no subjects, which the schema allows.
 */
function resolveAnnotationSubjects(annotations, context, declared, stats) {
  for (const annotation of annotations || []) {
    const subjects = [];
    for (const subject of annotation.subjects) {
      if (declared.has(subject) || isBomLink(subject)) {
        subjects.push(subject);
      } else if (
        subject === context.serialNumber &&
        context.inventoryRefId &&
        declared.has(context.inventoryRefId)
      ) {
        countRewrite(stats, "annotation subject (serial number → inventory)");
        subjects.push(context.inventoryRefId);
      } else {
        countDrop(stats, "annotation subject (undeclared)");
      }
    }
    annotation.subjects = [...new Set(subjects)];
  }
}

/** Drop composition targets that resolve to nothing, then empty entries. */
function resolveCompositionTargets(compositions, declared, stats) {
  if (!compositions) {
    return undefined;
  }
  const kept = [];
  for (const composition of compositions) {
    composition.targets = composition.targets.filter((target) => {
      const resolves = declared.has(target) || isBomLink(target);
      if (!resolves) {
        countDrop(stats, "composition target (undeclared)");
      }
      return resolves;
    });
    if (composition.targets.length) {
      kept.push(composition);
    } else {
      countDrop(stats, "composition (no declared target)");
    }
  }
  return kept.length ? kept : undefined;
}

/**
 * Declared parties: the document's own and carried parties, then each
 * derived party (see derivedPartyDeclarations: the cdxgen party, and the
 * party of the tool asserting the identifiers of another tool's BOM) that is
 * not declared yet and that something in the finished document references
 * (identifiers it asserts, identity evidence it is the asserter of). Each is
 * declared at most once.
 */
function renderParties(ownParties, carriedParties, document, declared, stats) {
  const parties = [
    ...(Array.isArray(ownParties) ? ownParties : []),
    ...carriedParties,
  ];
  for (const party of derivedPartyDeclarations(stats.claims, declared)) {
    if (
      referencesParty(document, party.refId) &&
      !parties.some((candidate) => candidate?.refId === party.refId)
    ) {
      parties.push(party);
    }
  }
  return parties.length ? parties : undefined;
}

/** Root required members (#/$defs properties specFormat, specVersion). */
function renderDocumentHeader(source) {
  const out = {};
  // A document read from 2.0 carries its own `$schema`, `$comment` and
  // `ext:` extension members.
  const root = source[CDX20_INTERNAL_SECTIONS_KEY]?.root;
  if (isObjectRecord(root) && root.$schema !== undefined) {
    out.$schema = root.$schema;
  } else if (source.$schema !== undefined) {
    out.$schema = source.$schema;
  }
  for (const [key, value] of Object.entries(isObjectRecord(root) ? root : {})) {
    if (key !== "$schema") {
      out[key] = clone(value);
    }
  }
  out.specFormat = "CycloneDX";
  out.specVersion = "2.0";
  if (source.serialNumber !== undefined) {
    out.serialNumber = source.serialNumber;
  }
  if (source.version !== undefined) {
    out.version = source.version;
  }
  return out;
}

// Keys of the internal sections object that are not document sections.
const NON_SECTION_KEYS = Object.freeze(
  new Set([
    "definitions",
    "definitionsParties",
    "root",
    "shadows",
    "compositions",
  ]),
);

/** Copy the carried 2.0-only sections, except the definitions parts. */
function renderCarriedSections(out, carried) {
  for (const [section, value] of Object.entries(carried)) {
    if (!NON_SECTION_KEYS.has(section)) {
      out[section] = clone(value);
    }
  }
}

/**
 * Render the 1.x-shaped internal model as a CycloneDX 2.0 document and report
 * what could not be carried. Pure: the input is never mutated and the output
 * shares no objects with it. Deterministic: the same input renders to the
 * same JSON.
 *
 * @param {object} internalBom BOM in the 1.x shape
 * @param {{hardwareMapper?: Function, hardwareOptions?: {includeSensitiveIdentifiers?: boolean, identifierPolicy?: string}}} [context]
 *   What the render may use besides the model: `hardwareMapper` is the
 *   optional toCdx20HardwareComponent of @cdxgen/cdx-hbom and
 *   `hardwareOptions` its identifier options (see hbomLoader.js:
 *   hardwareRenderContext and cyclonedx20RenderHardware.js). The output
 *   depends only on the model and this context.
 * @returns {{bomJson: object, report: {drops: Object<string, number>, rewrites: Object<string, number>, customSchemes: string[], droppedMethods: Array<{reason: string, technique: string}>}}}
 *   The 2.0 document, the counts of values the render could not carry
 *   (`drops`) and of values it rewrote without losing data (`rewrites`), by
 *   label
 */
export function renderCycloneDx20WithReport(internalBom, context = {}) {
  const source = isObjectRecord(internalBom) ? internalBom : {};
  const stats = createRenderStats(
    source[CDX20_INTERNAL_SECTIONS_KEY]?.shadows,
    identityClaimContext(source),
  );
  if (typeof context?.hardwareMapper === "function") {
    stats.hardwareMapper = context.hardwareMapper;
    stats.hardwareOptions = isObjectRecord(context.hardwareOptions)
      ? { ...context.hardwareOptions }
      : {};
  }
  const { out, inventory, definitions } = renderOwnSections(source, stats);
  dedupeRefIds(
    [
      out.metadata,
      out.inventories,
      out.annotations,
      out.formulation,
      out.citations,
      out.vulnerabilities,
      definitions,
    ],
    stats,
  );
  finalizeDocument(out, source, inventory, definitions, stats);
  logRenderStats(stats);
  return { bomJson: out, report: buildRenderReport(stats) };
}

/**
 * Render every section the 1.x model has, in document order. Definitions
 * are returned separately: they are merged with the carried 2.0 sections
 * last.
 */
function renderOwnSections(source, stats) {
  const out = renderDocumentHeader(source);
  setDefined(out, "metadata", renderMetadata(source.metadata, stats));
  const inventory = renderInventory(source, stats);
  setDefined(out, "inventories", inventory.inventories);
  setDefined(out, "dependencies", renderDependencies(source.dependencies));
  setDefined(
    out,
    "compositions",
    renderCompositions(
      source.compositions,
      inventory,
      source[CDX20_INTERNAL_SECTIONS_KEY]?.compositions,
      stats,
    ),
  );
  setDefined(out, "annotations", renderAnnotations(source.annotations, stats));
  if (source.formulation !== undefined) {
    out.formulation = convertFormulation(source.formulation, stats);
  }
  // After the formulation, which collects the formula components.
  const definitions = renderOwnDefinitions(
    source.definitions,
    inventory,
    source[CDX20_INTERNAL_SECTIONS_KEY]?.definitions?.components,
    stats,
  );
  setDefined(
    out,
    "citations",
    renderCitations(source.citations, inventory.hasSubject, stats),
  );
  setDefined(
    out,
    "vulnerabilities",
    renderVulnerabilities(source.vulnerabilities, stats),
  );
  setDefined(out, "properties", clone(source.properties));
  setDefined(out, "externalReferences", clone(source.externalReferences));
  return { out, inventory, definitions };
}

/**
 * Add the carried 2.0-only sections and the derived ones (post-quantum risks,
 * agent parties and blueprint, see cyclonedx20Derived.js), resolve
 * annotation subjects and composition targets against every declared refId,
 * and declare the parties. A carried `definitions` object merges with the
 * freshly assembled one so a round trip keeps both; carried parties append
 * to the declared parties.
 */
function finalizeDocument(out, source, inventory, definitions, stats) {
  const carried = isObjectRecord(source[CDX20_INTERNAL_SECTIONS_KEY])
    ? source[CDX20_INTERNAL_SECTIONS_KEY]
    : {};
  renderCarriedSections(out, carried);
  const ownParties = definitions.parties;
  delete definitions.parties;
  // The carried definitions components were merged in renderOwnSections, so
  // dedupeRefIds saw them.
  const { components: _carriedComponents, ...carriedDefinitions } =
    isObjectRecord(carried.definitions) ? carried.definitions : {};
  const mergedDefinitions = {
    ...clone(carriedDefinitions),
    ...definitions,
  };
  const carriedParties = appendDerivedSections(
    out,
    Array.isArray(carried.definitionsParties)
      ? clone(carried.definitionsParties)
      : [],
    source,
  );
  const declared = collectDeclaredRefIds([
    out,
    mergedDefinitions,
    ownParties,
    carriedParties,
  ]);
  resolveAnnotationSubjects(
    out.annotations,
    { ...inventory, serialNumber: source.serialNumber },
    declared,
    stats,
  );
  const compositions = resolveCompositionTargets(
    out.compositions,
    declared,
    stats,
  );
  if (compositions) {
    out.compositions = compositions;
  } else {
    delete out.compositions;
  }
  setDefined(
    mergedDefinitions,
    "parties",
    renderParties(
      ownParties,
      carriedParties,
      [out, mergedDefinitions],
      declared,
      stats,
    ),
  );
  if (Object.keys(mergedDefinitions).length) {
    out.definitions = mergedDefinitions;
  }
  delete out[CDX20_INTERNAL_SECTIONS_KEY];
}

/**
 * Render the 1.x-shaped internal model as a CycloneDX 2.0 document. Pure: the
 * input is never mutated and the output shares no objects with it. What the
 * render could not carry is logged through thoughtLog; use
 * renderCycloneDx20WithReport for the counts.
 *
 * @param {object} internalBom BOM in the 1.x shape
 * @param {object} [context] See renderCycloneDx20WithReport
 * @returns {object} BOM in the 2.0 shape
 */
export function renderCycloneDx20(internalBom, context = {}) {
  return renderCycloneDx20WithReport(internalBom, context).bomJson;
}

/** The render counters as a plain, sorted, serializable report. */
function buildRenderReport(stats) {
  const drops = {};
  for (const label of Object.keys(stats.drops).sort()) {
    drops[label] = stats.drops[label];
  }
  const rewrites = {};
  for (const label of Object.keys(stats.rewrites).sort()) {
    rewrites[label] = stats.rewrites[label];
  }
  return {
    drops,
    rewrites,
    customSchemes: [...stats.customSchemes].sort(),
    droppedMethods: stats.droppedMethods.map((method) => ({ ...method })),
  };
}

function logRenderStats(stats) {
  if (stats.droppedMethods.length) {
    thoughtLog(
      `CycloneDX 2.0 render dropped ${stats.droppedMethods.length} identity method(s): ` +
        JSON.stringify(stats.droppedMethods.slice(0, 10)),
    );
  }
  if (stats.customSchemes.size) {
    thoughtLog(
      `CycloneDX 2.0 render used custom identity schemes: ${[...stats.customSchemes].join(", ")}`,
    );
  }
  for (const [kind, counts] of [
    ["could not carry", stats.drops],
    ["rewrote", stats.rewrites],
  ]) {
    const labels = Object.keys(counts).sort();
    if (labels.length) {
      thoughtLog(
        `CycloneDX 2.0 render ${kind}: ${labels
          .map((label) => `${label} ×${counts[label]}`)
          .join(", ")}`,
      );
    }
  }
}
