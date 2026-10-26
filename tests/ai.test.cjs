"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { getEditingModel, streamSummary } = require("../src/ai");

test("generation resolves the explicit kernel configuration rather than stale window settings", () => {
  const stale = { editing: { modelId: "selected" }, providers: [{ apiKey: "stale-key", models: [{ id: "selected", name: "synthetic" }] }] };
  const current = { ...stale, providers: [{ ...stale.providers[0], apiKey: "current-key" }] };
  global.window = { siyuan: { config: { ai: stale } } };
  try {
    assert.equal(getEditingModel(current).provider.apiKey, "current-key");
    assert.equal(getEditingModel().provider.apiKey, "stale-key");
    assert.equal(getEditingModel(null), null);
  } finally {
    delete global.window;
  }
});

test("AI failures distinguish authentication from request denial and retain only recognized error identifiers", async (t) => {
  let status, body;
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const resolved = { provider: { baseURL: `http://127.0.0.1:${server.address().port}`, protocol: "openai" }, model: { name: "synthetic" }, editing: {} };
  for (const item of [
    { status: 401, code: "invalid_api_key", category: "authentication", savedCode: "invalid_api_key" },
    { status: 403, code: "private-user-material", category: "permission", savedCode: "" },
    { status: 403, code: "model_not_found", category: "model", savedCode: "model_not_found" },
  ]) {
    status = item.status;
    body = { error: { code: item.code, message: "private API key and meeting text" } };
    await assert.rejects(streamSummary({ system: "synthetic", user: "test", resolved }), (error) => {
      assert.deepEqual({ httpStatus: error.httpStatus, category: error.category, serviceCode: error.serviceCode }, {
        httpStatus: item.status, category: item.category, serviceCode: item.savedCode,
      });
      return true;
    });
  }
});
