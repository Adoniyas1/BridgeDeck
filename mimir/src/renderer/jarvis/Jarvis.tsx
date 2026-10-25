import React, { useEffect, useRef, useState } from "react";
import type { ChatMessage, FaceState, JarvisBrief, PendingEdit, ToolApproval } from "../../shared/types.js";
import Orb from "./Orb.js";
import { captionTail, dueText, startText, toolWords } from "./text.js";

export interface JarvisActivity {
  id: string;
  name: string;
  done: boolean;
  isError: boolean;
}

/** Talk: the orb and captions, made for voice. Chat: the whole conversation, with history,
 * attachments, the camera and thinking. */
export type JarvisView = "talk" | "chat";

interface Props {
  messages: ChatMessage[];
  faceState: FaceState;
  busy: boolean;
  openMicActive: boolean;
  approvals: ToolApproval[];
  pendingEdit: PendingEdit | null;
  activity: JarvisActivity[];
  view: JarvisView;
  onView: (view: JarvisView) => void;
  /** The top bar's controls (brain picker, Files, Skills, ChatGPT, Memory, Settings). */
  toolbar: React.ReactNode;
  /** The Chat view's conversation. */
  chat: React.ReactNode;
  /** A panel open over the view (Settings, Skills, ChatGPT, Memory), or null. */
  panel: React.ReactNode;
  onClosePanel: () => void;
  onDecide: (id: string, allow: boolean) => void;
  onEdit: (approve: boolean) => void;
  onSend: (text: string) => void;
  onToggleMic: () => void;
  onStop: () => void;
}

const STATE_WORDS: Record<FaceState, string> = { idle: "Standing by", listening: "Listening", thinking: "Working on it", speaking: "Speaking", error: "Something went wrong" };
const gb = (n: number) => (n / 1024 ** 3).toFixed(1);

/** The microphone's level (0-1) while the view is open and Open Mic is on, for the orb. */
function useMicLevel(on: boolean): React.MutableRefObject<number> {
  const level = useRef(0);
  useEffect(() => {
    if (!on || !navigator.mediaDevices?.getUserMedia) return;
    let stream: MediaStream | null = null;
    let audio: AudioContext | null = null;
    let frame = 0;
    let stopped = false;
    void navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(s).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += v * v;
        level.current = Math.sqrt(sum / data.length);
        frame = requestAnimationFrame(tick);
      };
      tick();
    }).catch(() => undefined);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
      void audio?.close();
      level.current = 0;
    };
  }, [on]);
  return level;
}

/**
 * Mimir's screen. The orb in the middle shows what it's doing; in Talk, what you said and its
 * answer run underneath as captions, and in Chat the whole conversation is there instead. The sides
 * show the time, the rest of your day, what's due, each step Mimir takes and how hard the computer
 * is working. ⌘/Ctrl+J switches Talk and Chat; Esc closes a panel.
 */
export default function Jarvis(props: Props) {
  const { messages, faceState, busy, openMicActive, approvals, activity } = props;
  const micLevel = useMicLevel(openMicActive);
  const [brief, setBrief] = useState<JarvisBrief | null>(null);
  const [now, setNow] = useState(Date.now());
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const load = () => void window.mimir.jarvis.brief().then(setBrief).catch(() => undefined);
    load();
    const slow = window.setInterval(load, 30_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(slow); window.clearInterval(clock); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.panel) props.onClosePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastReply = [...messages].reverse().find((m) => m.role === "assistant");
  const reply = lastReply && (!lastUser || lastReply.createdAt >= lastUser.createdAt) ? captionTail(lastReply.text) : "";
  const time = new Date(now);
  const memory = brief ? brief.system.memUsed / brief.system.memTotal : 0;
  const mod = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";
  const talk = props.view === "talk";

  return (
    <div className={`jarvis jarvis--${faceState} jarvis--${props.view}`}>
      <div className="jarvis-grid" aria-hidden="true" />
      <header className="jarvis-top">
        <span className="jarvis-brand">MIMIR</span>
        <span className="jarvis-engine">{brief?.engine ?? ""}</span>
        <div className="jarvis-views" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={talk} className={talk ? "on" : ""} onClick={() => props.onView("talk")} title={`The orb and captions, for talking (${mod}J)`}>Talk</button>
          <button type="button" role="tab" aria-selected={!talk} className={talk ? "" : "on"} onClick={() => props.onView("chat")} title={`The whole conversation: history, files, camera (${mod}J)`}>Chat</button>
        </div>
        <div className="jarvis-tools">{props.toolbar}</div>
      </header>

      <aside className="jarvis-side jarvis-side--left">
        <div className="jarvis-clock">
          <strong>{time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</strong>
          <span>{time.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</span>
        </div>
        <section>
          <h3>Today</h3>
          {brief?.events.length ? brief.events.map((e) => (
            <div key={`${e.title}${e.start}`} className="jarvis-row">
              <span className="jarvis-when">{e.allDay ? "all day" : startText(e.start, now)}</span>
              <span>{e.title}{e.location ? <small> · {e.location}</small> : null}</span>
            </div>
          )) : <p className="jarvis-quiet">Nothing else today.</p>}
        </section>
        <section>
          <h3>Due soon</h3>
          {brief?.due.length ? brief.due.map((d) => (
            <div key={`${d.course}${d.title}${d.due}`} className="jarvis-row">
              <span className="jarvis-when">{dueText(d.due, now)}</span>
              <span>{d.title}{d.course ? <small> · {d.course}</small> : null}</span>
            </div>
          )) : <p className="jarvis-quiet">Nothing due in the next three days.</p>}
          {brief && brief.flashcards > 0 && <p className="jarvis-quiet">{brief.flashcards} flashcard{brief.flashcards === 1 ? "" : "s"} to review</p>}
        </section>
      </aside>

      <main className="jarvis-center">
        <Orb state={faceState} micLevel={micLevel} />
        <div className="jarvis-state">{STATE_WORDS[faceState]}</div>
        {talk ? <>
        {lastUser && <p className="jarvis-you">“{captionTail(lastUser.text, 160)}”</p>}
        {reply && <p className="jarvis-reply" aria-live="polite">{reply}</p>}
        {props.pendingEdit && (
          <div className="jarvis-approval">
            <strong>Mimir wants to change its own {props.pendingEdit.tier === "core" ? "core code" : "skills"}</strong>
            <p className="jarvis-quiet">{props.pendingEdit.summary} · {props.pendingEdit.filesTouched.join(", ")}</p>
            <div className="jarvis-approval__actions">
              <button type="button" onClick={() => props.onView("chat")}>See the change</button>
              <button type="button" onClick={() => props.onEdit(true)}>Approve</button>
              <button type="button" className="ghost" onClick={() => props.onEdit(false)}>Reject</button>
            </div>
          </div>
        )}
        {approvals.map((a) => (
          <div key={a.id} className="jarvis-approval">
            <strong>{a.title}</strong>
            {a.detail && <pre>{a.detail.slice(0, 400)}</pre>}
            <div className="jarvis-approval__actions">
              <button type="button" onClick={() => props.onDecide(a.id, true)}>Allow</button>
              <button type="button" className="ghost" onClick={() => props.onDecide(a.id, false)}>Deny</button>
            </div>
          </div>
        ))}
        </> : <div className="jarvis-chat">{props.chat}</div>}
      </main>

      <aside className="jarvis-side jarvis-side--right">
        <section>
          <h3>System</h3>
          <div className="jarvis-meter"><span>Memory</span><i><b style={{ width: `${Math.round(memory * 100)}%` }} /></i><small>{brief ? `${gb(brief.system.memUsed)} / ${gb(brief.system.memTotal)} GB` : ""}</small></div>
          <div className="jarvis-meter"><span>CPU</span><i><b style={{ width: `${Math.round((brief?.system.cpu ?? 0) * 100)}%` }} /></i><small>{brief ? `${Math.round(brief.system.cpu * 100)}%` : ""}</small></div>
        </section>
        <section>
          <h3>Steps</h3>
          {activity.length ? activity.slice(-6).map((a) => (
            <div key={a.id} className={`jarvis-step${a.done ? " done" : ""}${a.isError ? " failed" : ""}`}>
              <i aria-hidden="true" />{toolWords(a.name)}
            </div>
          )) : <p className="jarvis-quiet">{busy ? "Thinking…" : "Waiting for you."}</p>}
        </section>
      </aside>

      {props.panel && (
        <div className="jarvis-panel" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClosePanel(); }}>
          <div className="jarvis-panel__body">{props.panel}</div>
        </div>
      )}

      {talk && <footer className="jarvis-bottom">
        <button type="button" className={`jarvis-mic${openMicActive ? " on" : ""}`} onClick={props.onToggleMic} title={openMicActive ? "Open Mic is on: just talk" : "Turn on Open Mic to talk hands-free"}>
          {openMicActive ? "● Listening for you" : "○ Mic off"}
        </button>
        <form onSubmit={(e) => { e.preventDefault(); if (typed.trim() && !busy) { props.onSend(typed.trim()); setTyped(""); } }}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={openMicActive ? "Talk, or type here" : "Type to Mimir"} aria-label="Message" />
        </form>
        {busy && <button type="button" className="jarvis-stop" onClick={props.onStop}>Stop</button>}
        <small className="jarvis-hint">{openMicActive ? "Open Mic is on: just talk" : `${navigator.userAgent.includes("Mac") ? "⌘⇧Space" : "Ctrl+Shift+Space"} to talk`} · files and camera in Chat</small>
      </footer>}
    </div>
  );
}
