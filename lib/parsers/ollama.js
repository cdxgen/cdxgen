const sanitizeOllamaPathLikeValue = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replaceAll("\\", "/");
  const isAbsolutePath = normalized.startsWith("/");
  const hasRelativePrefix = /^\.{1,2}(?:\/|$)/u.test(normalized);
  const hasTraversalSegment = /(?:^|\/)\.\.(?:\/|$)/u.test(normalized);
  if (!hasRelativePrefix && !hasTraversalSegment) {
    return trimmed;
  }
  const safePath = normalized
    .split("/")
    .reduce((segments, segment) => {
      if (!segment || segment === ".") {
        return segments;
      }
      if (segment === "..") {
        segments.pop();
        return segments;
      }
      segments.push(segment);
      return segments;
    }, [])
    .join("/");
  if (!safePath) {
    return isAbsolutePath ? "/" : undefined;
  }
  return isAbsolutePath ? `/${safePath}` : safePath;
};

/**
 * Parse an Ollama Modelfile into reusable model metadata.
 *
 * @param {string} raw Modelfile contents
 * @returns {{
 *   adapters: string[],
 *   from?: string,
 *   license?: string,
 *   parameters: Record<string, string>,
 *   system?: string,
 *   template?: string,
 * }} parsed model metadata
 */
export function parseOllamaModelfile(raw) {
  const parsed = {
    adapters: [],
    from: undefined,
    license: undefined,
    parameters: {},
    system: undefined,
    template: undefined,
  };
  for (const line of String(raw || "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(
      /^(FROM|PARAMETER|SYSTEM|TEMPLATE|ADAPTER|LICENSE)\s+(.+)$/iu,
    );
    if (!match) {
      continue;
    }
    const directive = match[1].toUpperCase();
    const value = match[2].trim();
    switch (directive) {
      case "FROM":
        parsed.from = sanitizeOllamaPathLikeValue(value);
        break;
      case "PARAMETER": {
        const [name, ...rest] = value.split(/\s+/u);
        if (name) {
          parsed.parameters[name] = rest.join(" ").trim();
        }
        break;
      }
      case "SYSTEM":
        parsed.system = value;
        break;
      case "TEMPLATE":
        parsed.template = value;
        break;
      case "ADAPTER":
        {
          const normalizedAdapter = sanitizeOllamaPathLikeValue(value);
          if (normalizedAdapter) {
            parsed.adapters.push(normalizedAdapter);
          }
        }
        break;
      case "LICENSE":
        parsed.license = value;
        break;
      default:
        break;
    }
  }
  return parsed;
}
