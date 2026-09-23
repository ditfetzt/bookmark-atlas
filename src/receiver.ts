import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { importXJson, type XImportResult } from "./x.ts";
import type { AtlasDatabase } from "./db.ts";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TOKEN_HEADER = "x-bookmark-atlas-session-token";

type Session = { account: string; source: string };
type CaptureBody = { sessionId?: unknown; bookmarks?: unknown; source?: unknown; account?: unknown };

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function cors(response: ServerResponse, origin: string | undefined): void {
  const allowed = origin === "https://x.com" || origin === "https://twitter.com" || origin === undefined;
  if (allowed) response.setHeader("access-control-allow-origin", origin ?? "null");
  response.setHeader("access-control-allow-headers", `content-type, ${TOKEN_HEADER}`);
  response.setHeader("access-control-allow-methods", "POST, OPTIONS");
}

async function body(request: IncomingMessage): Promise<CaptureBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("request body exceeds 8 MiB limit");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as CaptureBody;
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function tokenMatches(request: IncomingMessage, token: string): boolean {
  return request.headers[TOKEN_HEADER] === token;
}

export type XCaptureServerOptions = {
  db: AtlasDatabase;
  token: string;
  port?: number;
};

export type XCaptureServer = {
  server: Server;
  address: { host: string; port: number };
  close: () => Promise<void>;
};

export async function startXCaptureServer(options: XCaptureServerOptions): Promise<XCaptureServer> {
  if (!options.token.trim()) throw new Error("X capture token must not be empty");
  // Loopback only, and deliberately not configurable: this endpoint accepts
  // unauthenticated-until-tokened writes of whatever the browser sends.
  const host = "127.0.0.1";
  const sessions = new Map<string, Session>();
  const server = createServer(async (request, response) => {
    cors(response, typeof request.headers.origin === "string" ? request.headers.origin : undefined);
    if (request.method === "OPTIONS") return json(response, 204, {});
    if (request.method !== "POST" || !tokenMatches(request, options.token)) {
      return json(response, 401, { error: "unauthorized" });
    }
    try {
      const path = new URL(request.url ?? "/", `http://${host}`).pathname;
      const payload = await body(request);
      if (path === "/session/start") {
        const sessionId = randomUUID();
        sessions.set(sessionId, {
          account: typeof payload.account === "string" ? payload.account : "ego-browser",
          source: typeof payload.source === "string" ? payload.source : "x-browser",
        });
        return json(response, 201, { sessionId });
      }
      if (path === "/session/batch") {
        if (typeof payload.sessionId !== "string" || !sessions.has(payload.sessionId)) {
          return json(response, 400, { error: "unknown sessionId" });
        }
        if (!Array.isArray(payload.bookmarks)) return json(response, 400, { error: "bookmarks must be an array" });
        const session = sessions.get(payload.sessionId)!;
        const result: XImportResult = importXJson(options.db, {
          bookmarks: payload.bookmarks,
          source: session.source,
        }, { account: session.account });
        return json(response, 200, result);
      }
      if (path === "/session/complete") {
        if (typeof payload.sessionId !== "string" || !sessions.delete(payload.sessionId)) {
          return json(response, 400, { error: "unknown sessionId" });
        }
        return json(response, 200, { completed: true });
      }
      return json(response, 404, { error: "not found" });
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 41009, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("capture server did not expose an address");
  return {
    server,
    address: { host, port: address.port },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
