import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Headphones, Layers, LifeBuoy, Package, Sparkles, Target } from 'lucide-react'
import { isTauri, notesCreateMarkdown, studyLectures, type LectureFile } from '../../lib/bridge'
import { activateTab } from '../../core/tabs'
import { useStore } from '../../core/store'
import { useConfig } from '../../core/config'
import { aiAllowed } from '../../core/exam'
import { Card, SectionTitle } from '../../ui'
import { notesStore, openNoteRequest } from '../notes/state'
import { askMimir } from '../mimir'
import { belongsTo } from './canvas'
import { cardChapter, cardSource, deckOf, isLeech, masteryMap, type FlashCard } from './cards'
import { savedStarts } from './chapters'
import { retrievability } from './review'
import { stuckPrompt } from './problems'
import { openLecture } from './open'
import { useExams } from './assignments'
import { courseFolder } from './model'
import { loadMistakes, loadRatings, mistakesStore, ratingsStore } from './state'
import { Review } from './StudyTools'
import { examPackMarkdown, forExam, weakSpots, weakSpotsPrompt, weakSpotText, type WeakSpot } from './weakSpots'

type Info = { code: string; canvasCode: string; chapters?: unknown }

/** The course's weak spots (study/weakSpots.ts) with the cards behind each chapter and the
 *  ones you keep forgetting; shared by "Study these next" and the pre-exam pack. */
export function useWeakSpots(course: string, info: Info) {
  const notes = useStore(notesStore)
  const ratings = useStore(ratingsStore)
  const { mistakes } = useStore(mistakesStore)
  const config = useConfig()
  const [lectures, setLectures] = useState<LectureFile[]>([])
  useEffect(() => { void loadRatings(); void loadMistakes() }, [])
  useEffect(() => { if (isTauri()) void studyLectures(course).then(setLectures).catch(() => undefined) }, [course])
  const mine = (c: string) => c === course || belongsTo({ name: course, code: info.code, canvasCode: info.canvasCode }, c)
  const deck = useMemo(() => deckOf(notes, course), [notes, course])
  const starts = (file: string) => savedStarts(info, file)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const mastery = useMemo(() => masteryMap(deck, starts, card => retrievability(card)), [deck, info, config.study.fsrsWeights])
  const spots = useMemo(() => weakSpots({ mastery, lectures, ratings: ratings.filter(r => mine(r.course)), mistakes: mistakes.filter(m => mine(m.course)) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mastery, lectures, ratings, mistakes, course, info.code, info.canvasCode])
  const leeches = useMemo(() => deck.filter(isLeech), [deck])
  /** A chapter's cards, to review now. */
  const chapterCards = (label: string) => deck.filter(c => cardChapter(c, starts).label === label)
  /** The book page where a chapter's cards start, to open from the pack. */
  const chapterLink = (label: string) => {
    const sources = chapterCards(label).map(c => cardSource(c.back) ?? cardSource(c.front)).filter(s => s !== null)
    const first = sources.sort((a, b) => a.page - b.page)[0]
    return first?.href ?? null
  }
  return { spots, leeches, chapterCards, chapterLink }
}

/** Within this long of an exam, the list is scoped to what it covers and offers the pack. */
const EXAM_SOON = 7 * 86_400_000

const ICON = { chapter: BookOpen, lecture: Headphones, problem: LifeBuoy, mistake: Target }

/** One weak spot with what to do about it: review the chapter's cards, replay the lecture, or get
 *  unstuck with Mimir. */
export function WeakSpotRow({ course, spot, chapterCards, onReview }: { course: string; spot: WeakSpot; chapterCards: (label: string) => FlashCard[]; onReview: (cards: FlashCard[]) => void }) {
  const Icon = ICON[spot.kind]
  return <div className="weak-spot">
    <Icon size={13} />
    <span className="grow">{weakSpotText(spot)}</span>
    {spot.kind === 'chapter' && <button className="ghost" onClick={() => onReview(chapterCards(spot.label))}><Layers size={12} />Review</button>}
    {spot.kind === 'lecture' && <button className="ghost" title="Play the lecture from a little before" onClick={() => openLecture(course, spot.file, Math.max(0, spot.t - 20))}><Headphones size={12} />Replay</button>}
    {spot.kind === 'problem' && aiAllowed(course) && <button className="ghost" title="Worked examples from your book and a twin problem with checked numbers" onClick={() => void askMimir(stuckPrompt(course, spot.assignment, spot.section, spot.number), true, course)}><LifeBuoy size={12} />Stuck?</button>}
  </div>
}

/** "Study these next": the weakest chapters, lecture moments you got lost in, problems you got
 *  stuck on and recent mistakes, in one list, with practice aimed at them from Mimir. */
export function WeakSpotsCard({ course, info, onStatus }: { course: string; info: Info; onStatus: (s: string) => void }) {
  const { spots: all, leeches, chapterCards, chapterLink } = useWeakSpots(course, info)
  const exams = useExams()
  const notes = useStore(notesStore)
  const [reviewing, setReviewing] = useState<FlashCard[] | null>(null)
  const now = Date.now()
  const exam = exams.find(e => e.course === course && e.start > now && e.start - now < EXAM_SOON)
  const spots = exam ? forExam(all, exam.covers) : all
  if (!spots.length && !leeches.length && !exam) return null
  const packTitle = exam ? `${course} — pack: ${exam.title}` : ''

  /** The pre-exam pack: a checklist note in the course folder (opened again if already made, so
   *  its ticks are kept). */
  async function pack() {
    if (!exam) return
    const existing = notes.find(n => !n.deleted && n.title === packTitle)
    try {
      const note = existing ?? await notesCreateMarkdown(packTitle, courseFolder(course), 'list', examPackMarkdown(course, exam, spots, chapterLink, leeches.length))
      if (!existing) notesStore.set(list => [note, ...list])
      openNoteRequest.set(note.id)
      activateTab('notes')
    } catch (e) { onStatus(String(e)) }
  }

  const days = exam ? Math.max(0, Math.ceil((exam.start - now) / 86_400_000)) : 0
  return <Card><SectionTitle title={exam ? `Before ${exam.title}: study these` : 'Study these next'}
    subtitle={exam ? `${days <= 1 ? 'Tomorrow' : `In ${days} days`}${exam.covers ? ` · the weak spots in ${exam.covers}` : ''}` : 'Where this course is going worst: flashcards, lectures, homework and graded work'}
    action={<div className="actions">
      {exam && <button className="ghost" disabled={!isTauri()} title="One checklist note: these weak spots linked to the book and lecture, the practice exam, the formula sheet and what to bring" onClick={() => void pack()}><Package size={14} />{notes.some(n => !n.deleted && n.title === packTitle) ? 'Open the pack' : 'Pre-exam pack'}</button>}
      {aiAllowed(course) && spots.length > 0 && <button className="ghost" title="Mimir finds each in your book and makes practice problems with checked answers" onClick={() => void askMimir(weakSpotsPrompt(course, spots, exam?.title), true, course)}><Sparkles size={14} />Practice these</button>}
    </div>} />
    <div className="weak-spots">
      {spots.map(s => <WeakSpotRow key={s.key} course={course} spot={s} chapterCards={chapterCards} onReview={setReviewing} />)}
      {leeches.length > 0 && <div className="weak-spot"><Layers size={13} /><span className="grow">{leeches.length} card{leeches.length === 1 ? '' : 's'} you keep forgetting (rewrite them in Browse cards if they stay hard)</span><button className="ghost" onClick={() => setReviewing(leeches)}><Layers size={12} />Review</button></div>}
      {!spots.length && !leeches.length && <p className="hint">Nothing marked weak yet: review flashcards, mark “Lost here” in lectures and rate hard problems, and they show up here.</p>}
    </div>
    {reviewing && <Review cards={reviewing} onClose={() => setReviewing(null)} onStatus={onStatus} />}
  </Card>
}
