/**
 * Universal virtual environment metadata detector
 * @param {Object} env - Environment variables (defaults to process.env)
 * @param {string} [explicitPath] - Optional explicit venv path to inspect
 * @returns {Object} Structured environment metadata
 */
export function getVenvMetadata(env?: Object, explicitPath?: string): Object;
/**
 * Determines the appropriate Python executable path from a virtual environment.
 * Inspects the virtual environment metadata to detect the Python type (system,
 * conda, pyenv, etc.) and returns the most specific executable found, falling
 * back to the global `PYTHON_CMD` constant when no executable is detected.
 *
 * @param {string} env Path to the Python virtual environment directory
 * @returns {string} Path to the Python executable or the fallback command name
 */
export function get_python_command_from_env(env: string): string;
//# sourceMappingURL=pythonutils.d.ts.map