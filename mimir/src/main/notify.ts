/**
 * Desktop notification. BridgeDeck runs this process and shows a native
 * notification for every line printed with this marker (see BridgeDeck's
 * src-tauri/src/mimir_host.rs), so it works even while the Mimir tab is closed.
 */
export const NOTIFY_MARKER = "MIMIR_NOTIFY";

export function notify(title: string, body: string): void {
  console.log(`${NOTIFY_MARKER} ${JSON.stringify({ title: title.slice(0, 120), body: body.slice(0, 300) })}`);
}
