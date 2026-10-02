import { describe, expect, it } from 'vitest'
import { coursePrompt, passagePrompt, projectPrompt } from './chatgpt'

describe('ChatGPT starting points', () => {
  it('wraps a passage, a course and a project in a helpful request', () => {
    expect(passagePrompt('Calculus', 42, '  The chain\n rule ')).toContain('page 42 in plain words')
    expect(passagePrompt('Calculus', 42, '  The chain\n rule ')).toMatch(/"The chain rule"$/)
    expect(coursePrompt('Math 221', ['Calculus'])).toBe('I\'m taking Math 221 using "Calculus". Help me study: ask what I\'m working on, then explain it step by step and quiz me.')
    expect(projectPrompt('Robot', [{ title: 'To do', cards: ['Order motors'] }, { title: 'Doing', cards: [] }], ['Robot: Demo on Oct 16'])).toBe('I\'m working on a project called "Robot".\n\nMy task board:\n- To do: Order motors\n\nComing up: Robot: Demo on Oct 16.\n\nHelp me decide what to do next and break the next task into small steps.')
  })
})
