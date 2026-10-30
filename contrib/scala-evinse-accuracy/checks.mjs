// Pure checks over a Scala evidence BOM produced from a chen run, shared by
// check-chen.mjs and its unit tests. Nothing here reads files or spawns
// processes: every check takes the parsed BOM plus a small file resolver, so
// the tests can drive them with hand-written fixtures.

import { isAbsolute, join } from "node:path";

/**
 * Chen's main dependencies that its class files reference. Each entry matches
 * a component's name, or the artifact part of its purl, exactly, or as a
 * prefix when the entry ends with `*`. Edit this list as chen's build moves;
 * a run that stops joining one of these libraries to its sources is the
 * failure this check exists to catch. The shaded compiler jar
 * (`org.scala-lang.modules:scala-asm`) is deliberately absent: chen's own
 * classes never reference it, so it can have no occurrence to demand.
 */
export const EXPECTED_DEPENDENCIES = [
  "cpg2*",
  "javaparser-symbol-solver-core",
  "circe-*",
  "upickle*",
  "asm*",
];

/** Occurrence offenders listed per component before the rest are cut off. */
export const MAX_OFFENDERS_PER_COMPONENT = 5;

const DIAGNOSTIC_PROPERTY_PREFIX = "cdx:scalasem:diagnostic:";

/**
 * The names one component answers to: its own name (without a `group:`
 * prefix, since Maven components sometimes carry one) and the artifact part
 * of its purl.
 */
export function componentArtifacts(component) {
  const names = new Set();
  const name = String(component?.name || "").trim();
  if (name) {
    names.add(name);
    if (name.includes(":")) {
      names.add(name.slice(name.lastIndexOf(":") + 1));
    }
  }
  const purlArtifact = /^pkg:[^/]+\/(?:([^/@?]+)\/)?([^/@?]+)/.exec(
    String(component?.purl || ""),
  )?.[2];
  if (purlArtifact) {
    try {
      names.add(decodeURIComponent(purlArtifact));
    } catch (_err) {
      names.add(purlArtifact);
    }
  }
  return [...names].filter(Boolean);
}

/**
 * Whether a component matches one EXPECTED_DEPENDENCIES entry.
 *
 * @param {string} entry Dependency name, or a prefix when it ends with `*`.
 * @param {Object} component BOM component.
 */
export function matchesDependency(entry, component) {
  const artifacts = componentArtifacts(component);
  if (entry.endsWith("*")) {
    const prefix = entry.slice(0, -1);
    return artifacts.some((name) => name.startsWith(prefix));
  }
  return artifacts.includes(entry);
}

/**
 * Check (a): the metadata component carries no `cdx:scalasem:diagnostic:*`
 * property. Every way a scalasem run can fall short becomes one, so any
 * property here means the evidence in this BOM was produced by a degraded
 * run, such as one that analysed no Scala 3.10 module.
 *
 * @param {Object} bom Parsed BOM document.
 * @returns {{ found: {name: string, value: string}[] }}
 */
export function checkNoScalasemDiagnostics(bom) {
  const found = (bom?.metadata?.component?.properties || [])
    .filter(
      (property) =>
        typeof property?.name === "string" &&
        property.name.startsWith(DIAGNOSTIC_PROPERTY_PREFIX),
    )
    .map((property) => ({ name: property.name, value: property.value }));
  return { found };
}

/**
 * Check (b): every expected dependency has at least one evidence occurrence
 * on a matching component. A dependency the BOM does not hold at all is
 * reported as `missing` rather than as one without occurrences, since the
 * two failures have different causes: the first is a dependency or join
 * problem, the second means the component is there but no source was
 * attributed to it.
 *
 * @param {Object} bom Parsed BOM document.
 * @param {string[]} [expected] Dependencies to require, defaulting to
 *   EXPECTED_DEPENDENCIES.
 * @returns {{ results: {dependency: string, status: "ok"|"missing"|"no-occurrence", components: number, occurrences: number}[] }}
 */
export function checkDependencyOccurrences(
  bom,
  expected = EXPECTED_DEPENDENCIES,
) {
  const components = bom?.components || [];
  const results = (expected || []).map((dependency) => {
    const matching = components.filter((component) =>
      matchesDependency(dependency, component),
    );
    const occurrences = matching.reduce(
      (sum, component) =>
        sum + (component?.evidence?.occurrences || []).length,
      0,
    );
    const status = !matching.length
      ? "missing"
      : occurrences
        ? "ok"
        : "no-occurrence";
    return { dependency, status, components: matching.length, occurrences };
  });
  return { results };
}

/**
 * The file paths an occurrence location may live at: the location against
 * each root, or the location itself when it is already absolute.
 */
function candidatePaths(location, roots) {
  if (isAbsolute(location)) {
    return [location];
  }
  return (roots || []).map((root) => join(root, location));
}

/**
 * Occurrence entries of one component, with the line split out of the
 * location when the entry carries none of its own.
 */
function occurrencesOf(container) {
  return (container?.evidence?.occurrences || [])
    .map((occurrence) => {
      let location = String(occurrence?.location || "").trim();
      let line = Number(occurrence?.line);
      if (/#\d+$/.test(location)) {
        const hash = location.lastIndexOf("#");
        if (!Number.isFinite(line)) {
          line = Number(location.slice(hash + 1));
        }
        location = location.slice(0, hash);
      }
      return { location, line };
    })
    .filter((occurrence) => occurrence.location);
}

function containerLabel(container) {
  return (
    container?.["bom-ref"] ||
    container?.purl ||
    (container?.name ? `name:${container.name}` : "unknown")
  );
}

function locationOffender(occurrence, resolver) {
  let found;
  for (const candidate of candidatePaths(occurrence.location, resolver?.roots)) {
    const stat = resolver?.statFile?.(candidate);
    if (stat?.exists) {
      found = stat;
      break;
    }
  }
  if (!found) {
    return {
      location: occurrence.location,
      line: occurrence.line,
      reason: "file not found",
    };
  }
  if (!Number.isFinite(occurrence.line)) {
    // A file-only occurrence: existence is all there is to check.
    return undefined;
  }
  if (occurrence.line < 1) {
    return {
      location: occurrence.location,
      line: occurrence.line,
      reason: "line must be positive",
    };
  }
  if (found.lineCount === undefined) {
    // The file is there but its length could not be counted; give it the
    // benefit of the doubt rather than fail on an unreadable file.
    return undefined;
  }
  if (occurrence.line > found.lineCount) {
    return {
      location: occurrence.location,
      line: occurrence.line,
      reason: `line beyond end of file (${found.lineCount} lines)`,
    };
  }
  return undefined;
}

/**
 * Check (c): every occurrence points at a file that exists under one of the
 * roots, at a line the file has. Roots are the chen checkout plus any source
 * roots the scalasem report extracted; the first root that holds the file
 * wins. An occurrence without a line is checked for the file only. The first
 * `maxOffenders` offenders per component are reported.
 *
 * @param {Object} bom Parsed BOM document.
 * @param {{roots: string[], statFile: (path: string) => {exists: boolean, lineCount?: number}|undefined}} resolver
 *   File resolver: `statFile` answers for one absolute path without I/O here.
 * @param {{maxOffenders?: number}} [options]
 * @returns {{ checked: number, componentsWithOccurrences: number, offenders: {component: string, location: string, line: number|undefined, reason: string}[] }}
 */
export function checkOccurrenceLocations(bom, resolver, options = {}) {
  const maxOffenders = options.maxOffenders ?? MAX_OFFENDERS_PER_COMPONENT;
  const containers = [
    ...(bom?.metadata?.component ? [bom.metadata.component] : []),
    ...(bom?.components || []),
    ...(bom?.services || []),
  ];
  const offenders = [];
  let checked = 0;
  let componentsWithOccurrences = 0;
  for (const container of containers) {
    const occurrences = occurrencesOf(container);
    if (!occurrences.length) {
      continue;
    }
    componentsWithOccurrences++;
    let listed = 0;
    for (const occurrence of occurrences) {
      checked++;
      if (listed >= maxOffenders) {
        continue;
      }
      const offender = locationOffender(occurrence, resolver);
      if (offender) {
        offenders.push({
          component: containerLabel(container),
          ...offender,
        });
        listed++;
      }
    }
  }
  return { checked, componentsWithOccurrences, offenders };
}

/**
 * Check (d): every call stack in evidence ends in a component of the BOM.
 * cdxgen publishes a stack on the component the stack ends in, so the
 * component carrying each frame sequence must be identifiable by a bom-ref
 * or purl, and the sequence must be intact, with a final frame that names
 * where it ends. Evidence without frames, or a stack that stops at an
 * anonymous frame, says the terminal hop no longer resolves.
 *
 * @param {Object} bom Parsed BOM document.
 * @returns {{ stacks: number, offenders: {component: string, ref: string, reason: string}[] }}
 */
export function checkCallStacks(bom) {
  const containers = [
    ...(bom?.metadata?.component ? [bom.metadata.component] : []),
    ...(bom?.components || []),
  ];
  const offenders = [];
  let stacks = 0;
  for (const container of containers) {
    const frames = container?.evidence?.callstack?.frames;
    if (frames === undefined || frames === null) {
      continue;
    }
    const label = containerLabel(container);
    if (!Array.isArray(frames) || !frames.length) {
      offenders.push({
        component: label,
        ref: label,
        reason: "call stack evidence without frames",
      });
      continue;
    }
    stacks++;
    if (!container["bom-ref"] && !container.purl) {
      offenders.push({
        component: label,
        ref: label,
        reason: "call stack on a component without a bom-ref or purl",
      });
    }
    const last = frames[frames.length - 1];
    if (!last || typeof last !== "object") {
      offenders.push({
        component: label,
        ref: label,
        reason: "call stack without a final frame",
      });
    } else if (!last.module && !last.fullFilename) {
      offenders.push({
        component: label,
        ref: label,
        reason: "final frame names neither a class nor a file",
      });
    }
  }
  return { stacks, offenders };
}

/**
 * Run every check and return the rows the summary table prints. Each row
 * carries the structured result for the tests and a short summary plus
 * ready-to-print failure details.
 *
 * @param {Object} bom Parsed BOM document.
 * @param {{roots: string[], statFile: Function}} resolver File resolver for check (c).
 * @param {{expectedDependencies?: string[], maxOffenders?: number}} [options]
 * @returns {{check: string, pass: boolean, summary: string, details: string[], result: Object}[]}
 */
export function runAllChecks(bom, resolver, options = {}) {
  const rows = [];

  const diagnostics = checkNoScalasemDiagnostics(bom);
  rows.push({
    check: "no scalasem diagnostics on the metadata component",
    pass: diagnostics.found.length === 0,
    summary:
      diagnostics.found.length === 0
        ? "no diagnostic properties"
        : `${diagnostics.found.length} diagnostic properties found`,
    details: diagnostics.found.map(
      (diagnostic) => `${diagnostic.name} = ${diagnostic.value}`,
    ),
    result: diagnostics,
  });

  const dependencies = checkDependencyOccurrences(
    bom,
    options.expectedDependencies,
  );
  const ok = dependencies.results.filter((r) => r.status === "ok").length;
  const missing = dependencies.results.filter((r) => r.status === "missing");
  const without = dependencies.results.filter(
    (r) => r.status === "no-occurrence",
  );
  rows.push({
    check: "expected dependencies have occurrences",
    pass: missing.length + without.length === 0,
    summary: `${ok}/${dependencies.results.length} dependencies ok${
      missing.length ? `, ${missing.length} missing from BOM` : ""
    }${without.length ? `, ${without.length} without occurrences` : ""}`,
    details: [
      ...missing.map(
        (r) => `${r.dependency}: missing from BOM (no component matches)`,
      ),
      ...without.map(
        (r) =>
          `${r.dependency}: ${r.components} component(s) in the BOM, none with an occurrence`,
      ),
    ],
    result: dependencies,
  });

  const locations = checkOccurrenceLocations(bom, resolver, options);
  const byComponent = new Map();
  for (const offender of locations.offenders) {
    let list = byComponent.get(offender.component);
    if (!list) {
      list = [];
      byComponent.set(offender.component, list);
    }
    list.push(offender);
  }
  rows.push({
    check: "occurrence locations resolve",
    pass: locations.offenders.length === 0,
    summary:
      locations.offenders.length === 0
        ? `${locations.checked} occurrences checked`
        : `${locations.offenders.length} of ${locations.checked} occurrences point nowhere`,
    details: [...byComponent.entries()].flatMap(([component, list]) =>
      list.map(
        (offender) =>
          `${component}: ${offender.location}#${offender.line ?? "?"} (${offender.reason})`,
      ),
    ),
    result: locations,
  });

  const callStacks = checkCallStacks(bom);
  rows.push({
    check: "call stacks end in a component of the BOM",
    pass: callStacks.offenders.length === 0,
    summary:
      callStacks.offenders.length === 0
        ? `${callStacks.stacks} call stacks checked`
        : `${callStacks.offenders.length} offender(s) over ${callStacks.stacks} call stacks`,
    details: callStacks.offenders.map(
      (offender) => `${offender.component}: ${offender.reason}`,
    ),
    result: callStacks,
  });

  return rows;
}
