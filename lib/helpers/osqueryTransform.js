import { PackageURL } from "packageurl-js";

export function deriveOsQueryVersion(res) {
  return (
    res.version ||
    res.hotfix_id ||
    res.hardware_version ||
    res.port ||
    res.pid ||
    res.subject_key_id ||
    res.interface ||
    res.instance_id
  );
}

export function deriveOsQueryName(res, singleResult, queryName) {
  let name =
    res.name ||
    res.device_id ||
    res.hotfix_id ||
    res.uuid ||
    res.serial ||
    res.pid ||
    res.address ||
    res.ami_id ||
    res.interface ||
    res.client_app_id;
  if (!name && singleResult && queryName) {
    name = queryName;
  }
  return name;
}

export function deriveOsQueryPublisher(res) {
  const publisher =
    res.publisher ||
    res.maintainer ||
    res.creator ||
    res.manufacturer ||
    res.provider ||
    "";
  return publisher === "null" ? "" : publisher;
}

export function deriveOsQueryDescription(res) {
  return (
    res.description ||
    res.summary ||
    res.arguments ||
    res.device ||
    res.codename ||
    res.section ||
    res.status ||
    res.identifier ||
    res.components ||
    ""
  );
}

export function sanitizeOsQueryIdentity(value) {
  return String(value || "")
    .replace(/ /g, "+")
    .replace(/[:%]/g, "-")
    .replace(/^[@{]/g, "")
    .replace(/[}]$/g, "");
}

export function createOsQueryPurl(
  purlType,
  group,
  name,
  version,
  qualifiers,
  subpath,
) {
  return new PackageURL(
    purlType || "swid",
    group,
    name,
    version || "",
    qualifiers,
    subpath,
  ).toString();
}
