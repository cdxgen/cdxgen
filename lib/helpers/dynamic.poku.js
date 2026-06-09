import { assert, describe, it } from "poku";

import { groupHttpEntriesToServices } from "./traceRunner.js";

describe("groupHttpEntriesToServices()", () => {
  it("returns empty object for empty input", () => {
    const result = groupHttpEntriesToServices([]);
    assert.deepEqual(result, {});
  });

  it("groups entries by host and port", () => {
    const entries = [
      {
        method: "GET",
        host: "api.example.com",
        path: "/v1/users",
        port: 443,
        protocol: "https",
      },
      {
        method: "POST",
        host: "api.example.com",
        path: "/v1/users",
        port: 443,
        protocol: "https",
      },
      {
        method: "GET",
        host: "other.example.com",
        path: "/health",
        port: 443,
        protocol: "https",
      },
    ];
    const result = groupHttpEntriesToServices(entries);
    const keys = Object.keys(result);
    assert.strictEqual(keys.length, 2);
    assert.ok(keys[0].includes("api.example.com"));
    assert.ok(keys[1].includes("other.example.com"));
  });

  it("collects endpoints as a Set of full URLs", () => {
    const entries = [
      {
        method: "GET",
        host: "api.example.com",
        path: "/v1/users",
        port: 443,
        protocol: "https",
      },
    ];
    const result = groupHttpEntriesToServices(entries);
    const service = result[Object.keys(result)[0]];
    assert.ok(service.endpoints instanceof Set);
    assert.strictEqual(service.endpoints.size, 1);
    assert.ok(service.endpoints.has("https://api.example.com/v1/users"));
  });

  it("includes port in endpoint when non-default", () => {
    const entries = [
      {
        method: "GET",
        host: "api.example.com",
        path: "/health",
        port: 8080,
        protocol: "http",
      },
    ];
    const result = groupHttpEntriesToServices(entries);
    const service = result[Object.keys(result)[0]];
    assert.ok(service.endpoints.has("https://api.example.com:8080/health"));
  });

  it("adds httpMethod property for each unique method", () => {
    const entries = [
      {
        method: "GET",
        host: "api.example.com",
        path: "/v1/users",
        port: 443,
        protocol: "https",
      },
      {
        method: "POST",
        host: "api.example.com",
        path: "/v1/users",
        port: 443,
        protocol: "https",
      },
    ];
    const result = groupHttpEntriesToServices(entries);
    const service = result[Object.keys(result)[0]];
    const methods = service.properties.filter(
      (p) => p.name === "cdx:service:httpMethod",
    );
    assert.strictEqual(methods.length, 2);
    assert.ok(methods.some((p) => p.value === "GET"));
    assert.ok(methods.some((p) => p.value === "POST"));
  });

  it("deduplicates httpMethod properties", () => {
    const entries = [
      {
        method: "GET",
        host: "api.example.com",
        path: "/v1/users",
        port: 443,
        protocol: "https",
      },
      {
        method: "GET",
        host: "api.example.com",
        path: "/v1/items",
        port: 443,
        protocol: "https",
      },
    ];
    const result = groupHttpEntriesToServices(entries);
    const service = result[Object.keys(result)[0]];
    const methods = service.properties.filter(
      (p) => p.name === "cdx:service:httpMethod",
    );
    assert.strictEqual(methods.length, 1);
  });

  it("includes query property when present", () => {
    const entries = [
      {
        method: "GET",
        host: "api.example.com",
        path: "/search",
        port: 443,
        protocol: "https",
        query: "q=test",
      },
    ];
    const result = groupHttpEntriesToServices(entries);
    const service = result[Object.keys(result)[0]];
    const queries = service.properties.filter(
      (p) => p.name === "cdx:dynamic:httpQuery",
    );
    assert.strictEqual(queries.length, 1);
    assert.strictEqual(queries[0].value, "q=test");
  });

  it("handles entries without a path", () => {
    const entries = [
      { method: "GET", host: "api.example.com", port: 443, protocol: "https" },
    ];
    const result = groupHttpEntriesToServices(entries);
    const service = result[Object.keys(result)[0]];
    assert.ok(service.endpoints.has("https://api.example.com/"));
  });
});
