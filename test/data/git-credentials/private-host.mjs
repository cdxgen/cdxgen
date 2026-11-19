// A loopback HTTP server for the git credential tests. It stands in for a git
// host with one private repository: a request that carries the Basic
// credential given as the first argument ("user:password") gets the refs of
// the repository over the dumb HTTP protocol, which is all ls-remote needs,
// and every other request gets 401. The server stops when stdin closes.
import { Buffer } from "node:buffer";
import http from "node:http";
import process from "node:process";

const accepted = `Basic ${Buffer.from(process.argv[2]).toString("base64")}`;
const REFS = "0123456789abcdef0123456789abcdef01234567\trefs/tags/v1.0.0\n";

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== accepted) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
    res.end();
    return;
  }
  if (req.url.startsWith("/private.git/info/refs")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(REFS);
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, "127.0.0.1", () => {
  console.log(`READY ${server.address().port}`);
});
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
