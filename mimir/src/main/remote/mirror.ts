import type { ChatStreamEvent, FaceState, ToolApproval } from "../../shared/types.js";

/**
 * The conversation as BridgeDeck's phone page shows it: what Mimir is doing, what was last asked and
 * its answer so far, and anything waiting for an OK. Kept from the same events Mimir's own window
 * gets, so the phone and Jarvis on the computer are one conversation.
 */
export interface RemoteState {
  state: FaceState;
  busy: boolean;
  /** The last thing asked (from the phone or the computer). */
  you: string;
  /** Mimir's answer to it so far. */
  reply: string;
  error: string;
  approvals: Array<Pick<ToolApproval, "id" | "title" | "detail">>;
  /** Bumped on every change, so the page only redraws when something changed. */
  version: number;
}

const MAX_TEXT = 8000;

export class ConversationMirror {
  private s: RemoteState = { state: "idle", busy: false, you: "", reply: "", error: "", approvals: [], version: 0 };

  get(): RemoteState {
    return { ...this.s, approvals: [...this.s.approvals] };
  }

  private bump(patch: Partial<RemoteState>) {
    this.s = { ...this.s, ...patch, version: this.s.version + 1 };
  }

  /** Someone asked something (the phone, or the computer's chat). */
  asked(text: string) {
    this.bump({ you: text.slice(0, MAX_TEXT), reply: "", error: "", busy: true });
  }

  face(state: FaceState) {
    this.bump({ state });
  }

  stream(event: ChatStreamEvent) {
    switch (event.type) {
      case "text-delta":
        if (this.s.reply.length < MAX_TEXT) this.bump({ reply: (this.s.reply + event.text).slice(0, MAX_TEXT), busy: true });
        break;
      case "approval-pending":
        this.bump({ approvals: [...this.s.approvals, { id: event.approval.id, title: event.approval.title, detail: event.approval.detail?.slice(0, 600) }] });
        break;
      case "turn-done":
        this.bump({ reply: event.fullText.slice(0, MAX_TEXT) || this.s.reply, busy: false, approvals: [] });
        break;
      case "error":
        this.bump({ error: event.message, busy: false, approvals: [] });
        break;
      default:
        break;
    }
  }

  /** An approval was answered (anywhere). */
  decided(id: string) {
    this.bump({ approvals: this.s.approvals.filter((a) => a.id !== id) });
  }

  /** Every event Mimir sends its window passes through here. */
  observe(ch: string, args: unknown[], channels: { faceState: string; chatStream: string }) {
    if (ch === channels.faceState && typeof args[0] === "string") this.face(args[0] as FaceState);
    else if (ch === channels.chatStream && args[0] && typeof args[0] === "object") this.stream(args[0] as ChatStreamEvent);
  }
}
