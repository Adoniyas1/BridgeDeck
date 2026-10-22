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

## Course settings (`Study/<course>/.course.json`)

- One JSON object. `code`, `title`, `canvasId` and `canvasCode` are text. Other keys (`meetings`, `grading`, `collections`, and later ones) are kept as written.
- Changes are patches (`study_patch_course_info`): only the keys sent are replaced, on the file as it is when the change is saved.
- A Syncthing conflict copy is merged back when the course is read. Keys only one copy has are kept; for a key both changed, the newer file wins. The copy then goes to the Trash.
