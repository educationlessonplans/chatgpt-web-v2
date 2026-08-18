import test from "node:test";
import assert from "node:assert/strict";
import { mapHttpError, publicError, SessionAuthError, SentinelBlockedError } from "../src/errors.ts";

test("HTTP failures map to stable OpenAI-facing taxonomy", () => {
  assert.equal(mapHttpError(401).code, "AUTH_REQUIRED");
  assert.equal(mapHttpError(403) instanceof SessionAuthError, true);
  assert.equal(mapHttpError(429).code, "UPSTREAM_RATE_LIMIT");
  assert.equal(mapHttpError(413).status, 413);
  assert.equal(mapHttpError(500).retryable, true);
  assert.equal(new SentinelBlockedError().status, 403);
  assert.deepEqual(publicError(mapHttpError(429)).body.error, { message: "ChatGPT rate limited the account.", type: "rate_limit", code: "UPSTREAM_RATE_LIMIT" });
});
