import { createServer, type Server, type ServerResponse } from "node:http";
import type pg from "pg";

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createHealthServer(pool: pg.Pool): Server {
  return createServer(async (request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      sendJson(response, 404, { status: "not_found" });
      return;
    }
    try {
      await pool.query("select 1");
      sendJson(response, 200, { status: "ok" });
    } catch {
      sendJson(response, 503, { status: "unavailable" });
    }
  });
}
