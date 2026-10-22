import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { clock, correctWords, lectureNoteMarkdown, ORT_VERSION, transcriptMarkdown, wordFixes } from './lecture'
import { lectureLink, parseLectureLink } from './model'

describe('lecture transcripts', () => {
  it('formats times', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(247)).toBe('4:07')
    expect(clock(3909)).toBe('1:05:09')
  })

  it('groups about a minute per paragraph, each with its time', () => {
    const md = transcriptMarkdown([
      { start: 0, end: 5, text: 'Today we cover limits.' },
      { start: 30, end: 40, text: ' A limit is   where f heads.' },
      { start: 65, end: 70, text: 'Next, continuity.' },
    ], 'Recorded today')
    expect(md).toBe('Recorded today\n\n**[0:00]** Today we cover limits. A limit is where f heads.\n\n**[1:05]** Next, continuity.\n')
    expect(transcriptMarkdown([], 'x')).toContain('Nothing was heard')
  })

  it('downloads the speech engine Transformers.js was built with', () => {
    const transformers = JSON.parse(readFileSync('node_modules/@huggingface/transformers/package.json', 'utf8'))
    expect(transformers.dependencies['onnxruntime-web']).toBe(ORT_VERSION)
    expect(readFileSync('src-tauri/src/models.rs', 'utf8')).toContain(`pub const ORT_VERSION: &str = "${ORT_VERSION}";`)
  })

  it('writes the course\'s words its way', () => {
    const fixes = wordFixes(['Kirchhoff', 'kirk off => Kirchhoff', 'MOSFET', '', 3])
    const out = correctWords([{ start: 0, end: 3, text: 'By kirk off and kirchhoff, the mosfet... mosfets stay.' }], fixes)
    expect(out[0].text).toBe('By Kirchhoff and Kirchhoff, the MOSFET... mosfets stay.')
  })

  it('makes a dated note whose times play the recording', () => {
    const link = (t: number) => lectureLink('EE 310', 'Lecture 3.webm', t)
    expect(parseLectureLink(link(65))).toEqual({ course: 'EE 310', file: 'Lecture 3.webm', t: 65 })
    const md = lectureNoteMarkdown(new Date(2026, 9, 22, 10), '1:15:00', [{ start: 65, end: 70, text: 'Nodes.' }], link)
    expect(md).toContain('## Brain dump')
    expect(md).toContain('[1:05](lecture:EE%20310/Lecture%203.webm#t=65) Nodes.')
  })
})
