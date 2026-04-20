import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config";
import { createServer as createMcpServer } from "./server";

// Map MCP session ID → transport. Streamable HTTP allows one server process to
// host many concurrent conversations.
const transports = new Map<string, StreamableHTTPServerTransport>();

// Separate session store for the legacy SSE transport (used by n8n's MCP Client
// node and other older clients). Kept in a distinct map because the transport
// type is different and they're indexed by transport.sessionId.
const sseTransports = new Map<string, SSEServerTransport>();

function setCors(res: ServerResponse, origin: string | undefined): void {
  const allow = origin && config.allowedOrigins.includes(origin) ? origin : "";
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, mcp-protocol-version"
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return undefined;
  }
  return JSON.parse(raw);
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const origin = req.headers.origin;
  setCors(res, origin);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Caller auth: shared secret. Not end-user auth — guest identity is
  // established per-request via the phone passed to place_guest_order.
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${config.clientSecret}`) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return;
  }

  const sessionHeader = req.headers["mcp-session-id"];
  const sessionId =
    typeof sessionHeader === "string" ? sessionHeader : undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  // Parse the body once. The transport accepts parsedBody as a 3rd arg so it
  // does not try to re-read the stream.
  let parsedBody: unknown;
  try {
    parsedBody = await readJsonBody(req);
  } catch (err) {
    res.statusCode = 400;
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32_700, message: "Parse error" },
      })
    );
    return;
  }

  if (!transport) {
    if (req.method !== "POST") {
      res.statusCode = 404;
      res.end("Session not found");
      return;
    }
    // Fresh session — spin up a new transport + McpServer pair.
    const newSessionId = randomUUID();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (sid) => {
        transports.set(sid, transport!);
      },
    });
    transport.onclose = () => {
      if (transport?.sessionId) {
        transports.delete(transport.sessionId);
      }
    };
    const mcp = createMcpServer();
    await mcp.connect(transport);
  }

  try {
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    console.error("MCP handleRequest failed:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32_603,
            message: "Internal error",
            data: err instanceof Error ? err.message : String(err),
          },
        })
      );
    }
  }
}

// =============================================================================
// Legacy SSE transport — used by n8n's MCP Client node and other older clients.
// Two endpoints:
//   GET  /sse            → opens the event stream, emits "endpoint" event
//                           pointing at /message?sessionId=...
//   POST /message        → client sends JSON-RPC requests here, server pipes
//                           responses back over the matching SSE stream.
// =============================================================================

async function handleSseOpen(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const origin = req.headers.origin;
  setCors(res, origin);

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${config.clientSecret}`) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return;
  }

  const transport = new SSEServerTransport("/message", res);
  sseTransports.set(transport.sessionId, transport);

  transport.onclose = () => {
    sseTransports.delete(transport.sessionId);
  };

  const mcp = createMcpServer();
  await mcp.connect(transport);
}

async function handleSseMessage(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const origin = req.headers.origin;
  setCors(res, origin);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${config.clientSecret}`) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return;
  }

  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    res.statusCode = 400;
    res.end("Missing sessionId");
    return;
  }

  const transport = sseTransports.get(sessionId);
  if (!transport) {
    res.statusCode = 404;
    res.end("Session not found");
    return;
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (err) {
    console.error("SSE handlePostMessage failed:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal error");
    }
  }
}

const httpServer = createHttpServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );

    if (url.pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("ok");
      return;
    }

    if (url.pathname === "/mcp") {
      await handleMcp(req, res);
      return;
    }

    if (url.pathname === "/sse" && req.method === "GET") {
      await handleSseOpen(req, res);
      return;
    }

    if (url.pathname === "/message") {
      await handleSseMessage(req, res, url);
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  } catch (err) {
    console.error("Unhandled request error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  }
});

httpServer.listen(config.port, () => {
  console.log(`boxconv-mcp listening on :${config.port}`);
});
