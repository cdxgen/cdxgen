import { lstatSync, readdirSync, readFileSync } from "node:fs";
import {
  basename,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
} from "node:path";
import process from "node:process";
import { URL } from "node:url";

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

import {
  getScopedStaticValueByName,
  getStaticObjectProperty,
  resolveStaticValue,
} from "./analyzerScope.js";
import { classifyMcpReference } from "./mcp.js";
import { isLocalHost, sanitizeMcpRefToken } from "./mcpDiscovery.js";
import {
  sanitizeBomPropertyValue,
  sanitizeBomUrl,
} from "./propertySanitizer.js";

const IGNORE_DIRS = process.env.ASTGEN_IGNORE_DIRS
  ? process.env.ASTGEN_IGNORE_DIRS.split(",")
  : [
      "venv",
      "docs",
      "test",
      "tests",
      "e2e",
      "examples",
      "cypress",
      "site-packages",
      "typings",
      "api_docs",
      "dev_docs",
      "types",
      "mock",
      "mocks",
      "jest-cache",
      "eslint-rules",
      "codemods",
      "flow-typed",
      "i18n",
      "coverage",
    ];

const IGNORE_FILE_PATTERN = new RegExp(
  process.env.ASTGEN_IGNORE_FILE_PATTERN ||
    "(conf|config|test|spec|mock|setup-jest|\\.d)\\.(js|ts|tsx)$",
  "i",
);

const normalizeAnalyzerPathForGlob = (filePath) =>
  String(filePath || "").replaceAll("\\", "/");

const normalizeAnalyzerSearchOptions = (deepOrOptions = false) => {
  if (deepOrOptions && typeof deepOrOptions === "object") {
    return {
      deep: Boolean(deepOrOptions.deep),
      exclude: Array.isArray(deepOrOptions.exclude)
        ? deepOrOptions.exclude
        : [],
    };
  }
  return {
    deep: Boolean(deepOrOptions),
    exclude: [],
  };
};

const shouldExcludeAnalyzerPath = (
  rootDir,
  filePath,
  excludePatterns,
  isDirectory = false,
) => {
  if (!excludePatterns?.length) {
    return false;
  }
  const normalizedAbsolutePath = normalizeAnalyzerPathForGlob(
    resolve(filePath),
  );
  const normalizedRelativePath = normalizeAnalyzerPathForGlob(
    relative(rootDir, filePath),
  );
  const candidatePaths = [
    normalizedAbsolutePath,
    normalizedRelativePath,
    normalizedRelativePath ? `./${normalizedRelativePath}` : "",
  ].filter(Boolean);
  if (isDirectory) {
    candidatePaths.push(
      `${normalizedAbsolutePath}/`,
      normalizedRelativePath ? `${normalizedRelativePath}/` : "",
      normalizedRelativePath ? `./${normalizedRelativePath}/` : "",
    );
  }
  return excludePatterns.some((pattern) => {
    const normalizedPattern = normalizeAnalyzerPathForGlob(pattern);
    return candidatePaths.some((candidatePath) =>
      matchesGlob(candidatePath, normalizedPattern),
    );
  });
};

const getAllFiles = (
  deep,
  dir,
  extn,
  files,
  result,
  regex,
  rootDir,
  excludePatterns,
) => {
  files = files || readdirSync(dir);
  result = result || [];
  regex = regex || new RegExp(`\\${extn}$`);
  rootDir = rootDir || dir;
  excludePatterns = excludePatterns || [];

  for (let i = 0; i < files.length; i++) {
    if (IGNORE_FILE_PATTERN.test(files[i]) || files[i].startsWith(".")) {
      continue;
    }
    const file = join(dir, files[i]);
    const fileStat = lstatSync(file);
    if (fileStat.isSymbolicLink()) {
      continue;
    }
    if (
      shouldExcludeAnalyzerPath(
        rootDir,
        file,
        excludePatterns,
        fileStat.isDirectory(),
      )
    ) {
      continue;
    }
    if (fileStat.isDirectory()) {
      // Ignore directories
      const dirName = basename(file);
      if (
        dirName.startsWith(".") ||
        dirName.startsWith("__") ||
        IGNORE_DIRS.includes(dirName.toLowerCase())
      ) {
        continue;
      }
      // We need to include node_modules in deep mode to track exports
      // Ignore only for non-deep analysis
      if (!deep && dirName === "node_modules") {
        continue;
      }
      try {
        result = getAllFiles(
          deep,
          file,
          extn,
          readdirSync(file),
          result,
          regex,
          rootDir,
          excludePatterns,
        );
      } catch (_error) {
        // ignore
      }
    } else {
      if (regex.test(file)) {
        result.push(file);
      }
    }
  }
  return result;
};

const babelParserOptions = {
  sourceType: "unambiguous",
  allowImportExportEverywhere: true,
  allowAwaitOutsideFunction: true,
  allowNewTargetOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowSuperOutsideMethod: true,
  errorRecovery: true,
  allowUndeclaredExports: true,
  createImportExpressions: true,
  tokens: true,
  attachComment: false,
  plugins: [
    "optionalChaining",
    "classProperties",
    "decorators-legacy",
    "exportDefaultFrom",
    "doExpressions",
    "numericSeparator",
    "dynamicImport",
    "jsx",
    "typescript",
  ],
};

/**
 * Filter only references to (t|jsx?) or (less|scss) files for now.
 * Opt to use our relative paths.
 */
const setFileRef = (
  allImports,
  allExports,
  src,
  file,
  pathnode,
  specifiers = [],
) => {
  const pathway = pathnode.value || pathnode.name;
  const sourceLoc = pathnode.loc?.start;
  if (!pathway) {
    return;
  }
  const fileRelativeLoc = relative(src, file);
  // remove unexpected extension imports
  if (/\.(svg|png|jpg|json|d\.ts)/.test(pathway)) {
    return;
  }
  const importedModules = specifiers
    .map((s) => s.imported?.name)
    .filter((v) => v !== undefined);
  const exportedModules = specifiers
    .map((s) => s.exported?.name)
    .filter((v) => v !== undefined);
  const occurrence = {
    importedAs: pathway,
    importedModules,
    exportedModules,
    isExternal: true,
    fileName: fileRelativeLoc,
    lineNumber: sourceLoc?.line ?? undefined,
    columnNumber: sourceLoc?.column ?? undefined,
  };
  // replace relative imports with full path
  let moduleFullPath = pathway;
  let wasAbsolute = false;
  if (/\.\//g.test(pathway) || /\.\.\//g.test(pathway)) {
    moduleFullPath = resolve(file, "..", pathway);
    if (isAbsolute(moduleFullPath)) {
      moduleFullPath = relative(src, moduleFullPath);
      wasAbsolute = true;
    }
    if (!moduleFullPath.startsWith("node_modules/")) {
      occurrence.isExternal = false;
    }
  }
  allImports[moduleFullPath] = allImports[moduleFullPath] || new Set();
  allImports[moduleFullPath].add(occurrence);

  // Handle module package name
  // Eg: zone.js/dist/zone will be referred to as zone.js in package.json
  if (!wasAbsolute && moduleFullPath.includes("/")) {
    const modPkg = moduleFullPath.split("/")[0];
    allImports[modPkg] = allImports[modPkg] || new Set();
    allImports[modPkg].add(occurrence);
  }
  if (exportedModules?.length) {
    moduleFullPath = moduleFullPath
      .replace("node_modules/", "")
      .replace("dist/", "")
      .replace(/\.(js|ts|cjs|mjs)$/g, "")
      .replace("src/", "");
    allExports[moduleFullPath] = allExports[moduleFullPath] || new Set();
    occurrence.exportedModules = exportedModules;
    allExports[moduleFullPath].add(occurrence);
  }
};

const vueCleaningRegex = /<\/*script.*>|<style[\s\S]*style>|<\/*br>/gi;
const vueTemplateRegex = /(<template.*>)([\s\S]*)(<\/template>)/gi;
const vueCommentRegex = /<!--[\s\S]*?-->/gi;
const vueBindRegex = /(:\[)([\s\S]*?)(])/gi;
const vuePropRegex = /\s([.:@])([a-zA-Z]*?=)/gi;

const fileToParseableCode = (file) => {
  let code = readFileSync(file, "utf-8");
  if (file.endsWith(".vue") || file.endsWith(".svelte")) {
    code = code
      .replace(vueCommentRegex, (match) => match.replaceAll(/\S/g, " "))
      .replace(
        vueCleaningRegex,
        (match) => `${match.replaceAll(/\S/g, " ").substring(1)};`,
      )
      .replace(
        vueBindRegex,
        (_match, grA, grB, grC) =>
          grA.replaceAll(/\S/g, " ") + grB + grC.replaceAll(/\S/g, " "),
      )
      .replace(
        vuePropRegex,
        (_match, grA, grB) => ` ${grA.replace(/[.:@]/g, " ")}${grB}`,
      )
      .replace(
        vueTemplateRegex,
        (_match, grA, grB, grC) =>
          grA + grB.replaceAll("{{", "{ ").replaceAll("}}", " }") + grC,
      );
  }
  return code;
};

const isWasmPath = (modulePath) =>
  typeof modulePath === "string" && /\.wasm([?#].*)?$/i.test(modulePath);

const getStringValue = (astNode) => {
  if (!astNode) {
    return undefined;
  }
  if (astNode.type === "StringLiteral") {
    return astNode.value;
  }
  if (
    astNode.type === "TemplateLiteral" &&
    astNode.expressions.length === 0 &&
    astNode.quasis.length === 1
  ) {
    return astNode.quasis[0].value.cooked;
  }
  return undefined;
};

const unwrapAwait = (astNode) =>
  astNode?.type === "AwaitExpression" ? astNode.argument : astNode;

const isImportMetaUrl = (astNode) =>
  astNode?.type === "MemberExpression" &&
  astNode.object?.type === "MetaProperty" &&
  astNode.object.meta?.name === "import" &&
  astNode.object.property?.name === "meta" &&
  astNode.property?.type === "Identifier" &&
  astNode.property.name === "url";

const getMemberExpressionPropertyName = (propertyNode) => {
  if (!propertyNode) {
    return undefined;
  }
  if (propertyNode.type === "Identifier") {
    return propertyNode.name;
  }
  if (propertyNode.type === "StringLiteral") {
    return propertyNode.value;
  }
  return undefined;
};

const resolveWasmLiteralFromNode = (astNode, wasmBufferByVarName) => {
  const normalizedNode = unwrapAwait(astNode);
  const directLiteral = getStringValue(normalizedNode);
  if (isWasmPath(directLiteral)) {
    return directLiteral;
  }
  if (normalizedNode?.type === "Identifier") {
    return wasmBufferByVarName.get(normalizedNode.name);
  }
  if (normalizedNode?.type === "CallExpression") {
    if (
      normalizedNode.callee?.type === "Identifier" &&
      normalizedNode.callee.name === "fetch" &&
      normalizedNode.arguments?.length
    ) {
      return resolveWasmLiteralFromNode(
        normalizedNode.arguments[0],
        wasmBufferByVarName,
      );
    }
  }
  if (normalizedNode?.type === "NewExpression") {
    if (
      normalizedNode.callee?.type === "Identifier" &&
      normalizedNode.callee.name === "URL" &&
      normalizedNode.arguments?.length
    ) {
      const urlLiteral = getStringValue(normalizedNode.arguments[0]);
      const baseArg = normalizedNode.arguments[1];
      if (isWasmPath(urlLiteral) && (!baseArg || isImportMetaUrl(baseArg))) {
        return urlLiteral;
      }
    }
  }
  return undefined;
};

const getWasmSourceFromInstantiateCall = (callNode, wasmBufferByVarName) => {
  if (!callNode?.callee || callNode.callee.type !== "MemberExpression") {
    return undefined;
  }
  const objectNode = callNode.callee.object;
  const propertyNode = callNode.callee.property;
  const calleeObjectName = getMemberExpressionPropertyName(objectNode);
  const calleePropertyName = getMemberExpressionPropertyName(propertyNode);
  if (calleeObjectName !== "WebAssembly") {
    return undefined;
  }
  if (
    calleePropertyName !== "instantiate" &&
    calleePropertyName !== "instantiateStreaming" &&
    calleePropertyName !== "compile" &&
    calleePropertyName !== "compileStreaming"
  ) {
    return undefined;
  }
  if (!callNode.arguments?.length) {
    return undefined;
  }
  return resolveWasmLiteralFromNode(callNode.arguments[0], wasmBufferByVarName);
};

const getWasmSourceFromCallExpression = (callNode, wasmBufferByVarName) => {
  const wasmSourceFromInstantiate = getWasmSourceFromInstantiateCall(
    callNode,
    wasmBufferByVarName,
  );
  if (wasmSourceFromInstantiate) {
    return wasmSourceFromInstantiate;
  }
  if (
    callNode?.callee?.type === "Identifier" &&
    ["fetch", "locateFile"].includes(callNode.callee.name) &&
    callNode.arguments?.length
  ) {
    return resolveWasmLiteralFromNode(
      callNode.arguments[0],
      wasmBufferByVarName,
    );
  }
  return undefined;
};

const getNamedImportsFromObjectPattern = (idNode) => {
  const namedImports = [];
  if (!idNode || idNode.type !== "ObjectPattern") {
    return namedImports;
  }
  for (const prop of idNode.properties || []) {
    if (prop.type !== "ObjectProperty") {
      continue;
    }
    const keyName = getMemberExpressionPropertyName(prop.key);
    if (keyName) {
      namedImports.push(keyName);
    }
  }
  return namedImports;
};

const setSyntheticImportRef = (
  allImports,
  allExports,
  src,
  file,
  importPath,
  modules,
  sourceLoc,
) => {
  if (!importPath) {
    return;
  }
  const safeModules = modules || [];
  const syntheticSpecifiers = safeModules.map((moduleName) => ({
    imported: { name: moduleName },
  }));
  setFileRef(
    allImports,
    allExports,
    src,
    file,
    { value: importPath, loc: sourceLoc ? { start: sourceLoc } : undefined },
    syntheticSpecifiers,
  );
};

const setSyntheticExportRef = (
  allImports,
  allExports,
  src,
  file,
  importPath,
  modules,
  sourceLoc,
) => {
  if (!importPath) {
    return;
  }
  const safeModules = modules || [];
  const syntheticSpecifiers = safeModules.map((moduleName) => ({
    exported: { name: moduleName },
  }));
  setFileRef(
    allImports,
    allExports,
    src,
    file,
    { value: importPath, loc: sourceLoc ? { start: sourceLoc } : undefined },
    syntheticSpecifiers,
  );
};

const getWasmExportMemberInfo = (astNode) => {
  if (!astNode) {
    return undefined;
  }
  if (astNode.type === "AssignmentExpression") {
    return getWasmExportMemberInfo(astNode.right);
  }
  if (
    astNode.type !== "MemberExpression" ||
    astNode.object?.type !== "Identifier"
  ) {
    return undefined;
  }
  return {
    aliasName: astNode.object.name,
    exportName: getMemberExpressionPropertyName(astNode.property),
  };
};

const getAssignmentTargetName = (astNode) => {
  if (!astNode) {
    return undefined;
  }
  if (astNode.type === "Identifier") {
    return astNode.name;
  }
  if (
    astNode.type === "MemberExpression" &&
    astNode.object?.type === "Identifier" &&
    astNode.object.name === "Module"
  ) {
    return getMemberExpressionPropertyName(astNode.property);
  }
  return undefined;
};

/**
 * Check AST tree for any (j|tsx?) files and set a file
 * references for any import, require or dynamic import files.
 */
const parseFileASTTree = (src, file, allImports, allExports) => {
  const ast = parse(fileToParseableCode(file), babelParserOptions);
  const wasmBufferByVarName = new Map();
  const wasmResultByVarName = new Map();
  const wasmInstanceByVarName = new Map();
  const wasiConstructorAliases = new Set(["WASI"]);
  const wasiNamespaceAliases = new Set();
  const wasiInstanceAliases = new Set();
  const wasmPathLiterals = new Set();
  const wasmExportAliases = new Set(["wasmExports"]);
  traverse.default(ast, {
    ImportDeclaration: (path) => {
      if (path?.node) {
        setFileRef(
          allImports,
          allExports,
          src,
          file,
          path.node.source,
          path.node.specifiers,
        );
        const sourceValue = path.node.source?.value;
        if (sourceValue === "node:wasi" || sourceValue === "wasi") {
          for (const specifier of path.node.specifiers || []) {
            if (
              specifier.type === "ImportSpecifier" &&
              specifier.imported?.name === "WASI"
            ) {
              wasiConstructorAliases.add(specifier.local?.name || "WASI");
            }
            if (specifier.type === "ImportNamespaceSpecifier") {
              wasiNamespaceAliases.add(specifier.local?.name);
            }
          }
        }
      }
    },
    // For require('') statements
    Identifier: (path) => {
      if (
        path?.node &&
        path.node.name === "require" &&
        path.parent.type === "CallExpression"
      ) {
        setFileRef(allImports, allExports, src, file, path.parent.arguments[0]);
      }
    },
    // Use for dynamic imports like routes.jsx
    CallExpression: (path) => {
      if (path?.node && path.node.callee.type === "Import") {
        setFileRef(allImports, allExports, src, file, path.node.arguments[0]);
      }
      const wasmSourceLiteral = getWasmSourceFromCallExpression(
        path?.node,
        wasmBufferByVarName,
      );
      if (wasmSourceLiteral) {
        wasmPathLiterals.add(wasmSourceLiteral);
        setSyntheticImportRef(
          allImports,
          allExports,
          src,
          file,
          wasmSourceLiteral,
          [],
          path.node.loc?.start,
        );
      }
      if (
        path?.node?.callee?.type === "MemberExpression" &&
        path.node.callee.object?.type === "Identifier" &&
        wasiInstanceAliases.has(path.node.callee.object.name)
      ) {
        const methodName = getMemberExpressionPropertyName(
          path.node.callee.property,
        );
        if (methodName === "start" || methodName === "initialize") {
          setSyntheticImportRef(
            allImports,
            allExports,
            src,
            file,
            "node:wasi",
            [methodName],
            path.node.loc?.start,
          );
        }
      }
    },
    ImportExpression: (path) => {
      if (path?.node?.source) {
        setFileRef(allImports, allExports, src, file, path.node.source);
      }
    },
    VariableDeclarator: (path) => {
      const idNode = path?.node?.id;
      const initNode = unwrapAwait(path?.node?.init);
      if (!idNode || !initNode) {
        return;
      }
      if (
        idNode.type === "Identifier" &&
        initNode.type === "CallExpression" &&
        initNode.callee?.type === "MemberExpression"
      ) {
        const calleePropertyName = getMemberExpressionPropertyName(
          initNode.callee.property,
        );
        if (
          calleePropertyName === "readFile" ||
          calleePropertyName === "readFileSync"
        ) {
          const pathArg = initNode.arguments?.[0];
          const wasmPath = getStringValue(pathArg);
          if (isWasmPath(wasmPath)) {
            wasmBufferByVarName.set(idNode.name, wasmPath);
            wasmPathLiterals.add(wasmPath);
            setSyntheticImportRef(
              allImports,
              allExports,
              src,
              file,
              wasmPath,
              [],
              path.node.loc?.start,
            );
          }
        }
        const wasmSource = getWasmSourceFromInstantiateCall(
          initNode,
          wasmBufferByVarName,
        );
        if (wasmSource) {
          wasmResultByVarName.set(idNode.name, wasmSource);
          wasmPathLiterals.add(wasmSource);
          setSyntheticImportRef(
            allImports,
            allExports,
            src,
            file,
            wasmSource,
            [],
            path.node.loc?.start,
          );
        }
        if (
          initNode.callee?.type === "MemberExpression" &&
          initNode.callee.object?.type === "Identifier" &&
          wasiNamespaceAliases.has(initNode.callee.object.name) &&
          getMemberExpressionPropertyName(initNode.callee.property) === "WASI"
        ) {
          wasiInstanceAliases.add(idNode.name);
          setSyntheticImportRef(
            allImports,
            allExports,
            src,
            file,
            "node:wasi",
            ["WASI"],
            path.node.loc?.start,
          );
        }
      }
      if (
        idNode.type === "Identifier" &&
        initNode.type === "CallExpression" &&
        initNode.callee?.type === "Identifier" &&
        wasiConstructorAliases.has(initNode.callee.name)
      ) {
        wasiInstanceAliases.add(idNode.name);
        setSyntheticImportRef(
          allImports,
          allExports,
          src,
          file,
          "node:wasi",
          ["WASI"],
          path.node.loc?.start,
        );
      }
      if (idNode.type === "Identifier" && initNode.type === "NewExpression") {
        if (
          initNode.callee?.type === "Identifier" &&
          wasiConstructorAliases.has(initNode.callee.name)
        ) {
          wasiInstanceAliases.add(idNode.name);
          setSyntheticImportRef(
            allImports,
            allExports,
            src,
            file,
            "node:wasi",
            ["WASI"],
            path.node.loc?.start,
          );
        }
        if (
          initNode.callee?.type === "MemberExpression" &&
          initNode.callee.object?.type === "Identifier" &&
          wasiNamespaceAliases.has(initNode.callee.object.name) &&
          getMemberExpressionPropertyName(initNode.callee.property) === "WASI"
        ) {
          wasiInstanceAliases.add(idNode.name);
          setSyntheticImportRef(
            allImports,
            allExports,
            src,
            file,
            "node:wasi",
            ["WASI"],
            path.node.loc?.start,
          );
        }
      }
      if (idNode.type === "ObjectPattern") {
        if (initNode.type === "CallExpression") {
          const wasmSource = getWasmSourceFromInstantiateCall(
            initNode,
            wasmBufferByVarName,
          );
          if (wasmSource) {
            wasmPathLiterals.add(wasmSource);
            for (const prop of idNode.properties || []) {
              if (
                prop.type === "ObjectProperty" &&
                getMemberExpressionPropertyName(prop.key) === "instance" &&
                prop.value?.type === "Identifier"
              ) {
                wasmInstanceByVarName.set(prop.value.name, wasmSource);
              }
            }
            setSyntheticImportRef(
              allImports,
              allExports,
              src,
              file,
              wasmSource,
              [],
              path.node.loc?.start,
            );
          }
          if (
            initNode.callee?.type === "Identifier" &&
            initNode.callee.name === "require"
          ) {
            const requiredModule = getStringValue(initNode.arguments?.[0]);
            if (requiredModule === "node:wasi" || requiredModule === "wasi") {
              for (const prop of idNode.properties || []) {
                if (
                  prop.type === "ObjectProperty" &&
                  getMemberExpressionPropertyName(prop.key) === "WASI" &&
                  prop.value?.type === "Identifier"
                ) {
                  wasiConstructorAliases.add(prop.value.name);
                }
              }
            }
          }
        }
        if (initNode.type === "MemberExpression") {
          const exportNames = getNamedImportsFromObjectPattern(idNode);
          if (!exportNames.length) {
            return;
          }
          if (
            initNode.object?.type === "MemberExpression" &&
            initNode.object.object?.type === "Identifier" &&
            getMemberExpressionPropertyName(initNode.object.property) ===
              "instance" &&
            getMemberExpressionPropertyName(initNode.property) === "exports"
          ) {
            const wasmSource = wasmResultByVarName.get(
              initNode.object.object.name,
            );
            if (wasmSource) {
              setSyntheticImportRef(
                allImports,
                allExports,
                src,
                file,
                wasmSource,
                exportNames,
                path.node.loc?.start,
              );
            }
          }
          if (
            initNode.object?.type === "Identifier" &&
            getMemberExpressionPropertyName(initNode.property) === "exports"
          ) {
            const wasmSource = wasmInstanceByVarName.get(initNode.object.name);
            if (wasmSource) {
              setSyntheticImportRef(
                allImports,
                allExports,
                src,
                file,
                wasmSource,
                exportNames,
                path.node.loc?.start,
              );
            }
          }
        }
      }
      if (
        idNode.type === "Identifier" &&
        initNode.type === "MemberExpression" &&
        initNode.object?.type === "Identifier" &&
        getMemberExpressionPropertyName(initNode.property) === "instance"
      ) {
        const wasmSource = wasmResultByVarName.get(initNode.object.name);
        if (wasmSource) {
          wasmInstanceByVarName.set(idNode.name, wasmSource);
        }
      }
      if (
        idNode.type === "Identifier" &&
        initNode.type === "CallExpression" &&
        initNode.callee?.type === "MemberExpression" &&
        initNode.callee.object?.type === "Identifier" &&
        initNode.callee.object.name === "WebAssembly"
      ) {
        const wasmSource = getWasmSourceFromInstantiateCall(
          initNode,
          wasmBufferByVarName,
        );
        if (wasmSource) {
          wasmResultByVarName.set(idNode.name, wasmSource);
          wasmPathLiterals.add(wasmSource);
        }
      }
    },
    AssignmentExpression: (path) => {
      const wasmExportMemberInfo = getWasmExportMemberInfo(path?.node?.right);
      if (!wasmExportMemberInfo?.exportName) {
        return;
      }
      if (!wasmExportAliases.has(wasmExportMemberInfo.aliasName)) {
        return;
      }
      if (!wasmPathLiterals.size) {
        return;
      }
      for (const wasmPath of wasmPathLiterals) {
        setSyntheticImportRef(
          allImports,
          allExports,
          src,
          file,
          wasmPath,
          [wasmExportMemberInfo.exportName],
          path.node.loc?.start,
        );
      }
      const targetName = getAssignmentTargetName(path?.node?.left);
      if (!targetName) {
        return;
      }
      for (const wasmPath of wasmPathLiterals) {
        setSyntheticExportRef(
          allImports,
          allExports,
          src,
          file,
          wasmPath,
          [targetName],
          path.node.loc?.start,
        );
      }
    },
    NewExpression: (path) => {
      if (path?.node?.callee?.type === "Identifier") {
        if (wasiConstructorAliases.has(path.node.callee.name)) {
          setSyntheticImportRef(
            allImports,
            allExports,
            src,
            file,
            "node:wasi",
            ["WASI"],
            path.node.loc?.start,
          );
        }
      }
      if (
        path?.node?.callee?.type === "MemberExpression" &&
        path.node.callee.object?.type === "Identifier" &&
        wasiNamespaceAliases.has(path.node.callee.object.name) &&
        getMemberExpressionPropertyName(path.node.callee.property) === "WASI"
      ) {
        setSyntheticImportRef(
          allImports,
          allExports,
          src,
          file,
          "node:wasi",
          ["WASI"],
          path.node.loc?.start,
        );
      }
    },
    // Use for export barrells
    ExportAllDeclaration: (path) => {
      setFileRef(allImports, allExports, src, file, path.node.source);
    },
    ExportNamedDeclaration: (path) => {
      // ensure there is a path export
      if (path?.node?.source) {
        setFileRef(
          allImports,
          allExports,
          src,
          file,
          path.node.source,
          path.node.specifiers,
        );
      }
    },
  });
};

/**
 * Return paths to all (j|tsx?) files.
 */
const getAllSrcJSAndTSFiles = (src, deep) =>
  Promise.all(
    [".js", ".jsx", ".cjs", ".mjs", ".ts", ".tsx", ".vue", ".svelte"].map(
      (extension) => {
        const searchOptions = normalizeAnalyzerSearchOptions(deep);
        return getAllFiles(
          searchOptions.deep,
          src,
          extension,
          undefined,
          undefined,
          undefined,
          src,
          searchOptions.exclude,
        );
      },
    ),
  );

export const CHROMIUM_EXTENSION_CAPABILITY_CATEGORIES = [
  "fileAccess",
  "deviceAccess",
  "network",
  "bluetooth",
  "accessibility",
  "codeInjection",
  "fingerprinting",
];

const EXTENSION_CAPABILITY_CHAIN_PATTERNS = {
  fileAccess: [
    /^(chrome|browser)\.(downloads|fileSystem|fileBrowserHandler|fileManagerPrivate)\b/i,
    /^(window\.)?show(Open|Save|Directory)FilePicker$/i,
  ],
  deviceAccess: [
    /^(chrome|browser)\.(usb|hid|serial|nfc|mediaGalleries|gcdPrivate|bluetooth|bluetoothPrivate)\b/i,
  ],
  network: [
    /^(chrome|browser)\.(webRequest|declarativeNetRequest|proxy|webNavigation|socket)\b/i,
    /^(window\.)?(fetch|WebSocket|EventSource)$/i,
    /^(XMLHttpRequest)\b/i,
    /^navigator\.sendBeacon$/i,
  ],
  bluetooth: [/^(chrome|browser)\.(bluetooth|bluetoothPrivate)\b/i],
  accessibility: [
    /^(chrome|browser)\.(accessibilityFeatures|accessibilityPrivate|automation)\b/i,
  ],
  codeInjection: [
    /^(chrome|browser)\.(scripting\.executeScript|tabs\.executeScript|userScripts|debugger)\b/i,
    /^(window\.)?(eval|Function)$/i,
    /^document\.write$/i,
  ],
  fingerprinting: [
    /^navigator\.(userAgent|platform|languages|language|hardwareConcurrency|deviceMemory|plugins|userAgentData)\b/i,
    /^(screen\.)?(width|height|availWidth|availHeight|colorDepth|pixelDepth)$/i,
    /^(window\.)?(AudioContext|OfflineAudioContext|RTCPeerConnection)$/i,
    /^(canvas|[a-zA-Z_$][a-zA-Z0-9_$]*\.(getImageData|toDataURL|measureText))$/i,
  ],
};

const EXTENSION_CAPABILITY_IDENTIFIER_PATTERNS = {
  network: /^(fetch|WebSocket|EventSource|XMLHttpRequest)$/i,
  codeInjection: /^(eval|Function)$/i,
  fingerprinting: /^(AudioContext|OfflineAudioContext|RTCPeerConnection)$/i,
};

const SUSPICIOUS_JS_PROCESS_MODULES = new Set([
  "child_process",
  "node:child_process",
]);

const SUSPICIOUS_JS_NETWORK_MODULES = new Set([
  "axios",
  "got",
  "http",
  "https",
  "net",
  "node-fetch",
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "tls",
  "undici",
]);

const JS_FILE_ACCESS_MODULES = new Set([
  "fs",
  "fs/promises",
  "graceful-fs",
  "node:fs",
  "node:fs/promises",
  "original-fs",
]);
const JS_NETWORK_MODULES = new Set([
  ...SUSPICIOUS_JS_NETWORK_MODULES,
  "engine.io-client",
  "node:dgram",
  "socket.io-client",
  "sse.js",
  "ws",
]);
const JS_HARDWARE_MODULES = new Set([
  "@abandonware/noble",
  "bluetooth-serial-port",
  "electron-hid",
  "i2c-bus",
  "node-hid",
  "noble",
  "onoff",
  "pigpio",
  "raspi-io",
  "serialport",
  "spi-device",
  "usb",
  "webbluetooth",
]);
const JS_FILE_ACCESS_MEMBERS = new Set([
  "access",
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "cp",
  "createReadStream",
  "createWriteStream",
  "lstat",
  "mkdir",
  "mkdtemp",
  "open",
  "opendir",
  "readFile",
  "readdir",
  "readlink",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "watch",
  "watchFile",
  "writeFile",
]);
const JS_NETWORK_MEMBERS = new Set([
  "connect",
  "createConnection",
  "createSocket",
  "fetch",
  "get",
  "patch",
  "post",
  "put",
  "request",
  "send",
  "subscribe",
]);
const JS_HARDWARE_MEMBERS = new Set([
  "getDevices",
  "open",
  "requestDevice",
  "requestPort",
]);
const JS_CODE_GENERATION_MEMBERS = new Set([
  "compileFunction",
  "runInContext",
  "runInNewContext",
  "runInThisContext",
]);
const JS_HARDWARE_CHAIN_PATTERNS = [
  /^navigator\.(bluetooth|hid|serial|usb)\b/i,
  /^(chrome|browser)\.(bluetooth|hid|serial|usb|nfc)\b/i,
];
const JS_FILE_ACCESS_CHAIN_PATTERNS = [
  /^(window\.)?show(Open|Save|Directory)FilePicker$/i,
];
const JS_NETWORK_CHAIN_PATTERNS = [
  /^navigator\.sendBeacon$/i,
  /^(window\.)?(EventSource|WebSocket|XMLHttpRequest)$/i,
];
export const JS_CAPABILITY_CATEGORIES = [
  "fileAccess",
  "network",
  "hardware",
  "childProcess",
  "codeGeneration",
  "dynamicFetch",
  "dynamicImport",
];

const SUSPICIOUS_JS_EXECUTION_MEMBERS = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]);

const SUSPICIOUS_JS_NETWORK_MEMBERS = new Set([
  "fetch",
  "get",
  "post",
  "put",
  "patch",
  "request",
]);

const SUSPICIOUS_JS_LONG_BASE64_PATTERN = /\b[A-Za-z0-9+/]{80,}={0,2}\b/;

const getLiteralStringValue = (node) => {
  if (!node) {
    return undefined;
  }
  if (node.type === "StringLiteral") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions?.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked || "").join("");
  }
  return undefined;
};

const addSuspiciousLiteralIndicators = (obfuscationIndicators, rawValue) => {
  if (!rawValue || typeof rawValue !== "string") {
    return;
  }
  if (SUSPICIOUS_JS_LONG_BASE64_PATTERN.test(rawValue)) {
    obfuscationIndicators.add("long-base64-literal");
  }
};

const trackSuspiciousModuleReference = (
  moduleName,
  localName,
  executionIndicators,
  networkIndicators,
  processAliases,
  networkAliases,
) => {
  if (!moduleName || typeof moduleName !== "string") {
    return;
  }
  if (SUSPICIOUS_JS_PROCESS_MODULES.has(moduleName)) {
    executionIndicators.add("child-process-import");
    if (localName) {
      processAliases.add(localName);
    }
  }
  if (SUSPICIOUS_JS_NETWORK_MODULES.has(moduleName)) {
    networkIndicators.add("network-module-import");
    if (localName) {
      networkAliases.add(localName);
    }
  }
};

const trackJsCapabilityModuleReference = (
  moduleName,
  localName,
  capabilityIndicators,
  aliasMaps,
) => {
  if (!moduleName || typeof moduleName !== "string") {
    return;
  }
  if (JS_FILE_ACCESS_MODULES.has(moduleName)) {
    capabilityIndicators.fileAccess.add(`import:${moduleName}`);
    if (localName) {
      aliasMaps.fileAccess.add(localName);
    }
  }
  if (JS_NETWORK_MODULES.has(moduleName)) {
    capabilityIndicators.network.add(`import:${moduleName}`);
    if (localName) {
      aliasMaps.network.add(localName);
    }
  }
  if (JS_HARDWARE_MODULES.has(moduleName)) {
    capabilityIndicators.hardware.add(`import:${moduleName}`);
    if (localName) {
      aliasMaps.hardware.add(localName);
    }
  }
  if (SUSPICIOUS_JS_PROCESS_MODULES.has(moduleName)) {
    capabilityIndicators.childProcess.add(`import:${moduleName}`);
    if (localName) {
      aliasMaps.childProcess.add(localName);
    }
  }
};

const isStaticStringNode = (node) =>
  node?.type === "StringLiteral" ||
  (node?.type === "TemplateLiteral" && node.expressions?.length === 0);

const isStaticUrlNode = (node) => {
  if (isStaticStringNode(node)) {
    return true;
  }
  return (
    node?.type === "NewExpression" &&
    getMemberChainString(node.callee) === "URL" &&
    node.arguments?.length &&
    node.arguments.every((arg) => isStaticStringNode(arg))
  );
};

const getMemberChainString = (node) => {
  if (!node) {
    return "";
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "ThisExpression") {
    return "this";
  }
  if (node.type === "StringLiteral") {
    return node.value;
  }
  if (node.type === "MetaProperty") {
    const metaName = node.meta?.name || "";
    const propertyName = node.property?.name || "";
    return [metaName, propertyName].filter(Boolean).join(".");
  }
  if (node.type === "CallExpression") {
    return getMemberChainString(node.callee);
  }
  if (node.type === "OptionalCallExpression") {
    return getMemberChainString(node.callee);
  }
  if (
    node.type !== "MemberExpression" &&
    node.type !== "OptionalMemberExpression"
  ) {
    return "";
  }
  const objectChain = getMemberChainString(node.object);
  const propertyChain = getMemberChainString(node.property);
  if (objectChain && propertyChain) {
    return `${objectChain}.${propertyChain}`;
  }
  return objectChain || propertyChain || "";
};

export function analyzeSuspiciousJsSource(source) {
  const executionIndicators = new Set();
  const networkIndicators = new Set();
  const obfuscationIndicators = new Set();
  const processAliases = new Set();
  const networkAliases = new Set();
  let ast;
  try {
    ast = parse(source, babelParserOptions);
  } catch {
    return {
      executionIndicators: [],
      indicators: [],
      networkIndicators: [],
      obfuscationIndicators: [],
    };
  }
  traverse.default(ast, {
    ImportDeclaration: (path) => {
      const moduleName = getLiteralStringValue(path?.node?.source);
      path.node.specifiers.forEach((specifier) => {
        trackSuspiciousModuleReference(
          moduleName,
          specifier?.local?.name,
          executionIndicators,
          networkIndicators,
          processAliases,
          networkAliases,
        );
      });
      if (!path.node.specifiers?.length) {
        trackSuspiciousModuleReference(
          moduleName,
          undefined,
          executionIndicators,
          networkIndicators,
          processAliases,
          networkAliases,
        );
      }
    },
    VariableDeclarator: (path) => {
      const init = path?.node?.init;
      if (
        init?.type === "CallExpression" &&
        init.callee?.type === "Identifier" &&
        init.callee.name === "require"
      ) {
        const moduleName = getLiteralStringValue(init.arguments?.[0]);
        const localName =
          path?.node?.id?.type === "Identifier" ? path.node.id.name : undefined;
        trackSuspiciousModuleReference(
          moduleName,
          localName,
          executionIndicators,
          networkIndicators,
          processAliases,
          networkAliases,
        );
      }
    },
    CallExpression: (path) => {
      const callee = path?.node?.callee;
      const calleeChain = getMemberChainString(callee);
      if (callee?.type === "Identifier") {
        if (callee.name === "eval") {
          executionIndicators.add("eval");
        }
        if (callee.name === "atob") {
          obfuscationIndicators.add("atob");
        }
        if (["fetch", "axios", "got"].includes(callee.name)) {
          networkIndicators.add("network-request");
        }
      }
      if (calleeChain === "Buffer.from") {
        const encodingValue = getLiteralStringValue(path.node.arguments?.[1]);
        if (encodingValue?.toLowerCase() === "base64") {
          obfuscationIndicators.add("buffer-base64");
        }
      }
      if (calleeChain === "String.fromCharCode") {
        obfuscationIndicators.add("string-from-char-code");
      }
      if (calleeChain === "vm.runInNewContext") {
        executionIndicators.add("vm-run-context");
        obfuscationIndicators.add("vm-run-context");
      }
      if (calleeChain === "vm.runInThisContext") {
        executionIndicators.add("vm-run-context");
        obfuscationIndicators.add("vm-run-context");
      }
      if (callee?.type === "MemberExpression") {
        const objectName = getMemberChainString(callee.object);
        const propertyName = getMemberChainString(callee.property);
        if (
          objectName &&
          processAliases.has(objectName) &&
          SUSPICIOUS_JS_EXECUTION_MEMBERS.has(propertyName)
        ) {
          executionIndicators.add("child-process");
        }
        if (
          objectName &&
          networkAliases.has(objectName) &&
          SUSPICIOUS_JS_NETWORK_MEMBERS.has(propertyName)
        ) {
          networkIndicators.add("network-request");
        }
      }
      if (
        callee?.type === "Identifier" &&
        callee.name === "require" &&
        path.node.arguments?.length
      ) {
        const moduleName = getLiteralStringValue(path.node.arguments[0]);
        trackSuspiciousModuleReference(
          moduleName,
          undefined,
          executionIndicators,
          networkIndicators,
          processAliases,
          networkAliases,
        );
      }
    },
    NewExpression: (path) => {
      const calleeChain = getMemberChainString(path?.node?.callee);
      if (calleeChain === "Function") {
        executionIndicators.add("function-constructor");
      }
    },
    StringLiteral: (path) => {
      addSuspiciousLiteralIndicators(obfuscationIndicators, path?.node?.value);
    },
    TemplateElement: (path) => {
      addSuspiciousLiteralIndicators(
        obfuscationIndicators,
        path?.node?.value?.raw,
      );
    },
  });
  const indicators = [
    ...obfuscationIndicators,
    ...executionIndicators,
    ...networkIndicators,
  ].sort();
  return {
    executionIndicators: Array.from(executionIndicators).sort(),
    indicators,
    networkIndicators: Array.from(networkIndicators).sort(),
    obfuscationIndicators: Array.from(obfuscationIndicators).sort(),
  };
}

/**
 * Find all imports and exports
 */
export const findJSImportsExports = async (src, deep) => {
  const allImports = {};
  const allExports = {};
  try {
    const promiseMap = await getAllSrcJSAndTSFiles(src, deep);
    const srcFiles = promiseMap.flat();
    for (const file of srcFiles) {
      try {
        parseFileASTTree(src, file, allImports, allExports);
      } catch (_err) {
        // ignore parse failures
      }
    }
    return { allImports, allExports };
  } catch (_err) {
    return { allImports, allExports };
  }
};

/**
 * Detect suspicious obfuscation, execution, and network indicators in a single
 * JavaScript/TypeScript source file using Babel AST analysis.
 *
 * @param {string} filePath Source file path
 * @returns {{executionIndicators: string[], indicators: string[], networkIndicators: string[], obfuscationIndicators: string[]}}
 */
export const analyzeSuspiciousJsFile = (filePath) => {
  let source;
  try {
    source = fileToParseableCode(filePath);
  } catch {
    return {
      executionIndicators: [],
      indicators: [],
      networkIndicators: [],
      obfuscationIndicators: [],
    };
  }
  return analyzeSuspiciousJsSource(source);
};

export function analyzeJsCapabilitiesSource(source) {
  const capabilityIndicators = {
    childProcess: new Set(),
    codeGeneration: new Set(),
    dynamicFetch: new Set(),
    dynamicImport: new Set(),
    fileAccess: new Set(),
    hardware: new Set(),
    network: new Set(),
  };
  const aliasMaps = {
    childProcess: new Set(),
    fileAccess: new Set(),
    hardware: new Set(),
    network: new Set(),
  };
  let ast;
  try {
    ast = parse(source, babelParserOptions);
  } catch {
    return {
      capabilities: [],
      hasDynamicFetch: false,
      hasDynamicImport: false,
      hasEval: false,
      indicatorMap: {},
    };
  }
  const addIndicator = (category, rawIndicator) => {
    const indicator = String(rawIndicator || "").trim();
    if (!indicator) {
      return;
    }
    capabilityIndicators[category].add(indicator);
  };
  traverse.default(ast, {
    ImportDeclaration: (path) => {
      const moduleName = getLiteralStringValue(path?.node?.source);
      path.node.specifiers.forEach((specifier) => {
        trackJsCapabilityModuleReference(
          moduleName,
          specifier?.local?.name,
          capabilityIndicators,
          aliasMaps,
        );
      });
      if (!path.node.specifiers?.length) {
        trackJsCapabilityModuleReference(
          moduleName,
          undefined,
          capabilityIndicators,
          aliasMaps,
        );
      }
    },
    VariableDeclarator: (path) => {
      const init = path?.node?.init;
      if (
        init?.type === "CallExpression" &&
        init.callee?.type === "Identifier" &&
        init.callee.name === "require"
      ) {
        const moduleName = getLiteralStringValue(init.arguments?.[0]);
        const localName =
          path?.node?.id?.type === "Identifier" ? path.node.id.name : undefined;
        trackJsCapabilityModuleReference(
          moduleName,
          localName,
          capabilityIndicators,
          aliasMaps,
        );
      }
    },
    ImportExpression: (path) => {
      if (!isStaticStringNode(path?.node?.source)) {
        addIndicator("dynamicImport", "import(dynamic)");
      }
    },
    MemberExpression: (path) => {
      const memberChain = getMemberChainString(path?.node);
      if (
        JS_HARDWARE_CHAIN_PATTERNS.some((pattern) => pattern.test(memberChain))
      ) {
        addIndicator("hardware", memberChain);
      }
      if (
        JS_FILE_ACCESS_CHAIN_PATTERNS.some((pattern) =>
          pattern.test(memberChain),
        )
      ) {
        addIndicator("fileAccess", memberChain);
      }
      if (
        JS_NETWORK_CHAIN_PATTERNS.some((pattern) => pattern.test(memberChain))
      ) {
        addIndicator("network", memberChain);
      }
    },
    OptionalMemberExpression: (path) => {
      const memberChain = getMemberChainString(path?.node);
      if (
        JS_HARDWARE_CHAIN_PATTERNS.some((pattern) => pattern.test(memberChain))
      ) {
        addIndicator("hardware", memberChain);
      }
      if (
        JS_FILE_ACCESS_CHAIN_PATTERNS.some((pattern) =>
          pattern.test(memberChain),
        )
      ) {
        addIndicator("fileAccess", memberChain);
      }
      if (
        JS_NETWORK_CHAIN_PATTERNS.some((pattern) => pattern.test(memberChain))
      ) {
        addIndicator("network", memberChain);
      }
    },
    CallExpression: (path) => {
      const callee = path?.node?.callee;
      const calleeChain = getMemberChainString(callee);
      if (callee?.type === "Identifier") {
        if (callee.name === "fetch") {
          addIndicator("network", "fetch");
          if (!isStaticUrlNode(path.node.arguments?.[0])) {
            addIndicator("dynamicFetch", "fetch(dynamic)");
          }
        }
        if (callee.name === "eval") {
          addIndicator("codeGeneration", "eval");
        }
        if (
          aliasMaps.network.has(callee.name) &&
          ["axios", "got", "fetch"].includes(callee.name)
        ) {
          addIndicator("network", callee.name);
          if (!isStaticUrlNode(path.node.arguments?.[0])) {
            addIndicator("dynamicFetch", `${callee.name}(dynamic)`);
          }
        }
      }
      if (calleeChain === "Buffer.from") {
        const encodingValue = getLiteralStringValue(path.node.arguments?.[1]);
        if (encodingValue?.toLowerCase() === "base64") {
          addIndicator("codeGeneration", "buffer-base64");
        }
      }
      if (calleeChain.startsWith("vm.")) {
        const vmMethod = calleeChain.split(".").slice(1).join(".");
        if (JS_CODE_GENERATION_MEMBERS.has(vmMethod)) {
          addIndicator("codeGeneration", calleeChain);
        }
      }
      if (callee?.type === "MemberExpression") {
        const objectName = getMemberChainString(callee.object);
        const propertyName = getMemberChainString(callee.property);
        if (
          objectName &&
          aliasMaps.fileAccess.has(objectName) &&
          JS_FILE_ACCESS_MEMBERS.has(propertyName)
        ) {
          addIndicator("fileAccess", `${objectName}.${propertyName}`);
        }
        if (
          objectName &&
          aliasMaps.network.has(objectName) &&
          JS_NETWORK_MEMBERS.has(propertyName)
        ) {
          addIndicator("network", `${objectName}.${propertyName}`);
          if (!isStaticUrlNode(path.node.arguments?.[0])) {
            addIndicator(
              "dynamicFetch",
              `${objectName}.${propertyName}(dynamic)`,
            );
          }
        }
        if (
          objectName &&
          aliasMaps.hardware.has(objectName) &&
          JS_HARDWARE_MEMBERS.has(propertyName)
        ) {
          addIndicator("hardware", `${objectName}.${propertyName}`);
        }
        if (
          objectName &&
          aliasMaps.childProcess.has(objectName) &&
          SUSPICIOUS_JS_EXECUTION_MEMBERS.has(propertyName)
        ) {
          addIndicator("childProcess", `${objectName}.${propertyName}`);
        }
      }
      if (
        callee?.type === "Identifier" &&
        callee.name === "require" &&
        !isStaticStringNode(path.node.arguments?.[0])
      ) {
        addIndicator("dynamicImport", "require(dynamic)");
      }
    },
    NewExpression: (path) => {
      const calleeChain = getMemberChainString(path?.node?.callee);
      if (calleeChain === "Function") {
        addIndicator("codeGeneration", "Function");
      }
      if (
        ["WebSocket", "EventSource", "XMLHttpRequest"].includes(calleeChain)
      ) {
        addIndicator("network", calleeChain);
      }
    },
  });
  const indicatorMap = {};
  const capabilities = [];
  for (const category of JS_CAPABILITY_CATEGORIES) {
    const indicators = Array.from(capabilityIndicators[category]).sort();
    if (indicators.length) {
      indicatorMap[category] = indicators;
      capabilities.push(category);
    }
  }
  return {
    capabilities,
    hasDynamicFetch: capabilityIndicators.dynamicFetch.size > 0,
    hasDynamicImport: capabilityIndicators.dynamicImport.size > 0,
    hasEval: capabilityIndicators.codeGeneration.has("eval"),
    indicatorMap,
  };
}

export const analyzeJsCapabilitiesFile = (filePath) => {
  let source;
  try {
    source = fileToParseableCode(filePath);
  } catch {
    return {
      capabilities: [],
      hasDynamicFetch: false,
      hasDynamicImport: false,
      hasEval: false,
      indicatorMap: {},
    };
  }
  return analyzeJsCapabilitiesSource(source);
};

const CRYPTO_IMPORT_SOURCES = new Set([
  "crypto",
  "jose",
  "jsonwebtoken",
  "node:crypto",
  "node:tls",
  "openpgp",
  "sshpk",
  "tls",
]);
const NODE_CRYPTO_MODULE_SOURCES = new Set(["crypto", "node:crypto"]);
const JWT_IMPORT_SOURCES = new Set(["jsonwebtoken"]);
const JOSE_IMPORT_SOURCES = new Set(["jose"]);
const JWS_ALGORITHM_LITERAL_PATTERN =
  /^(?:ES|HS|PS|RS)(?:256|384|512)$|^Ed(?:25519|448)$/;
const NODE_CRYPTO_CALL_PRIMITIVES = new Map([
  ["createCipheriv", "cipher"],
  ["createDecipheriv", "cipher"],
  ["createHash", "hash"],
  ["createHmac", "hmac"],
  ["createSign", "signature"],
  ["createVerify", "signature"],
  ["generateKey", "key-generation"],
  ["generateKeyPair", "key-generation"],
  ["generateKeyPairSync", "key-generation"],
  ["generateKeySync", "key-generation"],
  ["hkdf", "kdf"],
  ["hkdfSync", "kdf"],
  ["pbkdf2", "kdf"],
  ["pbkdf2Sync", "kdf"],
  ["scrypt", "kdf"],
  ["scryptSync", "kdf"],
  ["sign", "signature"],
  ["verify", "signature"],
]);
const WEBCRYPTO_METHOD_PRIMITIVES = new Map([
  ["decrypt", "cipher"],
  ["deriveBits", "kdf"],
  ["deriveKey", "kdf"],
  ["digest", "hash"],
  ["encrypt", "cipher"],
  ["generateKey", "key-generation"],
  ["importKey", "key-management"],
  ["sign", "signature"],
  ["unwrapKey", "key-management"],
  ["verify", "signature"],
  ["wrapKey", "key-management"],
]);
const JWT_METHOD_NAMES = new Set([
  "sign",
  "verify",
  "decode",
  "encrypt",
  "decrypt",
]);
const CRYPTO_OBJECT_PROPERTY_KEYS = new Map([
  ["alg", "signature"],
  ["algorithm", "signature"],
  ["enc", "cipher"],
  ["hash", "hash"],
  ["name", "algorithm"],
]);

const recordCryptoAlgorithm = (
  algorithms,
  rawName,
  primitive,
  source,
  loc,
  extra = {},
) => {
  const algorithmName = typeof rawName === "string" ? rawName.trim() : "";
  if (!algorithmName) {
    return;
  }
  algorithms.push({
    columnNumber: loc?.column ?? undefined,
    keyLength:
      typeof extra.keyLength === "number" ? extra.keyLength : undefined,
    lineNumber: loc?.line ?? undefined,
    name: algorithmName,
    primitive,
    source,
  });
};

const recordCryptoAlgorithmsFromValue = (
  algorithms,
  value,
  primitive,
  source,
  loc,
) => {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      recordCryptoAlgorithmsFromValue(
        algorithms,
        entry,
        primitive,
        source,
        loc,
      );
    });
    return;
  }
  if (typeof value === "string") {
    recordCryptoAlgorithm(algorithms, value, primitive, source, loc);
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  const algorithmName =
    typeof value.name === "string"
      ? value.name
      : typeof value.algorithm === "string"
        ? value.algorithm
        : undefined;
  if (algorithmName) {
    recordCryptoAlgorithm(algorithms, algorithmName, primitive, source, loc, {
      keyLength:
        typeof value.length === "number"
          ? value.length
          : typeof value.modulusLength === "number"
            ? value.modulusLength
            : undefined,
    });
  }
  if (typeof value.hash === "string") {
    recordCryptoAlgorithm(
      algorithms,
      value.hash,
      "hash",
      `${source}:hash`,
      loc,
    );
  } else if (
    value.hash &&
    typeof value.hash === "object" &&
    typeof value.hash.name === "string"
  ) {
    recordCryptoAlgorithm(
      algorithms,
      value.hash.name,
      "hash",
      `${source}:hash`,
      loc,
    );
  }
  if (typeof value.alg === "string") {
    recordCryptoAlgorithm(
      algorithms,
      value.alg,
      "signature",
      `${source}:alg`,
      loc,
    );
  }
  if (typeof value.enc === "string") {
    recordCryptoAlgorithm(
      algorithms,
      value.enc,
      "cipher",
      `${source}:enc`,
      loc,
    );
  }
};

const uniqueCryptoAlgorithms = (algorithms) => {
  const seen = new Set();
  const uniqueAlgorithms = [];
  for (const algorithm of algorithms || []) {
    const key = [
      algorithm.fileName || "",
      algorithm.name || "",
      algorithm.primitive || "",
      algorithm.source || "",
      algorithm.lineNumber || "",
      algorithm.columnNumber || "",
    ].join("\u0000");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueAlgorithms.push(algorithm);
  }
  return uniqueAlgorithms.sort((left, right) => {
    return `${left.fileName || ""}:${left.lineNumber || 0}:${left.name || ""}`.localeCompare(
      `${right.fileName || ""}:${right.lineNumber || 0}:${right.name || ""}`,
    );
  });
};

const createScopedStaticValueResolver = (path, staticValueByName) => {
  const scopedStaticValueByName = getScopedStaticValueByName(
    path,
    staticValueByName,
    getLiteralStringValue,
    getMemberExpressionPropertyName,
  );
  return (astNode) =>
    resolveStaticValue(
      astNode,
      scopedStaticValueByName,
      getLiteralStringValue,
      getMemberExpressionPropertyName,
    );
};

const recordCryptoObjectPropertiesFromValue = (
  algorithms,
  optionsValue,
  source,
  loc,
) => {
  if (!optionsValue || typeof optionsValue !== "object") {
    return;
  }
  for (const [propertyName, primitive] of CRYPTO_OBJECT_PROPERTY_KEYS) {
    const propertyValue = getStaticObjectProperty(optionsValue, propertyName);
    if (propertyValue === undefined) {
      continue;
    }
    recordCryptoAlgorithmsFromValue(
      algorithms,
      propertyValue,
      primitive,
      source,
      loc,
    );
  }
};

const normalizeCryptoLibraryName = (moduleName) => {
  return String(moduleName || "").trim();
};

const getDirectCallInfo = (callee) => {
  if (!callee) {
    return {};
  }
  if (callee.type === "Identifier") {
    return {
      calleeName: callee.name,
    };
  }
  if (
    (callee.type === "MemberExpression" ||
      callee.type === "OptionalMemberExpression") &&
    callee.object?.type === "Identifier"
  ) {
    return {
      methodName: getMemberExpressionPropertyName(callee.property),
      rootAlias: callee.object.name,
    };
  }
  return {};
};

export function analyzeJsCryptoSource(source) {
  const algorithms = [];
  const libraries = new Set();
  const cryptoFunctionAliases = new Map();
  const cryptoModuleAliases = new Set();
  const jwtFunctionAliases = new Map();
  const jwtModuleAliases = new Set();
  const joseModuleAliases = new Set();
  const staticValueByName = new Map();
  const subtleAliases = new Set();
  const webcryptoAliases = new Set();
  let ast;
  try {
    ast = parse(source, babelParserOptions);
  } catch {
    return { algorithms: [], libraries: [] };
  }
  traverse.default(ast, {
    ImportDeclaration: (path) => {
      const sourceValue = getLiteralStringValue(path?.node?.source);
      if (!sourceValue) {
        return;
      }
      if (CRYPTO_IMPORT_SOURCES.has(sourceValue)) {
        libraries.add(normalizeCryptoLibraryName(sourceValue));
      }
      for (const specifier of path.node.specifiers || []) {
        if (NODE_CRYPTO_MODULE_SOURCES.has(sourceValue)) {
          if (
            specifier.type === "ImportDefaultSpecifier" ||
            specifier.type === "ImportNamespaceSpecifier"
          ) {
            cryptoModuleAliases.add(specifier.local.name);
          }
          if (specifier.type === "ImportSpecifier") {
            const importedName = specifier.imported?.name;
            if (!importedName) {
              continue;
            }
            if (importedName === "webcrypto") {
              webcryptoAliases.add(specifier.local.name);
              continue;
            }
            if (importedName === "subtle") {
              subtleAliases.add(specifier.local.name);
              continue;
            }
            cryptoFunctionAliases.set(specifier.local.name, importedName);
          }
        }
        if (JWT_IMPORT_SOURCES.has(sourceValue)) {
          if (
            specifier.type === "ImportDefaultSpecifier" ||
            specifier.type === "ImportNamespaceSpecifier"
          ) {
            jwtModuleAliases.add(specifier.local.name);
          }
          if (specifier.type === "ImportSpecifier") {
            const importedName = specifier.imported?.name;
            if (importedName) {
              jwtFunctionAliases.set(specifier.local.name, importedName);
            }
          }
        }
        if (JOSE_IMPORT_SOURCES.has(sourceValue)) {
          joseModuleAliases.add(specifier.local.name);
        }
      }
    },
    VariableDeclarator: (path) => {
      const idNode = path?.node?.id;
      const initNode = path?.node?.init;
      if (!idNode || !initNode) {
        return;
      }
      const resolveScopedValue = createScopedStaticValueResolver(
        path,
        staticValueByName,
      );
      const resolvedValue = resolveScopedValue(initNode);
      if (idNode.type === "Identifier") {
        if (resolvedValue !== undefined) {
          staticValueByName.set(idNode.name, resolvedValue);
        }
        const initChain = getMemberChainString(initNode);
        if (
          initChain === "crypto.subtle" ||
          initChain.startsWith("webcrypto.subtle") ||
          (initNode.type === "MemberExpression" &&
            webcryptoAliases.has(getMemberChainString(initNode.object)) &&
            getMemberExpressionPropertyName(initNode.property) === "subtle")
        ) {
          subtleAliases.add(idNode.name);
        }
      }
      if (
        initNode.type === "CallExpression" &&
        initNode.callee?.type === "Identifier" &&
        initNode.callee.name === "require"
      ) {
        const moduleName = getLiteralStringValue(initNode.arguments?.[0]);
        if (!moduleName) {
          return;
        }
        if (CRYPTO_IMPORT_SOURCES.has(moduleName)) {
          libraries.add(normalizeCryptoLibraryName(moduleName));
        }
        if (NODE_CRYPTO_MODULE_SOURCES.has(moduleName)) {
          if (idNode.type === "Identifier") {
            cryptoModuleAliases.add(idNode.name);
          }
          if (idNode.type === "ObjectPattern") {
            for (const property of idNode.properties || []) {
              if (property.type !== "ObjectProperty") {
                continue;
              }
              const importedName = getMemberExpressionPropertyName(
                property.key,
              );
              const localName =
                property.value?.type === "Identifier"
                  ? property.value.name
                  : undefined;
              if (!importedName || !localName) {
                continue;
              }
              if (importedName === "webcrypto") {
                webcryptoAliases.add(localName);
              } else if (importedName === "subtle") {
                subtleAliases.add(localName);
              } else {
                cryptoFunctionAliases.set(localName, importedName);
              }
            }
          }
        }
        if (JWT_IMPORT_SOURCES.has(moduleName)) {
          if (idNode.type === "Identifier") {
            jwtModuleAliases.add(idNode.name);
          }
          if (idNode.type === "ObjectPattern") {
            for (const property of idNode.properties || []) {
              if (property.type !== "ObjectProperty") {
                continue;
              }
              const importedName = getMemberExpressionPropertyName(
                property.key,
              );
              const localName =
                property.value?.type === "Identifier"
                  ? property.value.name
                  : undefined;
              if (importedName && localName) {
                jwtFunctionAliases.set(localName, importedName);
              }
            }
          }
        }
        if (
          JOSE_IMPORT_SOURCES.has(moduleName) &&
          idNode.type === "Identifier"
        ) {
          joseModuleAliases.add(idNode.name);
        }
      }
    },
    AssignmentExpression: (path) => {
      const leftNode = path?.node?.left;
      const rightNode = path?.node?.right;
      if (leftNode?.type !== "Identifier" || !rightNode) {
        return;
      }
      const resolveScopedValue = createScopedStaticValueResolver(
        path,
        staticValueByName,
      );
      const resolvedValue = resolveScopedValue(rightNode);
      if (resolvedValue === undefined) {
        staticValueByName.delete(leftNode.name);
        return;
      }
      staticValueByName.set(leftNode.name, resolvedValue);
    },
    CallExpression: (path) => {
      const callNode = path?.node;
      const loc = callNode?.loc?.start;
      const callee = callNode?.callee;
      const calleeChain = getMemberChainString(callee);
      const directCallInfo = getDirectCallInfo(callee);
      const resolveScopedValue = createScopedStaticValueResolver(
        path,
        staticValueByName,
      );
      let nodeCryptoMethod;
      if (callee?.type === "Identifier") {
        nodeCryptoMethod = cryptoFunctionAliases.get(callee.name);
        const jwtMethod = jwtFunctionAliases.get(callee.name);
        if (jwtMethod && JWT_METHOD_NAMES.has(jwtMethod)) {
          for (const argument of callNode.arguments || []) {
            const optionsValue = resolveScopedValue(argument);
            recordCryptoObjectPropertiesFromValue(
              algorithms,
              optionsValue,
              `jsonwebtoken.${jwtMethod}`,
              loc,
            );
          }
        }
      } else if (calleeChain) {
        const calleeParts = calleeChain.split(".");
        const rootAlias = directCallInfo.rootAlias;
        const directMethodName = directCallInfo.methodName;
        if (
          rootAlias &&
          cryptoModuleAliases.has(rootAlias) &&
          directMethodName
        ) {
          nodeCryptoMethod = directMethodName;
        }
        if (
          rootAlias &&
          jwtModuleAliases.has(rootAlias) &&
          directMethodName &&
          JWT_METHOD_NAMES.has(directMethodName)
        ) {
          for (const argument of callNode.arguments || []) {
            const optionsValue = resolveScopedValue(argument);
            recordCryptoObjectPropertiesFromValue(
              algorithms,
              optionsValue,
              `jsonwebtoken.${directMethodName}`,
              loc,
            );
          }
        }
        if (calleeParts[calleeParts.length - 1] === "setProtectedHeader") {
          const headerValue = resolveScopedValue(callNode.arguments?.[0]);
          if (headerValue && typeof headerValue === "object") {
            if (typeof headerValue.alg === "string") {
              recordCryptoAlgorithm(
                algorithms,
                headerValue.alg,
                "signature",
                "jwt.setProtectedHeader",
                loc,
              );
            }
            if (typeof headerValue.enc === "string") {
              recordCryptoAlgorithm(
                algorithms,
                headerValue.enc,
                "cipher",
                "jwt.setProtectedHeader",
                loc,
              );
            }
          }
        }
      }
      if (
        nodeCryptoMethod &&
        NODE_CRYPTO_CALL_PRIMITIVES.has(nodeCryptoMethod)
      ) {
        const primitive = NODE_CRYPTO_CALL_PRIMITIVES.get(nodeCryptoMethod);
        if (
          [
            "createHash",
            "createHmac",
            "createCipheriv",
            "createDecipheriv",
            "createSign",
            "createVerify",
            "hkdf",
            "hkdfSync",
            "sign",
            "verify",
          ].includes(nodeCryptoMethod)
        ) {
          const argumentIndex = ["hkdf", "hkdfSync"].includes(nodeCryptoMethod)
            ? 0
            : 0;
          const algorithmValue = resolveScopedValue(
            callNode.arguments?.[argumentIndex],
          );
          recordCryptoAlgorithmsFromValue(
            algorithms,
            algorithmValue,
            primitive,
            `node:crypto.${nodeCryptoMethod}`,
            loc,
          );
        }
        if (["pbkdf2", "pbkdf2Sync"].includes(nodeCryptoMethod)) {
          const digestValue = resolveScopedValue(callNode.arguments?.[4]);
          recordCryptoAlgorithmsFromValue(
            algorithms,
            digestValue,
            primitive,
            `node:crypto.${nodeCryptoMethod}`,
            loc,
          );
        }
        if (["scrypt", "scryptSync"].includes(nodeCryptoMethod)) {
          recordCryptoAlgorithm(
            algorithms,
            "scrypt",
            primitive,
            `node:crypto.${nodeCryptoMethod}`,
            loc,
          );
        }
        if (
          [
            "generateKey",
            "generateKeySync",
            "generateKeyPair",
            "generateKeyPairSync",
          ].includes(nodeCryptoMethod)
        ) {
          const typeValue = resolveScopedValue(callNode.arguments?.[0]);
          const optionsValue = resolveScopedValue(callNode.arguments?.[1]);
          if (typeof typeValue === "string") {
            const keyLength =
              typeof optionsValue?.length === "number"
                ? optionsValue.length
                : typeof optionsValue?.modulusLength === "number"
                  ? optionsValue.modulusLength
                  : undefined;
            recordCryptoAlgorithm(
              algorithms,
              typeValue,
              primitive,
              `node:crypto.${nodeCryptoMethod}`,
              loc,
              { keyLength },
            );
          }
        }
      }
      let webcryptoMethod;
      if (calleeChain.startsWith("crypto.subtle.")) {
        webcryptoMethod = calleeChain.split(".").slice(2).join(".");
      } else if (calleeChain.startsWith("subtle.")) {
        webcryptoMethod = subtleAliases.has("subtle")
          ? calleeChain.split(".").slice(1).join(".")
          : undefined;
      } else {
        const calleeParts = calleeChain.split(".");
        if (subtleAliases.has(calleeParts[0])) {
          webcryptoMethod = calleeParts.slice(1).join(".");
        } else if (
          webcryptoAliases.has(calleeParts[0]) &&
          calleeParts[1] === "subtle"
        ) {
          webcryptoMethod = calleeParts.slice(2).join(".");
        }
      }
      if (webcryptoMethod && WEBCRYPTO_METHOD_PRIMITIVES.has(webcryptoMethod)) {
        const primitive = WEBCRYPTO_METHOD_PRIMITIVES.get(webcryptoMethod);
        const primaryAlgorithmValue = resolveScopedValue(
          callNode.arguments?.[0],
        );
        recordCryptoAlgorithmsFromValue(
          algorithms,
          primaryAlgorithmValue,
          primitive,
          `webcrypto.${webcryptoMethod}`,
          loc,
        );
        if (webcryptoMethod === "deriveKey") {
          const derivedAlgorithmValue = resolveScopedValue(
            callNode.arguments?.[2],
          );
          recordCryptoAlgorithmsFromValue(
            algorithms,
            derivedAlgorithmValue,
            "key-generation",
            `webcrypto.${webcryptoMethod}:derived`,
            loc,
          );
        }
      }
    },
    StringLiteral: (path) => {
      if (
        !libraries.has("node:crypto") &&
        !libraries.has("jose") &&
        !libraries.has("jsonwebtoken")
      ) {
        return;
      }
      const literalValue = String(path?.node?.value || "").trim();
      if (!JWS_ALGORITHM_LITERAL_PATTERN.test(literalValue)) {
        return;
      }
      const parentNode = path.parent;
      const grandParentNode = path.parentPath?.parent;
      const isRelevantContext =
        (parentNode?.type === "AssignmentPattern" &&
          parentNode.right === path.node) ||
        (parentNode?.type === "VariableDeclarator" &&
          parentNode.init === path.node) ||
        (parentNode?.type === "BinaryExpression" &&
          ["===", "=="].includes(parentNode.operator)) ||
        (parentNode?.type === "LogicalExpression" &&
          ["||", "??"].includes(parentNode.operator) &&
          ["AssignmentExpression", "VariableDeclarator"].includes(
            grandParentNode?.type,
          ));
      if (!isRelevantContext) {
        return;
      }
      recordCryptoAlgorithm(
        algorithms,
        literalValue,
        "signature",
        "source-literal:jws-algorithm",
        path.node.loc?.start,
      );
    },
  });
  return {
    algorithms: uniqueCryptoAlgorithms(algorithms),
    libraries: Array.from(libraries).sort(),
  };
}

export const analyzeJsCryptoFile = (filePath) => {
  let source;
  try {
    source = fileToParseableCode(filePath);
  } catch {
    return { algorithms: [], libraries: [] };
  }
  return analyzeJsCryptoSource(source);
};

export const detectJsCryptoInventory = async (src, deep = false) => {
  let srcFiles = [];
  try {
    const promiseMap = await getAllSrcJSAndTSFiles(src, deep);
    srcFiles = promiseMap.flat();
  } catch {
    return { algorithms: [], libraries: [] };
  }
  const algorithms = [];
  const libraries = new Set();
  for (const file of srcFiles) {
    let analysis;
    try {
      analysis = analyzeJsCryptoFile(file);
    } catch {
      continue;
    }
    for (const library of analysis.libraries || []) {
      libraries.add(library);
    }
    for (const algorithm of analysis.algorithms || []) {
      algorithms.push({
        ...algorithm,
        fileName: relative(src, file),
      });
    }
  }
  return {
    algorithms: uniqueCryptoAlgorithms(algorithms),
    libraries: Array.from(libraries).sort(),
  };
};

/**
 * Detect browser-extension capability signals from source code using Babel AST analysis.
 *
 * @param {string} src Path to the extension source directory
 * @param {boolean} deep When true, includes node_modules and nested directories
 * @returns {{capabilities: string[], indicators: Object<string, string[]>}}
 * `indicators` is keyed by capability category name and contains arrays of
 * detected signal strings (for example property chains and call names).
 */
export const detectExtensionCapabilities = (src, deep = false) => {
  const indicators = {};
  for (const category of CHROMIUM_EXTENSION_CAPABILITY_CATEGORIES) {
    indicators[category] = new Set();
  }
  let srcFiles = [];
  try {
    const searchOptions = normalizeAnalyzerSearchOptions(deep);
    srcFiles = [
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".js",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".jsx",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".cjs",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".mjs",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".ts",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".tsx",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".vue",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".svelte",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
    ];
  } catch (_err) {
    return { capabilities: [], indicators: {} };
  }
  const addSignalByPatterns = (rawSignal, patternMap) => {
    const signal = String(rawSignal || "").trim();
    if (!signal) {
      return;
    }
    for (const category of Object.keys(patternMap)) {
      const categoryPatterns = patternMap[category];
      const safePatterns = Array.isArray(categoryPatterns)
        ? categoryPatterns
        : [categoryPatterns];
      if (safePatterns.some((pattern) => pattern?.test(signal))) {
        indicators[category].add(signal);
      }
    }
  };
  const addSignal = (rawSignal) => {
    addSignalByPatterns(rawSignal, EXTENSION_CAPABILITY_CHAIN_PATTERNS);
  };
  const addIdentifierSignal = (rawSignal) => {
    addSignalByPatterns(rawSignal, EXTENSION_CAPABILITY_IDENTIFIER_PATTERNS);
  };
  for (const file of srcFiles) {
    try {
      const ast = parse(fileToParseableCode(file), babelParserOptions);
      traverse.default(ast, {
        MemberExpression: (path) => {
          addSignal(getMemberChainString(path?.node));
        },
        OptionalMemberExpression: (path) => {
          addSignal(getMemberChainString(path?.node));
        },
        CallExpression: (path) => {
          addSignal(getMemberChainString(path?.node?.callee));
          if (path?.node?.callee?.type === "Identifier") {
            addIdentifierSignal(path.node.callee.name);
          }
        },
        OptionalCallExpression: (path) => {
          addSignal(getMemberChainString(path?.node?.callee));
          if (path?.node?.callee?.type === "Identifier") {
            addIdentifierSignal(path.node.callee.name);
          }
        },
        NewExpression: (path) => {
          addSignal(getMemberChainString(path?.node?.callee));
          if (path?.node?.callee?.type === "Identifier") {
            addIdentifierSignal(path.node.callee.name);
          }
        },
      });
    } catch (_err) {
      // Skip parse failures and continue scanning
    }
  }
  const capabilityList = [];
  const indicatorMap = {};
  for (const category of CHROMIUM_EXTENSION_CAPABILITY_CATEGORIES) {
    const sortedSignals = Array.from(indicators[category]).sort();
    if (sortedSignals.length) {
      capabilityList.push(category);
      indicatorMap[category] = sortedSignals;
    }
  }
  return { capabilities: capabilityList, indicators: indicatorMap };
};

const MCP_STDIO_TRANSPORT_NAMES = new Set(["StdioServerTransport"]);
const MCP_HTTP_TRANSPORT_NAMES = new Set([
  "NodeStreamableHTTPServerTransport",
  "StreamableHTTPServerTransport",
]);
const MCP_STDIO_CLIENT_TRANSPORT_NAMES = new Set(["StdioClientTransport"]);
const MCP_HTTP_CLIENT_TRANSPORT_NAMES = new Set([
  "NodeStreamableHTTPClientTransport",
  "StreamableHTTPClientTransport",
  "SSEClientTransport",
]);
const MCP_AUTH_HELPERS = new Set([
  "requireBearerAuth",
  "mcpAuthMetadataRouter",
  "createProtectedResourceMetadataRouter",
  "setupAuthServer",
]);
const MCP_APP_FACTORIES = new Set(["createMcpExpressApp"]);
const MCP_CLIENT_CONSTRUCTOR_NAMES = new Set([
  "Client",
  "MCPClient",
  "McpClient",
]);
const MCP_ROUTE_METHODS = new Set([
  "all",
  "delete",
  "get",
  "patch",
  "post",
  "put",
  "use",
]);
const MCP_CAPABILITY_FLAGS = new Set(["listChanged", "subscribe"]);
const MCP_CLIENT_USAGE_METHODS = new Set([
  "callTool",
  "complete",
  "connect",
  "getPrompt",
  "listPrompts",
  "listResources",
  "listTools",
  "readResource",
  "subscribe",
]);
const MCP_NETWORK_METHODS = new Set([
  "fetch",
  "get",
  "patch",
  "post",
  "put",
  "request",
]);
const MCP_PROVIDER_IMPORT_PATTERNS = [
  ["anthropic", /^(?:@anthropic-ai\/sdk|anthropic)$/i],
  ["openai", /^(?:openai|@openai\/agents)$/i],
  [
    "google",
    /^(?:@google\/genai|@google\/generative-ai|google-generativeai)$/i,
  ],
  ["mistral", /^@mistralai\/mistralai$/i],
  ["deepseek", /^deepseek$/i],
  ["ollama", /^ollama$/i],
  ["groq", /^groq-sdk$/i],
];
const MCP_PROVIDER_HOST_PATTERNS = [
  ["anthropic", /(?:^|\.)anthropic\.com$/i],
  ["openai", /(?:^|\.)openai\.com$/i],
  ["google", /(?:^|\.)googleapis\.com$/i],
  ["google", /(?:^|\.)generativelanguage\.googleapis\.com$/i],
  ["mistral", /(?:^|\.)mistral\.ai$/i],
  ["deepseek", /(?:^|\.)deepseek\.com$/i],
  ["ollama", /(?:^|\.)ollama\.com$/i],
  ["groq", /(?:^|\.)groq\.com$/i],
];

const providerFamilyFromImportSource = (sourceValue) => {
  if (!sourceValue) {
    return undefined;
  }
  return MCP_PROVIDER_IMPORT_PATTERNS.find(([, pattern]) =>
    pattern.test(sourceValue),
  )?.[0];
};

const providerFamilyFromHost = (hostname) => {
  if (!hostname) {
    return undefined;
  }
  return MCP_PROVIDER_HOST_PATTERNS.find(([, pattern]) =>
    pattern.test(hostname),
  )?.[0];
};

const modelFamilyFromModelName = (modelName) => {
  const normalized = String(modelName || "").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("claude")) {
    return "claude";
  }
  if (normalized.includes("gpt") || /^o[13](?:$|[-:])/u.test(normalized)) {
    return "gpt";
  }
  if (normalized.includes("gemini")) {
    return "gemini";
  }
  if (normalized.includes("llama")) {
    return "llama";
  }
  if (normalized.includes("mistral")) {
    return "mistral";
  }
  if (normalized.includes("command")) {
    return "command";
  }
  if (normalized.includes("deepseek")) {
    return "deepseek";
  }
  if (normalized.includes("qwen")) {
    return "qwen";
  }
  return normalized.split(/[:/,-]/u)[0] || undefined;
};

const providerFamilyFromModelName = (modelName) => {
  const normalized = String(modelName || "").toLowerCase();
  if (normalized.includes("claude")) {
    return "anthropic";
  }
  if (normalized.includes("gpt") || /^o[13](?:$|[-:])/u.test(normalized)) {
    return "openai";
  }
  if (normalized.includes("gemini")) {
    return "google";
  }
  if (normalized.includes("mistral")) {
    return "mistral";
  }
  if (normalized.includes("deepseek")) {
    return "deepseek";
  }
  if (normalized.includes("llama")) {
    return "meta";
  }
  return undefined;
};

const addUniqueProperty = (properties, name, value) => {
  const sanitizedValue = sanitizeBomPropertyValue(name, value);
  if (
    sanitizedValue === undefined ||
    sanitizedValue === null ||
    sanitizedValue === ""
  ) {
    return;
  }
  const normalizedValue =
    typeof sanitizedValue === "string"
      ? sanitizedValue
      : String(sanitizedValue);
  if (
    properties.some(
      (prop) => prop.name === name && prop.value === normalizedValue,
    )
  ) {
    return;
  }
  properties.push({ name, value: normalizedValue });
};

const rootMemberName = (value) => String(value || "").split(".")[0];

const classifyUrlValue = (urlValue) => {
  if (!urlValue || typeof urlValue !== "string") {
    return undefined;
  }
  if (urlValue.startsWith("/")) {
    return {
      exposureType: "local-only",
      hostname: undefined,
      isMcpEndpoint: urlValue.toLowerCase().includes("/mcp"),
      isPublic: false,
      normalized: urlValue,
      providerFamily: undefined,
    };
  }
  try {
    const parsed = new URL(urlValue);
    const hostname = parsed.hostname.toLowerCase();
    const isPublic = !isLocalHost(hostname);
    return {
      exposureType: isPublic ? "networked-public" : "local-only",
      hostname,
      isMcpEndpoint:
        parsed.pathname.toLowerCase().includes("/mcp") ||
        hostname.includes("modelcontextprotocol"),
      isPublic,
      normalized: parsed.toString(),
      providerFamily: providerFamilyFromHost(hostname),
    };
  } catch {
    return undefined;
  }
};

const getUrlStringValue = (node, urlLiteralByAlias) => {
  const literalValue = getLiteralStringValue(node);
  if (literalValue) {
    return literalValue;
  }
  if (node?.type === "Identifier") {
    return urlLiteralByAlias.get(node.name);
  }
  if (
    node?.type === "NewExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "URL"
  ) {
    return getLiteralStringValue(node.arguments?.[0]);
  }
  return undefined;
};

const recordMcpProvider = (serviceInfo, providerName) => {
  if (!providerName) {
    return;
  }
  serviceInfo.providerNames.add(providerName);
  serviceInfo.providerFamilies.add(providerName);
};

const recordMcpModel = (serviceInfo, modelName) => {
  if (!modelName) {
    return;
  }
  serviceInfo.modelNames.add(modelName);
  const modelFamily = modelFamilyFromModelName(modelName);
  if (modelFamily) {
    serviceInfo.modelFamilies.add(modelFamily);
  }
  const providerFamily = providerFamilyFromModelName(modelName);
  if (providerFamily) {
    serviceInfo.providerFamilies.add(providerFamily);
  }
};

const recordUrlUsage = (
  serviceInfo,
  urlValue,
  usageSignal,
  trackEndpoint = false,
) => {
  const classified = classifyUrlValue(urlValue);
  if (!classified) {
    return;
  }
  if (trackEndpoint || classified.isMcpEndpoint) {
    serviceInfo.endpoints.add(classified.normalized);
  }
  if (classified.hostname) {
    serviceInfo.outboundHosts.add(classified.hostname);
    if (classified.providerFamily) {
      serviceInfo.providerFamilies.add(classified.providerFamily);
    }
  }
  if (classified.isMcpEndpoint) {
    serviceInfo.serviceKinds.add("client");
  }
  if (classified.isPublic) {
    serviceInfo.publicNetwork = true;
  }
  if (classified.exposureType === "local-only") {
    serviceInfo.localOnlySignals += 1;
  }
  if (usageSignal) {
    serviceInfo.usageSignals.add(usageSignal);
  }
};

const mcpFileBaseName = (fileRelativeLoc) =>
  basename(fileRelativeLoc).replace(
    /\.(js|jsx|cjs|mjs|ts|tsx|vue|svelte)$/i,
    "",
  );

const objectExpressionProperty = (astNode, propertyName) => {
  if (!astNode || astNode.type !== "ObjectExpression") {
    return undefined;
  }
  return (astNode.properties || []).find((prop) => {
    if (prop.type !== "ObjectProperty") {
      return false;
    }
    return getMemberExpressionPropertyName(prop.key) === propertyName;
  });
};

const objectExpressionStringValue = (astNode, propertyName) =>
  getLiteralStringValue(objectExpressionProperty(astNode, propertyName)?.value);

const ensureMcpService = (servicesByKey, file, fileRelativeLoc) => {
  if (!servicesByKey.has(fileRelativeLoc)) {
    servicesByKey.set(fileRelativeLoc, {
      file,
      fileRelativeLoc,
      name: `${mcpFileBaseName(fileRelativeLoc)}-mcp-server`,
      version: "latest",
      description: undefined,
      endpoints: new Set(),
      transports: new Set(),
      capabilities: new Set(),
      capabilityFlags: new Map(),
      sdkImports: new Set(),
      officialSdk: undefined,
      authenticated: undefined,
      xTrustBoundary: undefined,
      modelNames: new Set(),
      modelFamilies: new Set(),
      providerNames: new Set(),
      providerFamilies: new Set(),
      outboundHosts: new Set(),
      usageSignals: new Set(),
      serviceKinds: new Set(),
      authModes: new Set(),
      publicNetwork: false,
      localOnlySignals: 0,
      authMetadata: new Map(),
      primitives: [],
      sourceLine: undefined,
    });
  }
  return servicesByKey.get(fileRelativeLoc);
};

const registerCapabilityObject = (serviceInfo, capabilitiesNode) => {
  if (!capabilitiesNode || capabilitiesNode.type !== "ObjectExpression") {
    return;
  }
  for (const prop of capabilitiesNode.properties || []) {
    if (prop.type !== "ObjectProperty") {
      continue;
    }
    const capabilityName = getMemberExpressionPropertyName(prop.key);
    if (!capabilityName) {
      continue;
    }
    serviceInfo.capabilities.add(capabilityName);
    if (prop.value?.type !== "ObjectExpression") {
      continue;
    }
    for (const nestedProp of prop.value.properties || []) {
      if (nestedProp.type !== "ObjectProperty") {
        continue;
      }
      const nestedName = getMemberExpressionPropertyName(nestedProp.key);
      if (!nestedName || !MCP_CAPABILITY_FLAGS.has(nestedName)) {
        continue;
      }
      if (nestedProp.value?.type === "BooleanLiteral") {
        serviceInfo.capabilityFlags.set(
          `${capabilityName}.${nestedName}`,
          String(nestedProp.value.value),
        );
      }
    }
  }
};

const recordMcpSdkImport = (serviceInfo, sourceValue) => {
  const classification = classifyMcpReference(sourceValue);
  if (!classification.isMcp) {
    return;
  }
  serviceInfo.sdkImports.add(sourceValue);
  serviceInfo.usageSignals.add("mcp-sdk-import");
  if (classification.isOfficial) {
    serviceInfo.officialSdk = true;
  } else if (typeof serviceInfo.officialSdk === "undefined") {
    serviceInfo.officialSdk = false;
  }
};

const recordMcpModelProperty = (serviceInfo, propertyNode) => {
  const propertyName = getMemberExpressionPropertyName(propertyNode?.key);
  if (!propertyName) {
    return;
  }
  if (["model", "modelName"].includes(propertyName)) {
    const modelValue = getLiteralStringValue(propertyNode.value);
    recordMcpModel(serviceInfo, modelValue);
  }
  if (["provider", "providerName"].includes(propertyName)) {
    const providerValue = getLiteralStringValue(propertyNode.value);
    recordMcpProvider(serviceInfo, providerValue);
  }
  if (
    ["endpoint", "baseUrl", "baseURL", "resourceServerUrl", "url"].includes(
      propertyName,
    )
  ) {
    const urlValue = getLiteralStringValue(propertyNode.value);
    if (urlValue) {
      recordUrlUsage(serviceInfo, urlValue, "configured-url");
    }
  }
};

const extractAuthMetadata = (astNode) => {
  if (!astNode || astNode.type !== "ObjectExpression") {
    return {};
  }
  return {
    authorizationEndpoint: objectExpressionStringValue(
      astNode,
      "authorization_endpoint",
    ),
    issuer: objectExpressionStringValue(astNode, "issuer"),
    tokenEndpoint: objectExpressionStringValue(astNode, "token_endpoint"),
  };
};

const extractServerDefinition = (astNode) => {
  const name = objectExpressionStringValue(astNode, "name");
  const version = objectExpressionStringValue(astNode, "version");
  const description =
    objectExpressionStringValue(astNode, "instructions") ||
    objectExpressionStringValue(astNode, "description");
  return { description, name, version };
};

const recordAuthMetadata = (serviceInfo, metadata) => {
  if (!metadata || typeof metadata !== "object") {
    return;
  }
  if (metadata.authorizationEndpoint) {
    serviceInfo.authMetadata.set(
      "authorization_endpoint",
      metadata.authorizationEndpoint,
    );
  }
  if (metadata.issuer) {
    serviceInfo.authMetadata.set("issuer", metadata.issuer);
  }
  if (metadata.tokenEndpoint) {
    serviceInfo.authMetadata.set("token_endpoint", metadata.tokenEndpoint);
  }
};

const primitiveComponentForMcp = (serviceInfo, primitive) => {
  const primitiveName = primitive.name || primitive.uri || primitive.role;
  const serviceToken = sanitizeMcpRefToken(serviceInfo.name);
  const primitiveToken = sanitizeMcpRefToken(primitiveName);
  const primitiveRef = `urn:mcp:${primitive.role}:${serviceToken}:${primitiveToken}`;
  const properties = [
    { name: "SrcFile", value: serviceInfo.file },
    { name: "cdx:mcp:role", value: primitive.role },
    { name: "cdx:mcp:serviceRef", value: serviceInfo["bom-ref"] },
  ];
  if (primitive.description) {
    addUniqueProperty(properties, "cdx:mcp:description", primitive.description);
  }
  if (primitive.uri) {
    addUniqueProperty(properties, "cdx:mcp:resourceUri", primitive.uri);
  }
  if (primitive.sourceLine) {
    addUniqueProperty(
      properties,
      "cdx:mcp:sourceLine",
      String(primitive.sourceLine),
    );
  }
  if (primitive.annotations) {
    addUniqueProperty(
      properties,
      "cdx:mcp:toolAnnotations",
      primitive.annotations,
    );
  }
  return {
    "bom-ref": primitiveRef,
    description: String(
      sanitizeBomPropertyValue(
        "cdx:mcp:description",
        primitive.description ||
          `${primitive.role} exposed by ${serviceInfo.name || "mcp-server"}`,
      ) || "",
    ),
    name: primitiveName,
    properties,
    scope: "required",
    tags: ["mcp", `mcp-${primitive.role}`],
    type: "application",
    version: serviceInfo.version || "latest",
  };
};

const inferMcpServiceType = (serviceInfo) => {
  const hasServerSignals =
    serviceInfo.serviceKinds.has("server") ||
    serviceInfo.primitives.length > 0 ||
    serviceInfo.capabilities.size > 0;
  const hasClientSignals =
    serviceInfo.serviceKinds.has("client") ||
    serviceInfo.outboundHosts.size > 0 ||
    serviceInfo.usageSignals.has("client-constructor");
  if (hasServerSignals && hasClientSignals) {
    return "gateway";
  }
  if (hasServerSignals) {
    return "server";
  }
  if (hasClientSignals) {
    return "client";
  }
  return "endpoint";
};

const inferMcpUsageConfidence = (serviceInfo) => {
  if (
    serviceInfo.usageSignals.has("server-constructor") ||
    serviceInfo.usageSignals.has("client-constructor") ||
    serviceInfo.usageSignals.has("registered-tool") ||
    serviceInfo.usageSignals.has("registered-resource")
  ) {
    return "high";
  }
  if (
    serviceInfo.outboundHosts.size ||
    serviceInfo.providerFamilies.size ||
    serviceInfo.modelNames.size
  ) {
    return "medium";
  }
  return "low";
};

const inferMcpExposureType = (serviceInfo) => {
  if (serviceInfo.publicNetwork) {
    return "networked-public";
  }
  if (serviceInfo.endpoints.size) {
    return "local-only";
  }
  if (serviceInfo.outboundHosts.size) {
    return "outbound-only";
  }
  return "code-only";
};

const inferMcpAuthMode = (serviceInfo) => {
  const authModes = new Set(serviceInfo.authModes);
  if (serviceInfo.authMetadata.size) {
    authModes.add("oauth-metadata");
  }
  if (serviceInfo.authenticated === true && !authModes.size) {
    authModes.add("authenticated");
  }
  if (
    serviceInfo.authenticated === false &&
    serviceInfo.transports.has("streamable-http")
  ) {
    authModes.add("none");
  }
  return Array.from(authModes).sort().join(",");
};

const inferMcpReviewNeeded = (serviceInfo, serviceType, exposureType) =>
  serviceInfo.officialSdk === false ||
  exposureType === "networked-public" ||
  serviceType === "gateway" ||
  (serviceType === "client" && serviceInfo.outboundHosts.size > 0);

const serviceObjectForMcp = (serviceInfo) => {
  const serviceName = serviceInfo.name || "mcp-server";
  const serviceVersion = serviceInfo.version || "latest";
  const serviceRef = `urn:service:mcp:${sanitizeMcpRefToken(serviceName)}:${sanitizeMcpRefToken(serviceVersion)}`;
  const properties = [{ name: "SrcFile", value: serviceInfo.file }];
  const serviceType = inferMcpServiceType(serviceInfo);
  const usageConfidence = inferMcpUsageConfidence(serviceInfo);
  const exposureType = inferMcpExposureType(serviceInfo);
  const authMode = inferMcpAuthMode(serviceInfo);
  const reviewNeeded = inferMcpReviewNeeded(
    serviceInfo,
    serviceType,
    exposureType,
  );
  addUniqueProperty(properties, "cdx:mcp:serviceType", serviceType);
  addUniqueProperty(
    properties,
    "cdx:mcp:inventorySource",
    "source-code-analysis",
  );
  addUniqueProperty(properties, "cdx:mcp:usageConfidence", usageConfidence);
  addUniqueProperty(properties, "cdx:mcp:exposureType", exposureType);
  if (serviceInfo.transports.size) {
    addUniqueProperty(
      properties,
      "cdx:mcp:transport",
      Array.from(serviceInfo.transports).sort().join(","),
    );
  }
  addUniqueProperty(
    properties,
    "cdx:mcp:officialSdk",
    serviceInfo.officialSdk === true ? "true" : "false",
  );
  for (const capability of Array.from(serviceInfo.capabilities).sort()) {
    addUniqueProperty(properties, `cdx:mcp:capabilities:${capability}`, "true");
  }
  for (const [flagName, flagValue] of Array.from(
    serviceInfo.capabilityFlags.entries(),
  ).sort((a, b) => a[0].localeCompare(b[0]))) {
    addUniqueProperty(
      properties,
      `cdx:mcp:capabilities:${flagName}`,
      flagValue,
    );
  }
  if (serviceInfo.sdkImports.size) {
    addUniqueProperty(
      properties,
      "cdx:mcp:sdkImports",
      Array.from(serviceInfo.sdkImports).sort().join(","),
    );
  }
  if (serviceInfo.modelNames.size) {
    addUniqueProperty(
      properties,
      "cdx:mcp:modelNames",
      Array.from(serviceInfo.modelNames).sort().join(","),
    );
  }
  if (serviceInfo.modelFamilies.size) {
    addUniqueProperty(
      properties,
      "cdx:mcp:modelFamilies",
      Array.from(serviceInfo.modelFamilies).sort().join(","),
    );
  }
  if (serviceInfo.providerNames.size) {
    addUniqueProperty(
      properties,
      "cdx:mcp:providerNames",
      Array.from(serviceInfo.providerNames).sort().join(","),
    );
  }
  if (serviceInfo.providerFamilies.size) {
    addUniqueProperty(
      properties,
      "cdx:mcp:providerFamilies",
      Array.from(serviceInfo.providerFamilies).sort().join(","),
    );
  }
  if (serviceInfo.outboundHosts.size) {
    addUniqueProperty(
      properties,
      "cdx:mcp:outboundHosts",
      Array.from(serviceInfo.outboundHosts).sort().join(","),
    );
  }
  if (serviceInfo.usageSignals.size) {
    addUniqueProperty(
      properties,
      "cdx:mcp:usageSignals",
      Array.from(serviceInfo.usageSignals).sort().join(","),
    );
  }
  if (authMode) {
    addUniqueProperty(properties, "cdx:mcp:authMode", authMode);
  }
  if (reviewNeeded) {
    addUniqueProperty(properties, "cdx:mcp:reviewNeeded", "true");
  }
  for (const [metadataKey, metadataValue] of Array.from(
    serviceInfo.authMetadata.entries(),
  ).sort((a, b) => a[0].localeCompare(b[0]))) {
    addUniqueProperty(properties, `cdx:mcp:auth:${metadataKey}`, metadataValue);
  }
  addUniqueProperty(
    properties,
    "cdx:mcp:toolCount",
    String(
      serviceInfo.primitives.filter((item) => item.role === "tool").length,
    ),
  );
  addUniqueProperty(
    properties,
    "cdx:mcp:promptCount",
    String(
      serviceInfo.primitives.filter((item) => item.role === "prompt").length,
    ),
  );
  addUniqueProperty(
    properties,
    "cdx:mcp:resourceCount",
    String(
      serviceInfo.primitives.filter((item) =>
        ["resource", "resource-template"].includes(item.role),
      ).length,
    ),
  );
  if (serviceInfo.sourceLine) {
    addUniqueProperty(
      properties,
      "cdx:mcp:sourceLine",
      String(serviceInfo.sourceLine),
    );
  }
  serviceInfo["bom-ref"] = serviceRef;
  return {
    "bom-ref": serviceRef,
    authenticated: serviceInfo.authenticated,
    description: String(
      sanitizeBomPropertyValue(
        "cdx:mcp:description",
        serviceInfo.description || "",
      ) || "",
    ),
    endpoints: Array.from(serviceInfo.endpoints)
      .map((endpoint) => sanitizeBomUrl(endpoint))
      .filter(Boolean)
      .sort(),
    group: "mcp",
    name: serviceName,
    properties,
    version: serviceVersion,
    "x-trust-boundary": serviceInfo.xTrustBoundary,
  };
};

const buildMcpInventoryFromServices = (servicesByKey) => {
  const services = [];
  const components = [];
  const dependencies = [];
  for (const serviceInfo of servicesByKey.values()) {
    if (
      !serviceInfo.primitives.length &&
      !serviceInfo.transports.size &&
      !serviceInfo.endpoints.size &&
      !serviceInfo.capabilities.size &&
      !serviceInfo.sourceLine &&
      !serviceInfo.outboundHosts.size &&
      !serviceInfo.usageSignals.size
    ) {
      continue;
    }
    if (
      serviceInfo.endpoints.size &&
      !serviceInfo.transports.has("stdio") &&
      !serviceInfo.transports.size
    ) {
      serviceInfo.transports.add("streamable-http");
    }
    if (
      serviceInfo.transports.has("streamable-http") &&
      typeof serviceInfo.authenticated === "undefined"
    ) {
      serviceInfo.authenticated = false;
    }
    const service = serviceObjectForMcp(serviceInfo);
    services.push(service);
    const providedRefs = [];
    for (const primitive of serviceInfo.primitives) {
      const component = primitiveComponentForMcp(serviceInfo, primitive);
      components.push(component);
      providedRefs.push(component["bom-ref"]);
    }
    if (providedRefs.length) {
      dependencies.push({
        ref: service["bom-ref"],
        dependsOn: [],
        provides: providedRefs.sort(),
      });
    }
  }
  return { components, dependencies, services };
};

// Capture groups:
// 1 = module path in `from x import y`
// 2 = imported symbols in `from x import y`
// 3 = imported modules in `import x, y`
const PYTHON_IMPORT_PATTERN =
  /^\s*(?:from\s+([a-zA-Z0-9_.]+)\s+import\s+([^\n#]+)|import\s+([^\n#]+))/gmu;
const PYTHON_DECORATOR_PATTERN = /@([a-zA-Z_][a-zA-Z0-9_]*)\.(\w+)\s*\(/gmu;
const PYTHON_STDIO_PATTERN = /\bstdio_server\s*\(/u;
const PYTHON_HTTP_TRANSPORT_PATTERN = /\b(streamable|sse|http)\b/iu;

const PYTHON_DECORATOR_ROLE_MAP = new Map([
  ["call_tool", "tool"],
  ["get_prompt", "prompt"],
  ["list_prompts", "prompt"],
  ["list_resources", "resource"],
  ["list_tools", "tool"],
  ["prompt", "prompt"],
  ["read_resource", "resource"],
  ["resource", "resource"],
  ["resource_template", "resource-template"],
  ["tool", "tool"],
]);

const lineNumberForIndex = (text, index) =>
  text.slice(0, index).split("\n").length || 1;

const extractPythonNamedString = (argumentText, key) => {
  const directPattern = new RegExp(`${key}\\s*=\\s*["']([^"'\\n]+)["']`, "u");
  const directMatch = argumentText.match(directPattern);
  if (directMatch?.[1]) {
    return directMatch[1];
  }
  const wrappedPattern = new RegExp(
    `${key}\\s*=\\s*[a-zA-Z_][a-zA-Z0-9_.]*\\(\\s*["']([^"'\\n]+)["']`,
    "u",
  );
  return argumentText.match(wrappedPattern)?.[1];
};

const extractFirstPythonString = (argumentText) =>
  argumentText.match(/^\s*["']([^"'\n]+)["']/u)?.[1];

const extractPythonCallArguments = (raw, alias) => {
  const aliasPattern = new RegExp(
    `(\\w+)\\s*=\\s*${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`,
    "gmu",
  );
  const calls = [];
  for (const match of raw.matchAll(aliasPattern)) {
    let callStart = -1;
    for (let index = match.index; index < raw.length; index++) {
      if (raw[index] === "(") {
        callStart = index;
        break;
      }
    }
    if (callStart === -1) {
      continue;
    }
    let depth = 0;
    let callEnd = -1;
    for (let index = callStart; index < raw.length; index++) {
      if (raw[index] === "(") {
        depth += 1;
      } else if (raw[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          callEnd = index;
          break;
        }
      }
    }
    if (callEnd === -1) {
      continue;
    }
    calls.push({
      argumentText: raw.slice(callStart + 1, callEnd),
      index: match.index,
      serviceVarName: match[1],
    });
  }
  return calls;
};

const extractPythonFunctionCalls = (raw, callName) => {
  const callPattern = new RegExp(
    `${callName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`,
    "gmu",
  );
  const calls = [];
  for (const match of raw.matchAll(callPattern)) {
    const callStart = match.index + match[0].lastIndexOf("(");
    let depth = 0;
    let callEnd = -1;
    for (let index = callStart; index < raw.length; index++) {
      if (raw[index] === "(") {
        depth += 1;
      } else if (raw[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          callEnd = index;
          break;
        }
      }
    }
    if (callEnd === -1) {
      continue;
    }
    calls.push({
      argumentText: raw.slice(callStart + 1, callEnd),
      index: match.index,
    });
  }
  return calls;
};

const parsePythonImports = (raw) => {
  const imports = [];
  for (const match of raw.matchAll(PYTHON_IMPORT_PATTERN)) {
    const fromSource = match[1];
    const fromImports = match[2];
    const directImports = match[3];
    if (fromSource && fromImports) {
      for (const importEntry of fromImports.split(",")) {
        const [importedName, localName] = importEntry
          .trim()
          .split(/\s+as\s+/u)
          .map((value) => value?.trim());
        if (importedName) {
          imports.push({
            importedName,
            localName: localName || importedName,
            sourceValue: fromSource,
          });
        }
      }
      continue;
    }
    for (const importEntry of (directImports || "").split(",")) {
      const [sourceValue, localName] = importEntry
        .trim()
        .split(/\s+as\s+/u)
        .map((value) => value?.trim());
      if (sourceValue) {
        imports.push({
          importedName: sourceValue.split(".").pop(),
          localName: localName || sourceValue.split(".").pop(),
          sourceValue,
        });
      }
    }
  }
  return imports;
};

const registerPythonPrimitive = (
  serviceInfo,
  role,
  name,
  description,
  uri,
  sourceLine,
) => {
  if (!role) {
    return;
  }
  const primitiveName =
    name ||
    uri ||
    `${role}-${serviceInfo.primitives.filter((item) => item.role === role).length + 1}`;
  serviceInfo.primitives.push({
    description,
    name: primitiveName,
    role,
    sourceLine,
    uri,
  });
  if (role === "tool") {
    serviceInfo.usageSignals.add("registered-tool");
  }
  if (["resource", "resource-template"].includes(role)) {
    serviceInfo.usageSignals.add("registered-resource");
  }
};

/**
 * Detect MCP server inventory from Python source using import and decorator heuristics.
 *
 * @param {string} src Absolute or relative path to the project source directory
 * @param {boolean} deep When true, also scans nested paths more aggressively
 * @returns {{components: Object[], dependencies: Object[], services: Object[]}}
 */
export const detectPythonMcpInventory = (src, deep = false) => {
  const servicesByKey = new Map();
  let srcFiles = [];
  try {
    srcFiles = getAllFiles(deep, src, ".py");
  } catch {
    return { components: [], dependencies: [], services: [] };
  }
  for (const file of srcFiles) {
    let raw;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const fileRelativeLoc = relative(src, file);
    const serverConstructorAliases = new Set(["Server", "FastMCP"]);
    const importEntries = parsePythonImports(raw);
    let fileHasMcpImports = false;
    for (const importEntry of importEntries) {
      const sourceValue = importEntry.sourceValue;
      const classification = classifyMcpReference(sourceValue);
      if (!classification.isMcp && !sourceValue.startsWith("mcp")) {
        continue;
      }
      fileHasMcpImports = true;
      const serviceInfo = ensureMcpService(
        servicesByKey,
        file,
        fileRelativeLoc,
      );
      if (sourceValue.startsWith("mcp")) {
        serviceInfo.sdkImports.add(sourceValue);
        serviceInfo.usageSignals.add("mcp-sdk-import");
        serviceInfo.officialSdk = true;
      } else {
        recordMcpSdkImport(serviceInfo, sourceValue);
      }
      if (
        sourceValue.startsWith("mcp.server") ||
        sourceValue === "fastmcp" ||
        /server/i.test(importEntry.importedName || "") ||
        /server/i.test(importEntry.localName || "")
      ) {
        serverConstructorAliases.add(importEntry.localName);
      }
    }
    for (const alias of serverConstructorAliases) {
      for (const match of extractPythonCallArguments(raw, alias)) {
        const serviceVarName = match.serviceVarName;
        const argumentText = match.argumentText || "";
        const serviceInfo = ensureMcpService(
          servicesByKey,
          file,
          fileRelativeLoc,
        );
        serviceInfo.name =
          extractPythonNamedString(argumentText, "name") ||
          extractFirstPythonString(argumentText) ||
          serviceInfo.name;
        serviceInfo.version =
          extractPythonNamedString(argumentText, "version") ||
          serviceInfo.version;
        serviceInfo.description =
          extractPythonNamedString(argumentText, "instructions") ||
          extractPythonNamedString(argumentText, "description") ||
          serviceInfo.description;
        serviceInfo.serviceKinds.add("server");
        serviceInfo.usageSignals.add("server-constructor");
        serviceInfo.sourceLine = lineNumberForIndex(raw, match.index);
        for (const decoratorMatch of raw.matchAll(PYTHON_DECORATOR_PATTERN)) {
          if (decoratorMatch[1] !== serviceVarName) {
            continue;
          }
          const primitiveRole = PYTHON_DECORATOR_ROLE_MAP.get(
            decoratorMatch[2],
          );
          if (!primitiveRole) {
            continue;
          }
          if (primitiveRole === "tool") {
            serviceInfo.capabilities.add("tools");
          } else if (primitiveRole === "prompt") {
            serviceInfo.capabilities.add("prompts");
          } else {
            serviceInfo.capabilities.add("resources");
          }
        }
      }
    }
    if (PYTHON_STDIO_PATTERN.test(raw)) {
      const serviceInfo = ensureMcpService(
        servicesByKey,
        file,
        fileRelativeLoc,
      );
      serviceInfo.transports.add("stdio");
    } else if (fileHasMcpImports && PYTHON_HTTP_TRANSPORT_PATTERN.test(raw)) {
      const serviceInfo = ensureMcpService(
        servicesByKey,
        file,
        fileRelativeLoc,
      );
      serviceInfo.transports.add("streamable-http");
    }
    const primitivePatterns = [
      ["mtypes.Tool", "tool"],
      ["mtypes.Prompt", "prompt"],
      ["mtypes.Resource", "resource"],
    ];
    for (const [callName, role] of primitivePatterns) {
      for (const match of extractPythonFunctionCalls(raw, callName)) {
        const serviceInfo = ensureMcpService(
          servicesByKey,
          file,
          fileRelativeLoc,
        );
        registerPythonPrimitive(
          serviceInfo,
          role,
          extractPythonNamedString(match.argumentText || "", "name"),
          extractPythonNamedString(match.argumentText || "", "description"),
          extractPythonNamedString(match.argumentText || "", "uri"),
          lineNumberForIndex(raw, match.index),
        );
      }
    }
    if (fileHasMcpImports) {
      ensureMcpService(servicesByKey, file, fileRelativeLoc);
    }
  }
  return buildMcpInventoryFromServices(servicesByKey);
};

/**
 * Detect MCP server inventory from JavaScript/TypeScript source using AST analysis.
 *
 * @param {string} src Absolute or relative path to the project source directory
 * @param {boolean} deep When true, also scans nested paths more aggressively
 * @returns {{components: Object[], dependencies: Object[], services: Object[]}}
 */
export const detectMcpInventory = (src, deep = false) => {
  const servicesByKey = new Map();
  let srcFiles = [];
  try {
    const searchOptions = normalizeAnalyzerSearchOptions(deep);
    srcFiles = [
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".js",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".jsx",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".cjs",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".mjs",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".ts",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".tsx",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".vue",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
      ...getAllFiles(
        searchOptions.deep,
        src,
        ".svelte",
        undefined,
        undefined,
        undefined,
        src,
        searchOptions.exclude,
      ),
    ];
  } catch {
    return { components: [], dependencies: [], services: [] };
  }
  for (const file of srcFiles) {
    const fileRelativeLoc = relative(src, file);
    const serverConstructorAliases = new Set(["McpServer", "MCPServer"]);
    const clientConstructorAliases = new Set(MCP_CLIENT_CONSTRUCTOR_NAMES);
    const authHelperAliases = new Set(MCP_AUTH_HELPERS);
    const httpTransportAliases = new Set(MCP_HTTP_TRANSPORT_NAMES);
    const stdioTransportAliases = new Set(MCP_STDIO_TRANSPORT_NAMES);
    const httpClientTransportAliases = new Set(MCP_HTTP_CLIENT_TRANSPORT_NAMES);
    const stdioClientTransportAliases = new Set(
      MCP_STDIO_CLIENT_TRANSPORT_NAMES,
    );
    const appFactoryAliases = new Set(MCP_APP_FACTORIES);
    const appAliases = new Set();
    const clientAliases = new Set();
    const providerAliases = new Map();
    const transportAliasKinds = new Map();
    const urlLiteralByAlias = new Map();
    const authMetadataByAlias = new Map();
    let fileHasMcpImports = false;
    try {
      const ast = parse(fileToParseableCode(file), babelParserOptions);
      traverse.default(ast, {
        ImportDeclaration: (path) => {
          const sourceValue = getLiteralStringValue(path?.node?.source);
          const classification = classifyMcpReference(sourceValue);
          const providerFamily = providerFamilyFromImportSource(sourceValue);
          if (classification.isMcp) {
            fileHasMcpImports = true;
            const serviceInfo = ensureMcpService(
              servicesByKey,
              file,
              fileRelativeLoc,
            );
            recordMcpSdkImport(serviceInfo, sourceValue);
          }
          for (const specifier of path.node.specifiers || []) {
            const localName = specifier.local?.name;
            if (!localName) {
              continue;
            }
            const importedName =
              specifier.type === "ImportSpecifier"
                ? specifier.imported?.name
                : localName;
            if (
              classification.isMcp &&
              (sourceValue?.includes("/server") ||
                /server/i.test(localName) ||
                importedName === "McpServer" ||
                importedName === "Server")
            ) {
              serverConstructorAliases.add(localName);
            }
            if (
              classification.isMcp &&
              (sourceValue?.includes("/client") ||
                /client/i.test(localName) ||
                importedName === "Client")
            ) {
              clientConstructorAliases.add(localName);
            }
            if (MCP_AUTH_HELPERS.has(importedName)) {
              authHelperAliases.add(localName);
            }
            if (MCP_HTTP_TRANSPORT_NAMES.has(importedName)) {
              httpTransportAliases.add(localName);
            }
            if (MCP_STDIO_TRANSPORT_NAMES.has(importedName)) {
              stdioTransportAliases.add(localName);
            }
            if (MCP_HTTP_CLIENT_TRANSPORT_NAMES.has(importedName)) {
              httpClientTransportAliases.add(localName);
            }
            if (MCP_STDIO_CLIENT_TRANSPORT_NAMES.has(importedName)) {
              stdioClientTransportAliases.add(localName);
            }
            if (MCP_APP_FACTORIES.has(importedName)) {
              appFactoryAliases.add(localName);
            }
            if (sourceValue === "express") {
              appFactoryAliases.add(localName);
            }
            if (providerFamily) {
              providerAliases.set(localName, providerFamily);
              const serviceInfo = servicesByKey.get(fileRelativeLoc);
              if (serviceInfo) {
                recordMcpProvider(serviceInfo, providerFamily);
                serviceInfo.usageSignals.add("provider-sdk-import");
              }
            }
          }
        },
        VariableDeclarator: (path) => {
          const idNode = path?.node?.id;
          const initNode = unwrapAwait(path?.node?.init);
          if (!idNode || !initNode) {
            return;
          }
          if (
            initNode.type === "CallExpression" &&
            initNode.callee?.type === "Identifier" &&
            initNode.callee.name === "require"
          ) {
            const sourceValue = getLiteralStringValue(initNode.arguments?.[0]);
            const classification = classifyMcpReference(sourceValue);
            const providerFamily = providerFamilyFromImportSource(sourceValue);
            if (classification.isMcp) {
              fileHasMcpImports = true;
              const serviceInfo = ensureMcpService(
                servicesByKey,
                file,
                fileRelativeLoc,
              );
              recordMcpSdkImport(serviceInfo, sourceValue);
              if (idNode.type === "Identifier") {
                if (
                  sourceValue?.includes("/server") ||
                  /server/i.test(idNode.name)
                ) {
                  serverConstructorAliases.add(idNode.name);
                }
                if (
                  sourceValue?.includes("/client") ||
                  /client/i.test(idNode.name)
                ) {
                  clientConstructorAliases.add(idNode.name);
                }
              }
              for (const moduleName of getNamedImportsFromObjectPattern(
                idNode,
              )) {
                if (MCP_AUTH_HELPERS.has(moduleName)) {
                  authHelperAliases.add(moduleName);
                }
                if (MCP_HTTP_TRANSPORT_NAMES.has(moduleName)) {
                  httpTransportAliases.add(moduleName);
                }
                if (MCP_STDIO_TRANSPORT_NAMES.has(moduleName)) {
                  stdioTransportAliases.add(moduleName);
                }
                if (MCP_HTTP_CLIENT_TRANSPORT_NAMES.has(moduleName)) {
                  httpClientTransportAliases.add(moduleName);
                }
                if (MCP_STDIO_CLIENT_TRANSPORT_NAMES.has(moduleName)) {
                  stdioClientTransportAliases.add(moduleName);
                }
                if (MCP_APP_FACTORIES.has(moduleName)) {
                  appFactoryAliases.add(moduleName);
                }
                if (sourceValue === "express") {
                  appFactoryAliases.add(moduleName);
                }
                if (
                  sourceValue?.includes("/server") ||
                  /server/i.test(moduleName) ||
                  moduleName === "McpServer"
                ) {
                  serverConstructorAliases.add(moduleName);
                }
                if (
                  sourceValue?.includes("/client") ||
                  /client/i.test(moduleName) ||
                  moduleName === "Client"
                ) {
                  clientConstructorAliases.add(moduleName);
                }
              }
            }
            if (providerFamily && idNode.type === "Identifier") {
              providerAliases.set(idNode.name, providerFamily);
              const serviceInfo = servicesByKey.get(fileRelativeLoc);
              if (serviceInfo) {
                recordMcpProvider(serviceInfo, providerFamily);
                serviceInfo.usageSignals.add("provider-sdk-import");
              }
            }
          }
          if (
            idNode.type === "Identifier" &&
            initNode.type === "NewExpression" &&
            initNode.callee?.type === "Identifier" &&
            serverConstructorAliases.has(initNode.callee.name)
          ) {
            const serviceInfo = ensureMcpService(
              servicesByKey,
              file,
              fileRelativeLoc,
            );
            const serverDefinition = extractServerDefinition(
              initNode.arguments?.[0],
            );
            serviceInfo.name = serverDefinition.name || serviceInfo.name;
            serviceInfo.version =
              serverDefinition.version || serviceInfo.version;
            serviceInfo.description =
              serverDefinition.description || serviceInfo.description;
            serviceInfo.sourceLine =
              serviceInfo.sourceLine || path.node.loc?.start?.line;
            serviceInfo.serviceKinds.add("server");
            serviceInfo.usageSignals.add("server-constructor");
            const capabilityNode =
              objectExpressionProperty(initNode.arguments?.[1], "capabilities")
                ?.value ||
              (initNode.arguments?.[1]?.type === "ObjectExpression"
                ? initNode.arguments[1]
                : undefined);
            registerCapabilityObject(serviceInfo, capabilityNode);
          }
          if (
            idNode.type === "Identifier" &&
            initNode.type === "CallExpression" &&
            initNode.callee?.type === "Identifier" &&
            appFactoryAliases.has(initNode.callee.name)
          ) {
            appAliases.add(idNode.name);
          }
          if (
            idNode.type === "Identifier" &&
            initNode.type === "NewExpression" &&
            initNode.callee?.type === "Identifier" &&
            clientConstructorAliases.has(initNode.callee.name)
          ) {
            const serviceInfo = ensureMcpService(
              servicesByKey,
              file,
              fileRelativeLoc,
            );
            clientAliases.add(idNode.name);
            serviceInfo.serviceKinds.add("client");
            serviceInfo.sourceLine =
              serviceInfo.sourceLine || path.node.loc?.start?.line;
            serviceInfo.usageSignals.add("client-constructor");
          }
          if (
            idNode.type === "Identifier" &&
            initNode.type === "NewExpression" &&
            initNode.callee?.type === "Identifier" &&
            providerAliases.has(initNode.callee.name) &&
            servicesByKey.has(fileRelativeLoc)
          ) {
            const serviceInfo = ensureMcpService(
              servicesByKey,
              file,
              fileRelativeLoc,
            );
            recordMcpProvider(
              serviceInfo,
              providerAliases.get(initNode.callee.name),
            );
            serviceInfo.serviceKinds.add("client");
            serviceInfo.usageSignals.add("provider-sdk-client");
          }
          if (
            idNode.type === "Identifier" &&
            initNode.type === "NewExpression" &&
            initNode.callee?.type === "Identifier"
          ) {
            if (httpTransportAliases.has(initNode.callee.name)) {
              transportAliasKinds.set(idNode.name, "streamable-http");
            }
            if (stdioTransportAliases.has(initNode.callee.name)) {
              transportAliasKinds.set(idNode.name, "stdio");
            }
            if (httpClientTransportAliases.has(initNode.callee.name)) {
              transportAliasKinds.set(idNode.name, "streamable-http");
              const serviceInfo = ensureMcpService(
                servicesByKey,
                file,
                fileRelativeLoc,
              );
              serviceInfo.serviceKinds.add("client");
              serviceInfo.usageSignals.add("client-http-transport");
              recordUrlUsage(
                serviceInfo,
                getUrlStringValue(initNode.arguments?.[0], urlLiteralByAlias),
                "outbound-mcp-endpoint",
              );
            }
            if (stdioClientTransportAliases.has(initNode.callee.name)) {
              transportAliasKinds.set(idNode.name, "stdio");
              const serviceInfo = ensureMcpService(
                servicesByKey,
                file,
                fileRelativeLoc,
              );
              serviceInfo.serviceKinds.add("client");
              serviceInfo.usageSignals.add("client-stdio-transport");
            }
            if (initNode.callee.name === "URL") {
              const urlValue = getLiteralStringValue(initNode.arguments?.[0]);
              if (urlValue) {
                urlLiteralByAlias.set(idNode.name, urlValue);
                const classifiedUrl = classifyUrlValue(urlValue);
                if (
                  servicesByKey.has(fileRelativeLoc) ||
                  classifiedUrl?.isMcpEndpoint ||
                  classifiedUrl?.providerFamily
                ) {
                  const serviceInfo = ensureMcpService(
                    servicesByKey,
                    file,
                    fileRelativeLoc,
                  );
                  recordUrlUsage(serviceInfo, urlValue, "configured-url", true);
                  if (urlValue.includes("/mcp")) {
                    serviceInfo.transports.add("streamable-http");
                  }
                }
              }
            }
          }
          if (
            idNode.type === "Identifier" &&
            initNode.type === "ObjectExpression" &&
            (objectExpressionProperty(initNode, "authorization_endpoint") ||
              objectExpressionProperty(initNode, "token_endpoint") ||
              objectExpressionProperty(initNode, "issuer"))
          ) {
            authMetadataByAlias.set(idNode.name, extractAuthMetadata(initNode));
          }
          if (idNode.type === "Identifier") {
            const literalValue = getLiteralStringValue(initNode);
            const serviceInfo = servicesByKey.get(fileRelativeLoc);
            if (literalValue && serviceInfo) {
              if (["model", "modelName"].includes(idNode.name)) {
                recordMcpModel(serviceInfo, literalValue);
              }
              if (["provider", "providerName"].includes(idNode.name)) {
                recordMcpProvider(serviceInfo, literalValue);
              }
              if (
                [
                  "endpoint",
                  "mcpEndpoint",
                  "resourceServerUrl",
                  "url",
                ].includes(idNode.name)
              ) {
                recordUrlUsage(serviceInfo, literalValue, "configured-url");
              }
            }
            if (
              providerAliases.has(idNode.name) &&
              servicesByKey.has(fileRelativeLoc)
            ) {
              const serviceInfo = ensureMcpService(
                servicesByKey,
                file,
                fileRelativeLoc,
              );
              recordMcpProvider(serviceInfo, providerAliases.get(idNode.name));
            }
          }
        },
        ObjectProperty: (path) => {
          const serviceInfo = servicesByKey.get(fileRelativeLoc);
          if (!serviceInfo) {
            return;
          }
          recordMcpModelProperty(serviceInfo, path.node);
        },
        NewExpression: (path) => {
          if (path?.node?.callee?.type !== "Identifier") {
            return;
          }
          const serviceInfo = servicesByKey.get(fileRelativeLoc);
          if (!serviceInfo) {
            return;
          }
          if (httpTransportAliases.has(path.node.callee.name)) {
            serviceInfo.transports.add("streamable-http");
          }
          if (stdioTransportAliases.has(path.node.callee.name)) {
            serviceInfo.transports.add("stdio");
          }
          if (httpClientTransportAliases.has(path.node.callee.name)) {
            serviceInfo.serviceKinds.add("client");
            serviceInfo.usageSignals.add("client-http-transport");
            recordUrlUsage(
              serviceInfo,
              getUrlStringValue(path.node.arguments?.[0], urlLiteralByAlias),
              "outbound-mcp-endpoint",
            );
          }
          if (stdioClientTransportAliases.has(path.node.callee.name)) {
            serviceInfo.serviceKinds.add("client");
            serviceInfo.usageSignals.add("client-stdio-transport");
          }
        },
        CallExpression: (path) => {
          const callNode = path?.node;
          if (!callNode) {
            return;
          }
          const serviceInfo = servicesByKey.get(fileRelativeLoc);
          const callee = callNode.callee;
          if (
            callee.type === "Identifier" &&
            authHelperAliases.has(callee.name)
          ) {
            const ensuredService = ensureMcpService(
              servicesByKey,
              file,
              fileRelativeLoc,
            );
            ensuredService.authenticated = true;
            ensuredService.xTrustBoundary = true;
            ensuredService.usageSignals.add("auth-helper");
            if (callee.name === "requireBearerAuth") {
              ensuredService.authModes.add("bearer");
            }
            if (callee.name === "mcpAuthMetadataRouter") {
              ensuredService.authModes.add("oauth-metadata");
            }
            if (callee.name === "createProtectedResourceMetadataRouter") {
              ensuredService.authModes.add("protected-resource-metadata");
            }
            if (
              callNode.arguments?.[0]?.type === "ObjectExpression" &&
              callee.name === "mcpAuthMetadataRouter"
            ) {
              const authMetadataNode = objectExpressionProperty(
                callNode.arguments[0],
                "oauthMetadata",
              )?.value;
              if (authMetadataNode?.type === "Identifier") {
                recordAuthMetadata(
                  ensuredService,
                  authMetadataByAlias.get(authMetadataNode.name),
                );
              } else {
                recordAuthMetadata(
                  ensuredService,
                  extractAuthMetadata(authMetadataNode),
                );
              }
              const resourceServerNode = objectExpressionProperty(
                callNode.arguments[0],
                "resourceServerUrl",
              )?.value;
              if (
                resourceServerNode?.type === "Identifier" &&
                urlLiteralByAlias.has(resourceServerNode.name)
              ) {
                recordUrlUsage(
                  ensuredService,
                  urlLiteralByAlias.get(resourceServerNode.name),
                  "configured-url",
                  true,
                );
              }
            }
            return;
          }
          if (callee.type === "Identifier") {
            if (serviceInfo && MCP_NETWORK_METHODS.has(callee.name)) {
              recordUrlUsage(
                serviceInfo,
                getUrlStringValue(callNode.arguments?.[0], urlLiteralByAlias),
                "outbound-network",
              );
            }
            return;
          }
          if (callee.type !== "MemberExpression") {
            return;
          }
          const objectName = getMemberChainString(callee.object);
          const methodName = getMemberExpressionPropertyName(callee.property);
          if (!methodName) {
            return;
          }
          if (methodName === "connect" && serviceInfo) {
            const transportArg = callNode.arguments?.[0];
            if (clientAliases.has(objectName)) {
              serviceInfo.serviceKinds.add("client");
              serviceInfo.usageSignals.add("client-connect");
            }
            if (transportArg?.type === "Identifier") {
              const transportKind = transportAliasKinds.get(transportArg.name);
              if (transportKind) {
                serviceInfo.transports.add(transportKind);
              }
            } else if (
              transportArg?.type === "NewExpression" &&
              transportArg.callee?.type === "Identifier"
            ) {
              if (httpTransportAliases.has(transportArg.callee.name)) {
                serviceInfo.transports.add("streamable-http");
              }
              if (stdioTransportAliases.has(transportArg.callee.name)) {
                serviceInfo.transports.add("stdio");
              }
              if (httpClientTransportAliases.has(transportArg.callee.name)) {
                serviceInfo.serviceKinds.add("client");
                serviceInfo.usageSignals.add("client-connect");
                recordUrlUsage(
                  serviceInfo,
                  getUrlStringValue(
                    transportArg.arguments?.[0],
                    urlLiteralByAlias,
                  ),
                  "outbound-mcp-endpoint",
                );
              }
            }
          }
          if (
            serviceInfo &&
            ["registerPrompt", "registerResource", "registerTool"].includes(
              methodName,
            )
          ) {
            const primitive = {
              annotations: undefined,
              description: undefined,
              name: undefined,
              role:
                methodName === "registerTool"
                  ? "tool"
                  : methodName === "registerPrompt"
                    ? "prompt"
                    : "resource",
              sourceLine: callNode.loc?.start?.line,
              uri: undefined,
            };
            primitive.name = getLiteralStringValue(callNode.arguments?.[0]);
            if (methodName === "registerTool") {
              primitive.description = objectExpressionStringValue(
                callNode.arguments?.[1],
                "description",
              );
              const annotationsNode = objectExpressionProperty(
                callNode.arguments?.[1],
                "annotations",
              )?.value;
              if (annotationsNode?.type === "ObjectExpression") {
                const annotations = {};
                for (const prop of annotationsNode.properties || []) {
                  if (prop.type !== "ObjectProperty") {
                    continue;
                  }
                  const keyName = getMemberExpressionPropertyName(prop.key);
                  const boolValue =
                    prop.value?.type === "BooleanLiteral"
                      ? prop.value.value
                      : undefined;
                  const stringValue = getLiteralStringValue(prop.value);
                  if (keyName && typeof boolValue === "boolean") {
                    annotations[keyName] = boolValue;
                  } else if (keyName && stringValue) {
                    annotations[keyName] = stringValue;
                  }
                }
                if (Object.keys(annotations).length) {
                  primitive.annotations = annotations;
                }
              }
              serviceInfo.capabilities.add("tools");
            } else if (methodName === "registerPrompt") {
              primitive.description = objectExpressionStringValue(
                callNode.arguments?.[1],
                "description",
              );
              serviceInfo.capabilities.add("prompts");
            } else if (methodName === "registerResource") {
              primitive.uri = getLiteralStringValue(callNode.arguments?.[1]);
              primitive.description = objectExpressionStringValue(
                callNode.arguments?.[2],
                "description",
              );
              if (
                primitive.uri?.includes("{") ||
                primitive.uri?.includes("}")
              ) {
                primitive.role = "resource-template";
              }
              serviceInfo.capabilities.add("resources");
            }
            if (primitive.name || primitive.uri) {
              serviceInfo.primitives.push(primitive);
            }
            serviceInfo.serviceKinds.add("server");
            serviceInfo.usageSignals.add(`registered-${primitive.role}`);
            return;
          }
          if (serviceInfo && MCP_CLIENT_USAGE_METHODS.has(methodName)) {
            serviceInfo.serviceKinds.add("client");
            serviceInfo.usageSignals.add(`client-${methodName}`);
          }
          if (
            serviceInfo &&
            appAliases.has(objectName) &&
            MCP_ROUTE_METHODS.has(methodName)
          ) {
            const routePath = getLiteralStringValue(callNode.arguments?.[0]);
            if (routePath?.includes("/mcp")) {
              recordUrlUsage(serviceInfo, routePath, "route-endpoint", true);
              serviceInfo.transports.add("streamable-http");
              serviceInfo.serviceKinds.add("server");
            }
            if (
              routePath?.includes("/.well-known/oauth-authorization-server") ||
              routePath?.includes("/.well-known/oauth-protected-resource")
            ) {
              serviceInfo.authenticated = true;
              serviceInfo.xTrustBoundary = true;
              serviceInfo.authModes.add("oauth-metadata");
              recordUrlUsage(serviceInfo, routePath, "auth-discovery", true);
            }
            for (const arg of callNode.arguments || []) {
              if (
                arg?.type === "Identifier" &&
                authHelperAliases.has(arg.name)
              ) {
                serviceInfo.authenticated = true;
                serviceInfo.xTrustBoundary = true;
                serviceInfo.authModes.add("bearer");
              }
              if (
                arg?.type === "CallExpression" &&
                arg.callee?.type === "Identifier" &&
                authHelperAliases.has(arg.callee.name)
              ) {
                serviceInfo.authenticated = true;
                serviceInfo.xTrustBoundary = true;
                serviceInfo.authModes.add("bearer");
              }
            }
          }
          if (!serviceInfo) {
            return;
          }
          const outboundUrl = getUrlStringValue(
            callNode.arguments?.[0],
            urlLiteralByAlias,
          );
          const objectRootName = rootMemberName(objectName);
          if (providerAliases.has(objectRootName)) {
            recordMcpProvider(serviceInfo, providerAliases.get(objectRootName));
            serviceInfo.serviceKinds.add("client");
            serviceInfo.usageSignals.add("provider-sdk-call");
          }
          if (outboundUrl && MCP_NETWORK_METHODS.has(methodName)) {
            recordUrlUsage(serviceInfo, outboundUrl, "outbound-network");
          }
          if (outboundUrl?.includes("/mcp")) {
            recordUrlUsage(serviceInfo, outboundUrl, "outbound-mcp-endpoint");
          }
        },
      });
    } catch {
      // Skip parse failures and continue scanning
    }
    if (fileHasMcpImports && !servicesByKey.has(fileRelativeLoc)) {
      ensureMcpService(servicesByKey, file, fileRelativeLoc);
    }
  }
  return buildMcpInventoryFromServices(servicesByKey);
};
