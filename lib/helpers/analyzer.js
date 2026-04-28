import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

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
