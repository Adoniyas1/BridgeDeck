# On-disk formats

Formats that sync between computers. Each has a version. A reader leaves alone anything it can't read and never rewrites it. A new format is written only after both computers run a build that can read it (see "Rules for every PR" in `plans/study-roadmap.md`).

## Study state, v1 (`src-tauri/src/study_state.rs`)

`<shared>/Study/.state/<key>/<instance id>.json`: each computer writes only its own file.

```json
{ "v": 1, "by": "<instance id>", "entries": { "<entry id>": { "at": 1761000000000, "val": <json> }, "<removed id>": { "at": 1761000000001, "del": true } } }
```

- **Reading:** take every `*.json` file in the key's folder, including Syncthing conflict copies. Skip files with a `v` above what you know. For each entry id, the largest `at` wins, and a tie goes to the larger `by`. A winning `del` means the entry is gone.
- **Writing:** stamp a change with `at = max(now, newest at seen for that id + 1)`.
- **Keys:**
  - `term`: entry `term` holds the semester's dates and breaks.
  - `problems`: one entry `<assignment>\u001f<problem>` per ticked problem, with value `true`.
  - `reading`: entry `<course>/<file>` holds `{ page | cfi, at }`, where a book was left. It's saved at most every 30 seconds and when the window is hidden or closed.
  - A new key is added by the change that first uses it.
- **Older builds:** the single files `Study/.term.json` and `Study/.problems.json` are still read. They count as computer `legacy`, with every entry dated by the file's modified time, and ids the file doesn't list count as removed. After every change they are rewritten with the merged state, dated by the newest change. Older builds keep working until both computers are updated.
- **Limits:** 4 MB per file, 64 KB per value, 20,000 entries.

## Note blocks (`src-tauri/src/bridgelink/notes.rs`)

- A block kind that isn't known (a short lowercase name) is kept as it is, and shown read-only.
- `ink` and `image` blocks hold an id. In Markdown they are written as `![Ink](bridgedeck-ink:<id>)` and `![Image](bridgedeck-image:<id>)`.
- `calc` blocks hold calculator lines as text (units, complex numbers, `name = …`). In Markdown they are a ```` ```calc ```` fence. Builds before 0.9.2 show them read-only.

## Course settings (`Study/<course>/.course.json`)

- One JSON object. `code`, `title`, `canvasId` and `canvasCode` are text. Other keys (`meetings`, `grading`, `collections`, and later ones) are kept as written.
- Changes are patches (`study_patch_course_info`): only the keys sent are replaced, on the file as it is when the change is saved.
- A Syncthing conflict copy is merged back when the course is read. Keys only one copy has are kept; for a key both changed, the newer file wins. The copy then goes to the Trash.

## Canvas copy (`Study/.canvas/<instance id>.json`)

- Written by each computer that's signed in to Canvas, after a refresh with no errors: `{ at, feed, api, courses, announcements }`, at most 3 MB.
- Readers take the file with the largest `at`. A computer that isn't signed in uses it, and so will the phone and Mimir.
- Done ticks for Canvas items: study state key `canvasDone`, entry `<assignment id>` = `true`. This computer's settings list (`canvas.done`) is still written for older builds and read once to fill in the state.

## Flashcard lines (`src/features/study/cards.ts`, `mimir_api.rs card_subs`)

- `front :: back` is one card; its state is `<!--fsrs due=… s=… …-->`, as in every build.
- `front ::: back` is two cards (`f`, `b`), and a line with `{{cN::answer}}` or `{{cN::answer::hint}}` is one card per N (`c1`, `c2`, …). Their state is `<!--fsrs b: due=… | f: due=…-->`, one group per card.
- Builds before 0.9.2 don't count the new kinds as cards and leave those lines alone.
- A back side `{{num:4.7k ohm ±2%}}` asks for a typed number (units, complex numbers; 1% when no tolerance is given).
- `![](bdimg:<course>/<file>)` on either side shows a picture from `Study/<course>/Cards/` (PNG, JPEG or WebP only).
- `#suspended` on a line leaves it out of reviews; `#leech` marks one forgotten 8 or more times.
- Examples both sides are tested with: `src/features/study/card-vectors.json`.

## Review log (`Study/.state/reviews/<instance>.jsonl`, `src-tauri/src/study_reviews.rs`)

- One JSON object per line: `{card, at, grade, ms}`. `card` is `note/block` or `note/block/sub`, `at` is ms, `grade` 1–4.
- Each computer only appends to its own file. Readers merge all files, skip lines they can't read, and count a `(card, at)` pair once.
- Tuned FSRS weights are saved per computer in `config.study.fsrsWeights`. Both computers fit them from the same log.

## Flashcard CSV (`src/features/study/deckio.ts`)

- The header is `kind,front,back,state`. `kind` is `qa`, `both` or `cloze` (a cloze sentence is in `front`). `state` is the line's `<!--fsrs …-->` comment, or empty.
- Import also takes two columns (term, definition; tab or comma) or one column of cloze sentences.

## Mimir inbox (study state `inbox`)

- Each entry is `{kind, course, payload, from: "mimir", at}`. `kind` is `cards` (`payload.lines`: card lines), `deadline` (`title`, `due` ms or null) or `exam` (`title`, `start` ms, optional `end`, `room`, `covers`, `allowed`).
- Study state `mistakes`: `m:<id>` → `{course, assignment, text, at}`, `p:<assignment id>` → `{course, assignment, predicted, at}`.
- Study state `ratings`: problem id → `{rating: "help"|"stuck", course, assignment, section, number, at}`.
- `syllabus` entries carry `weights` ([{name, weight}]), `people` ([{role, name, email, hours}]), `exams` ([{title, start, room?, covers?}]) and `aiPolicy`; accepting merges them into the course (nothing removed) after showing what changes.
- The Study tab adds an entry when the user accepts it, and removes it (null) when it's accepted or turned down. Builds that don't know a kind leave it alone.

## Lectures (`Study/<course>/Lectures/`, `src-tauri/src/study_lectures.rs`)

- Recordings are m4a, mp3, webm, ogg or wav. Each has a sidecar `<file>.json`: `{segments: [{start, end, text}], markers: [{t, note?}], photos: [{t, file}], started?, note?}`. Times are in seconds.
- Links in notes: `lecture:<course>/<file>#t=<seconds>`.
- Course settings: `recording` (true lets the class be recorded; off by default) and `words` (a list of words, or `heard => written` fixes).
