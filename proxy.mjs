import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

const ROUTE_PREFIX = "/route_to/";

// Connection-specific headers are forbidden in HTTP/2; Host becomes :authority.
const H2_FORBIDDEN = [
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
];

function selectRoute(rawUrl) {
  if (!rawUrl?.startsWith(ROUTE_PREFIX)) return;
  let upstream;
  try {
    upstream = new URL(rawUrl.slice(ROUTE_PREFIX.length));
  } catch {
    return;
  }
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") return;
  return { upstream, path: `${upstream.pathname}${upstream.search}` || "/" };
}

function requestHeaders(headers, upstream) {
  return { ...headers, host: upstream.host };
}

function forwardOverHttp1(req, res, route) {
  const transport = route.upstream.protocol === "https:" ? https : http;
  const upstreamReq = transport.request(
    {
      hostname: route.upstream.hostname,
      port: route.upstream.port || undefined,
      method: req.method,
      path: route.path,
      headers: requestHeaders(req.headers, route.upstream),
    },
    (upstreamRes) => {
      res.writeHead(
        upstreamRes.statusCode || 502,
        upstreamRes.statusMessage,
        upstreamRes.headers,
      );
      upstreamRes.on("error", (error) => res.destroy(error));
      upstreamRes.pipe(res);
    },
  );

  res.on("close", () => {
    if (!res.writableEnded) upstreamReq.destroy();
  });
  upstreamReq.on("error", (error) => {
    if (res.headersSent) return res.destroy(error);
    res.writeHead(502).end(`Upstream request failed: ${error.message}\n`);
  });
  req.on("aborted", () => upstreamReq.destroy());
  req.pipe(upstreamReq);
}

function forwardOverHttp2(req, res, route) {
  // Rebuild headers: drop HTTP/2 pseudo-headers (an h2c client advertises :scheme http, which
  // must not leak onto an https upstream) and connection-specific ones. Request trailers are
  // intentionally not relayed — no client in scope sends them, so the relay would be dead code.
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!name.startsWith(":") && !H2_FORBIDDEN.includes(name)) headers[name] = value;
  }
  // ponytail: fresh upstream session per request; pool by origin if TLS handshakes show up
  const session = http2.connect(route.upstream.origin);
  const upstream = session.request({
    ...headers,
    ":method": req.method,
    ":path": route.path,
    ":authority": route.upstream.host,
    ":scheme": route.upstream.protocol.slice(0, -1),
  });
  upstream.on("response", (responseHeaders) => {
    const { ":status": status, ...rest } = responseHeaders;
    res.writeHead(status || 502, rest);
  });
  // Node emits upstream trailers before "end", so addTrailers lands before res.end() in pipe().
  upstream.on("trailers", (trailers) => res.addTrailers(trailers));
  const fail = (error) => {
    if (res.headersSent) return res.destroy(error);
    res.writeHead(502).end(`Upstream request failed: ${error.message}\n`);
  };
  upstream.on("error", fail);
  session.on("error", fail);
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
    session.close();
  });
  upstream.pipe(res);
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

function handleRequest(req, res) {
  const route = selectRoute(req.url);
  if (!route) return res.writeHead(404).end(`Expected ${ROUTE_PREFIX}<http(s)-upstream-url>\n`);
  // Mirror the client's HTTP version: HTTP/2-only upstreams (e.g. Cursor) reject HTTP/1.1.
  if (req.httpVersion === "2.0") return forwardOverHttp2(req, res, route);
  return forwardOverHttp1(req, res, route);
}

function handleUpgrade(req, socket, head) {
  const route = selectRoute(req.url);
  if (!route) return socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");

  const port = Number(route.upstream.port) || (route.upstream.protocol === "https:" ? 443 : 80);
  const upstreamSocket = route.upstream.protocol === "https:"
    ? tls.connect({ host: route.upstream.hostname, port, servername: route.upstream.hostname })
    : net.connect({ host: route.upstream.hostname, port });

  upstreamSocket.once("connect", () => {
    const headers = requestHeaders(req.headers, route.upstream);
    const lines = [`${req.method} ${route.path} HTTP/${req.httpVersion}`];
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket).pipe(socket);
  });

  upstreamSocket.on("error", () => {
    if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  socket.on("error", () => upstreamSocket.destroy());
}

export function createProxyServer() {
  const h1 = http.createServer(handleRequest);
  h1.on("upgrade", handleUpgrade);
  const h2 = http2.createServer(handleRequest);

  const sockets = new Set();
  // One port, two protocols: sniff the first bytes — the HTTP/2 preface starts with "PRI",
  // which is a reserved method no HTTP/1.1 request may use. Buffer until at least 3 bytes
  // arrive in case the preface is fragmented across TCP segments.
  const server = net.createServer({ pauseOnConnect: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffered;
    const onFirstData = (chunk) => {
      buffered = buffered ? Buffer.concat([buffered, chunk]) : chunk;
      if (buffered.length < 3) return;
      socket.off("data", onFirstData);
      socket.pause();
      socket.unshift(buffered);
      if (buffered.subarray(0, 3).toString("latin1") === "PRI") h2.emit("connection", socket);
      else { h1.emit("connection", socket); socket.resume(); }
    };
    socket.on("data", onFirstData);
    socket.resume();
  });
  server.closeAllConnections = () => {
    for (const socket of sockets) socket.destroy();
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8787);
  createProxyServer().listen(port, host, () => {
    console.log(`Pi proxy (HTTP/1.1 + HTTP/2): http://${host}:${port}${ROUTE_PREFIX}<upstream-url>`);
  });
}
