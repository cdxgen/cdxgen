import process from "node:process";

import npa from "npm-package-arg";

import { isSafeLockfilePath } from "../../../core/lockPaths.js";

// extracted from npm v6 lib/install/realize-shrinkwrap-specifier.js

// cdxgen patch (issue #3816): lockfile `version`, `from` and `resolved`
// values are untrusted. A file or directory spec whose path is not a safe
// relative path inside `where` is refused, so it can never be followed, read,
// or emitted as a link to the outside. The refusal throws into the existing
// catch blocks, which already handle unusable candidates.
const npaResolveSafe = (name, spec, where) => {
  const resolved = npa.resolve(name, spec, where);
  if (resolved.type === "file" || resolved.type === "directory") {
    // npa absolutises fetchSpec against `where`, so the raw specifier is the
    // only form that still shows whether the lockfile named a safe relative
    // path.
    const rawSpec = resolved.rawSpec;
    const rawPath = rawSpec.startsWith("file:") ? rawSpec.slice(5) : rawSpec;
    if (!isSafeLockfilePath(rawPath, where || process.cwd())) {
      throw new Error(`refusing unsafe lockfile path '${spec}'`);
    }
  }
  return resolved;
};

const specFromLock = (name, lock, where) => {
  try {
    if (lock.version) {
      const spec = npaResolveSafe(name, lock.version, where);
      if (lock.integrity || spec.type === "git") {
        return spec;
      }
    }
    if (lock.from) {
      // legacy metadata includes "from", but not integrity
      const spec = npaResolveSafe(name, lock.from, where);
      if (spec.registry && lock.version) {
        return npaResolveSafe(name, lock.version, where);
      } else if (!lock.resolved) {
        return spec;
      }
    }
    if (lock.resolved) {
      return npaResolveSafe(name, lock.resolved, where);
    }
  } catch {
    // ignore errors
  }
  try {
    return npaResolveSafe(name, lock.version, where);
  } catch {
    return {};
  }
};

export default specFromLock;
