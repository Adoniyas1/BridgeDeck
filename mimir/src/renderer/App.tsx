import React, { useEffect, useRef, useState } from "react";
import Chat from "./Chat.js";
import Settings from "./Settings.js";
import QuickControls from "./QuickControls.js";
import Skills from "./Skills.js";
import ChatGpt from "./ChatGpt.js";
import Memory from "./Memory.js";
import Jarvis, { type JarvisActivity, type JarvisView } from "./jarvis/Jarvis.js";
import { preloadTranscriber, transcribeSamples, VoiceRecorder } from "./voice/stt.js";
import type { AutoStopReason } from "./voice/vad.js";
import { sanitizeSpeech, takeCompleteSentences } from "./voice/speech.js";
import { OpenMicController } from "./voice/openMic.js";
import { fileToAttachment } from "./attachments.js";
import { pythonRuntime } from "./python/pythonRuntime.js";
import { searchProjectFiles } from "./search/projectSearch.js";
import type { Attachment, ChatMessage, FaceState, LoadedPromptModule, MimirChat, PendingEdit, ToolApproval } from "../shared/types.js";
import { applyTeamEvent } from "./teamProgress.js";

function newId(): string {
  return crypto.randomUUID();
}

const OPEN_MIC_ECHO_GUARD_MS = 1_500;

const greeting = (): ChatMessage => ({
  id: newId(),
  role: "assistant",
  text: "I'm Mimir. Ask me anything, or tell me to change how I work — I can edit my own code.",
  createdAt: Date.now()
});

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [greeting()]);
  // The conversation on screen, saved to ~/.mimir/chats after each reply.
  const [chatId, setChatId] = useState<string>(() => newId());
  const chatCreated = useRef(Date.now());
  /** Something changed since the last save (a message was sent). */
  const unsaved = useRef(false);
  const [thinkingOn, setThinkingOn] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);
  const [approvals, setApprovals] = useState<ToolApproval[]>([]);
  const [faceState, setFaceState] = useState<FaceState>("idle");
  const [busy, setBusy] = useState(false);
  const [, setListening] = useState(false);
  const [openMicActive, setOpenMicActive] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showChatGpt, setShowChatGpt] = useState(false);
  const [turnContext, setTurnContext] = useState<{ modules: LoadedPromptModule[]; tokens: number } | null>(null);
  // Talk (the orb and captions) or Chat (the whole conversation), remembered between launches.
  const [view, setView] = useState<JarvisView>(() => { try { return localStorage.getItem("mimir.view") === "chat" ? "chat" : "talk"; } catch { return "talk"; } });
  const [activity, setActivity] = useState<JarvisActivity[]>([]);
  useEffect(() => { try { localStorage.setItem("mimir.view", view); } catch { /* not kept */ } }, [view]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "j") { e.preventDefault(); setView((v) => (v === "talk" ? "chat" : "talk")); } };
    window.addEventListener("keydown", onKey);
    // BridgeDeck's Jarvis button and ⌘/Ctrl+Shift+J: straight to Talk.
    const offOpen = window.mimir.jarvis.onOpen(() => { closePanels(); setView("talk"); });
    return () => { window.removeEventListener("keydown", onKey); offOpen(); };
  }, []);

  function closePanels() {
    setShowSettings(false);
    setShowSkills(false);
    setShowChatGpt(false);
    setShowMemory(false);
  }
  /** Opens one panel over the view (or closes it when it's the one open). */
  function togglePanel(which: "settings" | "skills" | "chatgpt" | "memory") {
    const open = { settings: showSettings, skills: showSkills, chatgpt: showChatGpt, memory: showMemory }[which];
    closePanels();
    if (open) return;
    if (which === "settings") setShowSettings(true);
    else if (which === "skills") setShowSkills(true);
    else if (which === "chatgpt") setShowChatGpt(true);
    else setShowMemory(true);
  }

  const assistantMessageId = useRef<string | null>(null);
  const voiceOrigin = useRef(false);
  const recorder = useRef<VoiceRecorder | null>(null);
  // State updates reach the next render asynchronously; this ref is the
  // immediate guard shared by wake-word, follow-up, and mic-button paths.
  const listeningRef = useRef(false);
  const busyRef = useRef(false);
  const openMicEnabled = useRef(false);
  const openMic = useRef<OpenMicController | null>(null);
  const speechBuffer = useRef("");
  const speechQueue = useRef<Promise<void>>(Promise.resolve());
  /** When the current reply started thinking, to show "Thought for 4s". */
  const thinkingStarted = useRef<number | null>(null);

  // Pick up the last conversation where it was left (Mimir continues it from the saved messages).
  useEffect(() => {
    void window.mimir.chats.list().then(async (chats) => {
      const latest = chats[0] ? await window.mimir.chats.open(chats[0].id) : null;
      if (latest && !unsaved.current) showChat(latest);
    });
    void window.mimir.team.getConfig().then((team) => setThinkingOn(team.thinking));
  }, []);

  // Save once a reply is finished (not on every streamed word).
  useEffect(() => {
    if (busy || !unsaved.current) return;
    unsaved.current = false;
    void window.mimir.chats.save({ id: chatId, title: "", messages, createdAt: chatCreated.current, updatedAt: Date.now() });
  }, [busy, messages, chatId]);

  function showChat(chat: MimirChat) {
    setChatId(chat.id);
    chatCreated.current = chat.createdAt;
    setMessages(chat.messages.length ? chat.messages : [greeting()]);
    setTurnContext(null);
    setPendingEdit(null);
  }

  async function openChat(id: string | null) {
    if (busyRef.current) handleStop();
    const chat = await window.mimir.chats.open(id);
    if (chat) showChat(chat);
    else {
      setChatId(newId());
      chatCreated.current = Date.now();
      setMessages([greeting()]);
      setTurnContext(null);
      setPendingEdit(null);
    }
    unsaved.current = false;
    closePanels();
  }

  async function toggleThinking() {
    const team = await window.mimir.team.setConfig({ thinking: !thinkingOn });
    setThinkingOn(team.thinking);
  }

  useEffect(() => {
    // Only warm the (memory-heavy, WASM) Whisper model eagerly if wake word
    // is on — that means the user actually wants low-latency voice. Text-
    // only sessions load it lazily on first real mic use instead, so an
    // 8GB machine isn't holding a speech model in RAM for no reason.
    void window.mimir.voice.getConfig().then((cfg) => {
      if (cfg.wakeWordEnabled || cfg.openMicEnabled) preloadTranscriber();
      if (cfg.openMicEnabled) void setOpenMicEnabled(true);
    });

    const offFace = window.mimir.face.onState((state) => setFaceState(state));
    const offStream = window.mimir.chat.onStream((event) => {
      if (event.type === "text-delta") {
        // The id is read now: a "turn-done" right behind this would clear it before React applies the update.
        const id = assistantMessageId.current;
        const started = thinkingStarted.current;
        thinkingStarted.current = null;
        setMessages((prev) => {
          const next = appendToAssistant(prev, id, event.text);
          // The reply has started: the thinking before it is done.
          return started === null ? next : next.map((m) => (m.id === id && m.thinkingMs === undefined ? { ...m, thinkingMs: Date.now() - started } : m));
        });
        if (voiceOrigin.current) {
          const { chunks, remainder } = takeCompleteSentences(speechBuffer.current + event.text);
          speechBuffer.current = remainder;
          for (const chunk of chunks) enqueueSpeech(chunk);
        }
      } else if (event.type === "thinking-delta") {
        const id = assistantMessageId.current;
        if (thinkingStarted.current === null) thinkingStarted.current = Date.now();
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, thinking: (m.thinking ?? "") + event.text, thinkingMs: undefined } : m)));
      } else if (event.type === "image") {
        // Shown directly in the assistant's bubble, never sent back to the
        // model — see the "image" ChatStreamEvent doc comment.
        const id = assistantMessageId.current;
        setMessages((prev) => appendToAssistant(prev, id, `\n![plot](${event.dataUrl})\n`));
      } else if (event.type === "team-plan" || event.type === "team-step" || ((event.type === "tool-start" || event.type === "tool-end") && event.step != null)) {
        const id = assistantMessageId.current;
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, team: applyTeamEvent(m.team, event) } : m)));
      }
      // Every tool step, for Jarvis mode's list of what Mimir is doing.
      if (event.type === "tool-start") {
        setActivity((prev) => [...prev.slice(-19), { id: newId(), name: event.name, done: false, isError: false }]);
      } else if (event.type === "tool-end") {
        setActivity((prev) => {
          const i = prev.map((a) => !a.done && a.name === event.name).lastIndexOf(true);
          return i < 0 ? prev : prev.map((a, j) => (j === i ? { ...a, done: true, isError: event.isError } : a));
        });
      }
      if (event.type === "context") {
        setTurnContext({ modules: event.modules, tokens: event.tokens });
      } else if (event.type === "approval-pending") {
        setApprovals((prev) => [...prev, event.approval]);
      } else if (event.type === "edit-pending") {
        setPendingEdit(event.pending);
      } else if (event.type === "error") {
        setBusy(false);
        busyRef.current = false;
        setMessages((prev) => [
          ...prev,
          { id: newId(), role: "system", text: `⚠️ ${event.message}`, createdAt: Date.now() }
        ]);
      } else if (event.type === "turn-done") {
        thinkingStarted.current = null;
        setApprovals([]);
        setBusy(false);
        busyRef.current = false;
        assistantMessageId.current = null;
        if (voiceOrigin.current && event.fullText.trim()) {
          const finalSpeech = enqueueSpeech(speechBuffer.current);
          speechBuffer.current = "";
          void finalSpeech.then(resumeAfterVoiceReply, resumeAfterVoiceReply);
        } else if (voiceOrigin.current) {
          void maybeStartFollowUpListening();
        }
        voiceOrigin.current = false;
      }
      // tool-start / tool-end are surfaced via faceState "thinking" already;
      // intentionally not rendered as chat bubbles to keep the transcript readable.
    });

    const offWake = window.mimir.voice.onWakeTriggered(() => {
      void startVoiceTurn();
    });
    const offHotkey = window.mimir.voice.onHotkeyTriggered(() => {
      void handleMicToggle();
    });
    // A question from BridgeDeck: asked as soon as Mimir isn't answering something else.
    const offAsk = window.mimir.chat.onAsk((text) => {
      const ask = () => (busyRef.current ? window.setTimeout(ask, 1000) : void handleSend(text));
      ask();
    });
    const offPython = window.mimir.python.onRunRequest((req) => {
      if ("reset" in req) {
        pythonRuntime.reset();
        return;
      }
      void pythonRuntime
        .run(req.code, req.args, req.capabilities)
        .then((result) => window.mimir.python.sendResult(req.id, result));
    });
    const offSearch = window.mimir.search.onSearchRequest((req) => {
      void searchProjectFiles(req.query, req.corpus, req.topK).then((hits) =>
        window.mimir.search.sendResult(req.id, hits)
      );
    });

    return () => {
      offFace();
      offStream();
      offWake();
      offHotkey();
      offAsk();
      offPython();
      offSearch();
      void openMic.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function maybeStartFollowUpListening() {
    if (openMicEnabled.current) {
      await openMic.current?.start();
      return;
    }
    const cfg = await window.mimir.voice.getConfig();
    if (cfg.followUpListenSeconds > 0) {
      void startVoiceTurn({ noSpeechTimeoutMs: cfg.followUpListenSeconds * 1000 });
    }
  }

  async function resumeAfterVoiceReply() {
    // `say` can finish just before the room stops carrying its sound. Keep
    // the mic closed briefly so Open Mic does not transcribe Mimir itself.
    await new Promise<void>((resolve) => window.setTimeout(resolve, OPEN_MIC_ECHO_GUARD_MS));
    if (!busyRef.current) await maybeStartFollowUpListening();
  }

  function enqueueSpeech(text: string): Promise<void> {
    const cleanText = sanitizeSpeech(text);
    if (!cleanText) return speechQueue.current;

    // A request must finish before the next begins: this prevents sentence
    // chunks from overlapping and makes the final follow-up window reliable.
    speechQueue.current = speechQueue.current.catch(() => undefined).then(() => window.mimir.chat.speak(cleanText));
    return speechQueue.current;
  }

  async function handleSend(text: string, viaVoice = false, files?: File[]) {
    let attachments: Attachment[] | undefined;
    if (files && files.length > 0) {
      try {
        attachments = await Promise.all(files.map(fileToAttachment));
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: newId(),
            role: "system",
            text: `⚠️ ${err instanceof Error ? err.message : String(err)}`,
            createdAt: Date.now()
          }
        ]);
        return;
      }
    }

    voiceOrigin.current = viaVoice;
    speechBuffer.current = "";
    setActivity([]);
    thinkingStarted.current = null;
    unsaved.current = true;
    busyRef.current = true;
    setPendingEdit(null);
    setBusy(true);
    const displayText = attachments?.length
      ? `${text}${text ? "\n" : ""}📎 ${attachments.map((a) => a.name).join(", ")}`
      : text;
    setMessages((prev) => [...prev, { id: newId(), role: "user", text: displayText, createdAt: Date.now() }]);
    const id = newId();
    assistantMessageId.current = id;
    setMessages((prev) => [...prev, { id, role: "assistant", text: "", createdAt: Date.now() }]);
    window.mimir.chat.send(text, attachments);
  }

  async function setOpenMicEnabled(enabled: boolean) {
    openMicEnabled.current = enabled;
    setOpenMicActive(enabled);
    if (!enabled) {
      await openMic.current?.pause();
      setListening(false);
      if (!busyRef.current) setFaceState("idle");
      return;
    }

    if (!openMic.current) {
      openMic.current = new OpenMicController({
        onSpeechStart: () => {
          if (openMicEnabled.current && !busyRef.current) {
            setListening(true);
            setFaceState("listening");
          }
        },
        onSpeechEnd: (audio) => {
          void handleOpenMicSegment(audio);
        },
        onError: (error) => {
          console.error("[mimir] open mic failed:", error);
          setListening(false);
          setFaceState("error");
        }
      });
    }
    preloadTranscriber();
    await openMic.current.start();
  }

  async function handleOpenMicSegment(audio: Float32Array) {
    setListening(false);
    if (!openMicEnabled.current || busyRef.current) return;
    await openMic.current?.pause();
    setFaceState("thinking");
    try {
      const text = await transcribeSamples(audio);
      if (text) handleSend(text, true);
      else {
        setFaceState("idle");
        await openMic.current?.start();
      }
    } catch (error) {
      console.error("[mimir] open mic transcription failed:", error);
      setFaceState("idle");
      await openMic.current?.start();
    }
  }

  async function startVoiceTurn(opts?: { noSpeechTimeoutMs?: number }) {
    if (listeningRef.current) return;
    listeningRef.current = true;
    setListening(true);
    setFaceState("listening");
    const activeRecorder = new VoiceRecorder();
    recorder.current = activeRecorder;
    try {
      await activeRecorder.start();
      // Record until the room goes quiet again, rather than a fixed window —
      // see voice/vad.ts. `noSpeechTimeoutMs` is longer for follow-up
      // listening (the user needs a beat to decide to say anything at all)
      // than for a fresh wake-word trigger.
      const reason = await new Promise<AutoStopReason>((resolve) => {
        activeRecorder.watchForAutoStop((r) => resolve(r), {
          noSpeechTimeoutMs: opts?.noSpeechTimeoutMs ?? 6000
        });
      });
      if (recorder.current !== activeRecorder) return;
      listeningRef.current = false;
      setListening(false);
      if (reason === "no-speech-timeout" || reason === "cancelled") {
        // Nothing was said — don't bother running Whisper on near-silence
        // (it's prone to hallucinating text from silence).
        activeRecorder.abort();
        recorder.current = null;
        setFaceState("idle");
        return;
      }
      const text = await activeRecorder.stopAndTranscribe();
      recorder.current = null;
      if (text) handleSend(text, true);
      else setFaceState("idle");
    } catch (err) {
      if (recorder.current === activeRecorder) recorder.current = null;
      listeningRef.current = false;
      setListening(false);
      setFaceState("idle");
      console.error("[mimir] voice capture failed:", err);
    }
  }

  async function handleMicToggle() {
    if (!listeningRef.current) {
      listeningRef.current = true;
      setListening(true);
      setFaceState("listening");
      window.mimir.voice.pushToTalkStart();
      recorder.current = new VoiceRecorder();
      try {
        await recorder.current.start();
      } catch (err) {
        setListening(false);
        setFaceState("idle");
        console.error("[mimir] microphone unavailable:", err);
      }
      return;
    }

    listeningRef.current = false;
    setListening(false);
    window.mimir.voice.pushToTalkStop();
    if (!recorder.current) return;
    setFaceState("thinking");
    try {
      const text = await recorder.current.stopAndTranscribe();
      recorder.current = null;
      if (text) handleSend(text, true);
      else setFaceState("idle");
    } catch (err) {
      recorder.current = null;
      setFaceState("idle");
      console.error("[mimir] transcription failed:", err);
    }
  }

  function handleStop() {
    window.mimir.chat.stop();
    setApprovals([]);
    busyRef.current = false;
    voiceOrigin.current = false;
    speechBuffer.current = "";
    assistantMessageId.current = null;
    setBusy(false);
    setFaceState("idle");
    if (openMicEnabled.current) void resumeAfterVoiceReply();
  }

  async function toggleOpenMic() {
    const config = await window.mimir.voice.setConfig({ openMicEnabled: !openMicEnabled.current });
    await setOpenMicEnabled(config.openMicEnabled);
  }

  const decide = (id: string, allow: boolean) => {
    window.mimir.approval.decide(id, allow);
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  };
  const decideEdit = (approve: boolean) => {
    if (pendingEdit) {
      if (approve) window.mimir.edit.approve(pendingEdit.id);
      else window.mimir.edit.reject(pendingEdit.id);
    }
    setPendingEdit(null);
  };
  const toolButton = (which: "settings" | "skills" | "chatgpt" | "memory", label: string, title: string, on: boolean) => (
    <button type="button" className={`quick-controls__action${on ? " on" : ""}`} onClick={() => togglePanel(which)} title={title} aria-pressed={on}>{label}</button>
  );

  const panel = showSettings ? (
    <Settings onClose={closePanels} onVoiceConfigChanged={(config) => void setOpenMicEnabled(config.openMicEnabled)} />
  ) : showSkills ? (
    <Skills onClose={closePanels} lastLoaded={turnContext?.modules ?? []} />
  ) : showChatGpt ? (
    <ChatGpt onClose={closePanels} />
  ) : showMemory ? (
    <Memory onClose={closePanels} />
  ) : null;

  return (
    <div className={`app app--${faceState}`}>
      <Jarvis
        messages={messages}
        faceState={faceState}
        busy={busy}
        openMicActive={openMicActive}
        approvals={approvals}
        pendingEdit={pendingEdit}
        activity={activity}
        view={view}
        onView={setView}
        panel={panel}
        onClosePanel={closePanels}
        toolbar={<>
          <QuickControls
            onOpenSkills={() => togglePanel("skills")}
            onOpenChatGpt={() => togglePanel("chatgpt")}
            skillsOn={showSkills}
            chatGptOn={showChatGpt}
            onError={(message) => setMessages((prev) => [...prev, { id: newId(), role: "system", text: `⚠️ ${message}`, createdAt: Date.now() }])}
          />
          {toolButton("memory", "Memory", "What Mimir remembers about you", showMemory)}
          {toolButton("settings", "Settings", "Brain, voice, persona and setup", showSettings)}
        </>}
        chat={
          <Chat
            messages={messages}
            chatId={chatId}
            onNewChat={() => void openChat(null)}
            onOpenChat={(id) => void openChat(id)}
            onOpenMemory={() => togglePanel("memory")}
            thinkingOn={thinkingOn}
            onToggleThinking={() => void toggleThinking()}
            pendingEdit={pendingEdit}
            approvals={approvals}
            onDecide={decide}
            busy={busy}
            openMicEnabled={openMicActive}
            context={turnContext}
            onSend={(text, files) => void handleSend(text, false, files)}
            onStop={handleStop}
            onApprove={() => decideEdit(true)}
            onReject={() => decideEdit(false)}
            onOpenMicToggle={() => void toggleOpenMic()}
          />
        }
        onDecide={decide}
        onEdit={decideEdit}
        onSend={(text) => void handleSend(text)}
        onToggleMic={() => void toggleOpenMic()}
        onStop={handleStop}
      />
    </div>
  );
}

function appendToAssistant(prev: ChatMessage[], id: string | null, delta: string): ChatMessage[] {
  if (!id) return prev;
  return prev.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m));
}
