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
export function parseOllamaModelfile(raw: string): {
    adapters: string[];
    from?: string;
    license?: string;
    parameters: Record<string, string>;
    system?: string;
    template?: string;
};
//# sourceMappingURL=ollama.d.ts.map