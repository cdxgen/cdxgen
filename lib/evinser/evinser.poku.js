import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import {
  constructServiceName,
  detectServicesFromUsages,
  extractEndpoints,
  parseSemanticSlices,
} from "./evinser.js";

it("Service detection test", () => {
  const usageSlice = JSON.parse(
    readFileSync("./test/data/usages.json", { encoding: "utf-8" }),
  );
  const objectSlices = usageSlice.objectSlices;
  const servicesMap = {};
  for (const slice of objectSlices) {
    detectServicesFromUsages("java", slice, servicesMap);
    assert.ok(servicesMap);
    const serviceName = constructServiceName("java", slice);
    assert.ok(serviceName);
  }
});

it("extract endpoints test", () => {
  assert.deepStrictEqual(
    extractEndpoints("java", '@GetMapping(value = { "/", "/home" })'),
    ["/", "/home"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "java",
      '@PostMapping(value = "/issue", consumes = MediaType.APPLICATION_XML_VALUE)',
    ),
    ["/issue"],
  );
  assert.deepStrictEqual(extractEndpoints("java", '@GetMapping("/token")'), [
    "/token",
  ]);
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      'router.use("/api/v2/users",userRoutes.routes(),userRoutes.allowedMethods())',
    ),
    ["/api/v2/users"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.use('/encryptionkeys', serveIndexMiddleware, serveIndex('encryptionkeys', { icons: true, view: 'details' }))",
    ),
    ["/encryptionkeys"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.use(express.static(path.resolve('frontend/dist/frontend')))",
    ),
    ["frontend/dist/frontend"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.use('/ftp(?!/quarantine)/:file', fileServer())",
    ),
    ["/ftp(?!/quarantine)/:file"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.use('/rest/basket/:id', security.isAuthorized())",
    ),
    ["/rest/basket/:id"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      "app.get(['/.well-known/security.txt', '/security.txt'], verify.accessControlChallenges())",
    ),
    ["/.well-known/security.txt", "/security.txt"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "javascript",
      'router.post("/convert",async(ctx:Context):Promise<void>=>{constparameters=ctx.request.body;constbatchClient=newBatchClient({region:"us-west-1"});constcommand=newSubmitJobCommand({jobName:parameters?.jobName,jobQueue:"FOO-ARN",jobDefinition:"BAR-ARN",parameters,});try{constobjectsOutput=awaitbatchClient.send(command);ctx.response.body=objectsOutput;}catch(err){//Poorexceptionhandlingctx.response.body=err;}})',
    ),
    ["/convert"],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "java",
      '@RequestMapping(path = "/{name}", method = RequestMethod.GET)',
    ),
    ["/{name}"],
  );
  assert.deepStrictEqual(
    extractEndpoints("java", "@RequestMapping(method = RequestMethod.POST)"),
    [],
  );
  assert.deepStrictEqual(
    extractEndpoints(
      "java",
      '@RequestMapping(value = "/{accountName}", method = RequestMethod.GET)',
    ),
    ["/{accountName}"],
  );
});

it("parseSemanticSlices", () => {
  const semanticsSlice = JSON.parse(
    readFileSync("./test/data/swiftsem/semantics.slices.json", {
      encoding: "utf-8",
    }),
  );
  const bomJson = JSON.parse(
    readFileSync("./test/data/swiftsem/bom-hakit.json", {
      encoding: "utf-8",
    }),
  );
  const retMap = parseSemanticSlices(
    "swift",
    bomJson.components,
    semanticsSlice,
  );
  assert.ok(retMap);
});

async function atomArgsForUsagesSlice(options) {
  const projectDir = mkdtempSync(join(tmpdir(), "evinser-slice-"));
  const executeAtom = sinon.stub().returns(false);
  const warn = sinon.stub(console, "warn");
  const log = sinon.stub(console, "log");
  try {
    const { createSlice } = await esmock("./evinser.js", {
      "../helpers/utils.js": { executeAtom },
    });
    await createSlice("js", projectDir, "usages", {
      ...options,
      usagesSlicesFile: options.usagesSlicesFile?.replace("<dir>", projectDir),
    });
    return { args: executeAtom.firstCall.args[1], warnings: warn.args };
  } finally {
    warn.restore();
    log.restore();
    rmSync(projectDir, { recursive: true, force: true });
  }
}

it("hands atom the endpoints extraction only when no value is interpreted by a shell", async () => {
  const safe = await atomArgsForUsagesSlice({
    usagesSlicesFile: join("<dir>", "usages.json"),
  });
  assert.ok(safe.args.includes("--extract-endpoints"));
  assert.ok(
    !safe.warnings.some((warning) =>
      `${warning[0]}`.includes("Skipping the endpoints"),
    ),
  );
  const unsafeSlicesFile = await atomArgsForUsagesSlice({
    usagesSlicesFile: join("<dir>", "usages$(printenv NPM_TOKEN>leak).json"),
  });
  assert.ok(!unsafeSlicesFile.args.includes("--extract-endpoints"));
  assert.ok(unsafeSlicesFile.args.includes("usages"));
  assert.ok(
    unsafeSlicesFile.warnings.some((warning) =>
      `${warning[0]}`.includes("Skipping the endpoints"),
    ),
  );
  const unsafeSpecFile = await atomArgsForUsagesSlice({
    openapiSpecFile: "o$(id>RAN).json",
  });
  assert.ok(!unsafeSpecFile.args.includes("--extract-endpoints"));
});
