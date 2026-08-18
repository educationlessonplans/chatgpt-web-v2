import test from "node:test";
import assert from "node:assert/strict";
import { buildBrowserFingerprint, solvePow, DplDiscovery, SentinelClient } from "../src/sentinel.ts";
import { MockTransport, response } from "../src/transport.ts";

test("PoW deterministic vector is bounded and repeatable", async () => {
  const options = { config: ["fixture", "value", 0, 0], seed: "fixture-seed", target: "f", prefix: "gAAAAAC" as const, maxIterations: 10, yieldEvery: 2 };
  const first = await solvePow(options);
  const second = await solvePow(options);
  assert.deepEqual(first, second);
  assert.equal(first.token.startsWith("gAAAAAC"), true);
  assert.equal(first.iterations <= 10, true);
});

test("browser fingerprint has audited shape with deterministic inputs", () => {
  const fingerprint = buildBrowserFingerprint({ userAgent: "fixture-agent", dpl: "dpl=fixture", scriptSrc: "https://fixture.invalid/webpack.js", now: new Date("2026-01-01T00:00:00Z"), performanceNow: 100, random: () => 0, uuid: "fixture-uuid" });
  assert.equal(fingerprint.length, 18);
  assert.deepEqual(fingerprint.slice(4, 9), ["fixture-agent", "https://fixture.invalid/webpack.js", "dpl=fixture", "en-US", "en-US,en"]);
  assert.equal(fingerprint[13], 100);
  assert.equal(fingerprint[14], "fixture-uuid");
});

test("DPL and Sentinel requests use audited endpoint/body shapes", async () => {
  const transport = new MockTransport(async (request) => {
    if (request.url.endsWith("/")) return response(200, '<html data-build="fixture-build"><script src="https://fixture.invalid/_next/static/chunks/webpack-1234567890abcdef.js"></script></html>');
    if (request.url.endsWith("/prepare")) {
      const body = JSON.parse(String(request.body));
      assert.equal(typeof body.p, "string");
      assert.equal(body.p.startsWith("gAAAAAC"), true);
      return response(200, { prepare_token: "fixture-prepare" });
    }
    assert.equal(request.url.endsWith("/chat-requirements"), true);
    const body = JSON.parse(String(request.body));
    assert.equal(body.prepare_token, "fixture-prepare");
    return response(200, { token: "fixture-sentinel", proofofwork: { required: false }, turnstile: { required: false } });
  });
  const dpl = new DplDiscovery({ baseUrl: "https://fixture.invalid", fallbackClientVersion: "prod-fixture", transport });
  const client = new SentinelClient({ upstreamBaseUrl: "https://fixture.invalid", userAgent: "fixture-agent", clientVersion: "prod-fixture", clientBuildNumber: "fixture-build" }, transport, dpl);
  const result = await client.prepare({ accessToken: "fixture-access-token", accountId: "fixture-account", expiresAt: Date.now() + 1000, cookie: "__Secure-next-auth.session-token=fixture-cookie" });
  assert.equal(result.token, "fixture-sentinel");
  assert.equal(transport.requests.length, 3);
});
