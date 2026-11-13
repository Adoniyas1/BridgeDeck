import { useState } from 'react'
import { HelpCircle, Mail, Plus, Trash2, Users } from 'lucide-react'
import { notesCreateMarkdown, openExternal, studyPatchCourseInfo, type StudyCourse } from '../../lib/bridge'
import { errorText } from '../../core/util'
import { notesStore, openNoteRequest } from '../notes/state'
import { activateTab } from '../../core/tabs'
import { courseFolder } from './model'
import { meetingsOf, meetingText } from './schedule'
import { refreshLibrary } from './state'

/** Someone to ask about a course: the professor, a TA… */
export type Person = { role: string; name: string; email: string; hours: string }

export function peopleOf(info: { people?: unknown }): Person[] {
  if (!Array.isArray(info.people)) return []
  const text = (v: unknown, n: number) => typeof v === 'string' ? v.trim().slice(0, n) : ''
  return info.people.flatMap((p): Person[] => {
    const person = { role: text(p?.role, 30), name: text(p?.name, 80), email: text(p?.email, 120), hours: text(p?.hours, 120) }
    return person.name || person.email ? [person] : []
  }).slice(0, 12)
}

/** A plain email address (nothing that could add headers to a mailto: link). */
export const validEmail = (email: string) => /^[^\s@<>,;:"\\]+@[^\s@<>,;:"\\]+\.[^\s@<>,;:"\\]+$/.test(email)

export const questionsTitle = (course: string) => `${course} — questions for office hours`

/** The people to ask about a course, their office hours and email, and a running list of questions
 *  to bring to office hours. */
export function CoursePeople({ course, onStatus }: { course: StudyCourse; onStatus: (s: string) => void }) {
  const people = peopleOf(course.info)
  const officeHours = meetingsOf(course.info).filter(m => /office/i.test(m.kind))
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<Person>({ role: 'Professor', name: '', email: '', hours: '' })
  async function save(list: Person[]) {
    try { await studyPatchCourseInfo(course.name, { people: list }); await refreshLibrary() } catch (e) { onStatus(errorText(e, 'Couldn’t save it')) }
  }
  function email(p: Person) {
    const subject = encodeURIComponent(`${course.info.code || course.name}: `)
    void openExternal(`mailto:${p.email}?subject=${subject}`).catch(e => onStatus(errorText(e, 'Couldn’t open the mail app')))
  }
  async function questions() {
    const title = questionsTitle(course.name)
    const folder = courseFolder(course.name)
    const found = notesStore.get().find(n => !n.deleted && n.title === title && n.folder.toLowerCase() === folder.toLowerCase())
    try {
      const note = found ?? await notesCreateMarkdown(title, folder, 'list', '- [ ] ')
      if (!found) notesStore.set(list => [note, ...list])
      openNoteRequest.set(note.id)
      activateTab('notes')
    } catch (e) { onStatus(errorText(e, 'Couldn’t open the questions')) }
  }
  return <div className="class-times course-people">
    <span className="meta-label"><Users size={13} />People</span>
    {people.map((p, i) => <span key={i} className="class-time" title={p.hours ? `Office hours: ${p.hours}` : undefined}>
      <b>{p.role || 'Contact'}</b> {p.name}{p.hours ? ` · ${p.hours}` : ''}
      {validEmail(p.email) && <button className="cal-icon" title={`Email ${p.email}`} onClick={() => email(p)}><Mail size={11} /></button>}
      <button className="cal-icon" title="Remove" onClick={() => void save(people.filter((_, j) => j !== i))}><Trash2 size={11} /></button>
    </span>)}
    {officeHours.map((m, i) => <span key={`oh${i}`} className="class-time"><b>Office hours</b> {meetingText(m)}</span>)}
    {!people.length && !officeHours.length && !adding && <span className="hint">None yet</span>}
    {!adding ? <button className="ghost" onClick={() => setAdding(true)}><Plus size={12} />Professor or TA</button>
      : <form className="class-time-add" onSubmit={e => { e.preventDefault(); if (!draft.name.trim() && !draft.email.trim()) return; if (draft.email.trim() && !validEmail(draft.email.trim())) { onStatus('That email address doesn’t look right.'); return } void save([...people, { ...draft, email: draft.email.trim() }]); setAdding(false); setDraft({ role: 'TA', name: '', email: '', hours: '' }) }}>
        <select value={draft.role} onChange={e => setDraft(d => ({ ...d, role: e.target.value }))}><option>Professor</option><option>TA</option><option>Lab TA</option><option>Tutor</option><option>Lab partner</option><option>Classmate</option></select>
        <input placeholder="Name" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
        <input placeholder="Email" type="email" value={draft.email} onChange={e => setDraft(d => ({ ...d, email: e.target.value }))} />
        <input placeholder="Office hours, e.g. Tu 2–4 ECS 515" value={draft.hours} onChange={e => setDraft(d => ({ ...d, hours: e.target.value }))} />
        <button>Add</button>
        <button type="button" className="ghost" onClick={() => setAdding(false)}>Cancel</button>
      </form>}
    <button className="ghost course-questions" title="A checklist of things to ask at office hours" onClick={() => void questions()}><HelpCircle size={12} />Questions to ask</button>
  </div>
}
