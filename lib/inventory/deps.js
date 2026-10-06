import { lstatSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  delimiter as _delimiter,
  sep as _sep,
  basename,
  dirname,
  join,
} from "node:path";

import { build, Purl } from "@cdxgen/cdx-purl";
import StreamZip from "node-stream-zip";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
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
import { pypiBomRef } from "./purl.js";

const jarNSMapping_cache = {};

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
  const MAVEN_CACHE_DIR =
    readEnvironmentVariable("MAVEN_CACHE_DIR") ||
    join(homedir(), ".m2", "repository");
  const tempDir = safeMkdtempSync(join(tmpdir(), "mvn-deps-"));
  let copyArgs = [
    "dependency:copy-dependencies",
    `-DoutputDirectory=${tempDir}`,
    "-U",
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
    if (result.status !== 0 || result.error) {
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
    } else {
      jarNSMapping = await collectJarNS(tempDir);
    }
  }
  if (includeCacheDir || basePath === MAVEN_CACHE_DIR) {
    // slow operation
    jarNSMapping = await collectJarNS(MAVEN_CACHE_DIR);
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
      let pomname =
        pomPathMap[basename(jf).replace(".jar", ".pom")] ||
        jf.replace(".jar", ".pom");
      let pomData;
      let purl;
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
          const purlObj = new Purl({
            type: "maven",
            namespace: pomData.groupId || "" || null,
            name: pomData.artifactId,
            version: pomData.version || null,
            qualifiers: { type: "jar" } || null,
          });
          purl = purlObj.toString();
        }
      } else if (jf.includes(join(".m2", "repository"))) {
        // Let's try our best to construct a purl for .m2 cache entries of the form
        // .m2/repository/org/apache/logging/log4j/log4j-web/3.0.0-SNAPSHOT/log4j-web-3.0.0-SNAPSHOT.jar
        const tmpA = jf.split(join(".m2", "repository", ""));
        if (tmpA?.length) {
          const tmpJarPath = tmpA[tmpA.length - 1];
          // This would yield log4j-web-3.0.0-SNAPSHOT.jar
          const jarFileName = basename(tmpJarPath).replace(".jar", "");
          const tmpDirParts = dirname(tmpJarPath).split(_sep);
          // Retrieve the version
          let jarVersion = tmpDirParts.pop();
          if (jarVersion === "plugins") {
            jarVersion = tmpDirParts.pop();
            if (jarVersion === "eclipse") {
              jarVersion = tmpDirParts.pop();
            }
          }
          // The result would form the group name
          let jarGroupName = tmpDirParts.join(".").replace(/^\./, "");
          let qualifierType = "jar";
          // Support for p2 bundles and plugins
          // See https://github.com/CycloneDX/cyclonedx-maven-plugin/issues/137
          // See https://github.com/cdxgen/cdxgen/pull/510#issuecomment-1702551615
          if (jarGroupName.startsWith("p2.osgi.bundle")) {
            jarGroupName = "p2.osgi.bundle";
            qualifierType = "osgi-bundle";
          } else if (jarGroupName.startsWith("p2.eclipse.plugin")) {
            jarGroupName = "p2.eclipse.plugin";
            qualifierType = "eclipse-plugin";
          } else if (jarGroupName.startsWith("p2.binary")) {
            jarGroupName = "p2.binary";
            qualifierType = "eclipse-executable";
          } else if (jarGroupName.startsWith("p2.org.eclipse.update.feature")) {
            jarGroupName = "p2.org.eclipse.update.feature";
            qualifierType = "eclipse-feature";
          }
          const purlObj = new Purl({
            type: "maven",
            namespace: jarGroupName || null,
            name: jarFileName.replace(`-${jarVersion}`, ""),
            version: jarVersion || null,
            qualifiers: { type: qualifierType } || null,
          });
          purl = purlObj.toString();
        }
      } else if (jf.includes(join(".gradle", "caches"))) {
        // Let's try our best to construct a purl for gradle cache entries of the form
        // .gradle/caches/modules-2/files-2.1/org.xmlresolver/xmlresolver/4.2.0/f4dbdaa83d636dcac91c9003ffa7fb173173fe8d/xmlresolver-4.2.0-data.jar
        const tmpA = jf.split(join("files-2.1", ""));
        if (tmpA?.length) {
          const tmpJarPath = tmpA[tmpA.length - 1];
          // This would yield xmlresolver-4.2.0-data.jar
          const jarFileName = basename(tmpJarPath).replace(".jar", "");
          const tmpDirParts = dirname(tmpJarPath).split(_sep);
          // This would remove the hash from the end of the directory name
          tmpDirParts.pop();
          // Retrieve the version
          const jarVersion = tmpDirParts.pop();
          const pkgName = jarFileName.replace(`-${jarVersion}`, "");
          // The result would form the group name
          let jarGroupName = tmpDirParts.join(".").replace(/^\./, "");
          if (jarGroupName.includes(pkgName)) {
            jarGroupName = jarGroupName.replace(`.${pkgName}`, "");
          }
          const purlObj = new Purl({
            type: "maven",
            namespace: jarGroupName || null,
            name: pkgName,
            version: jarVersion || null,
            qualifiers: { type: "jar" } || null,
          });
          purl = purlObj.toString();
        }
      }
      // If we have a hit from the cache, use it.
      if (purl && jarNSMapping_cache[purl]) {
        jarNSMapping[purl] = jarNSMapping_cache[purl];
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
        };
        // Retain in the global cache to speed up future lookups
        if (purl) {
          jarNSMapping_cache[purl] = jarNSMapping[purl];
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
  jarMetadata.split("\n").forEach((l) => {
    l = l.replaceAll("\r", "");
    if (l.includes(": ")) {
      const tmpA = l.split(": ");
      if (tmpA && tmpA.length === 2) {
        metadata[tmpA[0]] = tmpA[1].replaceAll("\r", "");
      }
    }
  });
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
  if (!safeExistsSync(mavenDir) || !lstatSync(mavenDir).isDirectory()) {
    return {};
  }
  const pomPropertiesFiles = getAllFiles(mavenDir, "**/pom.properties").sort();
  if (!pomPropertiesFiles?.length) {
    return {};
  }
  const parsed = pomPropertiesFiles.map((f) =>
    parsePomProperties(readFileSync(f, { encoding: "utf-8" })),
  );
  if (parsed.length > 1 && jarName) {
    const stem = jarName.replace(/\.[jwe]ar$/, "");
    const exact = parsed.find(
      (p) =>
        p.artifactId &&
        p.version &&
        (stem === `${p.artifactId}-${p.version}` ||
          stem.startsWith(`${p.artifactId}-${p.version}-`)),
    );
    if (exact) {
      return exact;
    }
    // The longest matching artifactId wins: netty-common-4.1.jar belongs to
    // netty-common, not to an embedded netty descriptor.
    const byName = parsed
      .filter(
        (p) =>
          p.artifactId &&
          (stem === p.artifactId || stem.startsWith(`${p.artifactId}-`)),
      )
      .sort((a, b) => b.artifactId.length - a.artifactId.length);
    if (
      byName.length === 1 ||
      (byName.length > 1 &&
        byName[0].artifactId.length > byName[1].artifactId.length)
    ) {
      return byName[0];
    }
  }
  return parsed[0];
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
