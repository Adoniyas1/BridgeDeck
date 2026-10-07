import { useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, BookOpen, Link2, Map as MapIcon, CalendarPlus, FilePlus, FolderOpen, GraduationCap, ListChecks, MessageCircleQuestion, NotebookPen, Plus, Presentation, Trash2 } from 'lucide-react'
import { askChatGPT, coursePrompt } from '../../core/chatgpt'
import { calendarSave, notesCreateMarkdown, openPath, pickTransferPaths, studyAddBooks, studyAddCourse, studyArchiveCourse, studyDeleteCourse, studyRemoveBook, studySetCourseInfo, type CalEvent, type CourseInfo, type StudyBook, type StudyCourse } from '../../lib/bridge'
import { usePeriodicRefresh } from '../../core/refresh'
import { useStore } from '../../core/store'
import { activateTab } from '../../core/tabs'
import { Card, SectionTitle } from '../../ui'
import { eventsStore, refreshEvents } from '../calendar/state'
import { dateInput, formatRange, fromInputs } from '../calendar/model'
import { newId, noteTitle } from '../notes/model'
import { notesStore, openNoteRequest } from '../notes/state'
import { courseEvents, courseFolder, courseNotes, fmtBytes } from './model'
import { openBook } from './open'
import { libraryStore, refreshLibrary } from './state'
import { indexLibrary } from './indexer'
import { BookSearchCard, FlashcardsCard, FocusCard } from './StudyTools'
import { LectureCard } from './LectureCard'
import { AssignmentsCard, CanvasCard, ExamCard } from './AssignmentCards'
import { DegreePlan } from './DegreePlan'
import { canvasStore } from './canvasStore'
import { catalogTitle } from './plans'
import { courseKey } from './canvas'

export default function StudyPage({ active }: { active: boolean }) {
  const { library, error } = useStore(libraryStore)
  const [selected, setSelected] = useState<string | null>(null)
  const [newCourse, setNewCourse] = useState('')
  const [status, setStatus] = useState('')
  usePeriodicRefresh(async () => {
    if (!active) return
    await refreshLibrary()
    // Read the text of new books in the background, for search and Mimir.
    const current = libraryStore.get().library
    if (current) void indexLibrary(current, () => void refreshLibrary())
  }, 10_000, [active])
  const [showArchived, setShowArchived] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const all = library?.courses ?? []
  const courses = all.filter(c => !c.archived)
  const archived = all.filter(c => c.archived)
  const course = all.find(c => c.name === selected) ?? courses[0] ?? null
  useEffect(() => { if ((!selected || !all.some(c => c.name === selected)) && courses[0]) setSelected(courses[0].name) }, [selected, all])

  async function archive(name: string, on: boolean) {
    try { await studyArchiveCourse(name, on); await refreshLibrary(); if (on) setSelected(null) } catch (e) { setStatus(String(e)) }
  }

  async function remove(name: string) {
    if (!window.confirm(`Delete ${name}? Its folder (books, slides) goes to the Trash on this computer and is removed from your other computer. Its notes and calendar events stay. To keep it but hide it, archive it instead.`)) return
    try { await studyDeleteCourse(name); setSelected(null); await refreshLibrary() } catch (e) { setStatus(String(e)) }
  }

  async function addCourse() {
    const name = newCourse.trim()
    if (!name) return
    try {
      await studyAddCourse(name)
      setNewCourse('')
      await refreshLibrary()
      setSelected(libraryStore.get().library?.courses.find(c => c.name.toLowerCase().startsWith(name.toLowerCase().slice(0, 3)))?.name ?? null)
    } catch (e) { setStatus(String(e)) }
  }

  return <div className="study-layout">
    <aside className="card study-courses">
      <SectionTitle title="Courses" subtitle="Each has its books, notes, checklists and exams" />
      <div className="study-course-list">
        {courses.map(c => <button key={c.name} className={c.name === course?.name && !planOpen ? 'active' : ''} title={c.info.title || undefined} onClick={() => { setSelected(c.name); setPlanOpen(false) }}>
          <GraduationCap size={15} /><span>{c.name}{c.info.title && c.info.title !== c.name ? <small className="study-course-title">{c.info.title}</small> : null}</span><small>{c.books.length}</small>
        </button>)}
      </div>
      <button className={`ghost study-plan-toggle${planOpen ? ' active' : ''}`} onClick={() => setPlanOpen(v => !v)}><MapIcon size={13} />Degree plan</button>
      {archived.length > 0 && <button className="ghost study-archived-toggle" onClick={() => setShowArchived(v => !v)}><Archive size={13} />{showArchived ? 'Hide' : 'Show'} archived ({archived.length})</button>}
      {showArchived && <div className="study-course-list archived">
        {archived.map(c => <button key={c.name} className={c.name === course?.name && !planOpen ? 'active' : ''} onClick={() => { setSelected(c.name); setPlanOpen(false) }}>
          <Archive size={15} /><span>{c.name}</span><small>{c.books.length}</small>
        </button>)}
      </div>}
      <form className="study-new" onSubmit={e => { e.preventDefault(); void addCourse() }}>
        <input placeholder="New course, e.g. Math 221" value={newCourse} onChange={e => setNewCourse(e.target.value)} />
        <button className="cal-icon" title="Add course" disabled={!newCourse.trim()}><Plus size={16} /></button>
      </form>
      {library && <p className="hint">Books are kept in {library.root}, which Sync shares with your other computer.</p>}
      {error && <p className="cal-error">{error}</p>}
    </aside>
    {planOpen ? <div className="study-course"><DegreePlan courses={all} onOpen={name => { setSelected(name); setPlanOpen(false) }} /></div>
      : course ? <CourseView key={course.name} course={course} name={course.name} archived={course.archived} courses={courses.map(c => c.name)} books={course.books} root={library!.root} onStatus={setStatus} status={status}
        onArchive={on => void archive(course.name, on)} onDelete={() => void remove(course.name)} />
      : <div className="study-course"><Card className="study-empty"><GraduationCap size={28} /><h3>Add your first course</h3><p>Then add its textbooks (PDF), and BridgeDeck keeps them on both computers with your notes, chapter checklists and exam dates.</p></Card><AssignmentsCard courses={[]} /><CanvasCard /></div>}
  </div>
}

const SLIDES = /\.(pptx?|key|odp)$/i
const isSlides = (book: StudyBook) => book.kind !== 'pdf' && book.kind !== 'epub'

function CourseView({ course, name, archived, courses, books, root, status, onStatus, onArchive, onDelete }: { course: StudyCourse; name: string; archived: boolean; courses: string[]; books: StudyBook[]; root: string; status: string; onStatus: (s: string) => void; onArchive: (on: boolean) => void; onDelete: () => void }) {
  const notes = useStore(notesStore)
  const events = useStore(eventsStore)
  const mine = useMemo(() => courseNotes(notes, name), [notes, name])
  const upcoming = useMemo(() => courseEvents(events, name, Date.now(), course.info.code).slice(0, 8), [events, name, course.info.code])
  const [examTitle, setExamTitle] = useState('Exam')
  const [examDate, setExamDate] = useState(() => dateInput(Date.now() + 14 * 86_400_000))
  const [examTime, setExamTime] = useState('09:00')

  async function addBooks() {
    const paths = (await pickTransferPaths(false)).filter(p => /\.(pdf|epub)$/i.test(p) || SLIDES.test(p))
    if (!paths.length) { onStatus('Choose PDF or EPUB books, or presentations (PowerPoint, Keynote).'); return }
    try {
      const added = await studyAddBooks(name, paths)
      onStatus(`Added ${added.length} file${added.length === 1 ? '' : 's'}.`)
      await refreshLibrary()
    } catch (e) { onStatus(String(e)) }
  }

  async function removeBook(file: string, title: string) {
    if (!window.confirm(`Remove “${title}” from ${name}? It’s removed from your other computer too. Your notes stay.`)) return
    try { await studyRemoveBook(name, file); await refreshLibrary() } catch (e) { onStatus(String(e)) }
  }

  async function newNote() {
    try {
      const note = await notesCreateMarkdown(`${name} notes`, courseFolder(name), 'note', '')
      notesStore.set(list => [note, ...list])
      openNoteRequest.set(note.id)
      activateTab('notes')
    } catch (e) { onStatus(String(e)) }
  }

  async function addExam() {
    const start = fromInputs(examDate, examTime)
    const event: CalEvent = { id: newId(), title: `${name}: ${examTitle.trim() || 'Exam'}`, start, end: start + 2 * 3_600_000, allDay: false, location: '', notes: '', color: 'red', repeat: null, skip: [], reminder: 1440, updated: 0, by: '', deleted: false, seq: 0 }
    try {
      const saved = await calendarSave(event)
      eventsStore.set(list => [...list, saved])
      void refreshEvents()
      onStatus(`Added ${event.title} on ${new Date(start).toLocaleDateString()} with a reminder the day before.`)
    } catch (e) { onStatus(String(e)) }
  }

  const readable = books.filter(b => !isSlides(b))
  const slides = books.filter(isSlides)
  const open = (book: StudyBook) => isSlides(book) ? void openPath(`${root}/${name}/${book.file}`).catch(e => onStatus(String(e))) : openBook(name, book.file, book.title)
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  return <div className="study-course">
    {archived && <div className="notice"><Archive size={15} /><span>{name} is archived: it’s hidden from your courses, and its files are kept.</span><button className="ghost" onClick={() => onArchive(false)}>Unarchive</button></div>}
    <Card><SectionTitle title={course.info.title && course.info.title !== name ? `${name} · ${course.info.title}` : name} subtitle={[count(readable.length, 'book'), ...(slides.length ? [count(slides.length, 'presentation')] : []), count(mine.length, 'note')].join(' · ')}
      action={<div className="actions"><button onClick={() => void addBooks()} title="PDF or EPUB books, and PowerPoint or Keynote presentations"><Plus size={15} />Add books or slides</button><button className="secondary" onClick={() => void openPath(`${root}/${name}`)}><FolderOpen size={15} />Folder</button><button className="secondary" title="Open ChatGPT ready to help with this course" onClick={() => void askChatGPT(coursePrompt(name, books.map(b => b.title)), courseFolder(name)).catch(e => onStatus(String(e)))}><MessageCircleQuestion size={15} />ChatGPT</button>
        {archived ? <button className="secondary" title="Back into your courses" onClick={() => onArchive(false)}><ArchiveRestore size={15} /></button>
          : <button className="secondary" title="Archive: hide it from your courses, keep its files" onClick={() => onArchive(true)}><Archive size={15} /></button>}
        <button className="secondary" title="Delete the course" onClick={onDelete}><Trash2 size={15} /></button></div>} />
      {status && <p className="book-status">{status}</p>}
      <CourseDetails course={course} onStatus={onStatus} />
      {books.length ? <div className="study-books">{books.map(book => <div key={book.file} className="study-book">
        <button className={`study-book-cover${isSlides(book) ? ' slides' : ''}`} onClick={() => open(book)}>{isSlides(book) ? <Presentation size={26} /> : <BookOpen size={26} />}<span>{book.kind.toUpperCase()}</span></button>
        <div className="grow"><strong title={book.file}>{book.title}</strong><small>{fmtBytes(book.bytes)}</small></div>
        <div className="study-book-actions">
          <button className="ghost" title={isSlides(book) ? 'Opens in PowerPoint, Keynote or your presentation app' : undefined} onClick={() => open(book)}>Open</button>
          <button className="cal-icon" title="Remove" onClick={() => void removeBook(book.file, book.title)}><Trash2 size={14} /></button>
        </div>
      </div>)}</div> : <p className="hint">No books yet. Add the course’s textbooks (PDF, EPUB) and lecture slides (PowerPoint, Keynote); they appear on your other computer too.</p>}
    </Card>
    <AssignmentsCard course={name} info={course.info} courses={courses} />
    <div className="study-tools">
      <FocusCard course={name} />
      <FlashcardsCard course={name} onStatus={onStatus} />
      <ExamCard course={name} />
    </div>
    <CanvasCard />
    <LectureCard course={name} />
    <BookSearchCard course={name} books={books} />
    <div className="two-col">
      <Card><SectionTitle title="Notes and checklists" subtitle={`In Notes, folder ${courseFolder(name)}`} action={<button className="ghost" onClick={() => void newNote()}><FilePlus size={14} /> New note</button>} />
        {mine.length ? <div className="study-notes">{mine.map(({ note, done, total }) => <button key={note.id} onClick={() => { openNoteRequest.set(note.id); activateTab('notes') }}>
          {total ? <ListChecks size={14} /> : <NotebookPen size={14} />}<span className="grow">{noteTitle(note)}</span>
          {total > 0 && <span className="study-progress"><i style={{ width: `${(done / total) * 100}%` }} /></span>}
          {total > 0 && <small>{done}/{total}</small>}
        </button>)}</div> : <p className="hint">Open a book and use “Chapter checklist” to track chapters, or “Save highlight” to keep passages.</p>}
      </Card>
      <Card><SectionTitle title="Exams and deadlines" subtitle="From your calendar (events with the course name)" />
        {upcoming.length ? <div className="agenda-list">{upcoming.map(e => <button key={e.id} className="agenda-row" onClick={() => activateTab('calendar')}>
          <i style={{ background: '#f07178' }} /><span className="agenda-time">{new Date(e.start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} {formatRange(e)}</span><span className="grow agenda-title">{e.title}</span></button>)}</div>
          : <p className="hint">Nothing coming up.</p>}
        <form className="study-exam" onSubmit={e => { e.preventDefault(); void addExam() }}>
          <input value={examTitle} onChange={e => setExamTitle(e.target.value)} placeholder="Exam, quiz, essay due…" />
          <input type="date" value={examDate} onChange={e => setExamDate(e.target.value)} />
          <input type="time" value={examTime} onChange={e => setExamTime(e.target.value)} />
          <button className="ghost"><CalendarPlus size={14} /> Add</button>
        </form>
      </Card>
    </div>
  </div>
}

/** The course's catalog code and title, and which Canvas course is it: Canvas assignments, the
 *  calendar and the degree plan find the course by these, whatever its folder is called. */
function CourseDetails({ course, onStatus }: { course: StudyCourse; onStatus: (s: string) => void }) {
  const canvas = useStore(canvasStore)
  const [code, setCode] = useState(course.info.code)
  const [title, setTitle] = useState(course.info.title)
  useEffect(() => { setCode(course.info.code); setTitle(course.info.title) }, [course.info.code, course.info.title])
  async function save(patch: Partial<CourseInfo>) {
    const next = { ...course.info, ...patch }
    if (patch.code !== undefined && next.code && !next.title) next.title = catalogTitle(courseKey(next.code) ?? next.code)
    try { await studySetCourseInfo(course.name, next); await refreshLibrary() } catch (e) { onStatus(String(e)) }
  }
  const linked = canvas.courses.find(c => c.id === course.info.canvasId)
  return <div className="course-details">
    <label>Code<input value={code} placeholder="MATH 224" onChange={e => setCode(e.target.value)} onBlur={() => code !== course.info.code && void save({ code: courseKey(code) ?? code.trim() })} /></label>
    <label>Title<input value={title} placeholder="Calculus 3" onChange={e => setTitle(e.target.value)} onBlur={() => title !== course.info.title && void save({ title: title.trim() })} /></label>
    <label><span><Link2 size={11} /> Canvas course</span><select value={course.info.canvasId} onChange={e => { const c = canvas.courses.find(x => x.id === e.target.value); void save({ canvasId: c?.id ?? '', canvasCode: c?.code ?? '', ...(c && !course.info.code ? { code: courseKey(c.code) ?? '' } : {}) }) }}>
      <option value="">{canvas.courses.length ? 'Not linked' : 'Connect Canvas in Settings → Study'}</option>
      {canvas.courses.map(c => <option key={c.id} value={c.id}>{c.code}{c.name && c.name !== c.code ? ` · ${c.name}` : ''}</option>)}
      {course.info.canvasId && !linked && <option value={course.info.canvasId}>{course.info.canvasCode || 'Linked course'}</option>}
    </select></label>
  </div>
}
