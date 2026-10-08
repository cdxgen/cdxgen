import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter as _delimiter, basename, dirname, join } from "node:path";

import { build, Purl } from "@cdxgen/cdx-purl";
import StreamZip from "node-stream-zip";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { commandOutputText } from "../core/buildLedger.js";
import { parseMavenArgs } from "../core/env.js";
import {
  getAllFiles,
  multiChecksumFile,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
} from "../core/fs.js";
import { isWin } from "../core/paths.js";
import { xml2js } from "../parsers/xml.js";
import { noteBuildToolRateLimit } from "./buildToolRateLimit.js";
import {
  inferMavenCoordinatesFromPath,
  mavenLocalRepositories,
  splitArtifactFileName,
} from "./jvmLocalRepos.js";
import { pypiBomRef } from "./purl.js";
import { findLicenseId, spdxLicenses } from "./spdx.js";

const jarNSMapping_cache = new Map();

/**
 * Whether a jar holds sources or javadoc rather than classes.
 *
 * @param {string} jarName Jar file name.
 * @returns {boolean}
 */
export function isDocumentationJar(jarName) {
  return jarName.endsWith("-sources.jar") || jarName.endsWith("-javadoc.jar");
}

/**
 * Size and modification time of a file, used to tell whether a memoised
 * reading of it is still current.
 *
 * @param {string} file File path.
 * @returns {string} Stamp, or an empty string when the file cannot be read.
 */
function jarFileStamp(file) {
  try {
    const stats = statSync(file);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch (_err) {
    return "";
  }
}

/**
 * Build the purl of a jar. Eclipse p2 artifacts mirrored into a Maven
 * repository keep their dedicated purl type qualifiers.
 *
 * @param {string} group groupId.
 * @param {string} name artifactId.
 * @param {string} version Version.
 * @param {string} [classifier] Classifier.
 * @returns {string} Purl string.
 */
function jarPurl(group, name, version, classifier = undefined) {
  let namespace = group || null;
  let type = "jar";
  // See https://github.com/CycloneDX/cyclonedx-maven-plugin/issues/137
  // and https://github.com/cdxgen/cdxgen/pull/510#issuecomment-1702551615
  for (const [prefix, p2Type] of [
    ["p2.osgi.bundle", "osgi-bundle"],
    ["p2.eclipse.plugin", "eclipse-plugin"],
    ["p2.binary", "eclipse-executable"],
    ["p2.org.eclipse.update.feature", "eclipse-feature"],
  ]) {
    if (namespace?.startsWith(prefix)) {
      namespace = prefix;
      type = p2Type;
      break;
    }
  }
  const qualifiers = { type };
  if (classifier) {
    qualifiers.classifier = classifier;
  }
  return new Purl({
    type: "maven",
    namespace,
    name,
    version: version || null,
    qualifiers,
  }).toString();
}

/**
 * Collect maven dependencies
 *
 * @param {string} mavenCmd Maven command to use
 * @param {string} basePath Path to the maven project
 * @param {boolean} cleanup Remove temporary directories
 * @param {boolean} includeCacheDir Include maven and gradle cache directories
 */
export async function collectMvnDependencies(
  mavenCmd,
  basePath,
  cleanup = true,
  includeCacheDir = false,
) {
  let jarNSMapping = {};
  // MAVEN_CACHE_DIR when set, otherwise the local repository Maven itself
  // uses for this project.
  const MAVEN_CACHE_DIR =
    readEnvironmentVariable("MAVEN_CACHE_DIR") ||
    mavenLocalRepositories({ projectDir: basePath || undefined }).find((repo) =>
      safeExistsSync(repo),
    ) ||
    join(homedir(), ".m2", "repository");
  const tempDir = safeMkdtempSync(join(tmpdir(), "mvn-deps-"));
  // No -U: forcing update checks re-requests every maven-metadata.xml and
  // every artifact Maven already knows is missing, once per module.
  let copyArgs = [
    "dependency:copy-dependencies",
    `-DoutputDirectory=${tempDir}`,
    "-Dmdep.copyPom=true",
    "-Dmdep.useRepositoryLayout=true",
    "-Dmdep.includeScope=compile",
    `-Dmdep.prependGroupId=${readEnvironmentVariable("MAVEN_PREPEND_GROUP") || "false"}`,
    `-Dmdep.stripVersion=${readEnvironmentVariable("MAVEN_STRIP_VERSION") || "false"}`,
  ];
  if (readEnvironmentVariable("MVN_ARGS")) {
    const addArgs = parseMavenArgs(readEnvironmentVariable("MVN_ARGS"));
    copyArgs = copyArgs.concat(addArgs);
  }
  if (basePath && basePath !== MAVEN_CACHE_DIR) {
    console.log(`Executing '${mavenCmd} in ${basePath}`);
    const result = safeSpawnSync(mavenCmd, copyArgs, {
      cwd: basePath,
      shell: isWin,
    });
    const rateLimited = noteBuildToolRateLimit(
      "maven",
      commandOutputText(result),
      {
        command: `${basename(mavenCmd)} ${copyArgs.join(" ")}`,
        exitCode: typeof result.status === "number" ? result.status : undefined,
      },
    );
    if (result.status !== 0 || result.error) {
      if (!rateLimited) {
        console.error(result.stderr, result.error);
        console.log(
          "You can try the following remediation tips to resolve this error:\n",
        );
        console.log(
          "1. Check if the correct version of maven is installed and available in the PATH. Check if the environment variable MVN_ARGS needs to be set.",
        );
        console.log(
          "2. Perform 'mvn compile package' before invoking this command. Fix any errors found during this invocation.",
        );
        console.log(
          "3. Ensure the temporary directory is available and has sufficient disk space to copy all the artifacts.",
        );
      }
    } else {
      jarNSMapping = await collectJarNS(tempDir);
    }
  }
  if (includeCacheDir || basePath === MAVEN_CACHE_DIR) {
    // slow operation. The project's own dependencies, copied above, take
    // precedence over the rest of the cache.
    jarNSMapping = {
      ...(await collectJarNS(MAVEN_CACHE_DIR)),
      ...jarNSMapping,
    };
  }

  // Clean up
  if (cleanup && tempDir?.startsWith(tmpdir())) {
    safeRmSync(tempDir, { recursive: true, force: true });
  }
  return jarNSMapping;
}

/**
 * Method to collect class names from all jars in a directory
 *
 * @param {string} jarPath Path containing jars
 * @param {object} pomPathMap Map containing jar to pom names. Required to successfully parse gradle cache.
 *
 * @return object containing jar name and class list
 */
export async function collectJarNS(jarPath, pomPathMap = {}) {
  const jarNSMapping = {};
  const env = {
    ...process.env,
  };
  // jar command usually would not be available in the PATH for windows
  if (isWin && env.JAVA_HOME) {
    env.PATH = `${env.PATH || env.Path}${_delimiter}${join(
      env.JAVA_HOME,
      "bin",
    )}`;
  }
  // Parse jar files to get class names
  const jarFiles = jarPath.endsWith(".jar")
    ? [jarPath]
    : getAllFiles(jarPath, "**/*.jar");
  if (jarFiles?.length) {
    for (const jf of jarFiles) {
      const jarName = basename(jf);
      // Sources and javadoc jars hold no runtime classes. Reading them would
      // attach their hashes to the main artifact's purl.
      if (isDocumentationJar(jarName)) {
        continue;
      }
      let pomname =
        pomPathMap[jarName.replace(".jar", ".pom")] ||
        jf.replace(".jar", ".pom");
      let pomData;
      let purl;
      let manifestLicenses;
      // In some cases, the pom name might be slightly different to the jar name
      if (!safeExistsSync(pomname)) {
        let searchDir = dirname(jf);
        // in case of gradle, there would be hash directory that is different for jar vs pom
        // so we need to start search from a level up
        if (searchDir.includes(join(".gradle", "caches"))) {
          searchDir = join(searchDir, "..");
        }
        const pomSearch = getAllFiles(searchDir, "**/*.pom");
        if (pomSearch && pomSearch.length === 1) {
          pomname = pomSearch[0];
        }
      }
      if (safeExistsSync(pomname)) {
        // TODO: Replace with parsePom which contains pomPurl
        pomData = parsePomXml(readFileSync(pomname, { encoding: "utf-8" }));
        if (pomData) {
          purl = jarPurl(
            pomData.groupId,
            pomData.artifactId,
            pomData.version,
            pomData.version
              ? splitArtifactFileName(
                  jarName,
                  pomData.artifactId,
                  pomData.version,
                )?.classifier
              : undefined,
          );
        }
      } else {
        const coordinates = inferMavenCoordinatesFromPath(jf);
        if (coordinates?.extension === "jar") {
          purl = jarPurl(
            coordinates.group,
            coordinates.name,
            coordinates.version,
            coordinates.classifier,
          );
        }
        // No POM sits beside this jar, but the jar carries its own Maven
        // descriptor, so its metadata and manifest licence are read here,
        // before any remote lookup. Only a jar whose path names its
        // coordinates is read: they choose its descriptor, and an entry
        // without a purl never becomes a component.
        if (purl) {
          const embedded = await readEmbeddedJarMetadata(jf, coordinates);
          if (embedded?.pomXml) {
            try {
              pomData = parsePomXml(embedded.pomXml);
            } catch (_err) {
              pomData = undefined;
            }
          }
          if (embedded?.manifestLicenses?.length) {
            manifestLicenses = embedded.manifestLicenses;
          }
        }
      }
      // If we have a hit from the cache, use it. The entry is reused only
      // for the same file, unchanged, so a rebuilt SNAPSHOT is read again.
      const fileStamp = jarFileStamp(jf);
      const cached = purl ? jarNSMapping_cache.get(purl) : undefined;
      if (cached && cached.jarFile === jf && cached.stamp === fileStamp) {
        jarNSMapping[purl] = cached.entry;
      } else {
        if (DEBUG_MODE) {
          console.log(`Parsing ${jf}`);
        }
        const [nsList, hashValues] = await Promise.all([
          getJarClasses(jf),
          multiChecksumFile(["md5", "sha1", "sha256", "sha512"], jf).catch(
            () => undefined,
          ),
        ]);
        let hashes;
        if (hashValues) {
          hashes = [
            { alg: "MD5", content: hashValues["md5"] },
            { alg: "SHA-1", content: hashValues["sha1"] },
            { alg: "SHA-256", content: hashValues["sha256"] },
            { alg: "SHA-512", content: hashValues["sha512"] },
          ];
        }
        jarNSMapping[purl || jf] = {
          jarFile: jf,
          pom: pomData,
          namespaces: nsList,
          hashes,
          ...(manifestLicenses?.length ? { manifestLicenses } : {}),
        };
        // Retain in the global cache to speed up future lookups
        if (purl) {
          jarNSMapping_cache.set(purl, {
            jarFile: jf,
            stamp: fileStamp,
            entry: jarNSMapping[purl],
          });
        }
      }
    }
    if (!jarNSMapping) {
      console.log(`Unable to determine class names for the jars in ${jarPath}`);
    }
  } else {
    console.log(
      `${jarPath} did not contain any jars. Try building the project to improve the BOM precision.`,
    );
  }
  return jarNSMapping;
}

/**
 * Convert a JAR namespace mapping (produced by {@link collectJarNS}) into an array
 * of CycloneDX package component objects.
 *
 * Each entry in the mapping is resolved to a component with name, group, version,
 * purl, hashes, namespace properties, and source file evidence.
 *
 * @param {Object} jarNSMapping Map of purl string to `{ jarFile, pom, namespaces, hashes }`
 * @returns {Promise<Object[]>} Array of component objects derived from the JAR mapping
 */
export async function convertJarNSToPackages(jarNSMapping) {
  const pkgList = [];
  for (const purl of Object.keys(jarNSMapping)) {
    let { jarFile, pom, namespaces, hashes } = jarNSMapping[purl];
    if (!pom) {
      pom = {};
    }
    let purlObj;
    try {
      purlObj = Purl.parse(purl);
    } catch (_e) {
      // ignore
      purlObj = {};
    }
    const name = pom.artifactId || purlObj.name;
    if (!name) {
      console.warn(
        `Unable to identify the metadata for ${purl}. This will be skipped.`,
      );
      continue;
    }
    const apackage = {
      name,
      group: pom.groupId || purlObj.namespace || "",
      version: pom.version || purlObj.version,
      description: (pom.description || "").trim(),
      purl,
      "bom-ref": decodeURIComponent(purl),
      hashes,
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.3,
          methods: [
            {
              technique: "filename",
              confidence: 0.3,
              value: jarFile,
            },
          ],
        },
      },
      properties: [
        {
          name: "internal:SrcFile",
          value: jarFile,
        },
        {
          name: "internal:Namespaces",
          value: namespaces.join("\n"),
        },
      ],
    };
    if (pom.url) {
      apackage["homepage"] = { url: pom.url };
    }
    if (pom.scm) {
      apackage["repository"] = { url: pom.scm };
    }
    pkgList.push(apackage);
  }
  return pkgList;
}

/**
 * Deprecated function to parse pom.xml. Use parsePom instead.
 *
 * @deprecated
 * @param pomXmlData XML contents
 * @returns {Object} Parent component data
 */
export function parsePomXml(pomXmlData) {
  if (!pomXmlData) {
    return undefined;
  }
  const project = xml2js(pomXmlData, {
    compact: true,
    spaces: 4,
    textKey: "_",
    attributesKey: "$",
    commentKey: "value",
  }).project;
  if (project) {
    let version = project.version ? project.version._ : undefined;
    if (!version && project.parent) {
      version = project.parent.version._;
    }
    let groupId = project.groupId ? project.groupId._ : undefined;
    if (!groupId && project.parent) {
      groupId = project.parent.groupId._;
    }
    return {
      artifactId: project.artifactId ? project.artifactId._ : "",
      groupId,
      version,
      description: project.description ? project.description._ : "",
      url: project.url ? project.url._ : "",
      scm: project.scm?.url ? project.scm.url._ : "",
      licenses: project.licenses?.license,
      organization: project.organization,
    };
  }
  return undefined;
}

/**
 * Parse a JAR MANIFEST.MF file and return its key-value pairs as an object.
 *
 * @param {string} jarMetadata Raw text contents of a MANIFEST.MF file
 * @returns {Object} Key-value pairs extracted from the manifest
 */
export function parseJarManifest(jarMetadata) {
  const metadata = {};
  if (!jarMetadata) {
    return metadata;
  }
  // Manifests wrap at 72 bytes: a line that starts with a single space
  // continues the header above it.
  let name;
  for (const rawLine of jarMetadata.split("\n")) {
    const l = rawLine.replaceAll("\r", "");
    if (l.startsWith(" ")) {
      if (name !== undefined) {
        metadata[name] += l.slice(1);
      }
      continue;
    }
    name = undefined;
    const at = l.indexOf(": ");
    if (at > 0) {
      name = l.slice(0, at);
      metadata[name] = l.slice(at + 2);
    }
  }
  return metadata;
}

/**
 * Determine whether a manifest candidate looks like a namespace-qualified identifier.
 *
 * @param {string} candidate Manifest field value
 * @returns {boolean} True when candidate appears namespace-qualified
 */
function isQualifiedJarNamespace(candidate) {
  return (
    !!candidate &&
    !candidate.includes(" ") &&
    (candidate.includes(".") || candidate.includes("-"))
  );
}

/**
 * Select the most reliable group candidate from JAR manifest metadata.
 *
 * @param {Object} jarMetadata Parsed MANIFEST.MF key-value map
 * @returns {string} Best group candidate, or empty string if none exists
 */
export function inferJarGroupFromManifest(jarMetadata = {}) {
  // Keep this ordered from most to least namespace-qualified manifest fields.
  // Extension-Name is intentionally lower priority due to inconsistent usage.
  const qualifiedCandidates = [
    jarMetadata["Bundle-SymbolicName"],
    jarMetadata["Automatic-Module-Name"],
    jarMetadata["Implementation-Title"],
    jarMetadata["Extension-Name"],
  ];
  for (const candidate of qualifiedCandidates) {
    if (isQualifiedJarNamespace(candidate)) {
      return candidate;
    }
  }
  return (
    jarMetadata["Implementation-Vendor-Id"] ||
    jarMetadata["Bundle-Vendor"] ||
    jarMetadata["Extension-Name"] ||
    ""
  );
}

/**
 * Trim group suffix that duplicates the artifact name for compound artifact names.
 *
 * @param {string} group Group candidate
 * @param {string} name Artifact name candidate
 * @returns {string} Adjusted group
 */
export function trimJarGroupSuffix(group, name) {
  if (!group || !name || group.startsWith("javax")) {
    return group;
  }
  // Only trim when the artifact name contains a separator (hyphen or dot).
  if (!name.includes("-") && !name.includes(".")) {
    return group;
  }
  const lowerName = name.toLowerCase();
  const dottedName = lowerName.replace(/-/g, ".");
  const dottedSuffix = `.${dottedName}`;
  if (group.endsWith(dottedSuffix)) {
    return group.slice(0, -dottedSuffix.length);
  }
  const lowerSuffix = `.${lowerName}`;
  if (group.endsWith(lowerSuffix)) {
    return group.slice(0, -lowerSuffix.length);
  }
  return group;
}

/**
 * Parse a Maven pom.properties file and return its key-value pairs as an object.
 *
 * @param {string} pomProperties Raw text contents of a pom.properties file
 * @returns {Object} Key-value pairs extracted from the properties file
 */
export function parsePomProperties(pomProperties) {
  const properties = {};
  if (!pomProperties) {
    return properties;
  }
  pomProperties.split("\n").forEach((l) => {
    l = l.replaceAll("\r", "");
    if (l.includes("=")) {
      const separatorIndex = l.indexOf("=");
      if (separatorIndex !== -1) {
        properties[l.slice(0, separatorIndex)] = l.slice(separatorIndex + 1);
      }
    }
  });
  return properties;
}
/**
 * Method to get pom properties from maven directory
 *
 * A shaded or fat jar carries a `pom.properties` for every artifact folded
 * into it. When the jar's file name is known, the descriptor whose
 * `artifactId-version` (or `artifactId`) starts the file name is the jar's
 * own; otherwise the first descriptor is used, as before.
 *
 * @param {string} mavenDir Path to maven directory
 * @param {string} [jarName] File name of the jar the directory came from
 *
 * @return array with pom properties
 */
export function getPomPropertiesFromMavenDir(mavenDir, jarName = undefined) {
  return selectEmbeddedDescriptor(mavenDir, jarName)?.properties ?? {};
}

/**
 * Choose the embedded Maven descriptor of one jar from every descriptor an
 * extracted `META-INF/maven` directory holds.
 *
 * @param {string} mavenDir Path to the extracted META-INF/maven directory
 * @param {string} [jarName] File name of the jar the directory came from
 * @returns {{file: string, properties: Object}|undefined} The chosen
 *   descriptor, or undefined when the directory holds none.
 */
function selectEmbeddedDescriptor(mavenDir, jarName = undefined) {
  if (!safeExistsSync(mavenDir) || !lstatSync(mavenDir).isDirectory()) {
    return undefined;
  }
  const pomPropertiesFiles = getAllFiles(mavenDir, "**/pom.properties").sort();
  if (!pomPropertiesFiles?.length) {
    return undefined;
  }
  const candidates = pomPropertiesFiles.map((f) => ({
    file: f,
    properties: parsePomProperties(readFileSync(f, { encoding: "utf-8" })),
  }));
  const parsed = candidates.map((c) => c.properties);
  if (parsed.length > 1 && jarName) {
    const stem = jarName.replace(/\.[jwe]ar$/, "");
    const exact = candidates.find(
      (c) =>
        c.properties.artifactId &&
        c.properties.version &&
        (stem === `${c.properties.artifactId}-${c.properties.version}` ||
          stem.startsWith(
            `${c.properties.artifactId}-${c.properties.version}-`,
          )),
    );
    if (exact) {
      return exact;
    }
    // The longest matching artifactId wins: netty-common-4.1.jar belongs to
    // netty-common, not to an embedded netty descriptor.
    const byName = candidates
      .filter(
        (c) =>
          c.properties.artifactId &&
          (stem === c.properties.artifactId ||
            stem.startsWith(`${c.properties.artifactId}-`)),
      )
      .sort(
        (a, b) =>
          b.properties.artifactId.length - a.properties.artifactId.length,
      );
    if (
      byName.length === 1 ||
      (byName.length > 1 &&
        byName[0].properties.artifactId.length >
          byName[1].properties.artifactId.length)
    ) {
      return byName[0];
    }
  }
  return candidates[0];
}

/** Per-entry size bounds for the Maven descriptor files read out of a jar.
 * The jar is untrusted input, and its declared entry sizes are the only cheap
 * defence against an archive that expands without bound. */
const EMBEDDED_POM_PROPERTIES_LIMIT = 64 * 1024;
const EMBEDDED_POM_XML_LIMIT = 1024 * 1024;
const EMBEDDED_MANIFEST_LIMIT = 256 * 1024;
/** A shaded jar can fold in thousands of descriptors; reading a bounded
 * number keeps a hostile archive from turning one zip listing into
 * unbounded work. */
const EMBEDDED_DESCRIPTOR_LIMIT = 500;

/**
 * Read a file, refusing anything larger than the bound, so a jar whose
 * descriptor declares a huge size is never fully read.
 *
 * @param {string} file File path.
 * @param {number} limit Size bound in bytes.
 * @returns {string|undefined} File contents, or undefined when missing or too large.
 */
function readBoundedFile(file, limit) {
  try {
    if (!safeExistsSync(file) || statSync(file).size > limit) {
      return undefined;
    }
    return readFileSync(file, { encoding: "utf-8" });
  } catch (_err) {
    return undefined;
  }
}

/**
 * Split a manifest header value on a separator that is not inside double
 * quotes. Quoted strings hold commas and semicolons of their own, as in
 * `description="Apache License, Version 2.0"`.
 *
 * @param {string} value Header value.
 * @param {string} separator One character.
 * @returns {string[]} The parts, quotes kept.
 */
function splitOutsideQuotes(value, separator) {
  const parts = [];
  let current = "";
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === separator && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Trim a manifest value and remove one pair of surrounding double quotes.
 *
 * @param {string} value Value.
 * @returns {string} The bare value.
 */
function unquoteManifestValue(value) {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

/**
 * The licences a MANIFEST.MF `Bundle-License` value names. The value is a
 * comma-separated list; each item is an SPDX id, a licence name or a URL,
 * optionally followed by `;link=` and `;description=` attributes, and any
 * part may be quoted. Each item is mapped through findLicenseId; an item it
 * cannot map is replaced by its `link` URL when one is given, which the
 * licence URL lookup resolves later. `<<EXTERNAL>>` names no licence.
 *
 * @param {string} value Raw Bundle-License value.
 * @returns {string[]} Licence ids, names or URLs, without duplicates.
 */
export function parseManifestLicenseList(value) {
  if (!value || typeof value !== "string") {
    return [];
  }
  const licenses = [];
  for (const clause of splitOutsideQuotes(value, ",")) {
    const [rawName, ...attributes] = splitOutsideQuotes(clause, ";");
    const name = unquoteManifestValue(rawName);
    if (!name || name === "<<EXTERNAL>>") {
      continue;
    }
    let link;
    for (const attribute of attributes) {
      const at = attribute.indexOf("=");
      if (at > 0 && attribute.slice(0, at).trim() === "link") {
        link = unquoteManifestValue(attribute.slice(at + 1));
      }
    }
    const id = findLicenseId(name);
    const mapped = id !== name || spdxLicenses.includes(name);
    const license = mapped ? id : link?.startsWith("http") ? link : name;
    if (license && !licenses.includes(license)) {
      licenses.push(license);
    }
  }
  return licenses;
}

/**
 * The Maven descriptor a jar carries for itself, read from an extracted
 * `META-INF/maven` directory: the pom.properties that names the jar's own
 * coordinates and the pom.xml stored beside it.
 *
 * @param {string} mavenDir Path to the extracted META-INF/maven directory
 * @param {string} [jarName] File name of the jar the directory came from
 * @returns {{properties: Object, pomXml?: string}|undefined} The chosen
 *   descriptor, with its pom.xml text when one is stored beside it.
 */
export function readEmbeddedMavenDescriptor(mavenDir, jarName = undefined) {
  const selected = selectEmbeddedDescriptor(mavenDir, jarName);
  if (!selected) {
    return undefined;
  }
  const pomXml = readBoundedFile(
    join(dirname(selected.file), "pom.xml"),
    EMBEDDED_POM_XML_LIMIT,
  );
  return pomXml
    ? { properties: selected.properties, pomXml }
    : { properties: selected.properties };
}

/**
 * Choose the descriptor of the jar itself from the descriptors held inside
 * its zip: the one whose pom.properties names the jar's own group and
 * artifact, the matching version first. A shaded jar holds many descriptors
 * whose coordinates belong to the folded-in artifacts, so when none matches,
 * nothing is chosen rather than a dependency's descriptor.
 *
 * @param {Array<{name: string, properties: Object}>} descriptors Descriptors found in the zip.
 * @param {{group: string, name: string, version: string}} coordinates The jar's own coordinates.
 * @returns {{name: string, properties: Object}|undefined}
 */
function chooseZipDescriptor(descriptors, coordinates) {
  if (!coordinates?.group || !coordinates.name) {
    return undefined;
  }
  const byCoordinates = descriptors.filter(
    (d) =>
      d.properties.groupId === coordinates.group &&
      d.properties.artifactId === coordinates.name,
  );
  const byVersion = byCoordinates.find(
    (d) => coordinates.version && d.properties.version === coordinates.version,
  );
  return byVersion || byCoordinates[0];
}

/**
 * The Maven descriptor and manifest licence a jar carries for itself, read
 * from its zip without extracting it. Entry names are only matched and
 * paired, never used as paths, and each entry is read only under a size
 * bound, because the archive is untrusted input.
 *
 * @param {string} jarFile Path to the jar.
 * @param {{group: string, name: string, version: string}} coordinates The jar's own coordinates, which choose its descriptor.
 * @returns {Promise<{properties?: Object, pomXml?: string, manifestLicenses?: string[]}|undefined>}
 */
export async function readEmbeddedJarMetadata(jarFile, coordinates) {
  let zip;
  try {
    zip = new StreamZip.async({ file: jarFile });
    const entries = await zip.entries();
    const decoder = new TextDecoder("utf-8");
    const descriptors = [];
    const pomEntries = new Map();
    let manifestEntry;
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) {
        continue;
      }
      if (
        !manifestEntry &&
        entry.name === "META-INF/MANIFEST.MF" &&
        entry.size <= EMBEDDED_MANIFEST_LIMIT
      ) {
        manifestEntry = entry;
        continue;
      }
      if (!entry.name.startsWith("META-INF/maven/")) {
        continue;
      }
      if (entry.name.endsWith("/pom.properties")) {
        if (
          descriptors.length >= EMBEDDED_DESCRIPTOR_LIMIT ||
          entry.size > EMBEDDED_POM_PROPERTIES_LIMIT
        ) {
          continue;
        }
        const text = decoder.decode(
          Buffer.from(await zip.entryData(entry.name)),
        );
        descriptors.push({
          name: entry.name,
          properties: parsePomProperties(text),
        });
      } else if (entry.name.endsWith("/pom.xml")) {
        const dir = entry.name.slice(0, -"pom.xml".length);
        if (!pomEntries.has(dir)) {
          pomEntries.set(dir, entry);
        }
      }
    }
    const chosen = chooseZipDescriptor(descriptors, coordinates);
    const result = {};
    if (chosen) {
      result.properties = chosen.properties;
      const dir = chosen.name.slice(0, -"pom.properties".length);
      const pomEntry = pomEntries.get(dir);
      if (pomEntry && pomEntry.size <= EMBEDDED_POM_XML_LIMIT) {
        result.pomXml = decoder.decode(
          Buffer.from(await zip.entryData(pomEntry.name)),
        );
      }
    }
    if (manifestEntry) {
      const manifest = parseJarManifest(
        decoder.decode(
          Buffer.from(await zip.entryData("META-INF/MANIFEST.MF")),
        ),
      );
      const licenses = parseManifestLicenseList(manifest["Bundle-License"]);
      if (licenses.length) {
        result.manifestLicenses = licenses;
      }
    }
    return chosen || manifestEntry ? result : undefined;
  } catch (_err) {
    return undefined;
  } finally {
    try {
      await zip.close();
    } catch (_err) {
      // An already-failed zip reports its close as well.
    }
  }
}

/**
 * Method to read a single file entry from a zip file
 *
 * @param {string} zipFile Zip file to read
 * @param {string} filePattern File pattern
 * @param {string} contentEncoding Encoding. Defaults to utf-8
 *
 * @returns {Promise<string|undefined>} File contents
 */
export async function readZipEntry(
  zipFile,
  filePattern,
  contentEncoding = "utf-8",
) {
  /** @type {string|undefined} */
  let retData;
  try {
    const zip = new StreamZip.async({ file: zipFile });
    const entriesCount = await zip.entriesCount;
    if (!entriesCount) {
      return undefined;
    }
    const entries = await zip.entries();
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) {
        continue;
      }
      if (entry.name.endsWith(filePattern)) {
        const fileData = await zip.entryData(entry.name);
        let decoder;
        try {
          let enc = contentEncoding;
          if (enc) {
            const lower = enc.toLowerCase();
            if (lower === "ucs2" || lower === "ucs-2") {
              enc = "utf-16le";
            }
          }
          decoder = new TextDecoder(enc);
        } catch (_err) {
          decoder = new TextDecoder("utf-8");
        }
        retData = decoder.decode(Buffer.from(fileData));
        break;
      }
    }
    await zip.close();
  } catch (e) {
    console.log(e);
  }
  return retData;
}

/**
 * Read every zip entry whose name contains `pathFragment`. Unlike
 * `readZipEntry`, which returns the first matching entry, this enumerates all
 * matches — needed for PEP 770, where a distribution may carry several SBOM
 * documents under `<dist>.dist-info/sboms/`, in a directory whose name is
 * prefixed by the distribution stem and so is not known in advance.
 *
 * Entries larger than `maxEntryBytes` are skipped without being decompressed,
 * because a wheel is untrusted input and its declared sizes are the only cheap
 * defence against an archive that expands without bound.
 *
 * @param {string} zipFile Path to a zip archive (e.g. a wheel)
 * @param {string} pathFragment Substring an entry name must contain
 * @param {Object} [opts] Options
 * @param {string} [opts.contentEncoding] Text encoding. Defaults to utf-8
 * @param {number} [opts.maxEntryBytes] Per-entry uncompressed size bound
 * @returns {Promise<Array<{name: string, data: string}>>} Matching entries
 */
export async function readZipEntriesMatching(
  zipFile,
  pathFragment,
  { contentEncoding = "utf-8", maxEntryBytes = 5 * 1024 * 1024 } = {},
) {
  const results = [];
  let zip;
  try {
    zip = new StreamZip.async({ file: zipFile });
    const entries = await zip.entries();
    let decoder;
    try {
      const lower = String(contentEncoding).toLowerCase();
      decoder = new TextDecoder(
        lower === "ucs2" || lower === "ucs-2" ? "utf-16le" : contentEncoding,
      );
    } catch (_err) {
      decoder = new TextDecoder("utf-8");
    }
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) {
        continue;
      }
      if (pathFragment && !entry.name.includes(pathFragment)) {
        continue;
      }
      if (entry.size > maxEntryBytes) {
        if (DEBUG_MODE) {
          console.log(
            `Skipping ${entry.name} in ${zipFile}: ${entry.size} bytes exceeds the ${maxEntryBytes} byte limit.`,
          );
        }
        continue;
      }
      const fileData = await zip.entryData(entry.name);
      results.push({
        name: entry.name,
        data: decoder.decode(Buffer.from(fileData)),
      });
    }
  } catch (err) {
    if (DEBUG_MODE) {
      console.log(`Unable to read the entries of ${zipFile}`, err);
    }
  } finally {
    await zip?.close();
  }
  return results;
}

/**
 * Method to get the classes and relevant sources in a jar file
 *
 * @param {string} jarFile Jar file to read
 *
 * @returns List of classes and sources matching certain known patterns
 */
export async function getJarClasses(jarFile) {
  const retList = [];
  try {
    const zip = new StreamZip.async({ file: jarFile });
    const entriesCount = await zip.entriesCount;
    if (!entriesCount) {
      return [];
    }
    const entries = await zip.entries();
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) {
        continue;
      }
      if (
        (entry.name.includes(".class") ||
          entry.name.includes(".java") ||
          entry.name.includes(".scala") ||
          entry.name.includes(".groovy") ||
          entry.name.includes(".kt")) &&
        !entry.name.includes("-INF") &&
        !entry.name.includes("module-info")
      ) {
        retList.push(
          entry.name
            .replaceAll("\r", "")
            .replace(/\.(class|java|kt|scala|groovy)$/, "")
            .replace(/\/$/, "")
            .replace(/\//g, "."),
        );
      }
    }
    await zip.close();
  } catch (e) {
    // node-stream-zip seems to fail on deno with a RangeError.
    // So we fallback to using jar -tf command
    if (e.name === "RangeError") {
      const jarResult = safeSpawnSync("jar", ["-tf", jarFile], {
        shell: isWin,
      });
      if (
        jarResult?.stderr?.includes(
          "is not recognized as an internal or external command",
        )
      ) {
        return retList;
      }
      const consolelines = (jarResult.stdout || "").split("\n");
      return consolelines
        .filter((l) => {
          return (
            (l.includes(".class") ||
              l.includes(".java") ||
              l.includes(".scala") ||
              l.includes(".groovy") ||
              l.includes(".kt")) &&
            !l.includes("-INF") &&
            !l.includes("module-info")
          );
        })
        .map((e) => {
          return e
            .replaceAll("\r", "")
            .replace(/\.(class|java|kt|scala|groovy)$/, "")
            .replace(/\/$/, "")
            .replace(/\//g, ".");
        });
    }
  }
  return retList;
}

/**
 * Recursively flatten a Python package's transitive dependencies into the
 * dependencies map and flat package list.
 *
 * @param {Object} dependenciesMap Map of bom-ref to the list of dependent bom-refs, mutated in place
 * @param {Object[]} pkgList Flat list of package component objects, mutated in place
 * @param {string} reqOrSetupFile Path to the requirements.txt or setup.py file used as evidence
 * @param {Object} t Root package object with name, version, and nested dependencies
 * @returns {void}
 */
export function flattenDeps(dependenciesMap, pkgList, reqOrSetupFile, t) {
  const tRef = pypiBomRef(t.name, t.version);
  const dependsOn = [];
  for (const d of t.dependencies) {
    const pkgRef = pypiBomRef(d.name, d.version);
    dependsOn.push(pkgRef);
    if (!dependenciesMap[pkgRef]) {
      dependenciesMap[pkgRef] = [];
    }
    const purlString = build({
      type: "pypi",
      namespace: "" || null,
      name: d.name,
      version: d.version || null,
    });
    const apkg = {
      name: d.name,
      version: d.version,
      purl: purlString,
      "bom-ref": decodeURIComponent(purlString),
    };
    if (reqOrSetupFile) {
      apkg.properties = [
        {
          name: "internal:SrcFile",
          value: reqOrSetupFile,
        },
      ];
      apkg.evidence = {
        identity: {
          field: "purl",
          confidence: 0.8,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.8,
              value: reqOrSetupFile,
            },
          ],
        },
      };
    }
    pkgList.push(apkg);
    // Recurse and flatten
    if (d.dependencies && d.dependencies) {
      flattenDeps(dependenciesMap, pkgList, reqOrSetupFile, d);
    }
  }
  dependenciesMap[tRef] = (dependenciesMap[tRef] || [])
    .concat(dependsOn)
    .sort();
}

/**
 * Comparator function for sorting CycloneDX component objects.
 *
 * Compares components by `bom-ref`, then `purl`, then `name`, using locale-aware
 * string comparison on the first available key.
 *
 * @param {Object|string} a First component to compare
 * @param {Object|string} b Second component to compare
 * @returns {number} Negative, zero, or positive integer as required by Array.sort
 */
export function componentSorter(a, b) {
  if (a && b) {
    for (const k of ["bom-ref", "purl", "name"]) {
      if (a[k] && b[k]) {
        return a[k].localeCompare(b[k]);
      }
    }
  }
  return a.localeCompare(b);
}
