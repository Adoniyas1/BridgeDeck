/**
 * Where the main process sends events for the UI. Under Electron this was a
 * BrowserWindow; now the UI is a tab in BridgeDeck connected over a local
 * WebSocket (see server.ts), and `send` reaches it the same way.
 */
export interface UiChannel {
  send(channel: string, ...args: unknown[]): void;
}

/** Same shape the code used with BrowserWindow (`win.webContents.send(...)`). */
export interface UiWindow {
  webContents: UiChannel;
}
