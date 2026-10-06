import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { clock, ORT_VERSION, transcriptMarkdown } from './lecture'

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
})
