// Two loopback HTTP servers for the git redirect tests. "allowed" answers
// every request with a redirect to the same path on "target", under a
// different host name (127.0.0.1 instead of localhost), and "target" answers
// 404. Each request is printed as a line so the test can see which server git
// reached. The servers stop when stdin closes.
import http from "node:http";
import process from "node:process";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

const target = http.createServer((req, res) => {
  console.log(`HIT target ${req.method} ${req.url}`);
  res.writeHead(404);
  res.end();
});
const targetPort = await listen(target);

const allowed = http.createServer((req, res) => {
  console.log(`HIT allowed ${req.method} ${req.url}`);
  res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}${req.url}` });
  res.end();
});
const allowedPort = await listen(allowed);

console.log(`READY ${allowedPort} ${targetPort}`);
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
