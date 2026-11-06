/**
 * Read a CycloneDX 2.0 document into the 1.x-shaped internal model. The
 * public entry point is re-exported from cyclonedx20.js.
 *
 * Where definitions.components entries go (2.0 records no membership, so the
 * rule is fixed and deterministic, applied in document order):
 *
 * 0. An entry whose refId a formula lists in its
 *    `cdx:formulation:componentRefs` property (a JSON array of refIds, which
 *    renderCycloneDx20 writes for a subject-less document) is a component of
 *    every formula that lists it.
 * 1. An entry whose refId a formula references (a `ref` member, such as a
 *    resource reference, anywhere in its tree) is a component of the first
 *    such formula. Other strings that happen to equal the refId, such as a
 *    task type, do not count.
 * 2. In a document with inventories, an entry a componentReference the
 *    reader resolves points to (from an inventory, a tool, an annotator, a
 *    vulnerability or another definitions component) stays in definitions
 *    (kept for 2.0 output); its content reaches 1.x through the referencing
 *    entries.
 * 3. In a document with inventories, any other entry is a formula component
 *    when the document has a formulation (the renderer moves 1.x
 *    formula.components there), and otherwise stays in definitions with a
 *    loss: 1.x has no home for it.
 * 4. In a document without inventories (the renderer puts a subject-less
 *    document's components there), any other entry is a root component.
 *    Entries without a refId follow the same rules and are never dropped.
 * 5. Before all of these, an entry whose type 1.x does not have (`material`)
 *    stays in definitions with a loss.
 */

import { isDeepStrictEqual } from "node:util";

import {
  clone,
  collectDeclaredRefIds,
  isNonEmptyString,
  isObjectRecord,
  referencesParty,
} from "./cyclonedx20Common.js";
import {
  deriveCycloneDx20Sections,
  isCdxgenListedTool,
  isDerivedAgentParty,
  isDerivedBlueprint,
  isDerivedRisk,
  splitDerivedEntries,
} from "./cyclonedx20Derived.js";
import {
  EXTERNAL_REFERENCES_RULE,
  PROPERTIES_RULE,
} from "./cyclonedx20ReadCommon.js";
import {
  flushComponentShadows,
  keepComponentShadow,
  readComponentEntry,
} from "./cyclonedx20ReadComponents.js";
import {
  addLoss,
  cloneWithDepthLimit,
  createReadContext,
  jsonPointer,
  MAX_READ_DEPTH,
  markInternalModel,
  registerShadow,
  reportUnmapped,
  reverseFields,
} from "./cyclonedx20ReadContext.js";
import { flushIdentityShadows } from "./cyclonedx20ReadEvidence.js";
import {
  readAnnotations,
  readCitations,
  readCompositions,
  readFormulation,
  readMetadata,
  readVulnerabilities,
} from "./cyclonedx20ReadSections.js";
import {
  derivedPartyDeclarations,
  identityClaimContext,
} from "./cyclonedx20RenderEvidence.js";
import {
  CDX20_INTERNAL_SECTIONS_KEY,
  COMPONENT_TYPES_1X,
  FORMULA_COMPONENT_REFS_PROPERTY,
} from "./cyclonedx20Tables.js";

// 2.0-only root sections, carried verbatim for 2.0 output.
const CARRIED_SECTIONS = Object.freeze([
  "risks",
  "blueprints",
  "threats",
  "controls",
  "perspectives",
  "profiles",
  "declarations",
  "signatures",
]);
const ROOT_KEYS = Object.freeze(
  new Set([
    "$schema",
    "$comment",
    "specFormat",
    "specVersion",
    "serialNumber",
    "version",
    "metadata",
    "inventories",
    "dependencies",
    "compositions",
    "vulnerabilities",
    "annotations",
    "formulation",
    "definitions",
    "citations",
    "properties",
    "externalReferences",
    ...CARRIED_SECTIONS,
  ]),
);
const INVENTORY_KEYS = Object.freeze(
  new Set(["refId", "subject", "components"]),
);
const CARRIED_REASON =
  "2.0-only section with no 1.x field: dropped from 1.x and SPDX output (a 2.0 render of the read model keeps it)";
const DERIVED_REASON =
  "differs from what cdxgen derives from the 1.x model: a 2.0 render replaces it with the derived entry";

/**
 * Read a 2.0 document into the internal 1.x-shaped model. Never throws on a
 * schema-valid 2.0 document. Objects nested deeper than MAX_READ_DEPTH are
 * left out, each with a loss. The returned model carries the internal model
 * mark (markInternalModel), which loadBomForAnalysis checks. Every member the reader sees but cannot carry
 * into 1.x is reported in `losses` as `{pointer, reason}`, where `pointer` is
 * an RFC 6901 JSON pointer into the input. Objects whose 1.x form would not
 * render back to the same 2.0 object are kept under the internal sections
 * key, so renderCycloneDx20 restores them while they are unchanged.
 *
 * @param {object} bom20 BOM in the 2.0 shape
 * @returns {{internalBom: object, losses: Array<{pointer: string, reason: string}>}}
 */
export function readCycloneDx20(bom20) {
  const { value: doc, truncated } = isObjectRecord(bom20)
    ? cloneWithDepthLimit(bom20)
    : { value: {}, truncated: [] };
  const ctx = createReadContext(doc);
  for (const pointer of truncated) {
    addLoss(
      ctx,
      pointer,
      `nested deeper than ${MAX_READ_DEPTH} objects: not read`,
    );
  }
  ctx.componentIndex = indexComponents(doc);
  reportUnmapped(ctx, "document", doc, "", ROOT_KEYS);
  const internal = readHeader(doc);
  const metadata = readMetadata(ctx, doc.metadata);
  ctx.claims = identityClaimContext({ metadata });
  const inventory = readInventories(ctx, doc, metadata);
  const placement = classifyDefinitions(ctx, doc);
  readRootDefinitions(ctx, doc, placement, inventory);
  setList(internal, "components", inventory.components);
  setList(internal, "services", inventory.services);
  readDependencies(ctx, doc, internal);
  setList(
    internal,
    "compositions",
    doc.compositions !== undefined
      ? readCompositions(ctx, doc.compositions, inventory.subjects)
      : undefined,
  );
  readOptionalSections(ctx, doc, internal, placement);
  if (Object.keys(metadata).length) {
    internal.metadata = metadata;
  }
  flushComponentShadows(ctx);
  flushIdentityShadows(ctx);
  const sections = collectCarriedSections(ctx, doc, placement, internal);
  if (Object.keys(sections).length) {
    internal[CDX20_INTERNAL_SECTIONS_KEY] = sections;
  }
  return { internalBom: markInternalModel(internal), losses: ctx.losses };
}

/** Root header: 1.x has no `$schema` for 2.0 (it is carried for 2.0). */
function readHeader(doc) {
  const internal = { bomFormat: "CycloneDX", specVersion: "2.0" };
  for (const field of ["serialNumber", "version"]) {
    if (doc[field] !== undefined) {
      internal[field] = doc[field];
    }
  }
  return internal;
}

/** Assign a non-empty list. */
function setList(target, key, value) {
  if (Array.isArray(value) && value.length) {
    target[key] = value;
  }
}

/**
 * Map refId → the first concrete declaration (document order: tools,
 * inventories, definitions), so componentReferences resolve.
 */
function indexComponents(doc) {
  const index = new Map();
  const visit = (entry, pointer) => {
    if (!isObjectRecord(entry)) {
      return;
    }
    const isReference =
      typeof entry.ref === "string" && entry.name === undefined;
    if (
      !isReference &&
      isNonEmptyString(entry.refId) &&
      !index.has(entry.refId)
    ) {
      index.set(entry.refId, { entry, pointer });
    }
    (Array.isArray(entry.components) ? entry.components : []).forEach(
      (child, childIndex) => {
        visit(child, jsonPointer(pointer, "components", childIndex));
      },
    );
  };
  (doc.metadata?.tools?.components || []).forEach((entry, i) => {
    visit(entry, jsonPointer("/metadata/tools/components", i));
  });
  (Array.isArray(doc.inventories) ? doc.inventories : []).forEach(
    (inventory, i) => {
      visit(inventory?.subject, jsonPointer("/inventories", i, "subject"));
      (inventory?.components || []).forEach((entry, j) => {
        visit(entry, jsonPointer("/inventories", i, "components", j));
      });
    },
  );
  (doc.definitions?.components || []).forEach((entry, i) => {
    visit(entry, jsonPointer("/definitions/components", i));
  });
  return index;
}

/** Push a read entry once per refId; a repeat is a loss. */
function addInventoryEntry(ctx, inventory, read, pointer) {
  if (!read) {
    return;
  }
  if (read.refId !== undefined) {
    if (inventory.seen.has(read.refId)) {
      addLoss(
        ctx,
        pointer,
        "the component is already listed; 1.x lists it once",
      );
      return;
    }
    inventory.seen.add(read.refId);
  }
  keepComponentShadow(ctx, read);
  inventory[read.isService ? "services" : "components"].push(read.internal);
}

/**
 * Read the inventories: the first subject becomes metadata.component, the
 * components of every inventory become root components and services.
 */
function readInventories(ctx, doc, metadata) {
  const inventory = {
    components: [],
    services: [],
    seen: new Set(),
    subjects: new Map(),
  };
  if (doc.inventories !== undefined && !Array.isArray(doc.inventories)) {
    addLoss(ctx, "/inventories", "expected an array");
    return inventory;
  }
  (doc.inventories || []).forEach((entry, index) => {
    const pointer = jsonPointer("/inventories", index);
    if (!isObjectRecord(entry)) {
      addLoss(ctx, pointer, "inventory is not an object");
      return;
    }
    reportUnmapped(ctx, "inventory", entry, pointer, INVENTORY_KEYS);
    readInventorySubject(ctx, entry, pointer, metadata, inventory);
    (Array.isArray(entry.components) ? entry.components : []).forEach(
      (component, componentIndex) => {
        const entryPointer = jsonPointer(pointer, "components", componentIndex);
        addInventoryEntry(
          ctx,
          inventory,
          readComponentEntry(ctx, component, entryPointer),
          entryPointer,
        );
      },
    );
  });
  return inventory;
}

/** One inventory subject: the first is metadata.component. */
function readInventorySubject(ctx, entry, pointer, metadata, inventory) {
  const subjectPointer = jsonPointer(pointer, "subject");
  const read = isObjectRecord(entry.subject)
    ? readComponentEntry(ctx, entry.subject, subjectPointer)
    : undefined;
  if (entry.refId !== undefined) {
    inventory.subjects.set(entry.refId, read?.refId);
  }
  if (!read) {
    return;
  }
  if (metadata.component === undefined && !read.isService) {
    keepComponentShadow(ctx, read);
    metadata.component = read.internal;
    if (read.refId !== undefined) {
      inventory.seen.add(read.refId);
    }
    // The renderer derives the inventory refId from the subject; keep the
    // inventory's own members for the 2.0 round trip.
    const { subject: _subject, components: _components, ...own } = entry;
    registerShadow(ctx, "inventory", read.internal, own);
    return;
  }
  addLoss(
    ctx,
    subjectPointer,
    "1.x has one metadata.component; this inventory subject is read as a root component",
  );
  addInventoryEntry(ctx, inventory, read, subjectPointer);
}

/** `ref` values of componentReference-shaped objects under `node`. */
function collectReferences(node, into = new Set()) {
  if (Array.isArray(node)) {
    for (const value of node) {
      collectReferences(value, into);
    }
  } else if (isObjectRecord(node)) {
    if (typeof node.ref === "string" && node.name === undefined) {
      into.add(node.ref);
    }
    for (const value of Object.values(node)) {
      collectReferences(value, into);
    }
  }
  return into;
}

/**
 * The refIds the componentReferences the reader resolves into 1.x name:
 * those under the inventories, metadata (tools), annotations,
 * vulnerabilities and the definitions components themselves. References from
 * 2.0-only sections do not count, since 1.x drops those sections.
 */
function resolvedReferences(doc) {
  const refs = new Set();
  for (const section of [
    doc.inventories,
    doc.metadata,
    doc.annotations,
    doc.vulnerabilities,
    doc.definitions?.components,
  ]) {
    collectReferences(section, refs);
  }
  return refs;
}

/** Where one definitions entry goes, per the rule in the module comment. */
function placeDefinition(entry, facts) {
  if (
    isObjectRecord(entry) &&
    typeof entry.type === "string" &&
    entry.type !== "service" &&
    entry.type !== "component-choice" &&
    !COMPONENT_TYPES_1X.has(entry.type)
  ) {
    return { place: "carried", reason: "type" };
  }
  const refId = isNonEmptyString(entry?.refId) ? entry.refId : undefined;
  if (refId !== undefined) {
    const listed = facts.formulaMembers
      .map((refs, index) => (refs.has(refId) ? index : -1))
      .filter((index) => index >= 0);
    if (listed.length) {
      return { place: "formula", formula: listed[0], alsoIn: listed.slice(1) };
    }
    const formula = facts.formulaRefs.findIndex((refs) => refs.has(refId));
    if (formula >= 0) {
      return { place: "formula", formula };
    }
  }
  if (facts.hasInventories) {
    if (refId !== undefined && facts.referenced.has(refId)) {
      return { place: "carried" };
    }
    return facts.hasFormulation
      ? { place: "formula", formula: 0, unreferenced: true }
      : { place: "carried", reason: "unreferenced" };
  }
  return { place: "root" };
}

const PLACE_ORDER = Object.freeze({ carried: 0, root: 1, formula: 2 });

/**
 * The refIds a formula lists in its FORMULA_COMPONENT_REFS_PROPERTY property;
 * a value that is not a JSON array of strings lists none.
 */
function formulaMembers(formula) {
  const members = new Set();
  const properties = Array.isArray(formula?.properties)
    ? formula.properties
    : [];
  for (const property of properties) {
    if (
      property?.name !== FORMULA_COMPONENT_REFS_PROPERTY ||
      typeof property.value !== "string"
    ) {
      continue;
    }
    let refIds;
    try {
      refIds = JSON.parse(property.value);
    } catch {
      continue;
    }
    if (Array.isArray(refIds)) {
      for (const refId of refIds) {
        if (isNonEmptyString(refId)) {
          members.add(refId);
        }
      }
    }
  }
  return members;
}

/** Classify every definitions.components entry. */
function classifyDefinitions(ctx, doc) {
  const entries = Array.isArray(doc.definitions?.components)
    ? doc.definitions.components
    : [];
  const formulation = Array.isArray(doc.formulation) ? doc.formulation : [];
  const facts = {
    formulaRefs: formulation.map((formula) => collectReferences(formula)),
    formulaMembers: formulation.map(formulaMembers),
    referenced: resolvedReferences(doc),
    hasInventories:
      Array.isArray(doc.inventories) && doc.inventories.length > 0,
    hasFormulation: formulation.length > 0,
  };
  const placement = entries.map((entry) => placeDefinition(entry, facts));
  let rank = 0;
  placement.forEach((placed, index) => {
    const pointer = jsonPointer("/definitions/components", index);
    if (placed.reason === "type") {
      addLoss(
        ctx,
        jsonPointer(pointer, "type"),
        `component type '${doc.definitions.components[index].type}' has no 1.x equivalent: dropped from 1.x and SPDX output (a 2.0 render of the read model keeps it)`,
      );
    } else if (placed.reason === "unreferenced") {
      addLoss(
        ctx,
        pointer,
        "a definitions component nothing references has no 1.x home",
      );
    } else if (placed.unreferenced && formulation.length > 1) {
      addLoss(
        ctx,
        pointer,
        "formula membership is not recorded; read into the first formula",
      );
    }
    if (PLACE_ORDER[placed.place] < rank) {
      addLoss(ctx, pointer, "definitions.components order changes on render");
    }
    rank = Math.max(rank, PLACE_ORDER[placed.place]);
  });
  return placement;
}

/** Root-placed definitions entries become root components and services. */
function readRootDefinitions(ctx, doc, placement, inventory) {
  placement.forEach((placed, index) => {
    if (placed.place !== "root") {
      return;
    }
    const pointer = jsonPointer("/definitions/components", index);
    addInventoryEntry(
      ctx,
      inventory,
      readComponentEntry(ctx, doc.definitions.components[index], pointer),
      pointer,
    );
  });
}

/** dependencies: ref, dependsOn and provides keep their names. */
function readDependencies(ctx, doc, internal) {
  if (doc.dependencies === undefined) {
    return;
  }
  if (!Array.isArray(doc.dependencies)) {
    addLoss(ctx, "/dependencies", "expected an array");
    return;
  }
  internal.dependencies = doc.dependencies
    .map((dependency, index) =>
      isObjectRecord(dependency)
        ? reverseFields(
            ctx,
            "dependency",
            dependency,
            jsonPointer("/dependencies", index),
            {
              ref: true,
              dependsOn: true,
              provides: true,
            },
          )
        : undefined,
    )
    .filter((dependency) => typeof dependency?.ref === "string");
}

/** Formula components go back into their formula. */
function attachFormulaComponents(ctx, doc, formulation, placement) {
  placement.forEach((placed, index) => {
    if (placed.place !== "formula" || !formulation[placed.formula]) {
      return;
    }
    const read = readComponentEntry(
      ctx,
      doc.definitions.components[index],
      jsonPointer("/definitions/components", index),
    );
    if (read) {
      keepComponentShadow(ctx, read);
      const member = read.isService ? "services" : "components";
      (formulation[placed.formula][member] ||= []).push(read.internal);
      for (const other of placed.alsoIn || []) {
        if (formulation[other]) {
          (formulation[other][member] ||= []).push(clone(read.internal));
        }
      }
    }
  });
}

/** annotations, formulation, citations, vulnerabilities and root lists. */
function readOptionalSections(ctx, doc, internal, placement) {
  if (doc.annotations !== undefined) {
    setList(internal, "annotations", readAnnotations(ctx, doc.annotations));
  }
  if (doc.formulation !== undefined) {
    const formulation = readFormulation(ctx, doc.formulation) || [];
    attachFormulaComponents(ctx, doc, formulation, placement);
    setList(internal, "formulation", formulation);
  }
  if (doc.citations !== undefined) {
    setList(internal, "citations", readCitations(ctx, doc.citations));
  }
  if (doc.vulnerabilities !== undefined) {
    setList(
      internal,
      "vulnerabilities",
      readVulnerabilities(ctx, doc.vulnerabilities),
    );
  }
  for (const [key, rule] of [
    ["properties", PROPERTIES_RULE],
    ["externalReferences", EXTERNAL_REFERENCES_RULE],
  ]) {
    if (doc[key] !== undefined) {
      setList(internal, key, rule.convert(ctx, doc[key], jsonPointer("", key)));
    }
  }
}

/**
 * How many trailing definitions.parties entries are parties renderCycloneDx20
 * derives again from the read 1.x model (derivedPartyDeclarations): the
 * renderer appends, in its order, each derived party the finished document
 * references and does not declare yet. The longest such tail that renders
 * back identically is dropped by the reader, so a derived party neither
 * reaches the internal model nor goes stale when the 1.x tools change. With
 * no matching tail the count is 0 and every party is carried.
 */
function countDerivedParties(ctx, doc) {
  const parties = doc.definitions.parties;
  if (!Array.isArray(parties) || !parties.length) {
    return 0;
  }
  const { parties: _parties, ...definitions } = doc.definitions;
  const rest = { ...doc, definitions };
  const candidates = derivedPartyDeclarations(
    ctx.claims,
    collectDeclaredRefIds([rest, parties]),
  ).filter((party) => referencesParty(rest, party.refId));
  for (let count = candidates.length; count > 0; count--) {
    if (count > parties.length) {
      continue;
    }
    const remaining = parties.slice(0, parties.length - count);
    const remainingRefIds = new Set(remaining.map((party) => party?.refId));
    const expected = derivedPartyDeclarations(
      ctx.claims,
      collectDeclaredRefIds([rest, remaining]),
    ).filter(
      (party) =>
        referencesParty(rest, party.refId) && !remainingRefIds.has(party.refId),
    );
    if (isDeepStrictEqual(expected, parties.slice(remaining.length))) {
      return count;
    }
  }
  return 0;
}

/**
 * The 2.0 value of a carried root section without the entries the renderer
 * derives (cyclonedx20Derived.js): those that match the derivation from the
 * read model are dropped silently, those that differ with a loss. Returns
 * undefined when nothing else is left.
 */
function carriedSectionValue(ctx, doc, section, derived) {
  const value = doc[section];
  if (!derived.cdxgenListed) {
    // cdxgen derives nothing for another tool's document, so entries that
    // look derived (risk-pqc-*, party-agent-*, the agent blueprint) are that
    // tool's own and are carried like any other.
    return value;
  }
  if (section === "blueprints" && Array.isArray(value)) {
    const { kept, differing } = splitDerivedEntries(
      value,
      derived.blueprints,
      isDerivedBlueprint,
    );
    differing.forEach((index) => {
      addLoss(ctx, jsonPointer("/blueprints", index), DERIVED_REASON);
    });
    return kept.length || !value.length ? kept : undefined;
  }
  if (section === "risks" && Array.isArray(value?.risks)) {
    const { kept, differing } = splitDerivedEntries(
      value.risks,
      derived.risks,
      isDerivedRisk,
    );
    differing.forEach((index) => {
      addLoss(ctx, jsonPointer("/risks/risks", index), DERIVED_REASON);
    });
    const { risks: _risks, ...members } = value;
    const rest =
      kept.length || !value.risks.length
        ? { ...clone(members), risks: kept }
        : clone(members);
    return Object.keys(rest).length ? rest : undefined;
  }
  return value;
}

/**
 * Carry the definitions parties the renderer does not derive again: the
 * trailing claim parties (countDerivedParties) and the agent parties that
 * match the derivation are dropped silently, a differing agent party with a
 * loss; every other party is carried with a loss, since 1.x has no home for
 * it.
 */
function carryDefinitionsParties(ctx, doc, sections, derived) {
  const parties = doc.definitions.parties;
  if (!Array.isArray(parties)) {
    sections.definitionsParties = parties;
    return;
  }
  const derivedAgents = new Map(
    derived.agentParties.map((party) => [party.refId, party]),
  );
  const kept = [];
  parties
    .slice(0, parties.length - countDerivedParties(ctx, doc))
    .forEach((party, index) => {
      const pointer = jsonPointer("/definitions/parties", index);
      if (!derived.cdxgenListed || !isDerivedAgentParty(party)) {
        kept.push(party);
        addLoss(ctx, pointer, CARRIED_REASON);
      } else if (!isDeepStrictEqual(derivedAgents.get(party.refId), party)) {
        addLoss(ctx, pointer, DERIVED_REASON);
      }
    });
  if (kept.length || !parties.length) {
    sections.definitionsParties = kept;
  }
}

/**
 * The 2.0-only parts kept under the internal sections key: root sections,
 * definitions other than the components read into 1.x, `$schema` and
 * `$comment`, and the shadows. Entries the renderer derives from the model
 * (post-quantum risks, agent parties and blueprint) are not carried.
 */
function collectCarriedSections(ctx, doc, placement, internal) {
  const sections = {};
  const derived = {
    ...deriveCycloneDx20Sections(internal),
    cdxgenListed: isCdxgenListedTool(internal),
  };
  for (const section of CARRIED_SECTIONS) {
    if (doc[section] === undefined) {
      continue;
    }
    const value = carriedSectionValue(ctx, doc, section, derived);
    if (value !== undefined) {
      sections[section] = value;
      addLoss(ctx, jsonPointer("", section), CARRIED_REASON);
    }
  }
  if (isObjectRecord(doc.definitions)) {
    const { components, parties, ...rest } = doc.definitions;
    if (parties !== undefined) {
      carryDefinitionsParties(ctx, doc, sections, derived);
    }
    const carriedComponents = (
      Array.isArray(components) ? components : []
    ).filter((_entry, index) => placement[index]?.place === "carried");
    if (
      carriedComponents.length ||
      (Array.isArray(components) && !components.length)
    ) {
      rest.components = carriedComponents;
    }
    for (const key of Object.keys(rest)) {
      if (key !== "components") {
        addLoss(ctx, jsonPointer("/definitions", key), CARRIED_REASON);
      }
    }
    if (Object.keys(rest).length) {
      sections.definitions = rest;
    }
  }
  // `$schema`, `$comment` and `ext:` extension members (reported as losses
  // by the root allowlist, except `$schema`) ride along for 2.0 output.
  const root = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key === "$schema" || key === "$comment" || key.startsWith("ext:")) {
      root[key] = value;
    }
  }
  if (doc.$comment !== undefined) {
    addLoss(ctx, "/$comment", "$comment has no 1.x field");
  }
  if (Object.keys(root).length) {
    sections.root = root;
  }
  if (ctx.carriedCompositions?.length) {
    sections.compositions = ctx.carriedCompositions;
  }
  if (Object.keys(ctx.shadows).length) {
    sections.shadows = ctx.shadows;
  }
  return sections;
}
