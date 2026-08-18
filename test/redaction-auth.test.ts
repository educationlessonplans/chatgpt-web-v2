import test from "node:test";
import assert from "node:assert/strict";
import { mergeRotatedCookie, normalizeSessionCookie, redact, redactString, credentialSafe } from "../src/redaction.ts";
import { SessionAuthenticator } from "../src/auth.ts";
import { MockTransport, response } from "../src/transport.ts";

test("cookie normalization and rotated cookie adoption preserve unrelated cookies", () => {
  assert.equal(normalizeSessionCookie("abc"), "__Secure-next-auth.session-token=abc");
  assert.equal(normalizeSessionCookie("cookie: abc"), "__Secure-next-auth.session-token=abc");
  assert.equal(normalizeSessionCookie("foo=bar; __Secure-next-auth.session-token=old"), "foo=bar; __Secure-next-auth.session-token=old");
  const rotated = mergeRotatedCookie("foo=bar; __Secure-next-auth.session-token=old", "__Secure-next-auth.session-token=new; Path=/; HttpOnly");
  assert.equal(rotated, "foo=bar; __Secure-next-auth.session-token=new");
  assert.equal(mergeRotatedCookie("foo=bar; __Secure-next-auth.session-token=new", "__Secure-next-auth.session-token=new; Path=/"), null);
});

test("redaction removes common credential-bearing values recursively", () => {
  const input = {
    cookie: "__Secure-next-auth.session-token=fixture-cookie-value",
    authorization: "Bearer fixture-access-token",
    nested: "accessToken=fixture-access-token",
    ordinary: "keep this",
  };
  const output = redact(input);
  assert.equal((output as any).cookie, "[REDACTED]");
  assert.equal((output as any).authorization, "[REDACTED]");
  assert.equal((output as any).nested.includes("fixture-access-token"), false);
  assert.equal((output as any).ordinary, "keep this");
  assert.equal(credentialSafe(output), true);
  assert.equal(redactString("Cookie: __Secure-next-auth.session-token=fixture"), "Cookie: [REDACTED]");
});

test("auth exchange is single-flight and adopts rotated cookie immediately", async () => {
  let calls = 0;
  const transport = new MockTransport(async (request) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(request.url.endsWith("/api/auth/session"), true);
    return response(200, { accessToken: "fixture-access-token", expires: new Date(Date.now() + 60_000).toISOString(), user: { id: "fixture-account" } }, { "set-cookie": "__Secure-next-auth.session-token=rotated-fixture; Path=/" });
  });
  let adopted = "";
  const auth = new SessionAuthenticator({ baseUrl: "https://fixture.invalid", transport, onCookieRefreshed: (cookie) => { adopted = cookie; } });
  const [a, b] = await Promise.all([auth.exchange("initial-fixture"), auth.exchange("initial-fixture")]);
  assert.equal(calls, 1);
  assert.equal(a.accessToken, "fixture-access-token");
  assert.equal(b.cookie, "__Secure-next-auth.session-token=rotated-fixture");
  assert.equal(adopted, "__Secure-next-auth.session-token=rotated-fixture");
  assert.equal(auth.currentCookie, adopted);
});

test("one cancelled auth waiter does not cancel the shared exchange", async () => {
  let calls = 0;
  const transport = new MockTransport(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response(200, { accessToken: "fixture-access-token", expires: new Date(Date.now() + 60_000).toISOString() });
  });
  const auth = new SessionAuthenticator({ baseUrl: "https://fixture.invalid", transport });
  const cancelled = new AbortController();
  const first = auth.exchange("shared-fixture-cookie", cancelled.signal);
  cancelled.abort();
  const second = auth.exchange("shared-fixture-cookie");
  await assert.rejects(first, /cancelled/i);
  assert.equal((await second).accessToken, "fixture-access-token");
  assert.equal(calls, 1);
});
