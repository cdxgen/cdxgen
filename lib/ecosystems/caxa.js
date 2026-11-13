import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { shouldFetchPackageMetadata } from "../core/env.js";
import {
  getAllFiles,
  getTmpDir,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
} from "../core/fs.js";
import { sanitizeIngestedPurl } from "../inventory/purl.js";
import { extractJarArchive, getNpmMetadata } from "./ecosystems.js";
import { parsePnpmLock } from "./parsers-js.js";
import { parseComposerJson, parseComposerLock } from "./parsers-misc.js";
import { parseGemfileLockData } from "./rubyutils.js";

// The name of the executable is repeated in the evidence of every component,
// so the BOM grows by its length times the number of components. A name longer
// than a file name can be is not used as evidence.
const MAX_EXECUTABLE_NAME_LENGTH = 255;

/**
 * Parse caxa self-extracting executable metadata.
 *
 * @param {string} mfile Path to the caxa metadata file.
 * @returns {Promise<Object>} Parsed metadata object.
 */
export async function parseCaxaMetadata(mfile) {
  let mdata;
  try {
    mdata = JSON.parse(readFileSync(mfile));
  } catch (_e) {
    return {};
  }
  if (!mdata?.components) {
    return {};
  }
  const { parentComponent } = mdata;
  if (parentComponent) {
    parentComponent.properties = parentComponent.properties || [];
    parentComponent.properties.push({
      name: "internal:is_executable",
      value: "true",
    });
    // These purls are authored by @cdxgen/caxa, not by cdxgen. Older caxa
    // releases emitted arch/platform qualifiers that the generic purl type does
    // not allow, so anything invalid is repaired or dropped here rather than
    // being copied into the output and failing validation later.
    sanitizeIngestedPurl(parentComponent);
    for (const child of parentComponent.components || []) {
      sanitizeIngestedPurl(child);
    }
  }
  for (const comp of mdata.components) {
    comp.scope = "required";
    comp.properties = comp.properties || [];
    sanitizeIngestedPurl(comp);
    for (const child of comp.components || []) {
      sanitizeIngestedPurl(child);
    }
    // Guard the string check: a component from external metadata may have no
    // purl at all, and `.startsWith` on undefined throws.
    if (comp.purl?.startsWith("pkg:generic/node@")) {
      comp.properties.push({
        name: "internal:is_executable",
        value: "true",
      });
    }
    // The binary-analysis method names the executable the component was found
    // in, which only a parent component can supply. Any `*metadata.json` in
    // the scanned tree reaches this parser, so a document with components and
    // no parent is ordinary input rather than a broken caxa build.
    const methods = [];
    if (
      typeof parentComponent?.name === "string" &&
      parentComponent.name.length &&
      parentComponent.name.length <= MAX_EXECUTABLE_NAME_LENGTH
    ) {
      methods.push({
        technique: "binary-analysis",
        confidence: 1,
        value: parentComponent.name,
      });
    }
    comp.evidence = {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          ...methods,
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: mfile,
          },
        ],
      },
    };
  }
  if (shouldFetchPackageMetadata()) {
    mdata.components = await getNpmMetadata(mdata.components);
  }
  return mdata;
}

// Manifests and SBOMs read from an app are data the binary ships, so each is
// size-capped before it is parsed.
const MAX_APP_DOCUMENT_BYTES = 64 * 1024 * 1024;

function readAppJson(file) {
  try {
    if (statSync(file).size > MAX_APP_DOCUMENT_BYTES) {
      return undefined;
    }
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (_e) {
    return undefined;
  }
}

// A path a manifest in the app names must stay inside the directory it is
// relative to.
function resolveInside(baseDir, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.length) {
    return undefined;
  }
  if (isAbsolute(relativePath)) {
    return undefined;
  }
  const resolved = join(baseDir, relativePath);
  const back = relative(baseDir, resolved);
  if (!back || back.startsWith("..") || isAbsolute(back)) {
    return undefined;
  }
  return resolved;
}

function toPosix(filePath) {
  return filePath.split(sep).join("/");
}

// Parsers record the files they read by absolute path, which for an extracted
// app is a temporary directory. The path inside the app is the one that means
// something to a reader of the SBOM.
function relativizeToApp(component, appDir) {
  const inApp = (value) =>
    typeof value === "string" && value.startsWith(`${appDir}${sep}`)
      ? toPosix(relative(appDir, value))
      : value;
  for (const property of component.properties || []) {
    if (property.name === "internal:SrcFile") {
      property.value = inApp(property.value);
    }
  }
  const identities = component.evidence?.identity;
  for (const identity of Array.isArray(identities)
    ? identities
    : [identities]) {
    for (const method of identity?.methods || []) {
      method.value = inApp(method.value);
    }
  }
  for (const occurrence of component.evidence?.occurrences || []) {
    occurrence.location = inApp(occurrence.location);
  }
  return component;
}

// Components taken from the app's own SBOMs keep their bom-refs even when
// their purl has to be repaired, since the dependency graph refers to them by
// that ref. A component that has only a purl is referred to by it.
function ingestComponent(component) {
  const ref = component["bom-ref"];
  sanitizeIngestedPurl(component);
  if (ref) {
    component["bom-ref"] = ref;
  } else if (!component["bom-ref"] && component.purl) {
    component["bom-ref"] = decodeURIComponent(component.purl);
  }
  return component;
}

/**
 * Index the npm packages of an extracted caxa app by directory. Each entry is
 * the directory of a package.json relative to the app, mapped to the bom-ref
 * of the metadata component with the same name and version.
 */
function indexAppPackages(appDir, components) {
  const refs = new Set(components.map((c) => c["bom-ref"]));
  const packageDirs = [];
  const packageJsons = getAllFiles(appDir, "**/package.json", {
    includeDot: true,
    includeNodeModulesDir: true,
  });
  for (const file of packageJsons) {
    const pkg = readAppJson(file);
    if (!pkg?.name || !pkg?.version) {
      continue;
    }
    const ref = `pkg:npm/${pkg.name}@${pkg.version}`;
    if (refs.has(ref)) {
      packageDirs.push({ dir: toPosix(relative(appDir, dirname(file))), ref });
    }
  }
  // Innermost first, so a nested node_modules package owns its own files.
  packageDirs.sort((a, b) => b.dir.length - a.dir.length);
  return packageDirs;
}

function ownerOf(packageDirs, relativeFile) {
  return packageDirs.find(
    ({ dir }) => dir === "" || relativeFile.startsWith(`${dir}/`),
  );
}

function addDependencies(dependencyMap, ref, dependsOn) {
  if (!ref || !dependsOn?.length) {
    return;
  }
  const existing = dependencyMap.get(ref) || new Set();
  for (const target of dependsOn) {
    if (target && target !== ref) {
      existing.add(target);
    }
  }
  dependencyMap.set(ref, existing);
}

// Refs that nothing in the list depends on: the entry points of a sub-graph.
function unrequiredRefs(components, dependencies) {
  const required = new Set(dependencies.flatMap((d) => d.dependsOn || []));
  return components
    .map((c) => c["bom-ref"])
    .filter((ref) => ref && !required.has(ref));
}

/**
 * Read the integrity of each installed npm package from the lockfile pnpm or
 * npm leaves in the app's node_modules (or the app's own lockfile).
 *
 * @returns {Promise<Map<string, string>>} npm bom-ref to integrity string
 */
async function readAppIntegrity(appDir) {
  const integrity = new Map();
  for (const lockFile of [
    "node_modules/.package-lock.json",
    "package-lock.json",
  ]) {
    const lock = readAppJson(join(appDir, lockFile));
    for (const [installPath, entry] of Object.entries(lock?.packages || {})) {
      const name =
        entry?.name || installPath.split("node_modules/").pop() || undefined;
      if (installPath && name && entry?.version && entry?.integrity) {
        integrity.set(`pkg:npm/${name}@${entry.version}`, entry.integrity);
      }
    }
  }
  for (const lockFile of ["node_modules/.pnpm/lock.yaml", "pnpm-lock.yaml"]) {
    const file = join(appDir, lockFile);
    if (!safeExistsSync(file)) {
      continue;
    }
    try {
      const { pkgList } = await parsePnpmLock(file);
      for (const pkg of pkgList || []) {
        if (pkg?._integrity && pkg.name && pkg.version) {
          const name = pkg.group ? `${pkg.group}/${pkg.name}` : pkg.name;
          integrity.set(`pkg:npm/${name}@${pkg.version}`, pkg._integrity);
        }
      }
    } catch (_e) {
      // An unreadable lockfile leaves the components without hashes.
    }
  }
  return integrity;
}

/**
 * Add the native tools a package ships, as described by a cdxgen plugins
 * manifest (`plugins-manifest.json`, from @cdxgen/cdxgen-plugins-bin*). Only
 * entries whose binary is present are used, so a pruned bundle lists only what
 * it kept. Their own dependencies come from the aggregate
 * `sbom-postbuild.cdx.json` next to the manifest, or else from each entry's
 * `sbomFile`, limited to what the present tools reach.
 */
function addPluginTools(appDir, packageDirs, state) {
  const manifests = getAllFiles(appDir, "**/plugins-manifest.json", {
    includeDot: true,
    includeNodeModulesDir: true,
  });
  for (const manifestFile of manifests) {
    const owner = ownerOf(packageDirs, toPosix(relative(appDir, manifestFile)));
    const manifest = readAppJson(manifestFile);
    if (!owner || !Array.isArray(manifest?.plugins)) {
      continue;
    }
    const packageDir = join(appDir, owner.dir);
    const ownerComponent = state.byRef.get(owner.ref);
    const lazyMembers = new Set(
      (ownerComponent?.properties || [])
        .filter((p) => p.name === "cdx:caxa:lazyMember")
        .map((p) => p.value),
    );
    const toolRefs = [];
    const sbomDocuments = [];
    for (const plugin of manifest.plugins) {
      const component = plugin?.component;
      const binary = resolveInside(packageDir, plugin?.binaryPath);
      if (
        !component?.name ||
        typeof component["bom-ref"] !== "string" ||
        !binary ||
        !safeExistsSync(binary)
      ) {
        continue;
      }
      const tool = ingestComponent(structuredClone(component));
      tool.properties = tool.properties || [];
      tool.properties.push({
        name: "internal:SrcFile",
        value: toPosix(relative(appDir, manifestFile)),
      });
      if (lazyMembers.has(plugin.binaryPath)) {
        tool.properties.push({
          name: "cdx:caxa:lazyMember",
          value: plugin.binaryPath,
        });
      }
      if (state.addComponent(tool)) {
        toolRefs.push(tool["bom-ref"]);
      }
      const sbomFile = resolveInside(packageDir, plugin.sbomFile);
      if (sbomFile && safeExistsSync(sbomFile)) {
        sbomDocuments.push({ file: sbomFile, rootRef: tool["bom-ref"] });
      }
    }
    if (!toolRefs.length) {
      continue;
    }
    addDependencies(state.dependencyMap, owner.ref, toolRefs);
    const aggregate = join(dirname(manifestFile), "sbom-postbuild.cdx.json");
    const documents = safeExistsSync(aggregate)
      ? [{ file: aggregate }]
      : sbomDocuments;
    addReachableSbomContents(documents, toolRefs, state);
  }
}

// Merge the components and dependencies of the tools' own SBOMs, keeping only
// what the given tools reach. A per-tool SBOM's root is renamed to the tool's
// ref, since the manifest and the tool's build may name it differently.
function addReachableSbomContents(documents, toolRefs, state) {
  const candidates = new Map();
  const edges = new Map();
  for (const { file, rootRef } of documents) {
    const bom = readAppJson(file);
    if (!bom) {
      continue;
    }
    const sbomRoot = bom.metadata?.component?.["bom-ref"];
    const rename = (ref) => (rootRef && ref === sbomRoot ? rootRef : ref);
    for (const component of bom.components || []) {
      if (component?.["bom-ref"] && !candidates.has(component["bom-ref"])) {
        candidates.set(component["bom-ref"], component);
      }
    }
    for (const dependency of bom.dependencies || []) {
      addDependencies(
        edges,
        rename(dependency.ref),
        (dependency.dependsOn || []).map(rename),
      );
    }
  }
  const reached = new Set(toolRefs);
  const queue = [...toolRefs];
  while (queue.length) {
    for (const target of edges.get(queue.shift()) || []) {
      if (!reached.has(target) && candidates.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  for (const ref of reached) {
    const component = candidates.get(ref);
    if (component && !toolRefs.includes(ref)) {
      state.addComponent(ingestComponent(structuredClone(component)));
    }
    addDependencies(
      state.dependencyMap,
      ref,
      [...(edges.get(ref) || [])].filter((target) => reached.has(target)),
    );
  }
}

/**
 * Add the PHP (composer.lock), Ruby (Gemfile.lock) and Java (*.jar) packages
 * that npm packages of the app vendor, each linked from the npm package that
 * contains it.
 */
async function addEmbeddedPackages(appDir, packageDirs, state) {
  const options = { includeDot: true, includeNodeModulesDir: true };
  const embedded = [];
  for (const composerLock of getAllFiles(appDir, "**/composer.lock", options)) {
    const composerJson = join(dirname(composerLock), "composer.json");
    const { rootRequires } = safeExistsSync(composerJson)
      ? parseComposerJson(composerJson)
      : { rootRequires: {} };
    embedded.push({
      file: composerLock,
      result: parseComposerLock(composerLock, rootRequires),
    });
  }
  for (const gemLock of getAllFiles(appDir, "**/Gemfile.lock", options)) {
    embedded.push({
      file: gemLock,
      result: await parseGemfileLockData(
        readFileSync(gemLock, "utf-8"),
        gemLock,
      ),
    });
  }
  const jars = getAllFiles(appDir, "**/*.jar", options);
  if (jars.length) {
    const tempDir = safeMkdtempSync(join(getTmpDir(), "caxa-jars-"));
    try {
      for (const jar of jars) {
        embedded.push({
          file: jar,
          result: { pkgList: (await extractJarArchive(jar, tempDir)) || [] },
        });
      }
    } finally {
      safeRmSync(tempDir, { recursive: true, force: true });
    }
  }
  for (const { file, result } of embedded) {
    const owner = ownerOf(packageDirs, toPosix(relative(appDir, file)));
    const pkgList = result?.pkgList || [];
    if (!owner || !pkgList.length) {
      continue;
    }
    for (const pkg of pkgList) {
      pkg.properties = pkg.properties || [];
      if (!pkg.properties.some((p) => p.name === "internal:SrcFile")) {
        pkg.properties.push({ name: "internal:SrcFile", value: file });
      }
      state.addComponent(relativizeToApp(ingestComponent(pkg), appDir));
    }
    const dependencies = result.dependenciesList || [];
    for (const dependency of dependencies) {
      addDependencies(
        state.dependencyMap,
        dependency.ref,
        dependency.dependsOn,
      );
    }
    // The lockfile's direct dependencies, or failing that every package in
    // it that nothing else requires, hang off the npm package.
    const direct = (result.rootList || [])
      .map((pkg) => pkg["bom-ref"])
      .filter(Boolean);
    addDependencies(
      state.dependencyMap,
      owner.ref,
      direct.length ? direct : unrequiredRefs(pkgList, dependencies),
    );
  }
}

/**
 * Complete caxa metadata from the application the binary extracts (or was
 * built from): npm integrity from the lockfile pnpm or npm leaves in
 * node_modules, the native tools a cdxgen plugins manifest describes, with
 * their own dependencies, and the PHP, Ruby and Java packages vendored inside
 * npm packages. Everything found is linked from the npm package whose
 * directory contains it; npm packages that are not in the metadata are
 * ignored.
 *
 * @param {Object} mdata Parsed caxa metadata (see parseCaxaMetadata)
 * @param {string} appDir Directory of the extracted app
 * @returns {Promise<Object>} The metadata, with components and dependencies added
 */
export async function enrichCaxaMetadataFromApp(mdata, appDir) {
  if (!mdata?.components?.length || !appDir || !safeExistsSync(appDir)) {
    return mdata;
  }
  const byRef = new Map(mdata.components.map((c) => [c["bom-ref"], c]));
  const dependencyMap = new Map();
  for (const dependency of mdata.dependencies || []) {
    addDependencies(dependencyMap, dependency.ref, dependency.dependsOn);
  }
  const state = {
    byRef,
    dependencyMap,
    addComponent(component) {
      const ref = component?.["bom-ref"];
      if (!ref || byRef.has(ref)) {
        return false;
      }
      // It ships in the binary, unless its own SBOM said otherwise.
      component.scope = component.scope || "required";
      byRef.set(ref, component);
      mdata.components.push(component);
      return true;
    },
  };
  const integrity = await readAppIntegrity(appDir);
  for (const component of mdata.components) {
    const value = integrity.get(component["bom-ref"]);
    if (value && !component.hashes?.length && !component._integrity) {
      component._integrity = value;
    }
  }
  const packageDirs = indexAppPackages(appDir, mdata.components);
  addPluginTools(appDir, packageDirs, state);
  await addEmbeddedPackages(appDir, packageDirs, state);
  mdata.dependencies = [...dependencyMap].map(([ref, dependsOn]) => ({
    ref,
    dependsOn: [...dependsOn].sort(),
  }));
  return mdata;
}
