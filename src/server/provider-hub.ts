import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import { ProviderSession } from "../shared/types.js";
import { getProviderSession, updateProviderSession } from "./repositories.js";

type PendingInvocation = {
  resolve: (value: InvocationResult) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  chunks: string[];
  onChunk?: (chunk: string) => void;
};

export interface InvocationResult {
  output: string;
  token_usage?: { input_tokens?: number; output_tokens?: number };
}

const sessionConnections = new Map<string, WebSocket>();
const pendingInvocations = new Map<string, PendingInvocation>();

export function attachProviderHub(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: "/v1/providers/tunnel" });
  wss.on("connection", (ws, req) => {
    void (async () => {
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("session_token");
    if (!token) {
      ws.close(1008, "missing session_token");
      return;
    }
    const [sessionId] = token.split(".");
    const session = await getProviderSession(sessionId);
    if (!session) {
      ws.close(1008, "invalid session_token");
      return;
    }

    sessionConnections.set(sessionId, ws);
    await updateProviderSession(sessionId, {
      ...session,
      status: "online"
    });

    ws.on("message", (raw) => {
      void onProviderMessage(sessionId, String(raw));
    });
    ws.on("close", () => {
      void onProviderClose(sessionId);
    });
    ws.on("error", () => {
      void onProviderClose(sessionId);
    });
    })();
  });
}

async function onProviderMessage(sessionId: string, message: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(message);
  } catch {
    return;
  }
  const type = String(parsed.type ?? "");

  if (type === "heartbeat") {
    const session = await getProviderSession(sessionId);
    if (!session) return;
    await updateProviderSession(sessionId, {
      status: "online",
      current_concurrency: Number(parsed.current_concurrency ?? session.current_concurrency),
      latency_ms: Number(parsed.latency_ms ?? session.latency_ms ?? 0),
      success_rate_1m: Number(parsed.success_rate_1m ?? session.success_rate_1m ?? 1)
    });
    return;
  }

  if (type === "invoke.chunk") {
    const requestId = String(parsed.request_id ?? "");
    const chunk = String(parsed.chunk ?? "");
    const pending = pendingInvocations.get(requestId);
    if (!pending) return;
    pending.chunks.push(chunk);
    pending.onChunk?.(chunk);
    return;
  }

  if (type === "invoke.result" || type === "invoke.error") {
    const requestId = String(parsed.request_id ?? "");
    const pending = pendingInvocations.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingInvocations.delete(requestId);
    if (type === "invoke.error") {
      pending.reject(new Error(String(parsed.error ?? "provider error")));
      return;
    }
    pending.resolve({
      output: pending.chunks.join("") || String(parsed.output ?? ""),
      token_usage: parsed.token_usage as InvocationResult["token_usage"]
    });
  }
}

async function onProviderClose(sessionId: string): Promise<void> {
  sessionConnections.delete(sessionId);
  const session = await getProviderSession(sessionId);
  if (session) {
    await updateProviderSession(sessionId, {
      status: "offline"
    });
  }
}

export function createSessionToken(session: ProviderSession): string {
  return `${session.session_id}.${nanoid(18)}`;
}

export async function invokeProvider(
  sessionId: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  onChunk?: (chunk: string) => void
): Promise<InvocationResult> {
  const connection = sessionConnections.get(sessionId);
  if (!connection || connection.readyState !== WebSocket.OPEN) {
    throw new Error("provider offline");
  }

  const requestId = String(payload.request_id ?? nanoid());
  return new Promise<InvocationResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingInvocations.delete(requestId);
      reject(new Error("provider timeout"));
    }, timeoutMs);

    pendingInvocations.set(requestId, { resolve, reject, timer, onChunk, chunks: [] });
    connection.send(JSON.stringify({ type: "invoke.start", ...payload }));
  });
}
