function toProperties(propertiesOrObject) {
  if (Array.isArray(propertiesOrObject)) {
    return propertiesOrObject;
  }
  if (Array.isArray(propertiesOrObject?.properties)) {
    return propertiesOrObject.properties;
  }
  return [];
}

export function getPropertyValue(propertiesOrObject, propertyName) {
  return toProperties(propertiesOrObject).find(
    (property) => property?.name === propertyName,
  )?.value;
}

function hasPropertyValue(propertiesOrObject, propertyName, valuePredicate) {
  const propertyValue = getPropertyValue(propertiesOrObject, propertyName);
  if (typeof valuePredicate === "function") {
    return valuePredicate(propertyValue);
  }
  return propertyValue === valuePredicate;
}

function isFileComponent(component) {
  return component?.type === "file";
}

function isCryptographicAssetComponent(component) {
  return component?.type === "cryptographic-asset";
}

export function getUnpackagedExecutableComponents(components = []) {
  return (components || []).filter(
    (component) =>
      isFileComponent(component) &&
      hasPropertyValue(component, "internal:is_executable", "true"),
  );
}

export function getUnpackagedSharedLibraryComponents(components = []) {
  return (components || []).filter(
    (component) =>
      isFileComponent(component) &&
      hasPropertyValue(component, "internal:is_shared_library", "true"),
  );
}

export function getSourceDerivedCryptoComponents(components = []) {
  return (components || []).filter(
    (component) =>
      isCryptographicAssetComponent(component) &&
      hasPropertyValue(component, "cdx:crypto:sourceType", (propertyValue) =>
        propertyValue?.startsWith("js-ast:"),
      ),
  );
}

export function getContainerFileInventoryStats(components = []) {
  const unpackagedExecutables = getUnpackagedExecutableComponents(components);
  const unpackagedSharedLibraries =
    getUnpackagedSharedLibraryComponents(components);
  return {
    unpackagedExecutables,
    unpackagedSharedLibraries,
    unpackagedExecutableCount: unpackagedExecutables.length,
    unpackagedSharedLibraryCount: unpackagedSharedLibraries.length,
  };
}
