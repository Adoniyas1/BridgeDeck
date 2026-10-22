import { createStore } from './store'
import { aiAllowed, courseOfFolder } from './exam'

/** The ChatGPT side panel: open or not, its width, and text waiting to go in its message box. */
export const chatPanelStore = createStore<{ open: boolean; width: number; ask: { text: string | null; folder: string | null; at: number } | null }>({
  open: false, width: savedWidth(), ask: null,
})

/**
 * Starting points for ChatGPT, which the person uses in a panel at the side of the window as a
 * study and project helper (src-tauri/src/chatgpt.rs). The text lands in ChatGPT's message box
 * for them to edit and send; nothing is sent for them. Chats they save with the panel's
 * "Save to BridgeDeck" button become notes in `folder` (the course or project), else "ChatGPT".
 */
export async function askChatGPT(text?: string, folder?: string) {
  if (!aiAllowed(courseOfFolder(folder))) return
  chatPanelStore.set(s => ({ ...s, open: true, ask: text || folder ? { text: text ?? null, folder: folder ?? null, at: Date.now() } : s.ask }))
}

export function toggleChatPanel() {
  if (!chatPanelStore.get().open && !aiAllowed()) return
  chatPanelStore.set(s => ({ ...s, open: !s.open }))
}

export const PANEL_MIN = 320
const WIDTH_KEY = 'bd-chat-panel-width'
function savedWidth() {
  try { return Math.max(PANEL_MIN, Number(localStorage.getItem(WIDTH_KEY)) || 440) } catch { return 440 }
}
export function saveWidth(width: number) {
  try { localStorage.setItem(WIDTH_KEY, String(Math.round(width))) } catch { /* not remembered */ }
}

export function passagePrompt(book: string, page: number, passage: string) {
  return `I'm studying "${book}". Explain this passage from page ${page} in plain words, then give me one example and one question to check I understood it.\n\n"${passage.replace(/\s+/g, ' ').trim()}"`
}

export function coursePrompt(course: string, books: string[]) {
  return `I'm taking ${course}${books.length ? ` using ${books.map(b => `"${b}"`).join(', ')}` : ''}. Help me study: ask what I'm working on, then explain it step by step and quiz me.`
}

export function projectPrompt(project: string, board: Array<{ title: string; cards: string[] }>, milestones: string[]) {
  const columns = board.filter(c => c.cards.length).map(c => `${c.title}: ${c.cards.join('; ')}`)
  return [
    `I'm working on a project called "${project}".`,
    columns.length ? `My task board:\n${columns.map(c => `- ${c}`).join('\n')}` : '',
    milestones.length ? `Coming up: ${milestones.join('; ')}.` : '',
    'Help me decide what to do next and break the next task into small steps.',
  ].filter(Boolean).join('\n\n')
}
