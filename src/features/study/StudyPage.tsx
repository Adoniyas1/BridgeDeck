import { useEffect, useMemo, useState } from 'react'
import { BookOpen, CalendarPlus, FilePlus, FolderOpen, GraduationCap, ListChecks, NotebookPen, Plus, Trash2 } from 'lucide-react'
import { calendarSave, notesCreateMarkdown, openPath, pickTransferPaths, studyAddBooks, studyAddCourse, studyRemoveBook, type CalEvent } from '../../lib/bridge'
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
  const courses = library?.courses ?? []
  const course = courses.find(c => c.name === selected) ?? courses[0] ?? null
  useEffect(() => { if (!selected && courses[0]) setSelected(courses[0].name) }, [selected, courses])

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
        {courses.map(c => <button key={c.name} className={c.name === course?.name ? 'active' : ''} onClick={() => setSelected(c.name)}>
          <GraduationCap size={15} /><span>{c.name}</span><small>{c.books.length}</small>
        </button>)}
      </div>
      <form className="study-new" onSubmit={e => { e.preventDefault(); void addCourse() }}>
        <input placeholder="New course, e.g. Math 221" value={newCourse} onChange={e => setNewCourse(e.target.value)} />
        <button className="cal-icon" title="Add course" disabled={!newCourse.trim()}><Plus size={16} /></button>
      </form>
      {library && <p className="hint">Books are kept in {library.root}, which Sync shares with your other computer.</p>}
      {error && <p className="cal-error">{error}</p>}
    </aside>
    {course ? <CourseView key={course.name} name={course.name} books={course.books} root={library!.root} onStatus={setStatus} status={status} />
      : <Card className="study-empty"><GraduationCap size={28} /><h3>Add your first course</h3><p>Then add its textbooks (PDF), and BridgeDeck keeps them on both computers with your notes, chapter checklists and exam dates.</p></Card>}
  </div>
}

function CourseView({ name, books, root, status, onStatus }: { name: string; books: import('../../lib/bridge').StudyBook[]; root: string; status: string; onStatus: (s: string) => void }) {
  const notes = useStore(notesStore)
  const events = useStore(eventsStore)
  const mine = useMemo(() => courseNotes(notes, name), [notes, name])
  const upcoming = useMemo(() => courseEvents(events, name).slice(0, 8), [events, name])
  const [examTitle, setExamTitle] = useState('Exam')
  const [examDate, setExamDate] = useState(() => dateInput(Date.now() + 14 * 86_400_000))
  const [examTime, setExamTime] = useState('09:00')

  async function addBooks() {
    const paths = (await pickTransferPaths(false)).filter(p => /\.(pdf|epub)$/i.test(p))
    if (!paths.length) { onStatus('Choose PDF or EPUB files.'); return }
    try {
      const added = await studyAddBooks(name, paths)
      onStatus(`Added ${added.length} book${added.length === 1 ? '' : 's'}.`)
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

  return <div className="study-course">
    <Card><SectionTitle title={name} subtitle={`${books.length} book${books.length === 1 ? '' : 's'} · ${mine.length} note${mine.length === 1 ? '' : 's'}`}
      action={<div className="actions"><button onClick={() => void addBooks()}><Plus size={15} />Add books</button><button className="secondary" onClick={() => void openPath(`${root}/${name}`)}><FolderOpen size={15} />Folder</button></div>} />
      {status && <p className="book-status">{status}</p>}
      {books.length ? <div className="study-books">{books.map(book => <div key={book.file} className="study-book">
        <button className="study-book-cover" onClick={() => openBook(name, book.file, book.title)}><BookOpen size={26} /><span>{book.kind.toUpperCase()}</span></button>
        <div className="grow"><strong title={book.file}>{book.title}</strong><small>{fmtBytes(book.bytes)}</small></div>
        <div className="study-book-actions">
          <button className="ghost" onClick={() => openBook(name, book.file, book.title)}>Open</button>
          <button className="cal-icon" title="Remove" onClick={() => void removeBook(book.file, book.title)}><Trash2 size={14} /></button>
        </div>
      </div>)}</div> : <p className="hint">No books yet. Add the course’s textbooks as PDFs; they appear on your other computer too.</p>}
    </Card>
    <div className="study-tools">
      <FocusCard course={name} />
      <FlashcardsCard course={name} onStatus={onStatus} />
    </div>
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
