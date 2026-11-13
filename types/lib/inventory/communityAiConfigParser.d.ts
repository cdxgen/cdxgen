/**
 * Parser object for community AI assistant configuration files.
 *
 * Dispatches matched files (opencode/langgraph configs, agent/skill/rule
 * markdown, crewai python/yaml definitions, and similar) to dedicated
 * parsers and collects the resulting components and services.
 *
 * @type {Object}
 * @property {string} id Unique parser identifier ("community-ai-config")
 * @property {string[]} patterns File path patterns this parser handles
 * @property {Function} parse Parse matched files into components and
 *   services. The optional third argument carries `rootDir`, the scanned
 *   root every read file must stay inside.
 */
export declare const communityAiConfigParser: Object;
//# sourceMappingURL=communityAiConfigParser.d.ts.map