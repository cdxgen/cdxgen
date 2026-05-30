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
        parsed.from = value;
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
        parsed.adapters.push(value);
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
