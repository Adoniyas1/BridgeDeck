import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Headphones, Layers, LifeBuoy, Sparkles, Target } from 'lucide-react'
import { isTauri, studyLectures, type LectureFile } from '../../lib/bridge'
import { useStore } from '../../core/store'
import { useConfig } from '../../core/config'
import { aiAllowed } from '../../core/exam'
import { Card, SectionTitle } from '../../ui'
import { notesStore } from '../notes/state'
import { askMimir } from '../mimir'
import { belongsTo } from './canvas'
import { cardChapter, deckOf, isLeech, masteryMap, type FlashCard } from './cards'
import { savedStarts } from './chapters'
import { retrievability } from './review'
import { stuckPrompt } from './problems'
import { openLecture } from './open'
import { loadMistakes, loadRatings, mistakesStore, ratingsStore } from './state'
import { Review } from './StudyTools'
import { weakSpots, weakSpotsPrompt, weakSpotText, type WeakSpot } from './weakSpots'

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
  return { spots, leeches, chapterCards }
}

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
  const { spots, leeches, chapterCards } = useWeakSpots(course, info)
  const [reviewing, setReviewing] = useState<FlashCard[] | null>(null)
  if (!spots.length && !leeches.length) return null
  return <Card><SectionTitle title="Study these next" subtitle="Where this course is going worst: flashcards, lectures, homework and graded work"
    action={aiAllowed(course) && spots.length ? <button className="ghost" title="Mimir finds each in your book and makes practice problems with checked answers" onClick={() => void askMimir(weakSpotsPrompt(course, spots), true, course)}><Sparkles size={14} />Practice these</button> : undefined} />
    <div className="weak-spots">
      {spots.map(s => <WeakSpotRow key={s.key} course={course} spot={s} chapterCards={chapterCards} onReview={setReviewing} />)}
      {leeches.length > 0 && <div className="weak-spot"><Layers size={13} /><span className="grow">{leeches.length} card{leeches.length === 1 ? '' : 's'} you keep forgetting (rewrite them in Browse cards if they stay hard)</span><button className="ghost" onClick={() => setReviewing(leeches)}><Layers size={12} />Review</button></div>}
    </div>
    {reviewing && <Review cards={reviewing} onClose={() => setReviewing(null)} onStatus={onStatus} />}
  </Card>
}
