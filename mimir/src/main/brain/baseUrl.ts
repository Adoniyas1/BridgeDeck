/** Turns whatever the user typed into the Base URL field into something
 * fetch() accepts. "127.0.0.1:11434" or "localhost:11434" (the form
 * OLLAMA_HOST and most docs use) has no scheme, and fetch() rejects it with
 * "Failed to parse URL", so assume http:// for those. Also trims whitespace
 * and trailing slashes so `${base}/api/chat` never doubles up. Returns null
 * for a blank value so callers fall back to their own default. */
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
