// C/C++ evidence collection.
//
// This lives in lib/ecosystems/ rather than lib/inventory/evidenceUtils.js
// because every branch of it is C/C++-specific: vcpkg manifests, CMakeLists,
// and the C usage slices produced by atom. Keeping it here lets it import
// parsers-misc directly instead of having the two parsers threaded in as
// injected helpers from the CLI.

import { readFileSync } from "node:fs";
import {
  sep as _sep,
  basename,
  dirname,
  extname,
  join,
  resolve,
} from "node:path";

import { build } from "@cdxgen/cdx-purl";

import { DEBUG_MODE } from "../core/activity.js";
import { safeExistsSync } from "../core/fs.js";
import { CPP_STD_MODULES } from "../core/state.js";
import { findAppModules } from "../inventory/atomUtils.js";
import { cmakeBuildDirCandidates } from "../inventory/cmakeBuildDirs.js";
import { getOSPackageForFile } from "../inventory/osPackageResolver.js";
import { locateGenericPackage } from "../inventory/purl.js";
import {
  createIncludeAttributor,
  parseCIncludeSlices,
} from "./cppIncludeResolver.js";
import {
  parseCmakeLikeFile,
  parseCUsageSlice,
  parseXmakeRequiresLock,
} from "./parsers-misc.js";

/**
 * Headers of the C standard library (C89 to C23) and of POSIX and the common
 * system interfaces. They come with the C library or the operating system: a
 * component only when an OS package provides them, never a generic one.
 */
const C_SYSTEM_HEADERS = new Set([
  "assert.h",
  "complex.h",
  "ctype.h",
  "errno.h",
  "fenv.h",
  "float.h",
  "inttypes.h",
  "iso646.h",
  "limits.h",
  "locale.h",
  "math.h",
  "setjmp.h",
  "signal.h",
  "stdalign.h",
  "stdarg.h",
  "stdatomic.h",
  "stdbit.h",
  "stdbool.h",
  "stdckdint.h",
  "stddef.h",
  "stdint.h",
  "stdio.h",
  "stdlib.h",
  "stdnoreturn.h",
  "string.h",
  "tgmath.h",
  "threads.h",
  "time.h",
  "uchar.h",
  "wchar.h",
  "wctype.h",
  "aio.h",
  "alloca.h",
  "arpa/inet.h",
  "cpio.h",
  "dirent.h",
  "dlfcn.h",
  "endian.h",
  "err.h",
  "execinfo.h",
  "fcntl.h",
  "fmtmsg.h",
  "fnmatch.h",
  "ftw.h",
  "getopt.h",
  "glob.h",
  "grp.h",
  "iconv.h",
  "ifaddrs.h",
  "langinfo.h",
  "libgen.h",
  "libintl.h",
  "malloc.h",
  "memory.h",
  "monetary.h",
  "mqueue.h",
  "ndbm.h",
  "net/if.h",
  "netdb.h",
  "netinet/in.h",
  "netinet/tcp.h",
  "nl_types.h",
  "poll.h",
  "pthread.h",
  "pwd.h",
  "regex.h",
  "sched.h",
  "search.h",
  "semaphore.h",
  "spawn.h",
  "strings.h",
  "stropts.h",
  "sys/ioctl.h",
  "sys/ipc.h",
  "sys/mman.h",
  "sys/msg.h",
  "sys/param.h",
  "sys/resource.h",
  "sys/select.h",
  "sys/sem.h",
  "sys/shm.h",
  "sys/socket.h",
  "sys/stat.h",
  "sys/statvfs.h",
  "sys/syscall.h",
  "sys/sysctl.h",
  "sys/time.h",
  "sys/times.h",
  "sys/types.h",
  "sys/uio.h",
  "sys/un.h",
  "sys/utsname.h",
  "sys/wait.h",
  "syslog.h",
  "tar.h",
  "termios.h",
  "ucontext.h",
  "ulimit.h",
  "unistd.h",
  "utime.h",
  "utmpx.h",
  "wordexp.h",
]);

/**
 * Add the symbols a file uses to a component's `internal:ImportedSymbols`,
 * keeping every other property and the symbols already recorded.
 *
 * @param {Object} apkg Component to enrich
 * @param {string[]} symbols Symbol names
 */
function mergeImportedSymbols(apkg, symbols) {
  apkg.properties = apkg.properties || [];
  const prop = apkg.properties.find(
    (p) => p.name === "internal:ImportedSymbols",
  );
  if (prop) {
    prop.value = Array.from(new Set([...prop.value.split("|"), ...symbols]))
      .sort()
      .join("|");
  } else {
    apkg.properties.push({
      name: "internal:ImportedSymbols",
      value: symbols.join("|"),
    });
  }
}

/**
 * Method to find c/c++ modules by collecting usages with atom
 *
 * @param {string} src directory
 * @param {object} options Command line options
 * @param {array} osPkgsList Array of OS pacakges represented as components
 * @param {array} epkgList Existing packages list
 * @param {function(string): boolean} [isFirstPartyHeader] Whether an
 *   included header is the project's own (found under the project root or
 *   one of its own include directories, outside any dependency's sources);
 *   such a header is not a component
 */
export function getCppModules(
  src,
  options,
  osPkgsList,
  epkgList,
  isFirstPartyHeader = undefined,
) {
  // Generic is the type to use where the package registry could not be located
  const pkgType = "generic";
  const pkgList = [];
  const pkgAddedMap = {};
  let sliceData;
  const epkgMap = {};
  let parentComponent;
  const dependsOn = new Set();

  // Components from CMake and Conan carry no group: the key spells a missing
  // group the same way on insert and on lookup.
  const epkgKey = (group, name) => `${group || ""}/${name}`;
  (epkgList || []).forEach((p) => {
    epkgMap[epkgKey(p.group, p.name)] = p;
  });
  // Attributes a header from the file its include resolved to, when atom
  // names that file (atom 4 and later)
  const attributeInclude = createIncludeAttributor({
    src,
    components: epkgList || [],
    buildDirs: cmakeBuildDirCandidates(src, options),
    isFirstPartyHeader,
  });
  const vcpkgPorts = attributeInclude.vcpkgPorts();
  // Let's look for any vcpkg.json file to tell us about the directory we're scanning
  // users can use this file to give us a clue even if they do not use vcpkg library manager
  if (safeExistsSync(join(src, "vcpkg.json"))) {
    const vcPkgData = JSON.parse(
      readFileSync(join(src, "vcpkg.json"), { encoding: "utf-8" }),
    );
    if (vcPkgData && Object.keys(vcPkgData).length && vcPkgData.name) {
      const parentPurl = build({
        type: pkgType,
        namespace: "" || null,
        name: vcPkgData.name,
        version: vcPkgData.version || "" || null,
      });
      parentComponent = {
        name: vcPkgData.name,
        version: vcPkgData.version || "",
        description: vcPkgData.description,
        license: vcPkgData.license,
        purl: parentPurl,
        type: "application",
        "bom-ref": decodeURIComponent(parentPurl),
      };
      if (vcPkgData.homepage) {
        parentComponent.homepage = { url: vcPkgData.homepage };
      }
      // The builtin baseline is the vcpkg commit that pins every port version,
      // so it identifies the version set the manifest resolves against.
      if (typeof vcPkgData["builtin-baseline"] === "string") {
        parentComponent.properties = [
          {
            name: "cdx:vcpkg:baseline",
            value: vcPkgData["builtin-baseline"],
          },
        ];
      }
      // Are there any dependencies declared in vcpkg.json
      if (vcPkgData.dependencies && Array.isArray(vcPkgData.dependencies)) {
        for (const avcdep of vcPkgData.dependencies) {
          let avcpkgName;
          let scope;
          let vcpkgFeatures;
          if (typeof avcdep === "string" || avcdep instanceof String) {
            avcpkgName = avcdep;
          } else if (Object.keys(avcdep).length && avcdep.name) {
            avcpkgName = avcdep.name;
            if (avcdep.host) {
              scope = "optional";
            }
            vcpkgFeatures = Array.isArray(avcdep.features)
              ? avcdep.features.join(",")
              : undefined;
          }
          // Is this a dependency we haven't seen before including the all lower and upper case version?
          if (
            avcpkgName &&
            !epkgMap[epkgKey("", avcpkgName)] &&
            !epkgMap[epkgKey("", avcpkgName.toLowerCase())] &&
            !epkgMap[epkgKey("", avcpkgName.toUpperCase())]
          ) {
            // the version vcpkg installed, when the build tree has the port
            const installed = vcpkgPorts.get(avcpkgName.toLowerCase());
            const pkgPurl = build({
              type: pkgType,
              namespace: "" || null,
              name: avcpkgName,
              version: installed?.version || null,
            });
            const apkg = {
              group: "",
              name: avcpkgName,
              type: pkgType,
              version: installed?.version || "",
              purl: pkgPurl,
              scope,
              "bom-ref": decodeURIComponent(pkgPurl),
              properties: [
                { name: "cdx:vcpkg:declared", value: "true" },
                ...(vcpkgFeatures
                  ? [{ name: "cdx:vcpkg:features", value: vcpkgFeatures }]
                  : []),
                ...(installed
                  ? [{ name: "cdx:vcpkg:triplet", value: installed.triplet }]
                  : []),
              ],
              evidence: {
                identity: {
                  field: "purl",
                  confidence: 0.5,
                  methods: [
                    {
                      technique: "source-code-analysis",
                      confidence: 0.5,
                      value: `Filename ${join(src, "vcpkg.json")}`,
                    },
                  ],
                },
              },
            };
            if (!pkgAddedMap[avcpkgName]) {
              pkgList.push(apkg);
              dependsOn.add(apkg["bom-ref"]);
              pkgAddedMap[avcpkgName] = true;
            }
          }
        }
      }
    } // if
  }
  // xmake locks its resolved requirements in `xmake-requires.lock`; the
  // entries are additions to whatever other evidence collectors found.
  const xmakeLockFile = join(src, "xmake-requires.lock");
  if (safeExistsSync(xmakeLockFile)) {
    const xmakePkgs = parseXmakeRequiresLock(xmakeLockFile);
    for (const apkg of xmakePkgs) {
      if (!pkgAddedMap[apkg.name]) {
        pkgList.push(apkg);
        dependsOn.add(apkg["bom-ref"]);
        pkgAddedMap[apkg.name] = true;
      }
    }
  }
  if (!parentComponent && safeExistsSync(join(src, "CMakeLists.txt"))) {
    const retMap = parseCmakeLikeFile(join(src, "CMakeLists.txt"), pkgType);
    if (retMap.parentComponent && Object.keys(retMap.parentComponent).length) {
      parentComponent = retMap.parentComponent;
    }
  } else if (options.projectName && options.projectVersion) {
    parentComponent = {
      group: options.projectGroup || "",
      name: options.projectName || "",
      version: `${options.projectVersion}` || "latest",
      type: "application",
    };
    const parentPurl = build({
      type: pkgType,
      namespace: parentComponent.group || null,
      name: parentComponent.name,
      version: parentComponent.version || null,
    });
    parentComponent.purl = parentPurl;
    parentComponent["bom-ref"] = decodeURIComponent(parentPurl);
  }
  if (options.usagesSlicesFile && safeExistsSync(options.usagesSlicesFile)) {
    sliceData = JSON.parse(
      readFileSync(options.usagesSlicesFile, { encoding: "utf-8" }),
    );
    if (DEBUG_MODE) {
      console.log("Re-using existing slices file", options.usagesSlicesFile);
    }
  } else {
    sliceData = findAppModules(
      src,
      options.deep ? "c" : "h",
      "usages",
      options.usagesSlicesFile,
      options,
    );
  }
  const usageData = parseCUsageSlice(sliceData);
  const includeInfo = parseCIncludeSlices(sliceData);
  const osComponents = new Map();
  const addedRefs = new Set();
  // The component a resolved include belongs to, and whether it is already
  // listed (a dependency or vendored directory, a declared vcpkg port, a Conan
  // package the lock file named)
  const includeComponents = new Map();
  const listedNamed = (name, purlType) =>
    [...(epkgList || []), ...pkgList].find(
      (p) =>
        p.name?.toLowerCase() === name.toLowerCase() &&
        (!purlType || `${p.purl || ""}`.startsWith(`pkg:${purlType}/`)),
    );
  const componentForInclude = (target) => {
    if (target.kind === "component") {
      return { component: target.component, listed: true };
    }
    let coords;
    if (target.kind === "os") {
      coords = {
        name: target.pkgInfo.name,
        version: target.pkgInfo.version || "",
        purl: target.pkgInfo.purl,
        technique: "filename",
      };
    } else if (target.kind === "vcpkg") {
      const declared = listedNamed(target.port, pkgType);
      if (declared) {
        // already in the list: declared in vcpkg.json, or given by the caller
        return { component: declared, listed: true };
      }
      coords = {
        name: target.port,
        version: target.version,
        purl: build({
          type: pkgType,
          name: target.port,
          version: target.version || null,
        }),
        properties: [{ name: "cdx:vcpkg:triplet", value: target.triplet }],
        technique: "manifest-analysis",
      };
    } else {
      const locked = listedNamed(target.name, "conan");
      if (locked) {
        return { component: locked, listed: true };
      }
      coords = {
        name: target.name,
        version: target.version,
        purl: build({
          type: "conan",
          name: target.name,
          version: target.version || null,
        }),
        technique: "manifest-analysis",
      };
    }
    const ref = decodeURIComponent(
      coords.purl || `${coords.name}@${coords.version}`,
    );
    let component = includeComponents.get(ref);
    if (!component) {
      component = {
        name: coords.name,
        version: coords.version,
        type: "library",
        purl: coords.purl,
        "bom-ref": ref,
        properties: coords.properties || [],
        evidence: {
          identity: {
            field: "purl",
            confidence: 0.8,
            methods: [
              {
                technique: coords.technique,
                confidence: 0.8,
                value: "Resolved include file",
              },
            ],
          },
        },
      };
      includeComponents.set(ref, component);
    }
    return { component, listed: false };
  };
  const symbolsOf = (key, header) =>
    Array.from(
      new Set([
        ...(usageData[key] || []),
        ...(includeInfo.get(key)?.symbols || []),
      ]),
    )
      .filter(
        (v) =>
          !v.startsWith("<") &&
          !v.startsWith("__") &&
          v !== "main" &&
          !v.includes("anonymous_") &&
          !v.includes(header),
      )
      .map((v) => v.split(":")[0])
      .sort();
  // Only includes name headers; the other keys are the project's own source
  // files, with the symbols they use
  for (const sliceKey of Object.keys(usageData).filter((k) =>
    includeInfo.has(k),
  )) {
    // Normalize windows separator
    const afile = sliceKey.replace("..\\", "").replace(/\\/g, "/");
    const fileName = basename(afile);
    if (!fileName?.length) {
      continue;
    }
    const extn = extname(fileName);
    let group = dirname(afile);
    if (
      group.startsWith(".") ||
      group.startsWith(_sep) ||
      group.startsWith("/") ||
      // A drive-rooted include such as C:/vcpkg/include/png.h is an absolute
      // path like any other, and a filesystem root is not a package namespace.
      /^[A-Za-z]:/.test(group) ||
      safeExistsSync(resolve(afile)) ||
      safeExistsSync(resolve(src, afile))
    ) {
      group = "";
    }
    const version = "";
    // We need to resolve the name to an os package here
    const name = fileName.replace(extn, "");
    // Logic here if name matches the standard library of cpp
    // we skip it
    // Load the glibc-stdlib.json file, which contains std lib for cpp
    if (CPP_STD_MODULES.includes(name)) {
      continue;
    }
    // The file the include resolved to names its package exactly
    const resolvedFiles = includeInfo.get(sliceKey)?.paths;
    const target = resolvedFiles?.size
      ? attributeInclude(resolvedFiles)
      : undefined;
    if (target?.kind === "first-party") {
      continue;
    }
    if (target) {
      const { component, listed } = componentForInclude(target);
      const usymbols = symbolsOf(sliceKey, afile);
      if (usymbols.length) {
        mergeImportedSymbols(component, usymbols);
      }
      if (!listed && !addedRefs.has(component["bom-ref"])) {
        pkgList.push(component);
        addedRefs.add(component["bom-ref"]);
      }
      dependsOn.add(component["bom-ref"]);
      continue;
    }
    if (isFirstPartyHeader?.(afile)) {
      continue;
    }
    // The OS package list is shared by every header: a component taken from it
    // is a copy, so the internal:PkgProvides the next header is matched against
    // stays intact. A component the caller already listed is enriched in place
    // and not listed again.
    const osPkg = getOSPackageForFile(afile, osPkgsList);
    if (!osPkg && C_SYSTEM_HEADERS.has(afile)) {
      continue;
    }
    const listedPkg = osPkg ? undefined : epkgMap[epkgKey(group, name)];
    let apkg;
    if (osPkg) {
      const osRef = osPkg["bom-ref"] || osPkg.purl || osPkg.name;
      apkg = osComponents.get(osRef);
      if (!apkg) {
        apkg = {
          ...osPkg,
          properties: (osPkg.properties || []).map((prop) => ({ ...prop })),
        };
        osComponents.set(osRef, apkg);
      }
    } else {
      apkg = listedPkg || {
        name,
        group,
        version: "",
        type: pkgType,
      };
    }
    // If this is a relative file, there is a good chance we can reuse the project group
    if (!afile.startsWith(_sep) && !group.length) {
      group = options.projectGroup || "";
    }
    if (!apkg.purl) {
      // A purl subpath is relative, uses forward separators, and is split on
      // them, so an include resolved to an absolute path such as
      // /usr/include/zlib.h or C:\src\zlib.h contributes its segments without
      // the root.
      const subpath = afile
        ? afile
            .replaceAll("\\", "/")
            .replace(/^[A-Za-z]:/, "")
            .replace(/^\/+/, "")
        : null;
      apkg.purl = build({
        type: pkgType,
        namespace: group || null,
        name: name,
        version: version || null,
        subpath: subpath || null,
      });
      apkg.evidence = {
        identity: {
          field: "purl",
          confidence: 0,
          methods: [
            {
              technique: "source-code-analysis",
              confidence: 0,
              value: `Filename ${afile}`,
            },
          ],
        },
      };
      apkg["bom-ref"] = decodeURIComponent(apkg["purl"]);
    }
    const usymbols = symbolsOf(sliceKey, afile);
    if (usymbols.length) {
      mergeImportedSymbols(apkg, usymbols);
    }
    // At this point, we have a package but we don't know what it's called
    // So let's try to locate this generic package using some heuristics
    apkg = locateGenericPackage(apkg);
    if (listedPkg) {
      dependsOn.add(apkg["bom-ref"]);
    } else if (osPkg) {
      if (!addedRefs.has(apkg["bom-ref"])) {
        pkgList.push(apkg);
        dependsOn.add(apkg["bom-ref"]);
        addedRefs.add(apkg["bom-ref"]);
      }
    } else if (!pkgAddedMap[name]) {
      pkgList.push(apkg);
      dependsOn.add(apkg["bom-ref"]);
      pkgAddedMap[name] = true;
    }
  }
  const dependenciesList =
    dependsOn.size && parentComponent
      ? [
          {
            ref: parentComponent["bom-ref"],
            dependsOn: [...dependsOn].sort(),
          },
        ]
      : [];
  return {
    parentComponent,
    pkgList: pkgList.sort((a, b) => a.purl.localeCompare(b.purl)),
    dependenciesList,
  };
}
