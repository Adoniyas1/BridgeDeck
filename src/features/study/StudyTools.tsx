import { useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Brain, Layers, Pause, Play, Search, Timer } from 'lucide-react'
import { isTauri, studyFsrsTune, studySearch, type StudyHit } from '../../lib/bridge'
import { useStore } from '../../core/store'
import { setConfig, useConfig } from '../../core/config'
import { Card, SectionTitle } from '../../ui'
import { eventsStore } from '../calendar/state'
import { notesStore } from '../notes/state'
import { cardBody, cardLine, clozeLine, deckOf, hasMark, isLeech, parseCards, setMark, withBody, deckStats, dueCards, GRADES, masteryMap, type FlashCard } from './cards'
import { savedStarts } from './chapters'
import { intervals, retrievability, review } from './review'
import { indexStore } from './indexer'
import { studyMinutes, weekStart } from './model'
import { openBook, openBookLink } from './open'
import { CardText, cardSource } from './CardText'
import { addCards, changeCardLine, focusStore, saveReview, startFocus, stopFocus } from './state'

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A focus timer (25 or 50 minutes, then a break); finished sessions go in the calendar. */
export function FocusCard({ course }: { course: string }) {
  const focus = useStore(focusStore)
  const events = useStore(eventsStore)
  const config = useConfig()
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
    <label className="study-quiet"><input type="checkbox" checked={config.study.quietFocus} onChange={e => setConfig(c => ({ ...c, study: { ...c.study, quietFocus: e.target.checked } }))} /> Quiet Mail, Messages and AI notifications while focusing (verification codes still come through)</label>
  </Card>
}

/** The next cloze number in a sentence. */
const nextCloze = (text: string) => Math.max(0, ...[...text.matchAll(/\{\{c(\d+)::/g)].map(m => Number(m[1]))) + 1

/** The course's flashcards: what's due, a review, and a quick way to add one. */
export function FlashcardsCard({ course, info, onStatus }: { course: string; info?: { chapters?: unknown }; onStatus: (s: string) => void }) {
  const notes = useStore(notesStore)
  const deck = useMemo(() => deckOf(notes, course), [notes, course])
  const stats = deckStats(deck)
  const [reviewing, setReviewing] = useState<FlashCard[] | null>(null)
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [kind, setKind] = useState<'qa' | 'both' | 'cloze'>('qa')
  const [browsing, setBrowsing] = useState(false)
  const [showMastery, setShowMastery] = useState(false)
  const leeches = useMemo(() => new Set(deck.filter(isLeech).map(c => c.block.id)).size, [deck])
  const sentence = useRef<HTMLInputElement>(null)
  const ok = kind === 'cloze' ? parseCards(front).length > 0 : !!front.trim() && !!back.trim()

  async function add() {
    if (!ok) return
    try { await addCards(course, [kind === 'cloze' ? clozeLine(front) : cardLine(front, back, '', kind === 'both')]); setFront(''); setBack('') } catch (e) { onStatus(String(e)) }
  }

  /** Hides the selected words of the sentence: {{cN::words}}. */
  function hide() {
    const el = sentence.current
    if (!el || el.selectionStart === null || el.selectionEnd === null || el.selectionStart === el.selectionEnd) return
    const words = front.slice(el.selectionStart, el.selectionEnd)
    setFront(`${front.slice(0, el.selectionStart)}{{c${nextCloze(front)}::${words}}}${front.slice(el.selectionEnd)}`)
  }

  const ready = stats.due + Math.min(stats.fresh, 20)
  return <Card><SectionTitle title="Flashcards" subtitle={stats.total ? `${stats.total} cards · ${stats.due} due · ${stats.fresh} new · ${stats.learned} learned` : 'Spaced repetition (FSRS)'}
    action={<button className="ghost" disabled={!ready} onClick={() => setReviewing(dueCards(deck))}><Layers size={14} /> Review {ready || ''}</button>} />
    <form className="study-card-new" onSubmit={e => { e.preventDefault(); void add() }}>
      <select value={kind} onChange={e => setKind(e.target.value as typeof kind)} title="Kind of card">
        <option value="qa">Question</option><option value="both">Both ways</option><option value="cloze">Fill in the blank</option>
      </select>
      {kind === 'cloze'
        ? <><input ref={sentence} placeholder="A sentence; select words and press Hide" value={front} onChange={e => setFront(e.target.value)} />
          <button type="button" className="ghost" onClick={hide}>Hide</button></>
        : <><input placeholder={kind === 'both' ? 'Term' : 'Question'} value={front} onChange={e => setFront(e.target.value)} />
          <input placeholder={kind === 'both' ? 'Meaning' : 'Answer'} value={back} onChange={e => setBack(e.target.value)} /></>}
      <button className="ghost" disabled={!ok}>Add</button>
    </form>
    <p className="hint">Cards are lines in the note “{course} — flashcards”: “question :: answer”, “term ::: meaning” for both ways, or a sentence with {'{{c1::hidden words}}'}. Make them from a book selection, or ask Mimir to write some from a chapter.</p>
    {stats.total > 0 && <button className="ghost" onClick={() => setBrowsing(b => !b)}>{browsing ? 'Hide cards' : `Browse cards${leeches ? ` · ${leeches} to rewrite` : ''}`}</button>}
    {browsing && <CardList deck={deck} onStatus={onStatus} />}
    {stats.total > stats.fresh && <button className="ghost" onClick={() => setShowMastery(m => !m)}>{showMastery ? 'Hide what you know' : 'What you know, by chapter'}</button>}
    {showMastery && <MasteryList deck={deck} info={info} onStatus={onStatus} />}
    {reviewing && <Review cards={reviewing} onClose={() => setReviewing(null)} onStatus={onStatus} />}
  </Card>
}

/** Each chapter's cards and the chance of remembering them now, and tuning the schedule to the
 *  review log of both computers. */
function MasteryList({ deck, info, onStatus }: { deck: FlashCard[]; info?: { chapters?: unknown }; onStatus: (s: string) => void }) {
  const config = useConfig()
  const [tuning, setTuning] = useState(false)
  const rows = useMemo(() => masteryMap(deck, file => savedStarts(info ?? {}, file), card => retrievability(card)), [deck, info, config.study.fsrsWeights])
  async function tune() {
    setTuning(true)
    try {
      const tuned = await studyFsrsTune()
      setConfig(c => ({ ...c, study: { ...c.study, fsrsWeights: tuned.weights } }))
      onStatus(`Review times now fit your ${tuned.reviews} reviews of ${tuned.cards} cards.`)
    } catch (e) { onStatus(String(e)) } finally { setTuning(false) }
  }
  return <div className="study-mastery">
    {rows.map(r => <div key={r.label} className="study-mastery-row" title={`${r.learned} of ${r.cards} learned`}>
      <span className="grow">{r.label}</span>
      <span className="study-mastery-bar"><i style={{ width: `${Math.round(r.recall * 100)}%`, background: r.recall >= 0.85 ? '#4ade80' : r.recall >= 0.6 ? '#facc15' : '#f87171' }} /></span>
      <small>{Math.round(r.recall * 100)}% · {r.cards}</small>
    </div>)}
    <div className="study-mastery-tune">
      <button className="ghost" disabled={tuning || !isTauri()} onClick={() => void tune()}>{tuning ? 'Tuning…' : 'Tune review times to me'}</button>
      {config.study.fsrsWeights?.length ? <button className="ghost" onClick={() => setConfig(c => ({ ...c, study: { ...c.study, fsrsWeights: [] } }))}>Use the defaults</button> : null}
      <small className="hint">Fits the schedule to how you remember, from every review on both computers (needs about 400).</small>
    </div>
  </div>
}

/** Every card line of the course, to fix, put aside or remove; ones often forgotten first. */
function CardList({ deck, onStatus }: { deck: FlashCard[]; onStatus: (s: string) => void }) {
  const [query, setQuery] = useState('')
  const [onlyLeeches, setOnlyLeeches] = useState(false)
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null)
  // One row per line (a both-ways or cloze line has several cards).
  const lines = useMemo(() => {
    const byLine = new Map<string, { noteId: string; blockId: string; text: string; leech: boolean; lapses: number }>()
    for (const c of deck) {
      const key = `${c.noteId}/${c.block.id}`
      const row = byLine.get(key) ?? { noteId: c.noteId, blockId: c.block.id, text: c.block.text, leech: false, lapses: 0 }
      row.leech ||= isLeech(c)
      row.lapses = Math.max(row.lapses, c.card.lapses)
      byLine.set(key, row)
    }
    const q = query.trim().toLowerCase()
    return [...byLine.entries()].map(([key, row]) => ({ key, ...row }))
      .filter(r => (!onlyLeeches || r.leech) && (!q || cardBody(r.text).toLowerCase().includes(q)))
      .sort((a, b) => Number(b.leech) - Number(a.leech) || b.lapses - a.lapses)
  }, [deck, query, onlyLeeches])

  async function change(noteId: string, blockId: string, text: string | null) {
    try { await changeCardLine(noteId, blockId, text); setEditing(null) } catch (e) { onStatus(String(e)) }
  }

  return <div className="study-card-list">
    <div className="study-card-list-bar">
      <input placeholder="Find a card" value={query} onChange={e => setQuery(e.target.value)} />
      <label><input type="checkbox" checked={onlyLeeches} onChange={e => setOnlyLeeches(e.target.checked)} /> Often forgotten</label>
    </div>
    {lines.slice(0, 200).map(r => {
      const suspended = hasMark(r.text, 'suspended')
      return <div key={r.key} className={`study-card-row${suspended ? ' off' : ''}`}>
        {editing?.key === r.key
          ? <form className="grow" onSubmit={e => { e.preventDefault(); if (parseCards(editing.text).length) void change(r.noteId, r.blockId, withBody(r.text, editing.text)) }}>
            <input autoFocus value={editing.text} onChange={e => setEditing({ key: r.key, text: e.target.value })} onKeyDown={e => { if (e.key === 'Escape') setEditing(null) }} />
          </form>
          : <CardText className="grow" text={cardBody(r.text).replace(/\s#(suspended|leech)\b/g, '')} />}
        {r.leech && <span className="study-card-tag" title={`Forgotten ${r.lapses} times; rewriting it or splitting it up usually helps`}>often forgotten</span>}
        {suspended && <span className="study-card-tag">set aside</span>}
        {editing?.key === r.key
          ? <button className="ghost" disabled={!parseCards(editing.text).length} onClick={() => void change(r.noteId, r.blockId, withBody(r.text, editing.text))}>Save</button>
          : <button className="ghost" onClick={() => setEditing({ key: r.key, text: cardBody(r.text) })}>Edit</button>}
        <button className="ghost" title={suspended ? 'Review it again' : 'Leave it out of reviews'} onClick={() => void change(r.noteId, r.blockId, setMark(r.text, 'suspended', !suspended))}>{suspended ? 'Bring back' : 'Set aside'}</button>
        {r.leech && <button className="ghost" title="It stays, without the mark" onClick={() => void change(r.noteId, r.blockId, setMark(r.text, 'leech', false))}>Unmark</button>}
        <button className="ghost danger" onClick={() => { if (window.confirm('Delete this card?')) void change(r.noteId, r.blockId, null) }}>Delete</button>
      </div>
    })}
    {lines.length > 200 && <p className="hint">Showing 200 of {lines.length}. Search to narrow it down.</p>}
    {!lines.length && <p className="hint">No cards match.</p>}
  </div>
}

export function Review({ cards, onClose, onStatus }: { cards: FlashCard[]; onClose: () => void; onStatus: (s: string) => void }) {
  const [queue, setQueue] = useState(cards)
  const [shown, setShown] = useState(false)
  const [done, setDone] = useState(0)
  // When this card was put up, for the time spent on it in the review log.
  const shownAt = useRef(Date.now())
  useEffect(() => { shownAt.current = Date.now() }, [queue[0]])
  const card = queue[0]
  const times = useMemo(() => card ? intervals(card.card) : {}, [card])
  const source = card ? cardSource(card.back) ?? cardSource(card.front) : null

  async function answer(grade: (typeof GRADES)[number]['grade']) {
    if (!card) return
    const next = review(card.card, grade)
    try { await saveReview(card, next, grade, Date.now() - shownAt.current) } catch (e) { onStatus(String(e)) }
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
        <CardText className="study-review-front" text={card.front} />
        {shown ? <CardText className="study-review-back" text={card.back} /> : null}
        {shown && source && <button className="ghost study-review-source" title={source.label} onClick={() => openBookLink(source.href)}><BookOpen size={14} />Open p. {source.page}</button>}
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
