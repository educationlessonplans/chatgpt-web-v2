import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/credentials.ts";
import { SessionAuthenticator } from "../src/auth.ts";
import { MockTransport, response } from "../src/transport.ts";
import { createLogger } from "../src/logger.ts";

test("credential store bootstraps from environment, atomically rotates, and survives restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgpt-v2-credentials-"));
  const path = join(root, "session-cookie");
  const store = new CredentialStore(path);
  assert.equal(store.load("bootstrap-fixture-cookie"), "__Secure-next-auth.session-token=bootstrap-fixture-cookie");
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  store.write("__Secure-next-auth.session-token=rotated-fixture-cookie");
  const restarted = new CredentialStore(path);
  assert.equal(restarted.load(null), "__Secure-next-auth.session-token=rotated-fixture-cookie");

  const transport = new MockTransport(() => response(200, { accessToken: "fixture-access-token", expires: new Date(Date.now() + 60_000).toISOString() }, { "set-cookie": "__Secure-next-auth.session-token=second-rotation-fixture; Path=/" }));
  const logs: string[] = [];
  const logger = createLogger("info", (line) => logs.push(line));
  const auth = new SessionAuthenticator({ baseUrl: "https://fixture.invalid", transport, onCookieRefreshed: (cookie) => store.write(cookie), log: logger });
  await auth.exchange(restarted.load(null));
  assert.equal(new CredentialStore(path).load(null), "__Secure-next-auth.session-token=second-rotation-fixture");
  assert.equal(logs.some((line) => line.includes("second-rotation-fixture") || line.includes(path)), false);
  rmSync(root, { recursive: true, force: true });
});
