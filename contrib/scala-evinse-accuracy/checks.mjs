// Pure checks over a Scala evidence BOM produced from a chen run, shared by
// check-chen.mjs and its unit tests. Nothing here reads files or spawns
// processes: every check takes the parsed BOM, the parsed scalasem report and
// a small resolver, so the tests can drive them with hand-written fixtures.

import { isAbsolute, join } from "node:path";

import {
  parseScalaArtifact,
  scalaCoordinateOfPurl,
} from "../../lib/inventory/scalaCoords.js";

/**
 * Chen's main dependencies that its class files reference, by published
 * artifact name without the Scala binary suffix. Each one must be in the BOM
 * and have at least one evidence occurrence of its own. Edit this list as
 * chen's build moves; a run that stops joining one of these libraries to its
 * sources is the failure this check exists to catch. The shaded compiler jar
 * (`org.scala-lang.modules:scala-asm`) is deliberately absent: chen's own
 * classes never reference it, so it can have no occurrence to demand.
 */
export const EXPECTED_DEPENDENCIES = [
  "cpg2",
  "javaparser-symbol-solver-core",
  "circe-core",
  "circe-parser",
  "upickle",
  "asm",
];

/** Occurrence offenders listed per component before the rest are counted only. */
export const MAX_OFFENDERS_PER_COMPONENT = 5;

const DIAGNOSTIC_PROPERTY_PREFIX = "cdx:scalasem:diagnostic:";

function metadataProperty(bom, name) {
  return (bom?.metadata?.component?.properties || []).find(
    (property) => property?.name === name,
  )?.value;
}

/**
 * The names one component answers to: its own name (without a `group:`
 * prefix, since Maven components sometimes carry one) and the artifact part
 * of its purl, each also without its Scala binary and platform suffixes.
 */
export function componentArtifacts(component) {
  const names = new Set();
  const name = String(component?.name || "").trim();
  if (name) {
    names.add(name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name);
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
  for (const known of [...names]) {
    names.add(parseScalaArtifact(known).artifactBase);
  }
  return [...names].filter(Boolean);
}

/**
 * Whether a component is the expected dependency: its name, or its name
 * without the Scala suffixes, is the entry exactly.
 *
 * @param {string} entry Published artifact name without the Scala suffix.
 * @param {Object} component BOM component.
 */
export function matchesDependency(entry, component) {
  return componentArtifacts(component).includes(entry);
}

/**
 * Check (a): scalasem ran and its report is the one the BOM describes. The
 * metadata component names the report schema and a positive number of files
 * analysed, and a report was read. A run with the analyzer disabled or
 * missing leaves neither, and every later check would then pass on whatever
 * other evidence the BOM holds.
 *
 * @param {Object} bom Parsed BOM document.
 * @param {Object|undefined} report Parsed scalasem report.
 * @returns {{ problems: string[], filesAnalyzed: number }}
 */
export function checkScalasemRan(bom, report) {
  const problems = [];
  const schemaVersion = metadataProperty(bom, "cdx:scalasem:schemaVersion");
  const filesAnalyzed = Number(
    metadataProperty(bom, "cdx:scalasem:filesAnalyzed"),
  );
  if (schemaVersion !== "scalasem/2") {
    problems.push(
      `cdx:scalasem:schemaVersion is ${schemaVersion === undefined ? "absent" : `"${schemaVersion}"`}, not "scalasem/2"`,
    );
  }
  if (!Number.isInteger(filesAnalyzed) || filesAnalyzed < 1) {
    problems.push("cdx:scalasem:filesAnalyzed is absent or not positive");
  }
  if (!report?._meta) {
    problems.push("no scalasem report was read");
  } else if (report._meta.schemaVersion !== "scalasem/2") {
    problems.push(
      `the report has schema ${report._meta.schemaVersion || "none"}, not scalasem/2`,
    );
  }
  return {
    problems,
    filesAnalyzed: Number.isFinite(filesAnalyzed) ? filesAnalyzed : 0,
  };
}

/**
 * Check (b): the metadata component carries no `cdx:scalasem:diagnostic:*`
 * property. Every way a scalasem run can degrade becomes one, so any property
 * here means the evidence in this BOM was produced by a degraded run, such as
 * one that analysed no Scala 3.10 module. The counts scalasem keeps on a
 * healthy run (`stale-output`, `unresolved-symbols`) never reach the BOM; they
 * are read from the report and listed without failing the check, since a
 * stale build skipped is the analyzer working as meant.
 *
 * @param {Object} bom Parsed BOM document.
 * @param {Object|undefined} report Parsed scalasem report.
 * @returns {{ found: {name: string, value: string}[], informational: {code: string, count: number}[] }}
 */
export function checkNoScalasemDiagnostics(bom, report) {
  const found = (bom?.metadata?.component?.properties || [])
    .filter(
      (property) =>
        typeof property?.name === "string" &&
        property.name.startsWith(DIAGNOSTIC_PROPERTY_PREFIX),
    )
    .map((property) => ({ name: property.name, value: property.value }));
  const reported = new Set(
    found.map((property) =>
      property.name.slice(DIAGNOSTIC_PROPERTY_PREFIX.length),
    ),
  );
  // The report counts per module; the summary counts per code.
  const counts = new Map();
  for (const diagnostic of report?._meta?.diagnostics || []) {
    if (diagnostic?.code && !reported.has(diagnostic.code)) {
      counts.set(
        diagnostic.code,
        (counts.get(diagnostic.code) || 0) + (Number(diagnostic.count) || 1),
      );
    }
  }
  const informational = [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
  return { found, informational };
}

/**
 * Check (c): every expected dependency is in the BOM and has evidence
 * occurrences of its own. A dependency the BOM does not hold at all is
 * reported as `missing` rather than as one without occurrences, since the two
 * failures have different causes: the first is a dependency or join problem,
 * the second means the component is there but no source was attributed to it.
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
 * The parts of an occurrence: the file, and the line, from the `line` field
 * or from a `#N` suffix of the location. A line that is not a positive whole
 * number, and a `line` field that disagrees with the suffix, are problems of
 * their own.
 */
function occurrenceParts(occurrence) {
  let location = String(occurrence?.location || "").trim();
  let suffixLine;
  const hash = location.lastIndexOf("#");
  if (hash >= 0 && /^\d+$/.test(location.slice(hash + 1))) {
    suffixLine = Number(location.slice(hash + 1));
    location = location.slice(0, hash);
  }
  const hasField = occurrence?.line !== undefined && occurrence?.line !== null;
  const fieldLine = hasField ? Number(occurrence.line) : undefined;
  let problem;
  if (
    hasField &&
    suffixLine !== undefined &&
    fieldLine !== suffixLine
  ) {
    problem = `line ${occurrence.line} disagrees with the location's #${suffixLine}`;
  }
  const line = hasField ? fieldLine : suffixLine;
  if (!problem && line !== undefined && (!Number.isInteger(line) || line < 1)) {
    problem = "line must be a positive whole number";
  }
  return { location, line, problem };
}

function containerLabel(container) {
  return (
    container?.["bom-ref"] ||
    container?.purl ||
    (container?.name ? `name:${container.name}` : "unknown")
  );
}

// Occurrence locations are relative to the project root, which is where
// scalasem reports them from; an absolute one is taken as it is.
function locationOffender({ location, line, problem }, resolver) {
  if (problem) {
    return { location, line, reason: problem };
  }
  const path = isAbsolute(location) ? location : join(resolver.root, location);
  const stat = resolver.statFile(path);
  if (!stat?.exists) {
    return { location, line, reason: "file not found" };
  }
  if (line === undefined || stat.lineCount === undefined) {
    // A file-only occurrence, or a file whose length could not be counted:
    // existence is all there is to check.
    return undefined;
  }
  if (line > stat.lineCount) {
    return {
      location,
      line,
      reason: `line beyond end of file (${stat.lineCount} lines)`,
    };
  }
  return undefined;
}

/**
 * Check (d): every occurrence points at a file that exists under the project
 * root, at a line the file has. An occurrence without a line is checked for
 * the file only. Every offender is counted; the first `maxOffenders` of each
 * component are listed.
 *
 * @param {Object} bom Parsed BOM document.
 * @param {{root: string, statFile: (path: string) => {exists: boolean, lineCount?: number}|undefined}} resolver
 *   File resolver: `statFile` answers for one absolute path.
 * @param {{maxOffenders?: number}} [options]
 * @returns {{ checked: number, componentsWithOccurrences: number, offenderCount: number, offenders: {component: string, location: string, line: number|undefined, reason: string}[] }}
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
  let offenderCount = 0;
  let componentsWithOccurrences = 0;
  for (const container of containers) {
    const occurrences = (container?.evidence?.occurrences || []).map(
      occurrenceParts,
    );
    if (!occurrences.length) {
      continue;
    }
    componentsWithOccurrences++;
    let listed = 0;
    for (const occurrence of occurrences) {
      checked++;
      const offender = occurrence.location
        ? locationOffender(occurrence, resolver)
        : { location: "", line: occurrence.line, reason: "no location" };
      if (!offender) {
        continue;
      }
      offenderCount++;
      if (listed < maxOffenders) {
        offenders.push({ component: containerLabel(container), ...offender });
        listed++;
      }
    }
  }
  return { checked, componentsWithOccurrences, offenderCount, offenders };
}

// The binary name a class goes by in a jar, from the report's spelling of a
// class nested in an object (`Outer$.Inner` is `Outer$Inner`).
function binaryClassName(className) {
  return String(className || "").replaceAll("$.", "$");
}

// Whether a jar's namespaces hold a class, by its binary name or by the class
// it is nested in.
function namespaceCovers(namespaces, className) {
  const binary = binaryClassName(className).replace(/\$+$/, "");
  if (!binary) {
    return false;
  }
  const outer = binary.split("$")[0];
  return namespaces.some((namespace) => {
    const name = String(namespace || "").replace(/\$+$/, "");
    return name === binary || name === outer || name.split("$")[0] === outer;
  });
}

// The classes a report stack calls at its sink: the sink's owner, and every
// call the report records on the sink's line, which is how the join decides
// which components a stack is evidence for.
function sinkOwners(report, stack) {
  const sink = stack?.sink;
  const owners = new Set(sink?.owner ? [sink.owner] : []);
  for (const call of report?.[sink?.file]?.calls || []) {
    if (call?.line === sink.line && call.owner) {
      owners.add(call.owner);
    }
  }
  return [...owners];
}

/**
 * Check (e): the call stacks are intact and end in the component that carries
 * them. cdxgen publishes a report stack on each component that ships a class
 * the stack's sink calls, and the published frames end at the sink's call
 * site. So for every published stack, a report stack must end at the same
 * file and line, and one of the classes called there must be one the
 * component ships, as the jar namespace map beside the BOM records. Every
 * frame names a class or a file, and lines are positive. A BOM without any
 * stack fails, since the research profile always asks for them. A component
 * the namespace map holds nothing for cannot be verified and is counted, not
 * failed.
 *
 * @param {Object} bom Parsed BOM document.
 * @param {Object|undefined} report Parsed scalasem report.
 * @param {{namespacesOf?: (component: Object) => string[]|undefined}} [resolver]
 * @returns {{ stacks: number, verified: number, unverifiable: number, offenders: {component: string, reason: string}[] }}
 */
export function checkCallStacks(bom, report, resolver = {}) {
  const offenders = [];
  let stacks = 0;
  let verified = 0;
  let unverifiable = 0;
  const reportStacksBySink = new Map();
  for (const stack of report?.callStacks || []) {
    const key = `${stack?.sink?.file}#${stack?.sink?.line}`;
    reportStacksBySink.set(key, [...(reportStacksBySink.get(key) || []), stack]);
  }
  for (const container of bom?.components || []) {
    const frames = container?.evidence?.callstack?.frames;
    if (frames === undefined || frames === null) {
      continue;
    }
    const label = containerLabel(container);
    if (!Array.isArray(frames) || !frames.length) {
      offenders.push({
        component: label,
        reason: "call stack evidence without frames",
      });
      continue;
    }
    stacks++;
    const broken = frames.findIndex(
      (frame) =>
        !frame ||
        typeof frame !== "object" ||
        (!frame.module && !frame.fullFilename) ||
        (frame.line !== undefined &&
          (!Number.isInteger(frame.line) || frame.line < 1)),
    );
    if (broken >= 0) {
      offenders.push({
        component: label,
        reason: `frame ${broken + 1} of ${frames.length} names no class or file, or has no positive line`,
      });
      continue;
    }
    const last = frames[frames.length - 1];
    const reportStacks =
      reportStacksBySink.get(`${last.fullFilename}#${last.line}`) || [];
    if (!reportStacks.length) {
      offenders.push({
        component: label,
        reason: `no report stack has its sink at ${last.fullFilename}#${last.line}`,
      });
      continue;
    }
    const namespaces = resolver.namespacesOf?.(container);
    if (!namespaces?.length) {
      unverifiable++;
      continue;
    }
    const owners = reportStacks.flatMap((stack) => sinkOwners(report, stack));
    if (owners.some((owner) => namespaceCovers(namespaces, owner))) {
      verified++;
    } else {
      offenders.push({
        component: label,
        reason: `the stack ends calling ${owners.join(", ") || "nothing"}, which the component does not ship`,
      });
    }
  }
  if (!stacks && !offenders.length) {
    offenders.push({
      component: "BOM",
      reason: "no component carries a call stack",
    });
  }
  return { stacks, verified, unverifiable, offenders };
}

// The Scala binary versions a component was built for.
function binaryVersionsOf(component) {
  const suffix = scalaCoordinateOfPurl(component?.purl)?.binaryVersion;
  if (suffix) {
    return new Set([suffix]);
  }
  return new Set(
    (component?.properties || [])
      .filter((property) => property?.name === "cdx:scala:compilerVersion")
      .map((property) => property.value),
  );
}

/**
 * Check (f): each library is listed once. Two Maven components with the same
 * normalized coordinates built for an overlapping set of Scala binary
 * versions, or a component whose name is another's group-prefixed staged
 * spelling (`io.appthreat.cpg2-protos_3` beside `io.appthreat:cpg2-protos`),
 * are one library the merge left as two.
 *
 * @param {Object} bom Parsed BOM document.
 * @returns {{ duplicates: {library: string, purls: string[]}[] }}
 */
export function checkSingleSpelling(bom) {
  const components = (bom?.components || []).filter((component) =>
    String(component?.purl || "").startsWith("pkg:maven/"),
  );
  const byKey = new Map();
  for (const component of components) {
    const key = scalaCoordinateOfPurl(component.purl)?.key;
    if (key) {
      byKey.set(key, [...(byKey.get(key) || []), component]);
    }
  }
  const duplicates = [];
  for (const [key, group] of byKey) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const left = binaryVersionsOf(group[i]);
        const right = binaryVersionsOf(group[j]);
        const overlap =
          (!left.size && !right.size) ||
          [...left].some((version) => right.has(version));
        if (overlap) {
          duplicates.push({
            library: key,
            purls: [group[i].purl, group[j].purl],
          });
        }
      }
    }
  }
  const byStagedStem = new Map();
  for (const component of components) {
    if (component.group && component.name) {
      const stem = `${component.group}.${component.name}@${component.version}`;
      byStagedStem.set(stem, [...(byStagedStem.get(stem) || []), component]);
    }
  }
  for (const component of components) {
    const stem = `${parseScalaArtifact(component.name).artifactBase}@${component.version}`;
    const owner = (byStagedStem.get(stem) || []).find(
      (candidate) => candidate !== component,
    );
    if (owner) {
      duplicates.push({
        library: `${owner.group}:${owner.name}`,
        purls: [owner.purl, component.purl],
      });
    }
  }
  return { duplicates };
}

/**
 * Run every check and return the rows the summary table prints. Each row
 * carries the structured result for the tests and a short summary plus
 * ready-to-print failure details.
 *
 * @param {Object} bom Parsed BOM document.
 * @param {Object|undefined} report Parsed scalasem report.
 * @param {{root: string, statFile: Function, namespacesOf?: Function}} resolver
 * @param {{expectedDependencies?: string[], maxOffenders?: number}} [options]
 * @returns {{check: string, pass: boolean, summary: string, details: string[], result: Object}[]}
 */
export function runAllChecks(bom, report, resolver, options = {}) {
  const rows = [];

  const ran = checkScalasemRan(bom, report);
  rows.push({
    check: "scalasem ran over the project",
    pass: ran.problems.length === 0,
    summary: ran.problems.length
      ? `${ran.problems.length} problem(s)`
      : `${ran.filesAnalyzed} files analysed`,
    details: ran.problems,
    result: ran,
  });

  const diagnostics = checkNoScalasemDiagnostics(bom, report);
  const informational = diagnostics.informational
    .map((diagnostic) => `${diagnostic.code} ${diagnostic.count}`)
    .join(", ");
  rows.push({
    check: "no scalasem diagnostics on the metadata component",
    pass: diagnostics.found.length === 0,
    summary: `${
      diagnostics.found.length === 0
        ? "no diagnostic properties"
        : `${diagnostics.found.length} diagnostic properties found`
    }${informational ? `; informational: ${informational}` : ""}`,
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
  const listed = locations.offenders.length;
  rows.push({
    check: "occurrence locations resolve",
    pass: locations.offenderCount === 0,
    summary:
      locations.offenderCount === 0
        ? `${locations.checked} occurrences checked`
        : `${locations.offenderCount} of ${locations.checked} occurrences point nowhere${
            listed < locations.offenderCount ? ` (${listed} listed)` : ""
          }`,
    details: locations.offenders.map(
      (offender) =>
        `${offender.component}: ${offender.location}${
          offender.line === undefined ? "" : `#${offender.line}`
        } (${offender.reason})`,
    ),
    result: locations,
  });

  const callStacks = checkCallStacks(bom, report, resolver);
  rows.push({
    check: "call stacks end in the component that carries them",
    pass: callStacks.offenders.length === 0,
    summary: `${callStacks.stacks} call stacks, ${callStacks.verified} verified${
      callStacks.unverifiable
        ? `, ${callStacks.unverifiable} without namespaces to verify against`
        : ""
    }${
      callStacks.offenders.length
        ? `, ${callStacks.offenders.length} offender(s)`
        : ""
    }`,
    details: callStacks.offenders.map(
      (offender) => `${offender.component}: ${offender.reason}`,
    ),
    result: callStacks,
  });

  const spellings = checkSingleSpelling(bom);
  rows.push({
    check: "each library is listed once",
    pass: spellings.duplicates.length === 0,
    summary: spellings.duplicates.length
      ? `${spellings.duplicates.length} library(ies) listed more than once`
      : "no duplicate spellings",
    details: spellings.duplicates.map(
      (duplicate) => `${duplicate.library}: ${duplicate.purls.join(" and ")}`,
    ),
    result: spellings,
  });

  return rows;
}
