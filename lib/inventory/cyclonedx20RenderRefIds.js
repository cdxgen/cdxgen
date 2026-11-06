/**
 * Reference integrity of a rendered CycloneDX 2.0 document: every refId is
 * unique (the 2.0 refIdType rule "Every `refId` shall be unique within the
 * document", which JSON Schema cannot check), and dependency and
 * vulnerability references resolve to a declared refId or a BOM-Link.
 */

import { isDeepStrictEqual } from "node:util";

import {
  clone,
  countDrop,
  countRewrite,
  isBomLink,
  isObjectRecord,
} from "./cyclonedx20Common.js";
import { COMPONENT_ENTRY_ARRAY_KEYS } from "./cyclonedx20Tables.js";

// Returned by the walk for a declaration-only entry that repeats an earlier
// declaration; the enclosing array leaves it out.
const REMOVE = Symbol("remove");

// Slots outside component and party lists: a duplicate there has no
// reference form.
const PLAIN_SLOT = Object.freeze({});

/** How many times each refId string is declared under the roots. */
function countRefIds(roots) {
  const counts = new Map();
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isObjectRecord(node)) {
      return;
    }
    if (typeof node.refId === "string") {
      counts.set(node.refId, (counts.get(node.refId) || 0) + 1);
    }
    for (const value of Object.values(node)) {
      visit(value);
    }
  };
  roots.forEach(({ value }) => {
    visit(value);
  });
  return counts;
}

/**
 * True when a reference to `earlier` loses nothing of `later`: every member
 * of `later` except its refId has a deep-equal counterpart in `earlier`.
 */
function isCoveredBy(later, earlier) {
  if (!isObjectRecord(earlier)) {
    return false;
  }
  for (const [key, value] of Object.entries(later)) {
    if (key !== "refId" && !isDeepStrictEqual(value, earlier[key])) {
      return false;
    }
  }
  return true;
}

/** `${refId}-dup-<n>` for the smallest n not already taken. */
function uniqueRefId(refId, taken) {
  let index = 1;
  while (taken.has(`${refId}-dup-${index}`)) {
    index++;
  }
  const fresh = `${refId}-dup-${index}`;
  taken.add(fresh);
  return fresh;
}

/**
 * The slot a member value sits in. Component entry lists, the inventory
 * subject and an annotator component accept a componentReference
 * (#/$defs/cyclonedx-component-2.0/$defs/componentEntry), party lists a
 * partyReference (#/$defs/cyclonedx-party-2.0/$defs/partyChoice). The
 * definitions registry lists components and parties but accepts no
 * reference form (#/$defs/cyclonedx-definition-2.0/$defs/definitions).
 */
function memberSlot(key, value, ownKey, inDefinitions) {
  const isList = Array.isArray(value);
  if (inDefinitions && isList && (key === "components" || key === "parties")) {
    return {
      kind: key === "components" ? "component" : "party",
      declarationOnly: true,
    };
  }
  if (
    (COMPONENT_ENTRY_ARRAY_KEYS.has(key) && isList) ||
    key === "subject" ||
    (key === "component" && ownKey === "annotator")
  ) {
    return { kind: "component", reference: true };
  }
  if (key === "parties" && isList) {
    return { kind: "party", reference: true };
  }
  return PLAIN_SLOT;
}

/**
 * Make every refId unique. The roots are walked in order, so the earliest
 * root keeps a repeated refId; pass the inventories before metadata so the
 * subject of a self-scan keeps its members when it repeats the refId of the
 * tool. A later declaration with an already declared refId becomes:
 *
 * - a componentReference or partyReference `{ref}` when it sits in a slot
 *   that accepts one and an earlier declaration of the same kind already
 *   holds every member it has (nothing is lost);
 * - nothing, in the definitions registry, under the same condition (counted
 *   as already declared), and also when an inventory declares the refId
 *   with other members (the members only the registry entry had are
 *   counted as dropped);
 * - unchanged, when neither it nor an earlier declaration sits in a
 *   component or party slot (counted);
 * - otherwise the same object under a new refId `<refId>-dup-<n>`, so no data
 *   is lost and references to the refId keep resolving to the first
 *   declaration.
 *
 * @param {Array<{section: string, value: *}>} roots Rendered sections, the
 *   definitions root marked with `section: "definitions"`
 * @param {object} stats Render counters
 */
export function dedupeRefIds(roots, stats) {
  const counts = countRefIds(roots);
  const taken = new Set(counts.keys());
  const seen = new Map();
  const declare = (node, slot, section) => {
    const refId = node.refId;
    const variants = seen.get(refId);
    if (!variants) {
      seen.set(refId, [
        {
          kind: slot.kind,
          refId,
          section,
          snapshot: counts.get(refId) > 1 ? clone(node) : undefined,
        },
      ]);
      return node;
    }
    const match = slot.kind
      ? variants.find(
          (variant) =>
            variant.kind === slot.kind && isCoveredBy(node, variant.snapshot),
        )
      : undefined;
    if (match && slot.declarationOnly) {
      countRewrite(
        stats,
        `definitions ${slot.kind} (already declared in ${match.section === "inventories" ? "inventory" : match.section})`,
      );
      return REMOVE;
    }
    // A formula component the inventory declares too: 2.0 records no formula
    // membership, so a second definition would only repeat the component
    // under another refId. The inventory declaration stays, references keep
    // resolving to it, and the members only this copy had are counted.
    const inventoryVariant =
      slot.declarationOnly &&
      variants.find(
        (variant) =>
          variant.kind === slot.kind && variant.section === "inventories",
      );
    if (inventoryVariant) {
      countDrop(
        stats,
        `definitions ${slot.kind} (already declared in inventory; members it adds dropped)`,
      );
      return REMOVE;
    }
    if (match && slot.reference) {
      countRewrite(stats, "duplicate refId (rendered as a reference)");
      return { ref: match.refId };
    }
    if (!slot.kind && !variants.some((variant) => variant.kind)) {
      // Neither declaration sits where a componentReference or
      // partyReference could name it (a formula and its workflow, say), so
      // no reference can resolve to the wrong one. A document read from 2.0
      // keeps its refIds as written; the repeat is counted.
      countRewrite(stats, "duplicate refId (kept: no reference form)");
      return node;
    }
    node.refId = uniqueRefId(refId, taken);
    countRewrite(stats, "duplicate refId (kept under a new refId)");
    variants.push({
      kind: slot.kind,
      refId: node.refId,
      section,
      snapshot: clone(node),
    });
    return node;
  };
  const visit = (node, slot, ownKey, section, inDefinitions) => {
    if (Array.isArray(node)) {
      let removed = false;
      for (let index = 0; index < node.length; index++) {
        node[index] = visit(node[index], slot, ownKey, section, false);
        removed ||= node[index] === REMOVE;
      }
      if (removed) {
        const kept = node.filter((entry) => entry !== REMOVE);
        node.length = 0;
        node.push(...kept);
      }
      return node;
    }
    if (!isObjectRecord(node)) {
      return node;
    }
    if (typeof node.refId === "string") {
      const declared = declare(node, slot, section);
      if (declared !== node) {
        return declared;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      node[key] = visit(
        value,
        memberSlot(key, value, ownKey, inDefinitions),
        key,
        section,
        false,
      );
    }
    return node;
  };
  for (const { section, value } of roots) {
    visit(value, PLAIN_SLOT, undefined, section, section === "definitions");
  }
}

const resolves = (ref, declared) =>
  typeof ref === "string" && (declared.has(ref) || isBomLink(ref));

/**
 * Keep only dependency references that resolve: an entry whose `ref` names
 * nothing declared is dropped, and so is each such `dependsOn` and
 * `provides` member. An emptied `dependsOn` stays, since an empty list says
 * the component has no dependencies.
 *
 * @param {object[]|undefined} dependencies Rendered dependencies
 * @param {Set<string>} declared Every declared refId
 * @param {object} stats Render counters
 * @returns {object[]|undefined} The dependencies left, or undefined
 */
export function resolveDependencyRefs(dependencies, declared, stats) {
  if (!Array.isArray(dependencies)) {
    return undefined;
  }
  const kept = [];
  for (const dependency of dependencies) {
    if (!resolves(dependency.ref, declared)) {
      countDrop(stats, "dependency (undeclared ref)");
      continue;
    }
    for (const key of ["dependsOn", "provides"]) {
      if (!Array.isArray(dependency[key])) {
        continue;
      }
      const refs = dependency[key].filter((ref) => resolves(ref, declared));
      if (refs.length !== dependency[key].length) {
        countDrop(
          stats,
          `dependency.${key} (undeclared ref)`,
          dependency[key].length - refs.length,
        );
      }
      dependency[key] = refs;
    }
    kept.push(dependency);
  }
  return kept.length ? kept : undefined;
}

/**
 * Drop vulnerability `affects` entries whose `ref` resolves to nothing, and
 * an `affects` list left empty.
 *
 * @param {object[]|undefined} vulnerabilities Rendered vulnerabilities
 * @param {Set<string>} declared Every declared refId
 * @param {object} stats Render counters
 */
export function resolveAffectsRefs(vulnerabilities, declared, stats) {
  for (const vulnerability of vulnerabilities || []) {
    if (
      !isObjectRecord(vulnerability) ||
      !Array.isArray(vulnerability.affects)
    ) {
      continue;
    }
    const affects = vulnerability.affects.filter((entry) =>
      resolves(entry?.ref, declared),
    );
    if (affects.length !== vulnerability.affects.length) {
      countDrop(
        stats,
        "vulnerability.affects (undeclared ref)",
        vulnerability.affects.length - affects.length,
      );
    }
    if (affects.length) {
      vulnerability.affects = affects;
    } else {
      delete vulnerability.affects;
    }
  }
}
