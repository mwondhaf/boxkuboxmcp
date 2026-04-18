import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config";
import { createServer } from "./server";

// Map sessionId → transport. Streamable HTTP supports session-per-client so
// multiple conversations can share one server process.
const transports = new Map<string, StreamableHTTPServerTransport>();

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && config.allowedOrigins.includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Mcp-Session-Id",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

function unauthorized(origin: string | null): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: corsHeaders(origin),
  });
}

async function handleMcp(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // Caller auth: shared secret between the WhatsApp bot and this server.
  // This is *not* end-user auth; guest identity is established per-request
  // via the phone number passed to place_guest_order.
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${config.clientSecret}`) {
    return unauthorized(origin);
  }

  const sessionId = req.headers.get("mcp-session-id") ?? undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    if (req.method !== "POST") {
      return new Response("Session not found", {
        status: 404,
        headers: corsHeaders(origin),
      });
    }
    // New session — boot a transport and hook it into an McpServer instance.
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
    const server = createServer();
    await server.connect(transport);
  }

  // Streamable HTTP transport exposes a Node-style `handleRequest`. We adapt
  // Bun's Request/Response to it via a small shim using Fetch-API streams.
  const body = await req.arrayBuffer();
  const nodeReq: any = {
    method: req.method,
    url: new URL(req.url).pathname + new URL(req.url).search,
    headers: Object.fromEntries(req.headers.entries()),
    // Feed parsed body so the transport's JSON reader gets it.
    on(event: string, handler: (chunk?: unknown) => void) {
      if (event === "data" && body.byteLength > 0) {
        handler(new Uint8Array(body));
      }
      if (event === "end") {
        handler();
      }
    },
  };

  return await new Promise<Response>((resolve) => {
    let statusCode = 200;
    const resHeaders: Record<string, string> = { ...corsHeaders(origin) };
    const chunks: Uint8Array[] = [];
    const nodeRes: any = {
      setHeader(name: string, value: string) {
        resHeaders[name] = value;
      },
      writeHead(code: number, headers?: Record<string, string>) {
        statusCode = code;
        if (headers) {
          Object.assign(resHeaders, headers);
        }
      },
      write(chunk: Uint8Array | string) {
        chunks.push(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
        );
      },
      end(chunk?: Uint8Array | string) {
        if (chunk) {
          chunks.push(
            typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
          );
        }
        const buf = new Uint8Array(
          chunks.reduce((n, c) => n + c.byteLength, 0)
        );
        let o = 0;
        for (const c of chunks) {
          buf.set(c, o);
          o += c.byteLength;
        }
        resolve(new Response(buf, { status: statusCode, headers: resHeaders }));
      },
    };

    transport!.handleRequest(
      nodeReq,
      nodeRes,
      body.byteLength > 0
        ? JSON.parse(new TextDecoder().decode(body))
        : undefined
    );
  });
}

Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/mcp") {
      return handleMcp(req);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`boxconv-mcp listening on :${config.port}`);
