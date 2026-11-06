/**
 * Tool allow lists of coding-agent configurations, reduced to tool names.
 *
 * An allow list such as `Read, Bash(git status:*), Bash(curl -u user,secret)`
 * carries commands, paths and sometimes credentials inside its parentheses.
 * Only the tool name before any "(" is kept, so nothing an entry scopes its
 * tool to reaches a BOM. The list is split on the commas outside parentheses,
 * so the arguments of one entry never become entries of their own.
 *
 * A tool name is at most 64 characters of letters, digits and `_ - . : *`
 * (`Read`, `mcp__github__*`, `fs_write`), optionally in the `@server/tool`
 * form Kiro uses. A name that looks like a credential (a known token prefix
 * such as `ghp_` or `AKIA`, or a long run of letters and digits with no
 * separator) is dropped.
 */
/**
 * Split an allow list on the commas outside parentheses. An array is taken
 * as already split.
 *
 * @param {string|string[]|undefined} value Allow list
 * @returns {string[]} Trimmed, non-empty entries
 */
export declare function splitAllowList(value: string | string[] | undefined): string[];
/**
 * The tool name of one allow-list entry, or undefined when it is not a safe
 * tool name.
 *
 * @param {string} entry Allow-list entry
 * @returns {string|undefined} Tool name
 */
export declare function agentToolName(entry: string): string | undefined;
/**
 * The unique, sorted tool names of an allow list.
 *
 * @param {string|string[]|undefined} value Allow list
 * @returns {string[]} Tool names
 */
export declare function agentToolNames(value: string | string[] | undefined): string[];
/**
 * An allow list as cdxgen records it in `cdx:agent:tools` and
 * `cdx:agent:disallowedTools`: each entry reduced to its tool name, written
 * `Name(...)` when the entry scoped the tool with arguments, so a scoped
 * `Bash(git status:*)` stays distinguishable from an unrestricted `Bash`
 * without copying the scope. Unique, in the order the config lists them,
 * comma separated.
 *
 * @param {string|string[]|undefined} value Allow list
 * @returns {string|undefined} Summary, or undefined when nothing is left
 */
export declare function summarizeAgentToolList(value: string | string[] | undefined): string | undefined;
//# sourceMappingURL=agentToolNames.d.ts.map