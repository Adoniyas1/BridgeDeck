import { chatgptOpen } from '../lib/bridge'

/**
 * Starting points for ChatGPT, which the person uses in its own window as a study and
 * project helper (src-tauri/src/chatgpt.rs). The text lands in ChatGPT's message box for
 * them to edit and send; nothing is sent for them. Chats they save with the window's
 * "Save to BridgeDeck" button become notes in `folder` (the course or project), else "ChatGPT".
 */
export function askChatGPT(text?: string, folder?: string) {
  return chatgptOpen(text, folder)
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
