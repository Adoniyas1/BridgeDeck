/** The Code tab's pieces that aren't React: a starter program per language, the lines compiler
 *  messages point at, a small syntax highlighter and auto-indent. */

export const STARTERS: Record<string, string> = {
  c: `#include <stdio.h>

int main(void) {
    int n;
    printf("How many? ");
    if (scanf("%d", &n) != 1) n = 5;
    printf("\\n");
    for (int i = 1; i <= n; i++) {
        printf("%d squared is %d\\n", i, i * i);
    }
    return 0;
}
`,
  cpp: `#include <iostream>
#include <string>

int main() {
    std::string name;
    std::cout << "Your name? ";
    std::getline(std::cin, name);
    std::cout << "\\nHello, " << (name.empty() ? "world" : name) << "!" << std::endl;
    return 0;
}
`,
  python: `name = input("Your name? ")
print()
print(f"Hello, {name or 'world'}!")

for i in range(1, 6):
    print(i, "squared is", i * i)
`,
  matlab: `% A script. In Octave, input('') reads the Input box;
% MATLAB runs scripts in batch mode, so set values here instead.
x = linspace(0, 2*pi, 5);
y = sin(x);
disp('x and sin(x):')
disp([x; y]')

A = [2 1; 1 3];
b = [3; 5];
fprintf('Solution of A*v = b: v = [%g, %g]\\n', A \\ b);
`,
  java: `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        System.out.print("Your name? ");
        String name = in.hasNextLine() ? in.nextLine() : "";
        System.out.println();
        System.out.println("Hello, " + (name.isEmpty() ? "world" : name) + "!");
    }
}
`,
  javascript: `const input = require('fs').readFileSync(0, 'utf8').trim()
const name = input || 'world'
console.log(\`Hello, \${name}!\`)
`,
  rust: `use std::io::{self, BufRead};

fn main() {
    let mut name = String::new();
    io::stdin().lock().read_line(&mut name).ok();
    let name = name.trim();
    println!("Hello, {}!", if name.is_empty() { "world" } else { name });
}
`,
  go: `package main

import (
\t"bufio"
\t"fmt"
\t"os"
\t"strings"
)

func main() {
\tname, _ := bufio.NewReader(os.Stdin).ReadString('\\n')
\tname = strings.TrimSpace(name)
\tif name == "" {
\t\tname = "world"
\t}
\tfmt.Printf("Hello, %s!\\n", name)
}
`,
  verilog: `// A half adder and a testbench that tries every input.
module half_adder(input a, input b, output sum, output carry);
  assign sum = a ^ b;
  assign carry = a & b;
endmodule

module main;
  reg a, b;
  wire sum, carry;
  half_adder ha(a, b, sum, carry);
  initial begin
    $display("a b | sum carry");
    for (integer i = 0; i < 4; i = i + 1) begin
      {a, b} = i; #1;
      $display("%b %b |  %b    %b", a, b, sum, carry);
    end
  end
endmodule
`,
  bash: `read -r name
echo "Hello, \${name:-world}!"
for i in 1 2 3; do echo "line $i"; done
`,
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The lines (1-based) that compiler or runtime messages point at in the program's file. */
export function errorLines(output: string, file: string): number[] {
  const lines = new Set<number>()
  const f = escape(file)
  const patterns = [
    new RegExp(`${f}:(\\d+)`, 'g'), // gcc, clang, javac, rustc, go, iverilog, node
    new RegExp(`${f}", line (\\d+)`, 'g'), // Python
    new RegExp(`${f}: line (\\d+)`, 'g'), // bash
    /near line (\d+)/g, // Octave
    /\(line (\d+)\)/g, // MATLAB
    /^\s*main at line (\d+)/gm, // Octave, run through BridgeDeck's runner
  ]
  for (const re of patterns) for (const m of output.matchAll(re)) lines.add(Number(m[1]))
  return [...lines].filter(n => n > 0).sort((a, b) => a - b)
}

export type Token = { text: string; kind?: 'kw' | 'str' | 'com' | 'num' | 'pre' }

const KEYWORDS: Record<string, string[]> = {
  c: ['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'int', 'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', 'bool', 'true', 'false', 'NULL'],
  cpp: ['class', 'namespace', 'template', 'typename', 'public', 'private', 'protected', 'virtual', 'new', 'delete', 'this', 'using', 'auto', 'nullptr', 'std', 'string', 'vector', 'try', 'catch', 'throw', 'const', 'constexpr', 'override'],
  python: ['and', 'as', 'assert', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield', 'print', 'range', 'len', 'input'],
  matlab: ['break', 'case', 'catch', 'continue', 'else', 'elseif', 'end', 'for', 'function', 'global', 'if', 'otherwise', 'persistent', 'return', 'switch', 'try', 'while', 'disp', 'fprintf', 'zeros', 'ones', 'linspace', 'plot', 'pi', 'true', 'false'],
  java: ['abstract', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'continue', 'default', 'do', 'double', 'else', 'extends', 'final', 'finally', 'float', 'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'super', 'switch', 'this', 'throw', 'throws', 'try', 'void', 'while', 'true', 'false', 'String', 'var'],
  javascript: ['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'while', 'require', 'console'],
  rust: ['as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'trait', 'true', 'type', 'use', 'where', 'while', 'String', 'Vec', 'Option', 'Some', 'None', 'Ok', 'Err'],
  go: ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var', 'nil', 'true', 'false', 'string', 'int', 'error'],
  verilog: ['module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic', 'assign', 'always', 'initial', 'begin', 'end', 'if', 'else', 'case', 'endcase', 'for', 'integer', 'posedge', 'negedge', 'parameter', 'localparam', 'or', 'and', 'not'],
  bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'in', 'function', 'echo', 'read', 'local', 'return', 'export'],
}
KEYWORDS.cpp = [...KEYWORDS.c, ...KEYWORDS.cpp]

/** How each language writes comments and strings, as one pattern (comments first). */
function tokenPattern(lang: string): RegExp {
  const hash = lang === 'python' || lang === 'bash'
  const percent = lang === 'matlab'
  const comment = hash ? '#[^\\n]*' : percent ? '%\\{[\\s\\S]*?%\\}|%[^\\n]*' : '\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*'
  const triple = lang === 'python' ? `"""[\\s\\S]*?"""|'''[\\s\\S]*?'''|` : ''
  // MATLAB's ' is also "transpose" (after a name or a bracket), so its strings start only elsewhere.
  const single = percent ? `(?<![\\w)\\]}.'])'(?:[^'\\n]|'')*'` : `'(?:[^'\\\\\\n]|\\\\.)*'`
  const template = lang === 'javascript' ? '|`(?:[^`\\\\]|\\\\.)*`' : ''
  return new RegExp(`(${comment})|(${triple}"(?:[^"\\\\\\n]|\\\\.)*"|${single}${template})|(\\b\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b|\\b0x[0-9a-f]+\\b)|(\\b[A-Za-z_]\\w*\\b)|(^[ \\t]*#\\s*\\w+)`, 'gim')
}

/** The program split into coloured pieces (joined, they're the program exactly). */
export function highlight(source: string, lang: string): Token[] {
  const words = new Set(KEYWORDS[lang] ?? [])
  const out: Token[] = []
  let at = 0
  const push = (text: string, kind?: Token['kind']) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push(kind ? { text, kind } : { text })
  }
  for (const m of source.matchAll(tokenPattern(lang))) {
    push(source.slice(at, m.index))
    const [text, com, str, num, word, pre] = m
    if (pre && (lang === 'c' || lang === 'cpp')) push(text, 'pre')
    else if (pre) push(text, lang === 'python' || lang === 'bash' ? 'com' : undefined)
    else if (com) push(text, 'com')
    else if (str) push(text, 'str')
    else if (num) push(text, 'num')
    else if (word) push(text, words.has(word) ? 'kw' : undefined)
    else push(text)
    at = m.index! + text.length
  }
  push(source.slice(at))
  return out
}

/** What Enter inserts: a new line indented like this one, one step more after an opening line. */
export function newLine(before: string, lang: string): string {
  const line = before.slice(before.lastIndexOf('\n') + 1)
  const indent = /^[ \t]*/.exec(line)![0]
  const unit = lang === 'go' ? '\t' : lang === 'verilog' || lang === 'matlab' || lang === 'bash' ? '  ' : '    '
  const trimmed = line.trimEnd()
  const opens = /[{([]$/.test(trimmed)
    || (lang === 'python' && trimmed.endsWith(':'))
    || (lang === 'matlab' && /^\s*(if|for|while|function|switch|else|elseif|try|catch|case|otherwise)\b/.test(trimmed))
    || (lang === 'verilog' && /\bbegin$/.test(trimmed))
    || (lang === 'bash' && /\b(then|do)$/.test(trimmed))
  return `\n${indent}${opens ? unit : ''}`
}

export const indentUnit = (lang: string) => (lang === 'go' ? '\t' : lang === 'verilog' || lang === 'matlab' || lang === 'bash' ? '  ' : '    ')
