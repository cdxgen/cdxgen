/**
 * Render-side conversion of the 1.x definitions standards and the root
 * `declarations` (#/$defs/cyclonedx-standard-2.0 and
 * #/$defs/cyclonedx-declaration-2.0). Their members keep their names; the
 * 1.x `bom-ref` becomes `refId`, organizations and contacts take the 2.0
 * common shapes, attachments the 2.0 attachment, and a 1.x JSF `signature`
 * is counted and left out (see countSignatureDrop).
 */

import {
  clone,
  copyDefined,
  countDrop,
  countSignatureDrop,
  countUnmapped,
  isNonEmptyString,
  isObjectRecord,
  setDefined,
} from "./cyclonedx20Common.js";
import { toCommonContact, toCommonEntity } from "./cyclonedx20Parties.js";
import {
  convertComponent,
  convertDataContents,
  convertGovernance,
  convertService,
  toDataClassification,
} from "./cyclonedx20RenderComponents.js";

/** Start a converted object with the 1.x `bom-ref` as its `refId`. */
function withRefId(source) {
  return isNonEmptyString(source["bom-ref"])
    ? { refId: source["bom-ref"] }
    : {};
}

/**
 * Convert each object of a 1.x list with `convertEntry(entry)`, counting
 * entries that are not objects. Returns undefined for an empty result.
 */
function convertList(list, label, stats, convertEntry) {
  if (!Array.isArray(list)) {
    if (list !== undefined) {
      countDrop(stats, `${label} (not a list)`);
    }
    return undefined;
  }
  const converted = [];
  for (const entry of list) {
    if (!isObjectRecord(entry)) {
      countDrop(stats, `${label} (not an object)`);
      continue;
    }
    const out = convertEntry(entry);
    if (out) {
      converted.push(out);
    }
  }
  return converted.length ? converted : undefined;
}

/**
 * Copy `fields`, rename `bom-ref`, count a `signature` and every member not
 * in `fields` or `extraHandled`.
 */
function convertPlain(entry, label, fields, stats, extraHandled = []) {
  const out = withRefId(entry);
  copyDefined(out, entry, fields);
  if (entry.signature !== undefined) {
    countSignatureDrop(stats, `${label}.signature`);
  }
  countUnmapped(
    stats,
    label,
    entry,
    new Set([...fields, ...extraHandled, "bom-ref", "signature"]),
  );
  return out;
}

const STANDARD_FIELDS = [
  "name",
  "version",
  "description",
  "owner",
  "externalReferences",
];
const REQUIREMENT_FIELDS = [
  "identifier",
  "title",
  "text",
  "descriptions",
  "openCre",
  "parent",
  "properties",
  "externalReferences",
];
const LEVEL_FIELDS = ["identifier", "title", "description", "requirements"];

/**
 * Convert 1.x definitions.standards
 * (#/$defs/cyclonedx-standard-2.0/$defs/standards). Requirement `parent`
 * and level `requirements` are refLinkType values; the refIds keep the
 * bom-ref values, so they still resolve.
 *
 * @param {object[]} standards 1.x standards
 * @param {object} stats Render counters
 * @returns {object[]|undefined} 2.0 standards
 */
export function convertStandards(standards, stats) {
  return convertList(standards, "definitions.standards", stats, (standard) => {
    const out = convertPlain(
      standard,
      "definitions.standards",
      STANDARD_FIELDS,
      stats,
      ["requirements", "levels"],
    );
    setDefined(
      out,
      "requirements",
      convertList(
        standard.requirements,
        "definitions.standards.requirements",
        stats,
        (requirement) =>
          convertPlain(
            requirement,
            "definitions.standards.requirements",
            REQUIREMENT_FIELDS,
            stats,
          ),
      ),
    );
    setDefined(
      out,
      "levels",
      convertList(
        standard.levels,
        "definitions.standards.levels",
        stats,
        (level) =>
          convertPlain(
            level,
            "definitions.standards.levels",
            LEVEL_FIELDS,
            stats,
          ),
      ),
    );
    return out;
  });
}

/** Declaration evidence data: contents, classification and governance. */
function convertEvidenceData(data, stats) {
  return convertList(data, "declarations.evidence.data", stats, (entry) => {
    const out = {};
    copyDefined(out, entry, ["name", "sensitiveData"]);
    setDefined(out, "contents", convertDataContents(entry.contents, stats));
    setDefined(
      out,
      "classification",
      toDataClassification(entry.classification),
    );
    setDefined(out, "governance", convertGovernance(entry.governance, stats));
    countUnmapped(
      stats,
      "declarations.evidence.data",
      entry,
      new Set([
        "name",
        "sensitiveData",
        "contents",
        "classification",
        "governance",
      ]),
    );
    return Object.keys(out).length ? out : undefined;
  });
}

/**
 * Affirmation signatories. A 2.0 signatory needs either `signatures` or both
 * `externalReference` and `organization`; one that relied on its 1.x JSF
 * signature alone cannot be carried.
 */
function convertSignatories(signatories, stats) {
  const label = "declarations.affirmation.signatories";
  return convertList(signatories, label, stats, (signatory) => {
    if (signatory.signature !== undefined) {
      countSignatureDrop(stats, `${label}.signature`);
    }
    const organization = toCommonEntity(signatory.organization, stats);
    if (!organization || !isObjectRecord(signatory.externalReference)) {
      countDrop(stats, `${label} (no organization and external reference)`);
      return undefined;
    }
    const out = {};
    copyDefined(out, signatory, ["name", "role"]);
    out.organization = organization;
    out.externalReference = clone(signatory.externalReference);
    countUnmapped(
      stats,
      label,
      signatory,
      new Set([
        "name",
        "role",
        "organization",
        "externalReference",
        "signature",
      ]),
    );
    return out;
  });
}

/** Declaration targets: organizations, and components with the services. */
function convertTargets(targets, stats) {
  if (!isObjectRecord(targets)) {
    countDrop(stats, "declarations.targets (not an object)");
    return undefined;
  }
  const out = {};
  setDefined(
    out,
    "organizations",
    convertList(
      targets.organizations,
      "declarations.targets.organizations",
      stats,
      (organization) => toCommonEntity(organization, stats),
    ),
  );
  // 2.0 has no services; a 1.x service is a component of type `service`.
  const components = [
    ...(convertList(
      targets.components,
      "declarations.targets.components",
      stats,
      (component) => convertComponent(component, stats),
    ) || []),
    ...(convertList(
      targets.services,
      "declarations.targets.services",
      stats,
      (service) => convertService(service, stats),
    ) || []),
  ];
  if (components.length) {
    out.components = components;
  }
  countUnmapped(
    stats,
    "declarations.targets",
    targets,
    new Set(["organizations", "components", "services"]),
  );
  return Object.keys(out).length ? out : undefined;
}

/**
 * Render the root `declarations`
 * (#/$defs/cyclonedx-declaration-2.0/$defs/declarations).
 *
 * @param {object} declarations 1.x declarations
 * @param {object} stats Render counters
 * @returns {object|undefined} 2.0 declarations
 */
export function renderDeclarations(declarations, stats) {
  if (!isObjectRecord(declarations)) {
    if (declarations !== undefined) {
      countDrop(stats, "declarations (not an object)");
    }
    return undefined;
  }
  const out = {};
  setDefined(
    out,
    "assessors",
    convertList(
      declarations.assessors,
      "declarations.assessors",
      stats,
      (assessor) => {
        const converted = convertPlain(
          assessor,
          "declarations.assessors",
          ["thirdParty"],
          stats,
          ["organization"],
        );
        setDefined(
          converted,
          "organization",
          toCommonEntity(assessor.organization, stats),
        );
        return converted;
      },
    ),
  );
  setDefined(
    out,
    "attestations",
    convertList(
      declarations.attestations,
      "declarations.attestations",
      stats,
      (attestation) =>
        convertPlain(
          attestation,
          "declarations.attestations",
          ["summary", "assessor", "map"],
          stats,
        ),
    ),
  );
  setDefined(
    out,
    "claims",
    convertList(declarations.claims, "declarations.claims", stats, (claim) =>
      convertPlain(
        claim,
        "declarations.claims",
        [
          "target",
          "predicate",
          "mitigationStrategies",
          "reasoning",
          "evidence",
          "counterEvidence",
          "externalReferences",
        ],
        stats,
      ),
    ),
  );
  setDefined(
    out,
    "evidence",
    convertList(
      declarations.evidence,
      "declarations.evidence",
      stats,
      (evidence) => {
        const converted = convertPlain(
          evidence,
          "declarations.evidence",
          ["propertyName", "description", "created", "expires"],
          stats,
          ["data", "author", "reviewer"],
        );
        setDefined(
          converted,
          "data",
          convertEvidenceData(evidence.data, stats),
        );
        for (const field of ["author", "reviewer"]) {
          setDefined(converted, field, toCommonContact(evidence[field], stats));
        }
        return converted;
      },
    ),
  );
  if (declarations.targets !== undefined) {
    setDefined(out, "targets", convertTargets(declarations.targets, stats));
  }
  if (isObjectRecord(declarations.affirmation)) {
    const affirmation = convertPlain(
      declarations.affirmation,
      "declarations.affirmation",
      ["statement"],
      stats,
      ["signatories"],
    );
    setDefined(
      affirmation,
      "signatories",
      convertSignatories(declarations.affirmation.signatories, stats),
    );
    if (Object.keys(affirmation).length) {
      out.affirmation = affirmation;
    }
  } else if (declarations.affirmation !== undefined) {
    countDrop(stats, "declarations.affirmation (not an object)");
  }
  if (declarations.signature !== undefined) {
    countSignatureDrop(stats, "declarations.signature");
  }
  countUnmapped(
    stats,
    "declarations",
    declarations,
    new Set([
      "assessors",
      "attestations",
      "claims",
      "evidence",
      "targets",
      "affirmation",
      "signature",
    ]),
  );
  return Object.keys(out).length ? out : undefined;
}
