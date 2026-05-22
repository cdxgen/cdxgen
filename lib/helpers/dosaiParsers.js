import { PackageURL } from "packageurl-js";

export function normalizeDosaiPurlKey(purl) {
  if (!purl || typeof purl !== "string") {
    return undefined;
  }
  try {
    const purlObj = PackageURL.fromString(purl);
    return [
      purlObj.type?.toLowerCase(),
      purlObj.namespace?.toLowerCase() || "",
      purlObj.name?.toLowerCase(),
    ].join("/");
  } catch (_err) {
    return purl.split("?")[0].split("#")[0].split("@")[0].toLowerCase();
  }
}

export function addDosaiSetValue(map, key, value) {
  if (!key || !value) {
    return;
  }
  map[key] ??= new Set();
  map[key].add(value);
}

export function dosaiLocation(item) {
  const location = item?.Location || item?.CallLocation || item;
  const fileName =
    location?.Path || location?.FileName || item?.Path || item?.FileName;
  if (!fileName || fileName === "<unknown>") {
    return undefined;
  }
  const lineNumber = location?.LineNumber || item?.LineNumber;
  if (lineNumber && lineNumber > 0) {
    return `${fileName}#${lineNumber}`;
  }
  return fileName;
}

function dosaiSourceFileName(item) {
  const location = item?.Location || item?.CallLocation || item;
  return String(
    location?.Path || location?.FileName || item?.Path || item?.FileName || "",
  );
}

function dosaiSourceLineNumber(item) {
  const location = item?.Location || item?.CallLocation || item;
  return location?.LineNumber || item?.LineNumber;
}

export function dosaiSourceLocationFromNode(node) {
  const location = dosaiLocation(node);
  const fileName = dosaiSourceFileName(node).toLowerCase();
  const lineNumber = dosaiSourceLineNumber(node);
  if (!location || !/\.(cs|vb|fs|fsx)$/i.test(fileName)) {
    return undefined;
  }
  if (!lineNumber || lineNumber <= 0) {
    return undefined;
  }
  return location;
}

export function dosaiSourceLocation(location) {
  const sourceLocation = dosaiLocation(location);
  const fileName = dosaiSourceFileName(location);
  const lineNumber = dosaiSourceLineNumber(location);
  if (!sourceLocation || !/\.(cs|vb|fs|fsx)$/i.test(fileName)) {
    return undefined;
  }
  if (!lineNumber || lineNumber <= 0) {
    return undefined;
  }
  return sourceLocation;
}

export function buildDosaiPurlAliasMap(components = []) {
  const purlAliasMap = new Map();
  for (const component of components) {
    if (!component?.purl) {
      continue;
    }
    purlAliasMap.set(component.purl, component.purl);
    const key = normalizeDosaiPurlKey(component.purl);
    if (key && !purlAliasMap.has(key)) {
      purlAliasMap.set(key, component.purl);
    }
  }
  return purlAliasMap;
}

export function resolveDosaiComponentPurl(purl, purlAliasMap) {
  if (!purl) {
    return undefined;
  }
  return (
    purlAliasMap.get(purl) ||
    purlAliasMap.get(normalizeDosaiPurlKey(purl)) ||
    purl
  );
}
