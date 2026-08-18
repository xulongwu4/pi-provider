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

function selectUpstream(rawUrl, codex, anthropic, xai) {
  const { pathname } = new URL(rawUrl || "/", "http://proxy.local");
  if (pathname.startsWith("/codex/")) return codex;
  if (pathname.startsWith("/v1/messages")) return anthropic;
  if (pathname.startsWith("/chat/completions") || pathname.startsWith("/responses")) return xai;
}

function requestPath(rawUrl, upstream) {
  const incoming = new URL(rawUrl || "/", "http://proxy.local");
  const prefix = upstream.pathname.replace(/\/+$/, "");
  return `${prefix}${incoming.pathname}${incoming.search}` || "/";
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
    const upstream = selectUpstream(req.url, codex, anthropic, xai);
    if (!upstream) return res.writeHead(404).end("Unknown provider route\n");

    const transport = upstream.protocol === "https:" ? https : http;
    const upstreamReq = transport.request(
      {
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        method: req.method,
        path: requestPath(req.url, upstream),
        headers: requestHeaders(req.headers, upstream),
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
    const upstream = selectUpstream(req.url, codex, anthropic, xai);
    if (!upstream) return socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");

    const port = Number(upstream.port) || (upstream.protocol === "https:" ? 443 : 80);
    const upstreamSocket = upstream.protocol === "https:"
      ? tls.connect({ host: upstream.hostname, port, servername: upstream.hostname })
      : net.connect({ host: upstream.hostname, port });

    upstreamSocket.once("connect", () => {
      const headers = requestHeaders(req.headers, upstream);
      const lines = [`${req.method} ${requestPath(req.url, upstream)} HTTP/${req.httpVersion}`];
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
  });
}
