import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

const ROUTE_PREFIX = "/route_to/";

function selectRoute(rawUrl, allowedOrigins) {
  if (!rawUrl?.startsWith(ROUTE_PREFIX)) return;
  let upstream;
  try {
    upstream = new URL(rawUrl.slice(ROUTE_PREFIX.length));
  } catch {
    return;
  }
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") return;
  if (allowedOrigins.size && !allowedOrigins.has(upstream.origin)) return;
  return { upstream, path: `${upstream.pathname}${upstream.search}` || "/" };
}

function requestHeaders(headers, upstream) {
  const forwarded = { ...headers, host: upstream.host };
  delete forwarded["x-serverless-authorization"];
  return forwarded;
}

function configuredOrigins(value = process.env.ALLOWED_ORIGINS) {
  return new Set(value?.split(/[\s,]+/).filter(Boolean).map((origin) => new URL(origin).origin));
}

export function createProxyServer({ allowedOrigins = configuredOrigins() } = {}) {
  const server = http.createServer((req, res) => {
    const route = selectRoute(req.url, allowedOrigins);
    if (!route) return res.writeHead(404).end(`Expected ${ROUTE_PREFIX}<http(s)-upstream-url>\n`);

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
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on("error", (error) => {
      if (res.headersSent) return res.destroy(error);
      res.writeHead(502).end(`Upstream request failed: ${error.message}\n`);
    });
    req.on("aborted", () => upstreamReq.destroy());
    res.on("close", () => {
      if (!res.writableEnded) upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
  });

  server.on("upgrade", (req, socket, head) => {
    const route = selectRoute(req.url, allowedOrigins);
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
    upstreamSocket.on("close", () => socket.destroy());
    socket.on("error", () => upstreamSocket.destroy());
    socket.on("close", () => upstreamSocket.destroy());
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || (process.env.K_SERVICE ? "0.0.0.0" : "127.0.0.1");
  const port = Number(process.env.PORT || 8787);
  const allowedOrigins = configuredOrigins();
  if (!["127.0.0.1", "::1", "localhost"].includes(host) &&
      (!allowedOrigins.size || [...allowedOrigins].some((origin) => new URL(origin).protocol !== "https:"))) {
    throw new Error("ALLOWED_ORIGINS must contain exact HTTPS origins when the proxy is exposed beyond loopback");
  }
  createProxyServer({ allowedOrigins }).listen(port, host, () => {
    console.log(`Pi proxy: http://${host}:${port}${ROUTE_PREFIX}<upstream-url>`);
  });
}
