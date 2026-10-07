import { useEffect, useMemo, useState } from 'react'
import { Brain, Layers, Pause, Play, Search, Timer } from 'lucide-react'
import { studySearch, type StudyHit } from '../../lib/bridge'
import { useStore } from '../../core/store'
import { Card, SectionTitle } from '../../ui'
import { eventsStore } from '../calendar/state'
import { notesStore } from '../notes/state'
import { cardLine, deckOf, deckStats, dueCards, GRADES, type FlashCard } from './cards'
import { intervals, review } from './review'
import { indexStore } from './indexer'
import { studyMinutes, weekStart } from './model'
import { openBook } from './open'
import { addCards, focusStore, saveReview, startFocus, stopFocus } from './state'

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A focus timer (25 or 50 minutes, then a break); finished sessions go in the calendar. */
export function FocusCard({ course }: { course: string }) {
  const focus = useStore(focusStore)
  const events = useStore(eventsStore)
  const [, setNow] = useState(0)
  useEffect(() => {
    if (!focus) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [focus])
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const week = studyMinutes(events, course, weekStart(), Date.now() + 86_400_000)
  const day = studyMinutes(events, course, today.getTime(), Date.now() + 86_400_000)
  const mine = focus?.course === course
  return <Card><SectionTitle title="Focus" subtitle={`Today ${day} min · this week ${week} min`} />
    {focus ? <div className="study-focus">
      <span className={`study-clock${focus.kind === 'break' ? ' break' : ''}`}>{clock(focus.endsAt - Date.now())}</span>
      <div className="grow"><strong>{focus.kind === 'break' ? 'Break' : mine ? 'Focusing' : `Focusing on ${focus.course}`}</strong><small>{focus.kind === 'break' ? 'Stand up, look away from the screen.' : 'Kept in your calendar when it ends.'}</small></div>
      <button className="ghost" onClick={() => void stopFocus()}><Pause size={14} /> Stop</button>
    </div> : <div className="actions">
      <button onClick={() => startFocus(course, 25, 5)}><Play size={14} />25 min</button>
      <button className="secondary" onClick={() => startFocus(course, 50, 10)}><Timer size={14} />50 min</button>
    </div>}
  </Card>
}

/** The course's flashcards: what's due, a review, and a quick way to add one. */
export function FlashcardsCard({ course, onStatus }: { course: string; onStatus: (s: string) => void }) {
  const notes = useStore(notesStore)
  const deck = useMemo(() => deckOf(notes, course), [notes, course])
  const stats = deckStats(deck)
  const [reviewing, setReviewing] = useState<FlashCard[] | null>(null)
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')

  async function add() {
    if (!front.trim() || !back.trim()) return
    try { await addCards(course, [cardLine(front, back)]); setFront(''); setBack('') } catch (e) { onStatus(String(e)) }
  }

  const ready = stats.due + Math.min(stats.fresh, 20)
  return <Card><SectionTitle title="Flashcards" subtitle={stats.total ? `${stats.total} cards · ${stats.due} due · ${stats.fresh} new · ${stats.learned} learned` : 'Spaced repetition (FSRS)'}
    action={<button className="ghost" disabled={!ready} onClick={() => setReviewing(dueCards(deck))}><Layers size={14} /> Review {ready || ''}</button>} />
    <form className="study-card-new" onSubmit={e => { e.preventDefault(); void add() }}>
      <input placeholder="Question" value={front} onChange={e => setFront(e.target.value)} />
      <input placeholder="Answer" value={back} onChange={e => setBack(e.target.value)} />
      <button className="ghost" disabled={!front.trim() || !back.trim()}>Add</button>
    </form>
    <p className="hint">Cards are lines “question :: answer” in the note “{course} — flashcards”. Make them from a book selection, or ask Mimir to write some from a chapter.</p>
    {reviewing && <Review cards={reviewing} onClose={() => setReviewing(null)} onStatus={onStatus} />}
  </Card>
}

function Review({ cards, onClose, onStatus }: { cards: FlashCard[]; onClose: () => void; onStatus: (s: string) => void }) {
  const [queue, setQueue] = useState(cards)
  const [shown, setShown] = useState(false)
  const [done, setDone] = useState(0)
  const card = queue[0]
  const times = useMemo(() => card ? intervals(card.card) : {}, [card])

  async function answer(grade: (typeof GRADES)[number]['grade']) {
    if (!card) return
    const next = review(card.card, grade)
    try { await saveReview(card, next) } catch (e) { onStatus(String(e)) }
    setShown(false)
    setDone(d => d + 1)
    // Cards answered "Again" come back in this session when they're due within 20 minutes.
    setQueue(q => {
      const rest = q.slice(1)
      return next.due.getTime() - Date.now() < 20 * 60_000 ? [...rest, { ...card, card: next }] : rest
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'Escape') onClose()
      else if (!shown && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); setShown(true) }
      else if (shown) { const g = GRADES.find(g => g.key === e.key); if (g) void answer(g.grade) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return <div className="study-review" role="dialog" aria-label="Flashcard review">
    <div className="study-review-card">
      <div className="study-review-head"><Brain size={15} /><span className="grow">{card ? `${done} done · ${queue.length} to go` : 'All done'}</span><button className="ghost" onClick={onClose}>Close</button></div>
      {card ? <>
        <p className="study-review-front">{card.front}</p>
        {shown ? <p className="study-review-back">{card.back.replace(/\s*\(\[[^\]]*\]\(book:[^)]*\)\)\s*$/, '')}</p> : null}
        {shown ? <div className="study-review-grades">{GRADES.map(g => <button key={g.grade} onClick={() => void answer(g.grade)}><strong>{g.label}</strong><small>{times[g.grade]} · {g.key}</small></button>)}</div>
          : <button className="study-review-show" onClick={() => setShown(true)}>Show answer <small>space</small></button>}
      </> : <p className="study-review-front">Nothing left to review. Well done.</p>}
    </div>
  </div>
}

/** Search the course's books by page. */
export function BookSearchCard({ course, books }: { course: string; books: Array<{ kind: string; indexed: boolean }> }) {
  const indexing = useStore(indexStore)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<StudyHit[] | null>(null)
  const [error, setError] = useState('')
  const pdfs = books.filter(b => b.kind === 'pdf')
  const ready = pdfs.filter(b => b.indexed).length

  async function run() {
    if (!query.trim()) return
    try { setHits(await studySearch(query, course)); setError('') } catch (e) { setError(String(e)) }
  }

  return <Card><SectionTitle title="Search your books" subtitle={pdfs.length ? `${ready} of ${pdfs.length} book${pdfs.length === 1 ? '' : 's'} searchable${indexing.book ? ` · reading “${indexing.book}”${indexing.total ? ` ${Math.round(indexing.done / indexing.total * 100)}%` : ''}${indexing.scanned ? `, recognising text on ${indexing.scanned} scanned page${indexing.scanned === 1 ? '' : 's'}` : ''}` : ''}` : 'Add PDF books to search them'} />
    <form className="study-new" onSubmit={e => { e.preventDefault(); void run() }}>
      <input placeholder="e.g. chain rule, mitochondria, Nash equilibrium" value={query} onChange={e => setQuery(e.target.value)} />
      <button className="cal-icon" title="Search" disabled={!query.trim()}><Search size={15} /></button>
    </form>
    {error && <p className="cal-error">{error}</p>}
    {hits && (hits.length ? <div className="study-hits">{hits.slice(0, 12).map(h => <button key={`${h.file}-${h.page}`} onClick={() => openBook(h.course, h.file, h.book, h.page)}>
      <strong>{h.book}, p. {h.page}</strong><span>{h.snippet}</span></button>)}</div> : <p className="hint">No pages match.</p>)}
    <p className="hint">Scanned books are searchable too: pages that are pictures of text are read by text recognition on this computer, which takes a few seconds a page the first time. Mimir uses the same search to answer questions from these books with page references, write summaries and quizzes, and make flashcards.</p>
  </Card>
}
