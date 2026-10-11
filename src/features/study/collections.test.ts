import { describe, expect, it } from 'vitest'
import type { CourseInfo, StudyBook } from '../../lib/bridge'
import { addCollection, groupFiles, moveFile, readCollections, removeCollection, renameCollection, reorder, reorderCollection, withCollections, type Collection } from './collections'

const book = (file: string, kind: StudyBook['kind'] = 'pdf'): StudyBook => ({ file, title: file.replace(/\.[^.]+$/, ''), kind, bytes: 1, indexed: false })
const info: CourseInfo = { code: 'EE 201', title: 'Circuits', canvasId: '', canvasCode: '' }

describe('study collections', () => {
  it('reads saved collections and ignores anything malformed', () => {
    const saved = withCollections(info, [{ id: 'a', title: 'Midterm 1', files: ['w1.pptx', 'ch1.pdf'] }])
    expect(readCollections(saved)).toEqual([{ id: 'a', title: 'Midterm 1', files: ['w1.pptx', 'ch1.pdf'] }])
    expect(readCollections(info)).toEqual([])
    const messy = { ...info, collections: [null, { id: 'b' }, { id: 'c', title: 'Labs', files: ['x.pdf', 3] }, 'nope'] } as unknown as CourseInfo
    expect(readCollections(messy)).toEqual([{ id: 'c', title: 'Labs', files: ['x.pdf'] }])
  })

  it('keeps a file in only the first collection that lists it', () => {
    const saved = { ...info, collections: [{ id: 'a', title: 'A', files: ['x.pdf'] }, { id: 'b', title: 'B', files: ['x.pdf', 'y.pdf'] }] } as unknown as CourseInfo
    expect(readCollections(saved).map(c => c.files)).toEqual([['x.pdf'], ['y.pdf']])
  })

  it('sorts files into their collections in order, the rest on their own', () => {
    const books = [book('ch1.pdf'), book('ch2.pdf'), book('w1.pptx', 'pptx'), book('notes.epub', 'epub')]
    const collections: Collection[] = [{ id: 'a', title: 'Midterm 1', files: ['w1.pptx', 'gone.pdf', 'ch1.pdf'] }]
    const { groups, loose } = groupFiles(books, collections)
    expect(groups[0]!.books.map(b => b.file)).toEqual(['w1.pptx', 'ch1.pdf'])
    expect(loose.map(b => b.file)).toEqual(['ch2.pdf', 'notes.epub'])
  })

  it('adds, renames and removes collections; removing one keeps its files', () => {
    let list = addCollection([], '  Midterm 1 ', 'a')
    expect(list).toEqual([{ id: 'a', title: 'Midterm 1', files: [] }])
    expect(addCollection(list, '   ', 'b')).toBe(list)
    list = moveFile(list, 'ch1.pdf', 'a')
    list = renameCollection(list, 'a', 'Exam 1')
    expect(list[0]).toEqual({ id: 'a', title: 'Exam 1', files: ['ch1.pdf'] })
    expect(renameCollection(list, 'a', '')).toBe(list)
    const { loose } = groupFiles([book('ch1.pdf')], removeCollection(list, 'a'))
    expect(loose.map(b => b.file)).toEqual(['ch1.pdf'])
  })

  it('moves a file between collections and out of all of them', () => {
    let list: Collection[] = [{ id: 'a', title: 'A', files: ['x.pdf', 'y.pdf'] }, { id: 'b', title: 'B', files: [] }]
    list = moveFile(list, 'x.pdf', 'b')
    expect(list.map(c => c.files)).toEqual([['y.pdf'], ['x.pdf']])
    list = moveFile(list, 'x.pdf', null)
    expect(list.map(c => c.files)).toEqual([['y.pdf'], []])
  })

  it('reorders files within a collection and collections in the list', () => {
    const existing = new Set(['x.pdf', 'y.pdf', 'z.pdf'])
    let list: Collection[] = [{ id: 'a', title: 'A', files: ['x.pdf', 'gone.pdf', 'y.pdf', 'z.pdf'] }, { id: 'b', title: 'B', files: [] }]
    list = reorder(list, 'a', 'z.pdf', -1, existing)
    expect(list[0]!.files).toEqual(['x.pdf', 'z.pdf', 'y.pdf'])
    expect(reorder(list, 'a', 'x.pdf', -1, existing)).toBe(list)
    expect(reorderCollection(list, 'b', -1).map(c => c.id)).toEqual(['b', 'a'])
    expect(reorderCollection(list, 'a', -1)).toBe(list)
  })
})
