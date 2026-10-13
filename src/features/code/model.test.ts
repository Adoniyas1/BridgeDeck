import { describe, expect, it } from 'vitest'
import { errorLines, highlight, newLine, STARTERS } from './model'

describe('code tab', () => {
  it('finds the lines compiler and runtime messages point at', () => {
    expect(errorLines("main.c:4:12: error: use of undeclared identifier 'x'\nmain.c:9:1: warning: …", 'main.c')).toEqual([4, 9])
    expect(errorLines('Traceback (most recent call last):\n  File "/tmp/x/main.py", line 3, in <module>', 'main.py')).toEqual([3])
    expect(errorLines("error: 'y' undefined near line 5, column 5", 'main.m')).toEqual([5])
    expect(errorLines('Error in main (line 7)', 'main.m')).toEqual([7])
    expect(errorLines('error[E0425]: cannot find value `x`\n --> main.rs:2:13', 'main.rs')).toEqual([2])
    expect(errorLines('Hello.java:3: error: \';\' expected', 'Hello.java')).toEqual([3])
    expect(errorLines('main.sh: line 4: foo: command not found', 'main.sh')).toEqual([4])
    expect(errorLines('nothing here', 'main.c')).toEqual([])
  })

  it('highlights without changing the text', () => {
    for (const [lang, source] of Object.entries(STARTERS)) expect(highlight(source, lang).map(t => t.text).join('')).toBe(source)
    const c = highlight('#include <stdio.h>\nint x = 42; // the answer\nchar *s = "hi";', 'c')
    expect(c.find(t => t.kind === 'pre')?.text).toBe('#include')
    expect(c.find(t => t.kind === 'kw')?.text).toBe('int')
    expect(c.find(t => t.kind === 'num')?.text).toBe('42')
    expect(c.find(t => t.kind === 'com')?.text).toBe('// the answer')
    expect(c.find(t => t.kind === 'str')?.text).toBe('"hi"')
    // MATLAB: % comments, and ' after a name is a transpose, not a string.
    const m = highlight("y = x'; s = 'text'; % note", 'matlab')
    expect(m.filter(t => t.kind === 'str').map(t => t.text)).toEqual(["'text'"])
    expect(m.find(t => t.kind === 'com')?.text).toBe('% note')
    expect(highlight('x = 1  # comment', 'python').find(t => t.kind === 'com')?.text).toBe('# comment')
  })

  it('keeps the indent on a new line, one step more after an opening line', () => {
    expect(newLine('int main(void) {', 'c')).toBe('\n    ')
    expect(newLine('    x = 1;', 'c')).toBe('\n    ')
    expect(newLine('for i in range(3):', 'python')).toBe('\n    ')
    expect(newLine('for k = 1:10', 'matlab')).toBe('\n  ')
    expect(newLine('  disp(k)', 'matlab')).toBe('\n  ')
  })
})
