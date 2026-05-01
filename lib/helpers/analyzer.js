import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

import { classifyMcpReference } from "./mcp.js";
import { isLocalHost, sanitizeMcpRefToken } from "./mcpDiscovery.js";

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

const getAllFiles = (deep, dir, extn, files, result, regex) => {
  files = files || readdirSync(dir);
  result = result || [];
  regex = regex || new RegExp(`\\${extn}$`);

  for (let i = 0; i < files.length; i++) {
    if (IGNORE_FILE_PATTERN.test(files[i]) || files[i].startsWith(".")) {
      continue;
    }
    const file = join(dir, files[i]);
    const fileStat = lstatSync(file);
    if (fileStat.isSymbolicLink()) {
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
  Promise.all([
    getAllFiles(deep, src, ".js"),
    getAllFiles(deep, src, ".jsx"),
    getAllFiles(deep, src, ".cjs"),
    getAllFiles(deep, src, ".mjs"),
    getAllFiles(deep, src, ".ts"),
    getAllFiles(deep, src, ".tsx"),
    getAllFiles(deep, src, ".vue"),
    getAllFiles(deep, src, ".svelte"),
  ]);

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

function analyzeSuspiciousJsSource(source) {
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
    srcFiles = [
      ...getAllFiles(deep, src, ".js"),
      ...getAllFiles(deep, src, ".jsx"),
      ...getAllFiles(deep, src, ".cjs"),
      ...getAllFiles(deep, src, ".mjs"),
      ...getAllFiles(deep, src, ".ts"),
      ...getAllFiles(deep, src, ".tsx"),
      ...getAllFiles(deep, src, ".vue"),
      ...getAllFiles(deep, src, ".svelte"),
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
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (properties.some((prop) => prop.name === name && prop.value === value)) {
    return;
  }
  properties.push({ name, value });
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
      JSON.stringify(primitive.annotations),
    );
  }
  return {
    "bom-ref": primitiveRef,
    description:
      primitive.description ||
      `${primitive.role} exposed by ${serviceInfo.name || "mcp-server"}`,
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
    description: serviceInfo.description,
    endpoints: Array.from(serviceInfo.endpoints).sort(),
    group: "mcp",
    name: serviceName,
    properties,
    version: serviceVersion,
    "x-trust-boundary": serviceInfo.xTrustBoundary,
  };
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
    srcFiles = [
      ...getAllFiles(deep, src, ".js"),
      ...getAllFiles(deep, src, ".jsx"),
      ...getAllFiles(deep, src, ".cjs"),
      ...getAllFiles(deep, src, ".mjs"),
      ...getAllFiles(deep, src, ".ts"),
      ...getAllFiles(deep, src, ".tsx"),
      ...getAllFiles(deep, src, ".vue"),
      ...getAllFiles(deep, src, ".svelte"),
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
