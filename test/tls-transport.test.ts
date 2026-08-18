import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { TlsClientTransport } from "../src/transport.ts";

function localNativeLibrary(): string {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("tls-client-node/package.json");
  return join(dirname(packagePath), "bin", "tls-client-linux-ubuntu-amd64-1.15.1.so");
}

test("native tls-client-node binding initializes under Node v24 without network", async () => {
  const transport = new TlsClientTransport({ runtimeMode: "native", nativeLibraryPath: localNativeLibrary(), tempDir: "/tmp/chatgpt-web-v2-test-tls" });
  await transport.initialize();
  assert.equal(transport.ready, true);
  assert.equal(transport.error, null);
  await transport.close();
});

test("missing native binding fails explicitly instead of falling back to fetch", async () => {
  const transport = new TlsClientTransport({ runtimeMode: "native", nativeLibraryPath: "/tmp/does-not-exist/chatgpt-web-v2.so" });
  await assert.rejects(transport.initialize(), (error: any) => error?.code === "TLS_UNAVAILABLE");
  assert.equal(transport.ready, false);
  await assert.rejects(transport.request({ url: "https://fixture.invalid/" }), (error: any) => error?.code === "TLS_UNAVAILABLE");
});

test("production TLS request shape includes audited profile, proxy, redirects and stream output hooks", async () => {
  const tlsModule: any = await import("tls-client-node");
  const original = tlsModule.TLSClient.prototype.request;
  let captured: any = null;
  tlsModule.TLSClient.prototype.request = async (_url: string, options: any) => {
    captured = options;
    return { status: 200, body: "data: [DONE]\n\n", headers: { "content-type": ["text/event-stream"] } };
  };
  const root = mkdtempSync(join(tmpdir(), "cgpt-v2-tls-options-"));
  try {
    const transport = new TlsClientTransport({ runtimeMode: "native", nativeLibraryPath: localNativeLibrary(), proxyUrl: "http://fixture-proxy.invalid:8080", isRotatingProxy: true, tempDir: root });
    const response = await transport.request({ url: "https://fixture.invalid/", method: "POST", headers: { Cookie: "fixture-cookie" }, body: "{}", stream: true, timeoutMs: 1234 });
    assert.equal(response.status, 200);
    assert.equal(captured.tlsClientIdentifier, "firefox_148");
    assert.equal(captured.withRandomTLSExtensionOrder, true);
    assert.equal(captured.followRedirects, true);
    assert.equal(captured.timeoutMilliseconds, 1234);
    assert.equal(captured.proxyUrl, "http://fixture-proxy.invalid:8080");
    assert.equal(captured.isRotatingProxy, true);
    assert.equal(captured.streamOutputBlockSize, 1024);
    assert.equal(captured.streamOutputEOFSymbol, "[DONE]");
    assert.equal(readdirSync(root).length, 0);
    await transport.close();
  } finally {
    tlsModule.TLSClient.prototype.request = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("TLS stream temp directory is cleaned after caller cancellation while native operation unwinds", async () => {
  const tlsModule: any = await import("tls-client-node");
  const original = tlsModule.TLSClient.prototype.request;
  tlsModule.TLSClient.prototype.request = async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { status: 200, body: "data: [DONE]\n\n", headers: {} };
  };
  const root = mkdtempSync(join(tmpdir(), "cgpt-v2-tls-cancel-"));
  try {
    const transport = new TlsClientTransport({ runtimeMode: "native", nativeLibraryPath: localNativeLibrary(), tempDir: root });
    const controller = new AbortController();
    const pending = transport.request({ url: "https://fixture.invalid/", stream: true, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, /cancel|aborted/i);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(readdirSync(root).length, 0);
    await transport.close();
  } finally {
    tlsModule.TLSClient.prototype.request = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("TLS stream tails appended bytes before the native request promise resolves", async () => {
  const tlsModule: any = await import("tls-client-node");
  const original = tlsModule.TLSClient.prototype.request;
  let nativeResolved = false;
  const root = mkdtempSync(join(tmpdir(), "cgpt-v2-tls-tail-"));
  tlsModule.TLSClient.prototype.request = async (_url: string, options: any) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(options.streamOutputPath, "data: first\n\n");
    await new Promise((resolve) => setTimeout(resolve, 35));
    await appendFile(options.streamOutputPath, "data: second\n\ndata: [DO");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await appendFile(options.streamOutputPath, "NE]\n\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    nativeResolved = true;
    return { status: 200, body: "", headers: { "content-type": ["text/event-stream"] } };
  };
  try {
    const transport = new TlsClientTransport({ runtimeMode: "native", nativeLibraryPath: localNativeLibrary(), tempDir: root, streamFirstByteTimeoutMs: 1_000 });
    const response = await transport.request({ url: "https://fixture.invalid/", stream: true, timeoutMs: 2_000 });
    assert.equal(nativeResolved, false);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(new TextDecoder().decode(first.value).startsWith("data: "), true);
    assert.equal(nativeResolved, false);
    const chunks: string[] = [new TextDecoder().decode(first.value)];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(new TextDecoder().decode(next.value));
    }
    assert.equal(chunks.join(""), "data: first\n\ndata: second\n\ndata: [DONE]");
    assert.equal(nativeResolved, true);
    assert.equal(readdirSync(root).length, 0);
    await transport.close();
  } finally {
    tlsModule.TLSClient.prototype.request = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("TLS stream consumer cancellation stops tailing and cleans up after producer settlement", async () => {
  const tlsModule: any = await import("tls-client-node");
  const original = tlsModule.TLSClient.prototype.request;
  let nativeResolved = false;
  const root = mkdtempSync(join(tmpdir(), "cgpt-v2-tls-consumer-cancel-"));
  tlsModule.TLSClient.prototype.request = async (_url: string, options: any) => {
    await writeFile(options.streamOutputPath, "data: first\n\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    nativeResolved = true;
    return { status: 200, body: "", headers: {} };
  };
  try {
    const transport = new TlsClientTransport({ runtimeMode: "native", nativeLibraryPath: localNativeLibrary(), tempDir: root, streamFirstByteTimeoutMs: 1_000 });
    const response = await transport.request({ url: "https://fixture.invalid/", stream: true, timeoutMs: 2_000 });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("fixture consumer disconnected");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(nativeResolved, true);
    assert.equal(readdirSync(root).length, 0);
    await transport.close();
  } finally {
    tlsModule.TLSClient.prototype.request = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("TLS stream AbortSignal interrupts the tail and cleans up after producer settlement", async () => {
  const tlsModule: any = await import("tls-client-node");
  const original = tlsModule.TLSClient.prototype.request;
  const root = mkdtempSync(join(tmpdir(), "cgpt-v2-tls-signal-"));
  tlsModule.TLSClient.prototype.request = async (_url: string, options: any) => {
    await writeFile(options.streamOutputPath, "data: first\n\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { status: 200, body: "", headers: {} };
  };
  try {
    const transport = new TlsClientTransport({ runtimeMode: "native", nativeLibraryPath: localNativeLibrary(), tempDir: root, streamFirstByteTimeoutMs: 1_000 });
    const controller = new AbortController();
    const response = await transport.request({ url: "https://fixture.invalid/", stream: true, signal: controller.signal, timeoutMs: 2_000 });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort(new DOMException("fixture abort", "AbortError"));
    await assert.rejects(reader.read(), /cancel|abort/i);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(readdirSync(root).length, 0);
    await transport.close();
  } finally {
    tlsModule.TLSClient.prototype.request = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("TLS non-stream response remains status/header/text based", async () => {
  const tlsModule: any = await import("tls-client-node");
  const original = tlsModule.TLSClient.prototype.request;
  tlsModule.TLSClient.prototype.request = async () => ({ status: 201, body: "{\"fixture\":true}", headers: { "content-type": ["application/json"] } });
  try {
    const transport = new TlsClientTransport({ runtimeMode: "native", nativeLibraryPath: localNativeLibrary() });
    const response = await transport.request({ url: "https://fixture.invalid/", method: "GET" });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.text, "{\"fixture\":true}");
    assert.equal(response.body, null);
    await transport.close();
  } finally {
    tlsModule.TLSClient.prototype.request = original;
  }
});
