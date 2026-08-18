import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { createProxyServer } from "../proxy.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

test("forwards Codex requests and streams responses unchanged", async (t) => {
  let received;
  const body = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff]);
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = { url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(200, { "content-type": "text/event-stream", "x-upstream": "yes" });
      res.write("data: {\"type\":\"response.output_text.delta\"}\n\n");
      res.end("data: [DONE]\n\n");
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ codexUpstreamBase: `http://127.0.0.1:${upstreamPort}/backend-api` });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`http://127.0.0.1:${proxyPort}/codex/responses?stream=1`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "chatgpt-account-id": "account-1",
      originator: "pi",
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
    body,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-upstream"), "yes");
  assert.equal(await response.text(), "data: {\"type\":\"response.output_text.delta\"}\n\ndata: [DONE]\n\n");
  assert.equal(received.url, "/backend-api/codex/responses?stream=1");
  assert.equal(received.headers.authorization, "Bearer test-token");
  assert.equal(received.headers["chatgpt-account-id"], "account-1");
  assert.equal(received.headers.originator, "pi");
  assert.equal(received.headers["content-encoding"], "zstd");
  assert.deepEqual(received.body, body);
});

test("forwards Claude subscription requests and SSE responses", async (t) => {
  let received;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ anthropicUpstreamBase: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const body = '{"model":"claude-test","stream":true}';
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer sk-ant-oat-test",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "content-type": "application/json",
      "user-agent": "claude-cli/2.1.75",
      "x-app": "cli",
    },
    body,
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  assert.equal(received.url, "/v1/messages");
  assert.equal(received.headers.authorization, "Bearer sk-ant-oat-test");
  assert.match(received.headers["anthropic-beta"], /oauth-2025-04-20/);
  assert.equal(received.headers["x-app"], "cli");
  assert.equal(received.body, body);
});

test("forwards xAI subscription requests for both API adapters", async (t) => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: [DONE]\n\n");
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ xaiUpstreamBase: `http://127.0.0.1:${upstreamPort}/v1` });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  for (const path of ["/chat/completions", "/responses"]) {
    const response = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer xai-oauth-token",
        "content-type": "application/json",
      },
      body: '{"model":"grok-test","stream":true}',
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "data: [DONE]\n\n");
  }

  assert.deepEqual(received.map(({ url }) => url), ["/v1/chat/completions", "/v1/responses"]);
  assert.ok(received.every(({ headers }) => headers.authorization === "Bearer xai-oauth-token"));
});

test("forwards WebSocket upgrades", async (t) => {
  let received;
  const upstream = http.createServer();
  upstream.on("upgrade", (req, socket) => {
    received = { url: req.url, headers: req.headers };
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello");
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({ codexUpstreamBase: `http://127.0.0.1:${upstreamPort}/backend-api` });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const reply = await new Promise((resolve, reject) => {
    const socket = netConnect(proxyPort);
    let data = "";
    socket.on("connect", () => socket.write(
      "GET /codex/responses HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${proxyPort}\r\n` +
      "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
      "Authorization: Bearer test-token\r\n" +
      "chatgpt-account-id: account-1\r\n\r\n",
    ));
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("hello")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("error", reject);
  });

  assert.match(reply, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(reply, /hello$/);
  assert.equal(received.url, "/backend-api/codex/responses");
  assert.equal(received.headers.authorization, "Bearer test-token");
  assert.equal(received.headers["chatgpt-account-id"], "account-1");
});

function netConnect(port) {
  return net.connect({ host: "127.0.0.1", port });
}
