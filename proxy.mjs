import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

const DEFAULT_CODEX_UPSTREAM = "https://chatgpt.com/backend-api";
const DEFAULT_ANTHROPIC_UPSTREAM = "https://api.anthropic.com";
const DEFAULT_XAI_UPSTREAM = "https://api.x.ai/v1";

function parseUpstream(value, name) {
  const upstream = new URL(value);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error(`${name} must use http: or https:`);
  }
  return upstream;
}

function selectRoute(rawUrl, codex, anthropic, xai) {
  const incoming = new URL(rawUrl || "/", "http://proxy.local");
  const path = `${incoming.pathname}${incoming.search}`;
  if (incoming.pathname.startsWith("/codex/")) return { upstream: codex, path };
  if (incoming.pathname.startsWith("/v1/messages")) return { upstream: anthropic, path };
  if (incoming.pathname.startsWith("/chat/completions") || incoming.pathname.startsWith("/responses")) {
    return { upstream: xai, path };
  }

  const match = incoming.pathname.match(/^\/route_map\/([^/]+)(\/.*)?$/);
  if (!match) return;
  try {
    return {
      upstream: parseUpstream(decodeURIComponent(match[1]), "route_map endpoint"),
      path: `${match[2] || "/"}${incoming.search}`,
    };
  } catch {
    return;
  }
}

function requestPath(route) {
  const prefix = route.upstream.pathname.replace(/\/+$/, "");
  return `${prefix}${route.path}` || "/";
}

function requestHeaders(headers, upstream) {
  return { ...headers, host: upstream.host };
}

export function createProxyServer({
  codexUpstreamBase = DEFAULT_CODEX_UPSTREAM,
  anthropicUpstreamBase = DEFAULT_ANTHROPIC_UPSTREAM,
  xaiUpstreamBase = DEFAULT_XAI_UPSTREAM,
} = {}) {
  const codex = parseUpstream(codexUpstreamBase, "CODEX_UPSTREAM_BASE");
  const anthropic = parseUpstream(anthropicUpstreamBase, "ANTHROPIC_UPSTREAM_BASE");
  const xai = parseUpstream(xaiUpstreamBase, "XAI_UPSTREAM_BASE");

  const server = http.createServer((req, res) => {
    const route = selectRoute(req.url, codex, anthropic, xai);
    if (!route) return res.writeHead(404).end("Unknown provider route\n");

    const transport = route.upstream.protocol === "https:" ? https : http;
    const upstreamReq = transport.request(
      {
        hostname: route.upstream.hostname,
        port: route.upstream.port || undefined,
        method: req.method,
        path: requestPath(route),
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
    req.pipe(upstreamReq);
  });

  server.on("upgrade", (req, socket, head) => {
    const route = selectRoute(req.url, codex, anthropic, xai);
    if (!route) return socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");

    const port = Number(route.upstream.port) || (route.upstream.protocol === "https:" ? 443 : 80);
    const upstreamSocket = route.upstream.protocol === "https:"
      ? tls.connect({ host: route.upstream.hostname, port, servername: route.upstream.hostname })
      : net.connect({ host: route.upstream.hostname, port });

    upstreamSocket.once("connect", () => {
      const headers = requestHeaders(req.headers, route.upstream);
      const lines = [`${req.method} ${requestPath(route)} HTTP/${req.httpVersion}`];
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
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8787);
  const codexUpstreamBase = process.env.CODEX_UPSTREAM_BASE || process.env.UPSTREAM_BASE;
  const server = createProxyServer({
    codexUpstreamBase,
    anthropicUpstreamBase: process.env.ANTHROPIC_UPSTREAM_BASE,
    xaiUpstreamBase: process.env.XAI_UPSTREAM_BASE,
  });
  server.listen(port, host, () => {
    console.log(`Pi subscription proxy: http://${host}:${port}`);
    console.log(`  Codex -> ${codexUpstreamBase || DEFAULT_CODEX_UPSTREAM}`);
    console.log(`  Claude -> ${process.env.ANTHROPIC_UPSTREAM_BASE || DEFAULT_ANTHROPIC_UPSTREAM}`);
    console.log(`  xAI -> ${process.env.XAI_UPSTREAM_BASE || DEFAULT_XAI_UPSTREAM}`);
    console.log("  Custom -> /route_map/<encoded-upstream>");
  });
}
