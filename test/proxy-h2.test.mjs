import assert from "node:assert/strict";
import http2 from "node:http2";
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

function h2cSession(proxyPort) {
  const session = http2.connect(`http://127.0.0.1:${proxyPort}`);
  // Without a listener a session error would surface as an unhandled event and hang the test.
  session.on("error", (error) => { throw error; });
  return session;
}

/** Speak h2c prior knowledge to the proxy, like pi-cursor's node:http2 client does. */
function h2cRequest(session, { path, headers, body }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let responseHeaders;
    let trailers;
    const request = session.request({ ":method": "POST", ":path": path, ...headers });
    request.on("response", (h) => { responseHeaders = h; });
    request.on("trailers", (t) => { trailers = t; });
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      resolve({
        status: Number(responseHeaders?.[":status"]),
        headers: responseHeaders,
        trailers,
        body: Buffer.concat(chunks),
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

function listenH2cUpstream(onRequest) {
  const upstream = http2.createServer(onRequest);
  return listen(upstream).then((port) => ({ upstream, port }));
}

test("forwards h2c Connect streams to the upstream over HTTP/2 unchanged", async (t) => {
  let received;
  let receivedScheme;
  const body = Buffer.from("agent-client-message-frame");
  const { upstream, port } = await listenH2cUpstream((req, res) => {
    const chunks = [];
    receivedScheme = req.headers[":scheme"];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = { url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(200, { "content-type": "application/connect+proto" });
      res.write("server-frame-one");
      res.addTrailers({ "x-final-status": "ok" });
      setTimeout(() => res.end("server-frame-two"), 20);
    });
  });
  const proxy = createProxyServer();
  const proxyPort = await listen(proxy);
  const session = h2cSession(proxyPort);
  t.after(async () => {
    await new Promise((resolve) => session.close(resolve));
    await close(proxy);
    await close(upstream);
  });

  const response = await h2cRequest(session, {
    path: `/route_to/http://127.0.0.1:${port}/agent.v1.AgentService/Run`,
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      te: "trailers",
    },
    body,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/connect+proto");
  assert.deepEqual(
    response.body,
    Buffer.concat([Buffer.from("server-frame-one"), Buffer.from("server-frame-two")]),
  );
  assert.equal(response.trailers["x-final-status"], "ok");
  assert.equal(received.url, "/agent.v1.AgentService/Run");
  assert.equal(received.headers.authorization, "Bearer test-token");
  assert.equal(received.headers["content-type"], "application/connect+proto");
  assert.equal(received.headers["connect-protocol-version"], "1");
  assert.equal(received.headers.te, "trailers");
  assert.equal(receivedScheme, "http");
  assert.deepEqual(received.body, body);
});

test("multiple h2c streams multiplex over one client session", async (t) => {
  const seen = [];
  const { upstream, port } = await listenH2cUpstream((req, res) => {
    req.resume();
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/proto" });
    res.end("unary");
  });
  const proxy = createProxyServer();
  const proxyPort = await listen(proxy);
  const session = h2cSession(proxyPort);
  t.after(async () => {
    await new Promise((resolve) => session.close(resolve));
    await close(proxy);
    await close(upstream);
  });

  const paths = [
    `/route_to/http://127.0.0.1:${port}/aiserver.v1.AiService/AvailableModels`,
    `/route_to/http://127.0.0.1:${port}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
  ];
  // Both requests share one proxy connection and run concurrently.
  const results = await Promise.all(paths.map((path) => h2cRequest(session, {
    path,
    headers: { "content-type": "application/proto", authorization: "Bearer test-token" },
    body: Buffer.alloc(0),
  })));

  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), "unary");
  }
  assert.deepEqual(seen, [
    "/aiserver.v1.AiService/AvailableModels",
    "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
  ]);
});

test("h2c requests without a routable upstream get a 404", async (t) => {
  const proxy = createProxyServer();
  const proxyPort = await listen(proxy);
  const session = h2cSession(proxyPort);
  t.after(async () => {
    await new Promise((resolve) => session.close(resolve));
    await close(proxy);
  });

  const response = await h2cRequest(session, {
    path: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: Buffer.alloc(0),
  });
  assert.equal(response.status, 404);
});

test("classifies the protocol even when the first bytes are fragmented", async (t) => {
  const proxy = createProxyServer();
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); });

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const connect = () => new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
    socket.on("connect", () => resolve(socket));
    socket.on("error", reject);
  });

  // HTTP/2 preface split after one byte, followed by an empty SETTINGS frame:
  // the proxy must hand the socket to its HTTP/2 server (which replies with a
  // SETTINGS frame of its own), not parse it as HTTP/1.1.
  const h2Socket = await connect();
  h2Socket.write("P");
  await wait(20);
  h2Socket.write(Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n").subarray(1));
  h2Socket.write(Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0]));
  // TCP may split the frame header itself, so accumulate a full 9-byte frame header first.
  const h2Reply = await new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    h2Socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 9) resolve(data);
    });
    h2Socket.on("error", reject);
  });
  h2Socket.destroy();
  assert.equal(h2Reply.subarray(3, 4)[0], 4, "expected an HTTP/2 SETTINGS frame");

  // HTTP/1.1 request line split after one byte must still route to the HTTP/1.1 server.
  const h1Socket = await connect();
  h1Socket.write("G");
  await wait(20);
  h1Socket.write("ET /route_to/not-a-url HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  const h1Reply = await new Promise((resolve, reject) => {
    let data = "";
    h1Socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n\r\n")) resolve(data);
    });
    h1Socket.on("error", reject);
  });
  h1Socket.destroy();
  assert.match(h1Reply, /^HTTP\/1\.1 404/);
});

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the upstream to answer an open request");
}

test("an HTTP/1.1 hop forces an HTTP/2 upstream and streams a request that never ends", async (t) => {
  const clientFrames = [];
  let scheme;
  const { upstream, port } = await listenH2cUpstream((req, res) => {
    scheme = req.headers[":scheme"];
    // Answer before the request body ends, exactly like a Connect bidi stream.
    res.writeHead(200, { "content-type": "application/connect+proto" });
    res.write("server-frame-one");
    req.on("data", (chunk) => {
      clientFrames.push(chunk.toString());
      res.write(`echo:${chunk.length}`);
    });
  });
  const proxy = createProxyServer();
  const proxyPort = await listen(proxy);
  const socket = net.connect(proxyPort, "127.0.0.1");
  const received = [];
  socket.on("data", (chunk) => received.push(chunk.toString("latin1")));
  t.after(async () => {
    socket.destroy();
    await close(proxy);
    await close(upstream);
  });
  await new Promise((resolve) => socket.once("connect", resolve));

  socket.write(
    `POST /route_to/http://127.0.0.1:${port}/agent.v1.AgentService/Run HTTP/1.1\r\n` +
      "Host: 127.0.0.1\r\n" +
      "x-pi-force-http2: 1\r\n" +
      "content-type: application/connect+proto\r\n" +
      "Transfer-Encoding: chunked\r\n\r\n",
  );
  const frame = "client-frame";
  socket.write(`${frame.length.toString(16)}\r\n${frame}\r\n`);

  // No terminating 0-length chunk: the request stays open for the whole exchange.
  await waitFor(() => received.join("").includes("echo:"));
  const text = received.join("");
  assert.equal(scheme, "http");
  assert.deepEqual(clientFrames, [frame]);
  assert.match(text, /^HTTP\/1\.1 200 OK/);
  assert.match(text, /server-frame-one/);
  assert.match(text, /echo:12/);
  assert.doesNotMatch(text, /x-pi-force-http2/);
});

