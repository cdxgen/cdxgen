import process from "node:process";

/**
 * The diagnostic report of the running Node.js, without its network part.
 *
 * cdxgen reads the report for what the runtime is made of: the versions of the
 * bundled components, the release source URL and the loaded shared objects.
 * `process.report.getReport()` also describes every open socket, and for each
 * end of one it resolves the address to a host name with a blocking reverse
 * DNS lookup on the main thread. The server holds a socket per connected
 * client, so the clients decide how many lookups there are, and whoever runs
 * the name servers of a client's reverse zone decides how long each one waits.
 * `process.report.excludeNetwork` leaves the lookups out. It is set for this
 * one call and then put back, so a report the operator or an embedding
 * application asks for keeps the setting they chose.
 *
 * This lives in the core layer so the HTTP client can use it as well.
 *
 * @returns {Object|undefined} the report, or undefined on a runtime that has
 *   none
 */
export function readRuntimeReport() {
  const report = process.report;
  if (typeof report?.getReport !== "function") {
    return undefined;
  }
  const excludeNetwork = report.excludeNetwork;
  report.excludeNetwork = true;
  try {
    return report.getReport();
  } finally {
    report.excludeNetwork = excludeNetwork;
  }
}
