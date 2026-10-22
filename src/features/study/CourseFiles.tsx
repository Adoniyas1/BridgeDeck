import { useMemo, useState } from 'react'
import { BookOpen, ChevronDown, ChevronUp, Columns2, ExternalLink, Library, Pencil, Plus, Presentation, Trash2 } from 'lucide-react'
import { studyPatchCourseInfo, type StudyBook, type StudyCourse } from '../../lib/bridge'
import { newId } from '../notes/model'
import { fmtBytes } from './model'
import { refreshLibrary } from './state'
import { addCollection, groupFiles, MAX_TITLE, moveFile, readCollections, removeCollection, renameCollection, reorder, reorderCollection, type Collection } from './collections'

export const isSlides = (book: StudyBook) => ['pptx', 'ppt', 'key', 'odp'].includes(book.kind)

type Props = {
  course: StudyCourse
  books: StudyBook[]
  /** `beside`: on the right of a split screen. */
  onOpen: (book: StudyBook, beside?: boolean) => void
  onOpenExternally: (book: StudyBook) => void
  onRemove: (book: StudyBook) => void
  onStatus: (s: string) => void
}

/** A course's books and slides, grouped into collections (bigger books such as "Midterm 1") the
 *  user makes and orders; files in no collection are listed after them. */
export function CourseFiles({ course, books, onOpen, onOpenExternally, onRemove, onStatus }: Props) {
  const collections = useMemo(() => readCollections(course.info), [course.info])
  const { groups, loose } = useMemo(() => groupFiles(books, collections), [books, collections])
  const existing = useMemo(() => new Set(books.map(b => b.file)), [books])
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)

  async function save(next: Collection[]) {
    if (next === collections) return
    try {
      await studyPatchCourseInfo(course.name, { collections: next })
      await refreshLibrary()
    } catch (e) { onStatus(`Couldn’t save the collections: ${String(e)}`) }
  }

  function create() {
    const next = addCollection(collections, title, newId())
    setTitle('')
    setAdding(false)
    void save(next)
  }

  function remove(collection: Collection) {
    if (!window.confirm(`Remove the collection “${collection.title}”? Its files stay in ${course.name}.`)) return
    void save(removeCollection(collections, collection.id))
  }

  const card = (book: StudyBook, inCollection: Collection | null, position?: { first: boolean; last: boolean }) =>
    <div key={book.file} className="study-book">
      <button className={`study-book-cover${isSlides(book) ? ' slides' : ''}`} onClick={() => onOpen(book)}>{isSlides(book) ? <Presentation size={26} /> : <BookOpen size={26} />}<span>{book.kind.toUpperCase()}</span></button>
      <div className="grow">
        <strong title={book.file}>{book.title}</strong>
        <small>{fmtBytes(book.bytes)}</small>
        {collections.length > 0 && <select className="study-collection-pick" title="Put it in a collection" value={inCollection?.id ?? ''} onChange={e => void save(moveFile(collections, book.file, e.target.value || null))}>
          <option value="">Not in a collection</option>
          {collections.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>}
      </div>
      <div className="study-book-actions">
        <button className="ghost" title={isSlides(book) ? 'Read the slides here' : undefined} onClick={() => onOpen(book)}>Open</button>
        <div className="study-book-icons">
          <button className="cal-icon" title="Open beside what's showing (split screen)" onClick={() => onOpen(book, true)}><Columns2 size={14} /></button>
          {inCollection && position && <>
            <button className="cal-icon" title="Earlier in the collection" disabled={position.first} onClick={() => void save(reorder(collections, inCollection.id, book.file, -1, existing))}><ChevronUp size={14} /></button>
            <button className="cal-icon" title="Later in the collection" disabled={position.last} onClick={() => void save(reorder(collections, inCollection.id, book.file, 1, existing))}><ChevronDown size={14} /></button>
          </>}
          {isSlides(book) && <button className="cal-icon" title="Open in PowerPoint, Keynote or your presentation app" onClick={() => onOpenExternally(book)}><ExternalLink size={14} /></button>}
          <button className="cal-icon" title="Remove" onClick={() => onRemove(book)}><Trash2 size={14} /></button>
        </div>
      </div>
    </div>

  if (!books.length) return <p className="hint">No books yet. Add the course’s textbooks (PDF, EPUB) and lecture slides (PowerPoint, Keynote); they appear on your other computer too.</p>

  return <div className="study-files">
    <div className="study-files-head">
      {adding
        ? <form className="study-collection-form" onSubmit={e => { e.preventDefault(); create() }}>
          <input autoFocus maxLength={MAX_TITLE} placeholder="Collection name, e.g. Midterm 1 or Lab manual" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setAdding(false) }} />
          <button disabled={!title.trim()}>Add</button>
          <button type="button" className="ghost" onClick={() => setAdding(false)}>Cancel</button>
        </form>
        : <button className="ghost" title="Group this course’s files into a bigger book" onClick={() => setAdding(true)}><Plus size={14} /> New collection</button>}
    </div>

    {groups.map(({ collection, books: items }, index) => <section key={collection.id} className="study-collection">
      <div className="study-collection-head">
        <Library size={16} />
        {renaming?.id === collection.id
          ? <form className="study-collection-form" onSubmit={e => { e.preventDefault(); void save(renameCollection(collections, collection.id, renaming.title)); setRenaming(null) }}>
            <input autoFocus maxLength={MAX_TITLE} value={renaming.title} onChange={e => setRenaming({ id: collection.id, title: e.target.value })} onKeyDown={e => { if (e.key === 'Escape') setRenaming(null) }} />
            <button disabled={!renaming.title.trim()}>Save</button>
          </form>
          : <strong className="grow">{collection.title}</strong>}
        <small>{items.length} {items.length === 1 ? 'file' : 'files'}</small>
        <button className="cal-icon" title="Rename" onClick={() => setRenaming({ id: collection.id, title: collection.title })}><Pencil size={14} /></button>
        <button className="cal-icon" title="Move up" disabled={index === 0} onClick={() => void save(reorderCollection(collections, collection.id, -1))}><ChevronUp size={14} /></button>
        <button className="cal-icon" title="Move down" disabled={index === groups.length - 1} onClick={() => void save(reorderCollection(collections, collection.id, 1))}><ChevronDown size={14} /></button>
        <button className="cal-icon" title="Remove the collection (its files stay)" onClick={() => remove(collection)}><Trash2 size={14} /></button>
      </div>
      {items.length
        ? <div className="study-books">{items.map((b, i) => card(b, collection, { first: i === 0, last: i === items.length - 1 }))}</div>
        : <p className="hint">Empty. Choose “{collection.title}” in a file’s collection menu below to put it here.</p>}
    </section>)}

    {loose.length > 0 && <section className={groups.length ? 'study-collection loose' : undefined}>
      {groups.length > 0 && <div className="study-collection-head"><strong className="grow">Not in a collection</strong><small>{loose.length} {loose.length === 1 ? 'file' : 'files'}</small></div>}
      <div className="study-books">{loose.map(b => card(b, null))}</div>
    </section>}
  </div>
}
