/**
 * BridgeDeck's toolbox, reached over its loopback API. BridgeDeck starts Mimir
 * with BRIDGEDECK_API (http://127.0.0.1:port) and BRIDGEDECK_TOKEN; without
 * them (Mimir run on its own) there are no BridgeDeck tools.
 */
export interface BridgeDeckClient {
  call<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T>;
}

export function bridgeDeckFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): BridgeDeckClient | null {
  const base = env.BRIDGEDECK_API;
  const token = env.BRIDGEDECK_TOKEN;
  if (!base || !token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) return null;
  return {
    async call<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
      const response = await fetchImpl(`${base}/mimir/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        // Sending asks the person first, so give them time to answer.
        signal: AbortSignal.timeout(path.endsWith("send") ? 180_000 : 30_000)
      });
      const value = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string };
      if (!response.ok || value.ok === false) throw new Error(value.error || `BridgeDeck answered ${response.status}`);
      return value.result as T;
    }
  };
}
