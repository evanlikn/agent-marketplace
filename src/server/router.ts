import { ProviderSession } from "../shared/types.js";
import { getCircuitOpenedUntil, getListingProviderSessions, touchCircuit } from "./repositories.js";

export async function markInvocationResult(sessionId: string, succeeded: boolean): Promise<void> {
  await touchCircuit(sessionId, succeeded);
}

export async function pickBestProvider(listingId: string): Promise<ProviderSession | undefined> {
  const sessions = await getListingProviderSessions(listingId);
  if (sessions.length === 0) return undefined;
  const candidates: ProviderSession[] = [];
  for (const session of sessions) {
    if (session.status !== "online") continue;
    if (session.current_concurrency >= session.max_concurrency) continue;
    if (Date.now() - new Date(session.updated_at).getTime() > 30_000) continue;
    const openedUntil = await getCircuitOpenedUntil(session.session_id);
    if (openedUntil && openedUntil > Date.now()) continue;
    candidates.push(session);
  }
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => score(b) - score(a))[0];
}

function score(session: ProviderSession): number {
  const latencyScore = 1 / Math.max((session.latency_ms ?? 300) / 100, 1);
  const successScore = session.success_rate_1m ?? 1;
  const capacityScore = (session.max_concurrency - session.current_concurrency) / session.max_concurrency;
  return latencyScore * 0.3 + successScore * 0.5 + capacityScore * 0.2;
}
