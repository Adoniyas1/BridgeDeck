# Study roadmap

The plan for the 50 Study improvements and four new features. One checkbox is one PR; tick it when it merges.

New features: **B1** book folders (open at last page, chapter list, split long books, download), **B2** stitch PDFs, **B3** pen / Apple Pencil notes, **B4** paper notes → typed PDF.

Sizes: S ≈ a day, M ≈ a few days, L ≈ a week or more.

## Rules for every PR

- **Readers before writers.** A change to a synced format (study state, note block kinds, card lines, ink logs, `.book.json`) ships first as a build that can *read* the new format and leaves unknown data alone. Data in the new format is written only after both computers run that build.
- **Safety net first.** Backups and Syncthing versioning for Study (1.0) land before any change to how Study data is stored.
- Every on-disk format has a `v` field and is described in `docs/formats.md`. Shared test vectors are checked by both `vitest` and `cargo test`.

## Changes from the review

The plan was checked against the code by two reviewers. Their corrections are applied below:

- **1.0 (new): versioning and backups for Study come first.** Syncthing staggered versioning, and backups carrying `.course.json`, `.term.json`, `.problems.json` and `.degree-plan.json`. `Export semester` stays in 1.5.
- **1.4 (unknown block kinds) is the first format change merged**, and a BridgeLink version handshake gates writing ink, image or v2 card data.
- **1.1 is split.** 1.1a adds the Rust store, its merge rules and tests, with no callers. 1.1b moves term and problems onto it. It extends the existing `study_state_read`/`study_state_write` and keeps reading the legacy files on every read until both computers have migrated. Each other key is added in the PR that first uses it.
- **1.2:** settings that change often (cancelled classes, exams, office hours, word list) go in the per-device state store, so two computers can't conflict. `.course.json` keeps only settings that rarely change.
- **1.3 is M:** `serve()` already handles Range; it stops reading the whole file, handles open-ended and suffix ranges, and falls back to loading bytes.
- **A vision-model spike runs in Phase 2.** It reports go/no-go before 5.5, 5.6 and 8.9. Scanning (8.8) no longer depends on 5.5.
- **HEIC:** the phone page converts photos to JPEG in Safari in 2.3. The desktop conversion stays in 8.8.
- **8.2 keeps the original book by default**, hidden in the manifest. Highlights, index entries and `book:` links are moved in the same PR.
- **Exam mode applies on both computers.** Site blocks are a set of reasons (exam, focus), so ending a focus session can't lift an exam block. Every `askChatGPT` and `askMimir` call goes through one `isAiAllowed(course)` check.
- **Card grammar v2 is split.** First a v1 test-vector file. Then 4.3a, readers only (both parsers understand v2 and never rewrite state they can't parse). Then 4.3b, writers. Cloze from transcripts moves to 6.5.
- **4.6 uses `fsrs-browser` (WASM) or the `fsrs` crate, not the Node binding.** It is split into the log, the optimizer and the mastery map.
- **4.9:** CSV, TSV and Quizlet export, plus `.apkg` import, first. `.apkg` export comes later and needs zstd.
- **9.1 is L, split into three:** analog parts and schematic, netlist plus a Rust ngspice runner, and an analysis panel. Logic has no analog model today.
- **8.5, 8.9 and 3.3/3.4 are split** into PRs that can be reviewed on their own.
- **9.6:** files go to a classmate through LocalSend or Show in folder. A `mailto:` link can't attach files.
- **9.7:** the phone sends only grades, and the desktop applies FSRS when it syncs. New `/api/cards` and `/api/review` endpoints.
- **6.3:** phone uploads carry `purpose`, `course` and `takenAt`.
- **3.4:** the Exam type gets `chapters` and `allowed`. 7.5 depends on 4.6.
- **2.4:** the reading position is saved on close, on blur, or at most every 30 seconds, and is left out of versioning.
- **6.x:** recording is **off** by default and needs a per-course opt-in, because California requires everyone's consent to record. Whisper is benchmarked on the Mac before 6.4.
- **9.5** reuses `code.rs`'s Octave and MATLAB lookup (S).

## Phase 1: Foundations for safe, synced data

Make study data merge cleanly between the PC and the Mac, make it impossible to lose, and fix the big-file serving and unknown-block problems before any new feature builds on them. The user should notice ticks and term data matching on both computers, and backups that now include Study.

- [x] **1.0 Safety net: Study files in daily backups and exports, and Syncthing keeps old versions** (S). Items: 40 (part 1). Needs: none.
  - backups.rs: the daily backup, export and restore carry Study's small state files (`.course.json`, `.term.json`, `.problems.json`, `.degree-plan.json`). syncthing_bridge.rs: staggered versioning (30 days) on the shared folder, for new folders and for existing ones that have none.
- [x] **1.1a Study state store (Rust, merge rules, tests, no callers)** (M). Format in `docs/formats.md`.
- [x] **1.1b Term and ticked problems use the state store; old files still read and kept up to date** (M).
- [x] **1.1 Per-device study state store, merged on read** (M). Items: 38 (also foundation (c), used later by 11, 14, 18, 21, 23, 30, 35, 36, 39). Needs: none.
  - src-tauri/src/study.rs: new study_state_read(key) / study_state_put(key, entries) commands taking State<BridgeLinkManager> for runtime.instance_id. Layout Study/.state/<key>/<instanceId>.json as {v:1, entries:{id:{at,del?,val}}}; .jsonl logs are concatenated on read. Newest-at wins, del is a tombstone, at = max(now, lastSeen+1). Key allowlist: term, problems, canvasDone, ratings, focus, plan, examDay, mistakes, reviews, inbox, timetable, reading. One-time import of legacy .term.json/.problems.json as device "legacy" (at = mtime), leaving the files in place. src/lib/bridge.ts widens the key union. state.ts problemsStore becomes Record<assignment, Record<problemKey,{at,done,rating?}>> with the 600 ms debounce kept. Rust unit tests for the merge plus a vitest test for the TS store.
- [x] **1.2 Per-course settings patch (study_course_patch) and courseSettings.ts** (M). Items: foundation (a), no numbered item (enables 1, 22, 26, 27, 31, 34, 41, 42, 44, 50). Needs: none.
  - study.rs: study_course_patch(name, patch) re-reads .course.json, merges only the top-level keys it is given, validates them, writes to a temp file and renames, and respects MAX_PLAN. Also pub fn course_settings(name) for mimir_api.rs. New src/features/study/courseSettings.ts with typed readers and defaults (aiPolicy, recording, officeHours, contacts, exams, cancelled, wordList, bring, units, major). Move GradesCard.tsx:26, ClassTimes.tsx:15, CourseFiles.tsx:33, assignments.ts:67 and StudyPage.tsx:210 off {...course.info, x} and onto patch.
- [x] **1.3 Ranged file serving for bdbook and pdf.js URL loading** (S). Items: foundation (prerequisite for B1, 23, 24 and large books). Needs: none.
  - study.rs serve(): replace fs::read with File::open + seek + read_exact for the requested Range and return 206 with Content-Range. src/features/study/pdf.ts: loadBook switches to getDocument({url:'bdbook://…', rangeChunkSize:65536, disableAutoFetch:true}); loadBookBytes is kept only for the indexer and OCR. Test with a 300+ MB PDF on WebView2 and WKWebView.
- [x] **1.4 Notes keep unknown block kinds; reserve "ink" and "image" kinds** (S). Items: foundation for B3 and B4 (no numbered item). Needs: none.
  - src-tauri/src/bridgelink/notes.rs: sanitize_block (:146) keeps unknown kinds instead of turning them into "p". Add "ink" and "image" to the allowed kinds (:21) with Markdown out/in `![Ink](bridgedeck-ink:<id>)` and `![Image](bridgedeck-image:<id>)` next to :720/:805, plus tests like :1197. Frontend model.ts renders unknown kinds as a read-only placeholder. Ship this early so both computers have it long before ink or scans create these blocks.
- [x] **1.5 Backups include study state, Syncthing versioning, export semester** (M). Items: 40. Needs: 1.1.
  - backups.rs: add Study to CARRIED but include only .course.json, .state/**, .degree-plan.json and Lectures sidecars/text, so no books are included and the 20 MB MAX_IMPORT_FILE cap is not exceeded; allow these dotfiles past the skip at :226. syncthing_bridge.rs: set folder versioning {type:'staggered', params:{maxAge:'2592000'}} when the shared folder is created or updated. Settings gets an 'Export semester' button: the same zip filtered by term, saved via plugin-dialog save().

## Phase 2: Quick wins the user feels right away

Visible improvements on the Windows PC after each merge: synced last page, stitching PDFs, phone photos to a PDF, nicer flashcards, safer tutoring, Mimir knowing what you read, faster adding, and class/office-hour info.

- [x] **2.0 Split screen** (M). Added at the user's request: any two tabs side by side (two books, a book and its notes, a book and Code). Open beside from a book's split button, a tab's split button or right-click, or the split button in a tab group's menu. Ctrl/⌘ \ toggles. Drag the bar to resize (remembered), double-click it for half and half.
- [x] **2.1 PDF writer chunk (pdf-lib) and raw-body study_save_pdf** (S). Items: foundation (h) (used by B2, 20, 29, 47, B3). Needs: 1.3.
  - package.json: pdf-lib@1.17.1. New lazy src/lib/pdfwrite.ts with imagesToPdf(jpegs/pngs,{title,pageSize}) and mergePdfs(parts, order, rotations). Rust study.rs: study_save_pdf(course,name) reading tauri::ipc::Request InvokeBody::Raw (headers course/name); checks %PDF-, caps size, uses clean_name/free_name, writes .partial then renames, then refreshLibrary(). Also study_read_source(path) limited to dialog-returned paths and <Shared>/From phone. HEIC detection with a clear message on Windows.
- [x] **2.2 Stitch PDFs together in a chosen order** (M). Items: B2. Needs: 2.1.
  - New src/features/study/StitchPdf.tsx opened from a 'Stitch PDFs' button in the StudyPage.tsx course action bar (:160). Sources: course PDFs, pickTransferPaths files, the From phone folder. pdf.js thumbnails; tick pages, drag to reorder, rotate, name the output (default 'Homework <date>.pdf'). Builds with pdfwrite.mergePdfs, saves with study_save_pdf, can add to a collection (collections.ts moveFile).
- [x] **2.3 Phone page photos become one named PDF ready to upload** (M). Items: 20. Needs: 2.1, 1.1.
  - phone.rs: /api/upload?batch=<id>&assignment=… groups uploads; phone.html gets a 'Scan homework' flow (input accept=image/* capture=environment multiple). The window builds the PDF with pdfwrite.imagesToPdf named '<course> <assignment>.pdf' beside the assignment and warns if problems in the assignment are not ticked (reads problems from the 1.1 state).
- [x] **2.4 Synced last-page memory (books open where you left off on either computer)** (S). Items: B1 (part 1 of 4: open at the last page). Needs: 1.1.
  - BookTab.tsx (pageKey :19-25, :226, :230) and EpubTab.tsx (placeKey :14, :57, :66) write {page|cfi, at} to study state key 'reading' (1.1) with a ~2 s debounce, keeping localStorage as an instant cache. On open, use the newest entry across devices. One-time copy of existing localStorage positions.
- [x] **2.5 Flashcards render math/symbols plus an 'Open p. N' button** (S). Items: 9. Needs: none.
  - Review UI (review.ts / the Study card view) renders $…$ and $$…$$ with KaTeX (already a dependency) and Unicode symbols; a card's existing [Book, p. N](book:…) source link becomes an 'Open p. N' button via openBookLink. No grammar change, so it stays compatible with mimir_api.rs card_parts.
- [x] **2.6 Hints-first tutor rules; Code's Ask Mimir points at the line** (S). Items: 2. Needs: none.
  - mimir/src/main/... modules.ts: a new 'tutor' prompt module, required whenever a study course or the Code/Logic tab is in context: hints first, no full solutions unless asked, point at the line and explain instead of rewriting. bd_study (:365-375) gets citation text. CodePage.tsx:243 prompt changes from 'show the fixed code' to 'point at the line and give a hint'. Reads aiPolicy when present (wired fully in 3.3).
- [x] **2.7 Mimir knows what you're reading; Ask Mimir on a highlighted passage** (S). Items: 3. Needs: none.
  - BookTab.tsx and EpubTab.tsx call useTabContext('study', {course, book, page, selection, pageText}) as CodePage.tsx:98 does. Add an 'Ask Mimir' action to the selection menu (next to highlight) through askMimir, carrying bookLink(course,file,page).
- [x] **2.8 Quick-add in plain words with next-class/lab chips** (S). Items: 33. Needs: 1.2.
  - Quick-add parser for phrases like 'HW 4 due next lab'. Chips computed from schedule.ts meetings (next class, next lab, next week same day). Optional per-course 'auto lab deadline' (weekly due N hours before lab), stored via study_course_patch.
- [x] **2.9 Class reminders with room; cancel or move one class date** (S). Items: 34. Needs: 1.2.
  - schedule.ts: reminder N minutes before each meeting, with the room in the text (notify.ts). ClassTimes.tsx: 'Cancel this date' / 'Move to…' saving the courseSettings `cancelled` key via patch; calendar projection and reminders skip or move that date.
- [x] **2.10 Office hours, contacts, email professor, office-hours question list** (S). Items: 44. Needs: 1.2.
  - CourseSettings UI for officeHours (Meeting[]) and contacts [{role,name,email}] via patch. 'Email professor' opens mailto: with the course code in the subject. A per-course 'Questions for office hours' list (a note section), shown as a reminder before office hours.

## Phase 3: Canvas, exams, exam mode and grades in one place

Give Rust and Mimir the Canvas data, make exam mode real (AI off, survives a restart), keep one exam list everywhere, and make reminders and grades trustworthy.

- [x] **3.1 Canvas data readable by Rust; done marks synced** (M). Items: foundation (b) (used by 4, 21, 25, 29, 30, 32, 36, 41, 39). Needs: 1.1.
  - New src-tauri/src/study_canvas.rs: study_canvas_publish(data) writes <appdata>/canvas.json (per computer, never synced) and keeps an in-memory copy. assignments.ts refreshCanvas (:44-47) calls it; canvasStore.ts loads from it at start. apiAssignments keeps submission{submitted_at,workflow_state,score,missing,late}, points_possible, html_url. config.canvas.done moves to state key canvasDone with a one-time migration.
- [x] **3.2 Exam mode persisted in Rust (site block survives a restart)** (S). Items: 1 (part 1 of 2). Needs: none.
  - New src-tauri/src/exam.rs: static plus <appdata>/exam.json {course, until, sites}, exam_set/exam_get commands, restored at start-up and re-applying browser::exam_sites (browser.rs:123). src/core/exam.ts setExam calls exam_set; localStorage only as a dev fallback. Optional BridgeLink broadcast to the paired computer.
- [x] **3.3 Exam mode turns all AI off; per-course AI policy none/hints/full** (M). Items: 1 (part 2 of 2). Needs: 3.2, 1.2, 2.6.
  - courseSettings aiPolicy UI. mimir_api::route returns 423 'Exam mode: AI is off' for every /mimir/* route except calendar/notes reads; new /mimir/study/policy returns {exam, policies}. mimir/src/main/agent/session.ts checks policy before each turn and ends the turn in code when exam is on or the policy is none. BridgeDeck hides the Mimir and ChatGPT tabs, the chatgpt.rs side panel and askMimir in exam mode. The tutor module (2.6) switches to hints-only under 'hints'. The UI states that 'hints' is prompt-level only.
- [x] **3.4 One exam list everywhere** (M). Items: 27 (part 1 of 2). Needs: 1.2.
  - New src/features/study/exams.ts (Exam type with source manual|canvas|syllabus|finals) stored in .course.json exams via patch. ensureExamEvents() upserts calendar events with id exam-<id>. Replace the heuristics in brief.ts:37, planner.ts:29, StudyPage.tsx:138 and Mimir daily_brief (tools.ts:205-233) with lookups. One-time import of red '<course>: …exam…' events; Canvas quizzes offered as exams. Rust study::exams_of plus /mimir/study/exams.
- [x] **3.5 CSULB finals table with room** (S). Items: 27 (part 2 of 2). Needs: 3.4. Done: Study → Semester takes the finals table pasted from the university's page (study/finals.ts reads class days and time, exam date and time), matches each course's lecture to its row (exactly, or the nearest start within 30 min on the same days) and adds the finals to the calendar with a day-before reminder. Not done: fetching the table automatically (the page changes each term), and the room, which the table doesn't give: it's entered on the exam.
  - New src/features/study/finals.ts mapping meeting pattern (days + start time) to a final slot for the current term, with source URL and date in the file. A 'Add my finals' action creates source:'finals' exams with the room taken from the course's meeting room.
- [x] **3.6 Exam-day card** (S). Items: 31. Needs: 3.4, 1.1.
  - Home and Study card the day before and the day of an exam: room, allowed items (exam.allowed), bring-list (courseSettings bring), leave-by time (start minus a travel setting), suggested bedtime. Checklist ticks are stored in state key examDay.
- [x] **3.7 Reminders include Canvas work everywhere; 24h/1h warnings for hand-added items** (S). Items: 32. Needs: 3.1.
  - Reminder pass reads the Canvas data (3.1) and manual assignments; 24 h and 1 h notifications for hand-added items; done marks (canvasDone) suppress them; muted in exam mode. Pushed into the phone SNAPSHOT (phone.rs phone_publish).
- [x] **3.8 Warning: ticked done but not submitted on Canvas** (S). Items: 21. Needs: 3.1.
  - Compare canvasDone / problem ticks with submission.workflow_state/submitted_at; a 'Not submitted yet' badge plus a notification before the due time, with a link to html_url.
- [x] **3.9 Canvas scores into the grade sheet with an at-risk alert** (M). Items: 41 (part 1 of 2). Needs: 3.1, 1.2.
  - GradesCard / grades.ts fill category scores from Canvas submission.score/points_possible, with manual override kept. At-risk alert when the projected letter drops below the target (letters without +/-, as at CSULB, grades.ts:10).
- [x] **3.10 Drop lowest, extra credit and points mode** (S). Items: 41 (part 2 of 2). Needs: 3.9.
  - Extend readGrading in grades.ts with {dropLowest, extraCredit, mode:'weights'|'points'} per category, saved via patch; vitest cases for each rule.
- [x] **3.11 Major GPA, what-if GPA, semester wrap-up** (M). Items: 42. Needs: 3.9, 1.2.
  - courseSettings units and major flag; major GPA next to the existing overall GPA; what-if sliders per current course; a wrap-up view at term end (final letters, GPA change, hours studied when available) that feeds the 1.5 semester export.

## Phase 4: Flashcards 2.0 and the engineering math engine

Build a single expression/units engine, then grow the card format (cloze, both-ways, images, typed answers) with a review log, personal FSRS tuning and import/export, keeping the TS and Rust card parsers identical.

- [x] **4.1 Units and complex expression engine (src/lib/expr.ts)** (M). Items: foundation (i) (used by 8, 12, 45, 46, 47, 48). Needs: none.
  - Move the plot.ts:12-120 tokenizer/parser into src/lib/expr.ts. Value Q={re,im,dim:Int8Array(7)}; SI prefixes only before a unit; Ω ohm V A W F H Hz s S; j/i, ∠deg, ||, 0b/0x/0o; abs/arg/conj/re/im/sqrt; equalWithin(a,b,relTol,units). plot.ts evaluates with im=0. Test table covering the m/milli and e rules. No new dependency.
- [x] **4.2 Engineering calculator block** (S). Items: 46. Needs: 4.1, 1.4.
  - New note block or Study tool using expr.ts: unit-aware results with automatic prefixes, resistor color code to and from value (E-series), complex/phasor display (rectangular and polar), parallel ||. Uses an existing block kind (e.g. a python-like 'calc' fenced code) or adds a kind on top of 1.4.
- [x] **4.3 Card grammar v2: cloze and both-ways cards (TS and Rust in lockstep)** (M). Items: 13. Needs: 2.5.
  - cards.ts and mimir_api.rs (card_parts, card_due, is_card_note :445-458): front ::: back gives two sub-cards; {{c1::text}} gives one sub-card per cN; FSRS state <!--fsrs c1:due=…;s=…|c2:…--> while the un-prefixed form stays. Card id ${noteId}/${blockId}/${sub}. Shared test vectors JSON used by vitest and cargo test. 'Make cloze' action from notes, highlights and transcript text.
- [x] **4.4 Edit and delete cards in Study; leech list** (S). Items: 11 (part 1 of 2). Needs: 4.3.
  - Study deck view: edit front/back inline (rewrites the block through the notes store), delete card, suspend. Leech list computed as lapses >= 8 (from the 4.6 log when present, otherwise the FSRS lapse field), tagged #leech in the line.
- [x] **4.5 One interleaved review session across all courses from Home** (S). Items: 10. Needs: 4.3.
  - allDue(notes, library) in the lazy cards chunk, round-robin by course; a Home 'Review all (N)' button. Home imports only types (cards.ts:1 comment).
- [x] **4.6 Review log, personal FSRS tuning, per-chapter mastery map** (M). Items: 14. Needs: 4.3, 1.1.
  - saveReview (state.ts:228) appends {card,at,grade,elapsedDays,state,ms} to .state/reviews/<instanceId>.jsonl (1.1). Lazy optimizer: @open-spaced-repetition/binding (fallback fsrs-browser); weights in config.study.fsrsWeights; review.ts builds fsrs({w}). Mastery map: card page links map to chapters through the '<book> — chapters' note / outline, combined with retrievability.
- [x] **4.7 Type-your-answer mode with numeric tolerance and units** (S). Items: 12. Needs: 4.1, 4.3.
  - Answer spec {{num:4.7k Ω ±2%}} parsed by expr.ts; review shows an input, checks with equalWithin and unit match, and suggests a grade. Added to the shared card test vectors.
- [x] **4.8 Pictures and circuit drawings on cards** (S). Items: 16. Needs: 4.3, 1.3.
  - ![](bdimg:<course>/<file>) on either side; files in Study/<course>/Cards/; resolve() accepts this 3-level path (canonicalize + starts_with kept); 'Add drawing' exports the Excalidraw/Logic SVG/PNG into Cards/. Done: pictures are added by picking or pasting (a Logic or drawing export pastes in as a picture).
- [x] **4.9 Anki / CSV / Quizlet import and export** (M). Items: 15. Needs: 4.3, 4.8.
  - New src/features/study/deckio.ts. Rust study_anki_import(path) using rusqlite + zip (already in Cargo.toml), mapping Basic, Reversed and Cloze notes and media into Cards/. CSV/TSV and Quizlet tab/newline parsers. Export to CSV and .apkg (or CSV only first if .apkg writing is too large). Done as our own format (per the decision: no Anki): CSV with kind, front, back and review state; Quizlet-style tab lists and spreadsheets import; export saves a CSV in the course folder.

## Phase 5: Mimir as a study partner (routes, approval inbox, vision)

Let Mimir read assignments, grades, class times and plans, require approval before anything is written, turn on local vision, and replace ChatGPT for homework photos.

- [x] **5.1 Mimir study routes and tools: assignments, grades, class times, plan** (M). Items: 4 (part 1 of 2). Needs: 3.1, 3.3, 3.4.
  - mimir_api.rs: /mimir/study/assignments (canvas.json + canvasDone + manual Assignments note), /grades, /schedule (meetings, term, cancelled), /plan. tools.ts defs and handlers; study_assignments and study_policy join the core tools (:309); new bd_assignments module in modules.ts triggered by due|grade|class|schedule.
- [x] **5.2 Approval inbox: Mimir deadlines wait for approval** (M). Items: 4 (part 2 of 2). Needs: 5.1, 1.1.
  - /mimir/study/inbox/add appends {kind:'card'|'deadline'|'exam'|'problems'|'syllabus'|'words', course, payload, from:'mimir'} to state key inbox. A Study 'From Mimir' card accepts or rejects; accepting calls the existing add paths. Mimir's deadline/exam writes go through it; confirm() stays only for instant actions.
- [x] **5.3 Mimir flashcards wait for approval** (S). Items: 11 (part 2 of 2). Needs: 5.2, 4.3.
  - /mimir/study/flashcards/add (mimir_api.rs:333-363) writes to '<course> — draft cards' (not reviewed because the title lacks 'flashcards') and adds an inbox entry; accepting moves the block into the deck. /study/courses reports a pending count.
- [x] **5.4 Tutor evaluation harness with a fixed EE problem set** (S). Items: 6. Needs: 2.6.
  - New mimir/tests/tutor-eval/: fixed EE problems (circuits, signals, digital) with expected hint-only behaviour and leak checks, plus a vitest runner per configured model (Mac and PC plans in plan.ts) that writes a score report. Not run in CI by default. Run: MIMIR_TUTOR_EVAL_URL=http://127.0.0.1:8080 MIMIR_TUTOR_EVAL_MODELS=qwen3.5-9b npx vitest run tests/tutor-eval (in mimir/).
- [x] **5.5 Turn on Mimir vision (mmproj) for local models** (M). Items: B4 (part 1 of 5). Needs: none.
  - mimir setup/index.ts:150 and setup/gpu.ts:79 stop skipping mmproj; plan.ts:200-205 passes --mmproj and adds a 'vision' llama-swap role (PC: Qwen3.5-9B checker). openaiCompatibleProvider.ts:58 supportsVision reads llama-server /props modalities.vision; ollamaProvider.ts regex widened. A settings choice of vision model and 'prefer PC over network' for the Mac. First verify that the PrismML fork supports Qwen3.5 mmproj. Done: a local model's mmproj beside it is passed with --mmproj (-hf models fetch their own); vision is read from llama-server's /props (through llama-swap only for a running model) and a name guess; Ollama's list widened. A vision model can be set in Mimir's Settings → Brain team → Pictures: it reads photos (study_photo, and pictures sent in the chat) and its reading is added as text, so a chat model that can't see can still use them. Not done here: checking the PrismML fork's Qwen3.5 mmproj support on the Mac (needs the hardware).
- [x] **5.6 Homework photo becomes a problem list and due date via Mimir (no ChatGPT)** (M). Items: 19. Needs: 5.5, 5.2.
  - homework.ts:12 swaps ChatGPT for a Mimir vision call (local llama-swap, PC first) that returns JSON {problems[], due}; the result goes to the inbox as kind 'problems'/'deadline'. Photos come from the phone upload or a picker, with HEIC handled. Done: 'Read it with Mimir' keeps the photo in the course, Mimir looks at it (study_photo, library pictures only) and suggests deadlines and exams into the inbox; ChatGPT stays as the other choice. HEIC is refused with a hint (the phone page sends JPEG).

## Phase 6: Lectures and course materials

Keep lecture audio with timestamps, live transcription and Mimir summaries; download Canvas files and read the syllabus; make search cover everything with precise citations.

- [x] **6.1 Lecture audio storage and streaming** (M). Items: foundation (j) (used by 5, 22, 23, 24). Needs: 1.3, 1.2.
  - study.rs: audio kind in book_kind, resolve accepts Study/<course>/Lectures/<file> (3 levels), served by the 1.3 range reader. Sidecar <date> <title>.json {segments, markers, photos}. model.ts parses lecture:<course>/<file>#t=123 next to parseBookLink. Recording is blocked when courseSettings.recording is false.
- [x] **6.2 Import existing audio, per-course word list, dated note and brain dump, recording-allowed flag** (M). Items: 22 (part 1 of 2). Needs: 6.1.
  - lecture.ts: import m4a/mp3/webm into Lectures/ and transcribe with the existing whisper worker; post-correction with the courseSettings wordList; create a dated lecture note with a brain-dump section; recording-allowed toggle in CourseSettings.
- [x] **6.3 Lecture player: clickable timestamps, '?' lost markers, whiteboard photos in the transcript** (M). Items: 23. Needs: 6.1.
  - Lecture view: transcript segments seek the audio; a '?' button during recording stores a marker (sidecar plus state key for unresolved ones); phone/desktop photos taken during class are placed at their time in the transcript. Done: player tab with clickable lines, the line being said marked, '?' marks while recording and while listening (kept in the sidecar, resolved with ×); photos show at their time when the sidecar lists them (placing class photos automatically is left).
- [x] **6.4 Live transcription during class** (M). Items: 24. Needs: 6.3, 3.2.
  - lecture.ts / whisper.worker.ts: chunked streaming (e.g. 10-20 s windows with overlap) while recording, a live transcript pane, the final pass replacing live text. Blocked in exam mode and when recording is not allowed. Watch CPU on the 8 GB Mac (tiny model by default). Done: 20-second pieces from the microphone (16 kHz) go to one long-lived worker; when it falls behind, older pieces are skipped (the full pass fills in); a setting turns it off; nothing is sent in exam mode.
- [x] **6.5 Mimir lecture summary, key terms and draft cards** (S). Items: 22 (part 2 of 2). Needs: 6.2, 5.3.
  - /mimir/study/lectures route serving transcript segments; an action 'Summarise lecture' writes the summary and key terms into the dated note and sends draft cards and new words (kind 'words') to the inbox. Done: /mimir/study/lectures and study_lecture; 'Summarise' asks Mimir to add the summary and key terms to the note, suggest cards (inbox), and list misheard words for the course word list.
- [x] **6.6 Canvas files and modules download into the course folder, searchable** (M). Items: 25. Needs: 3.1.
  - Second Canvas pass for modules/files (canvas.rs proxy) into Study/<course>/Canvas/ (slides, old exams, syllabus), with size checks against Syncthing/backup limits and skip-if-unchanged. PDFs are indexed by the existing indexer. Done: 'Canvas files' on a linked course downloads its files (books, slides, pictures; 150 MB each, 1 GB a run; unchanged ones skipped by .canvas-files.json) beside its books, grouped as 'From Canvas', so they're listed and indexed. Module pages (not files) aren't read.
- [x] **6.7 Search covers EPUBs, lecture transcripts and notes; timestamp citations; re-checks pages** (M). Items: 5. Needs: 6.1, 5.1.
  - study_save_index accepts kind epub (EpubTab/indexer via epubjs) and transcripts (minute paragraphs as pages); notes searched through the notes store; Hit gains t for lectures. bd_study rules: cite (Book, p. N) and lecture [mm:ss], and re-read the page through study_search before quoting. Done: EPUBs were already indexed by chapter; search now also covers each minute of a lecture transcript (hits carry t and open the player there) and course notes (not flashcards); Mimir cites [mm:ss] and re-reads pages before quoting.
- [x] **6.8 Syllabus reader proposes weights, exams, office hours and AI policy** (M). Items: 26. Needs: 6.6, 5.2, 3.4.
  - Mimir reads the syllabus (downloaded by 6.6 or picked) and posts kind 'syllabus' to the inbox; accepting fills grading weights, exams (source syllabus), officeHours and aiPolicy via patch, showing a diff first.

## Phase 7: Homework, exam prep and planning

Help with each homework problem without giving answers away, build exam prep from real material, and plan study time realistically.

- [x] **7.1 Read section and Check answer for each homework problem** (M). Items: 17. Needs: 1.1.
  - Problem rows get 'Read section' (opens the book at the mapped section via the outline) and 'Check answer' (opens the book's answers page in a split view beside the user's work). The mapping problem→page is stored in the problems state. Done: pages come from the textbook's contents (biggest non-slide PDF first) and are kept in the course setting sectionPages; Check answers opens beside the work.
- [x] **7.2 Rate problems solved/help/stuck; hard ones resurface** (S). Items: 18. Needs: 1.1, 7.1.
  - A rating per problem stored in state key ratings; 'stuck'/'help' problems come back in review sessions and before exams, optionally as cards. Done: right-click a problem for needed help → stuck → clear; a course's 'Problems to redo' card lists them with Read section and Got it. They can become flashcards (one, or all of a course's): 'Redo 1.4 #12 from HW 3 on paper', so they come back in review until they're easy.
- [x] **7.3 Stuck? button: book worked examples plus a twin problem checked in Python** (M). Items: 7. Needs: 5.1, 3.3, 7.1.
  - From a problem row: study_search finds worked examples in the book; Mimir writes a twin problem and checks its numbers with run_python (compute/tools.ts:36) before showing it. Follows aiPolicy (off under none and in exam mode). Done: 'Stuck?' on a problem to redo asks Mimir (beside) for the book's worked examples, a twin problem checked with run_python, and a first hint only; hidden when the course's AI help is off or in exam mode.
- [x] **7.4 Step checker for typed steps** (M). Items: 8. Needs: 4.1, 3.3.
  - Typed steps are parsed with expr.ts; consecutive steps are checked numerically (random substitution with units); Mimir explains the first wrong step only in hints mode. Disabled under policy none and in exam mode. Done in the calculator block: '= …' lines are checked against the line above at several values of the letters; 'Why?' on the first wrong step asks Mimir for a hint (hidden when AI is off); step checks are off in exam mode.
- [x] **7.5 Exam countdown plan in the calendar** (M). Items: 28. Needs: 3.4, 4.6.
  - For each exam: chapter-scoped cards (tags from exams.chapters through the mastery map), a formula checklist, a crunch-week strip on Home, and study blocks written to the calendar. Done: a course's next exam (3 weeks out) shows days left, a review of the cards from the chapters it covers (by chapter number or title words), a formula-sheet checklist and the problems to redo; Home shows a strip of exams in the next two weeks. Study blocks come from the existing planner (3.6).
- [x] **7.6 Practice exams** (M). Items: 29. Needs: 6.6, 2.1, 5.2.
  - Build a practice exam from old Canvas exams (6.6), assigned problems with their labels hidden, and Mimir questions verified with run_python (through the inbox); output as a PDF with pdfwrite.mergePdfs. Done: 'Practice exam' makes a PDF in the course (a front page of homework problems from the covered chapters, stuck ones first, in random order, then up to four old exams); 'Questions from Mimir' asks for new questions with answers worked out in Python (in chat, not the inbox).
- [x] **7.7 Mistake log from graded work, with predicted vs actual scores** (M). Items: 30. Needs: 3.9, 5.3.
  - State key mistakes: log mistakes from graded Canvas work (scores from 3.9) and turn them into cards through the inbox; record a predicted score before submission and compare it with the actual score. Done: Canvas work with points takes an expected % before it's handed in and shows expected vs got once graded, with 'Log a mistake'; a course's 'Mistakes to avoid' card lists them (each can become a card directly) and how far off your guesses run.
- [x] **7.8 Focus sessions tied to an assignment** (M). Items: 35. Needs: 3.2, 1.1.
  - Focus timer tied to an assignment: blocks sites through browser.rs exam_sites (via exam.rs), ticks problems in the session, logs real hours to .state/focus/<id>.jsonl, and supports hour targets per assignment. Done: a focus session can be for an assignment (its calendar event carries [a:<id>], so hours count on both computers), shows hours so far against its expected hours (guessHours or '~3h' in the title), and can close the exam-mode site list while it runs. Problems aren't ticked from the session itself (the problem grid does that).
- [x] **7.9 Adaptive planner** (M). Items: 36. Needs: 7.8, 3.1, 3.4.
  - planner.ts: split long sets across days, reschedule skipped blocks, warn when the hours do not fit before the due date; uses learned hours from 7.8, Canvas due dates and exams. Plan stored in state key plan. Done: hours are scaled by how long finished work really took (median actual ÷ guess, from focus sessions) less what's already been spent; missed plan blocks (no study logged during them) are flagged and planning again fits the rest in; what doesn't fit says what to do. Plan blocks carry the task's [a:<id>]. The plan stays in the calendar (no separate 'plan' state).
- [x] **7.10 Sleep and overload guard** (S). Items: 37. Needs: 7.9.
  - Planner and reminders warn on late-night blocks, too many hours in a day, or 3+ deadlines/exams in 48 h, and suggest moves. Done in the planner: late-night blocks, days over 10 hours of classes, events and study, and 3+ deadlines or exams in 48 hours, each with what to change.
- [x] **7.11 Next-semester timetable** (M). Items: 43. Needs: 1.2, 1.1.
  - Paste sections from the CSULB schedule; parser plus a week grid with conflict highlighting and the existing prereq check; 'Use these' writes meetings into the new courses via patch. Draft stored in state key timetable. Done under the degree plan: paste sections, pick one per course and type, a Mon–Fri grid with clashes in red, missing prerequisites from the plan, and 'Use these class times' writes meetings (making the course if needed). The draft is study state 'timetable' ({text, picked}).

## Phase 8: Books, handwriting and scanned notes

Make huge books into clickable chapter books with download, write with a pen or Apple Pencil (also on PDFs), and turn photos of paper notes into a clean typed notes PDF.

- [x] **8.1 Book folders in the library with chapter navigation** (M). Items: B1 (part 2 of 4: chapter list and one-book folders). Needs: 1.3, 2.4.
  - study.rs: Book gains folder/chapters; read_library accepts subdirectories with a valid .book.json (skips ones with missing chapters, i.e. still syncing); resolve accepts course/bookdir/chapter.pdf only when the manifest exists. pdf.ts loadChapter. BookTab.tsx: global page numbers, prev/next across chapter files, Contents from manifest.outline. Index key <course>/<bookdir>.json joining chapters. CourseFiles.tsx folder badge with chapter count.
- [x] **8.2 Split a huge PDF into per-chapter files that still act as one book** (M). Items: B1 (part 3 of 4). Needs: 8.1.
  - Cargo.toml lopdf (pinned, default features off). study_split_book(course,file,chapters) in spawn_blocking: delete_pages/prune_objects/compress per range, .partial then rename, .book.json last with source, splitBy and the global outline, page counts checked, original sent to trash. 'Split into chapters…' toolbar UI prefilled from resolveOutline. openBookLink redirects old book:<file.pdf>#N links via the manifest source; the reading position moves too.
- [x] **8.3 Download/export a whole book, a chapter or pages** (S). Items: B1 (part 4 of 4). Needs: 8.2.
  - study_export(course,file,chapter?,page_range?,dest): fs::copy for whole files, lopdf range extract for a chapter of an unsplit PDF, lopdf merge for a whole split folder, EPUB whole-file only. A 'Download' menu in BookTab and an Export icon on CourseFiles cards, using plugin-dialog save() like pickBackupFile.
- [x] **8.4 Ink data model and storage (per-device stroke logs)** (M). Items: B3 (part 1 of 4). Needs: 1.4.
  - New src-tauri/src/ink.rs (modelled on drawings.rs): <Shared>/Ink/<id>/doc.json plus strokes-<deviceId>.jsonl, append-only, delta-encoded, ignores a cut-off last line; commands ink_create, ink_load, ink_append, ink_set_doc, ink_set_background; registered in lib.rs. src/features/notes/ink/model.ts with merge/encode and vitest. Compaction of a device's own log.
- [x] **8.5 Desktop ink editor (Windows pen, Sidecar)** (M). Items: B3 (part 2 of 4). Needs: 8.4.
  - npm perfect-freehand 1.2.x. InkBlock.tsx (thumbnails), InkEditor.tsx (full window, autosave per stroke), ink/{render.ts,input.ts,paper.ts}: pointerType pen, pressure, getCoalescedEvents, desynchronized canvas, eraser button, palm rejection, highlighter, stroke eraser, lasso, undo/redo, paper styles, Letter/A4. Reload on focus/mtime when the other computer adds strokes. 'Ink' in the insert menu. Done: 'Handwriting' in the insert menu; pen (pressure, coalesced events), highlighter, stroke eraser (button or the pen's eraser end), palm rejection once a pen is seen, undo/redo, colours and widths, lined/grid/dots/blank paper, pages, save per stroke, reload on focus and every 5 s, own-log compaction on close; the editor and perfect-freehand load only when opened. Lasso (on the computer and the iPad page): draw round writing to select it, drag to move (written again as new strokes, the old ones erased), Delete to remove.
- [x] **8.6 iPad/iPhone ink page served by the phone server** (M). Items: B3 (part 3 of 4). Needs: 8.5.
  - phone.rs: GET /ink (include_str ink.html), GET /ink.js (vendored perfect-freehand), /api/ink/list|doc|bg|append|new behind X-Key, an ink-changed event. Phone strokes go to strokes-phone-<hash>.jsonl. Safari touch-action/-webkit settings and a retrying local queue. A 'Write on iPad' QR button on the Mac. Done: /ink on the phone server (self-contained page, no outside scripts), list of handwriting plus 'New page' (by course), Pencil writes and a finger scrolls, pen/highlighter/eraser/undo, strokes queued in the iPad's storage until sent, its own strokes-phone-<id>.jsonl, an ink-changed event the desktop editor listens to. The phone page links to it (no separate QR).
- [x] **8.7 Write on PDF pages and export the annotated PDF** (M). Items: B3 (part 4 of 4). Needs: 8.6, 2.1.
  - 'Write on this PDF' in CourseFiles/BookTab creates an ink doc with pdf backgrounds (desktop renders with pdf.js and writes bg/*.png for the iPad). ink/exportPdf.ts uses pdf-lib drawSvgPath with CropBox and /Rotate handling and saves '<name> (annotated).pdf' via study_save_pdf; blank notebooks export with paper lines. Done: 'Write on it' in the book reader draws each page (up to 120) as the ink's background (so the iPad shows them), makes a '<book> (handwriting)' note in the course and opens the pen page; its export button saves '<name> (annotated).pdf' in the course (strokes as SVG paths fitted to each page's crop box) or, for a notebook, a PDF on lined paper. Pages that aren't Letter-shaped are stretched to Letter while writing; /Rotate isn't handled.
- [x] **8.8 Scan capture, straighten and whiten (with HEIC fix)** (M). Items: B4 (part 2 of 5). Needs: 5.5, 1.4.
  - phone.html 'Scan notes' (capture, ?purpose=scan&course=), also accepting iPhone 'Scan Documents' PDFs. New warp.worker.ts (homography, bilinear), a 4-corner crop screen with a JS edge heuristic, whitening. Rust HEIC conversion on Windows (WIC) with a clear error. Fix CoursePhotos.tsx swallowing errors. Done: a course photo's Straighten button opens a 4-corner crop (perspective warp with bilinear sampling and whitening by local paper brightness, in a worker) and saves '<name> (scan).jpg' beside it, read into a note; photo-reading errors are now shown. The phone's scan page already sends JPEG. The crop screen finds the page itself (the biggest bright region, by Otsu's threshold, and its four extreme points; it falls back to marking them by hand when nothing page-like is found). HEIC photos are turned into JPEG when added (Windows: WIC, upright from the photo's orientation, with Microsoft's HEIF/HEVC extensions; Mac: sips), and older ones have a Convert button.
- [x] **8.9 Handwriting recognition, review screen and notes with image blocks** (M). Items: B4 (part 3 of 5). Needs: 8.8.
  - src/features/study/handwriting.ts recognizeHandwriting() -> blocks (Mimir VLM JSON, math as LaTeX checked by katex throwOnError, figure crops), with tesseract fallback. ScanReview.tsx side-by-side editor with low-confidence highlights. Output note uses 'image' blocks (<Shared>/Note images/<id>.png) and $$…$$ math. Corrections saved to <Shared>/Handwriting/samples/ and fed back as prompt examples. CoursePhotos.tsx rebuilt on this pipeline. Done (partly): a photo's 'Read' button opens a side-by-side review (photo, editable text from tesseract, lines with math that won't typeset or that look misread flagged) that saves a course note; 'Read it with Mimir instead' has the vision model read handwriting and math into a note itself. Not done: image blocks for figure crops, and saving corrections as examples.
- [x] **8.10 Apple Vision handwriting engine on the Mac** (M). Items: B4 (part 4 of 5). Needs: 8.9.
  - New src-tauri/src/handwriting_mac.rs (cfg macos) with objc2-vision 0.3 + objc2-core-image: VNRecognizeTextRequest (accurate, customWords from course terms and samples), VNDetectDocumentSegmentationRequest for the suggested crop. Settings 'Reading handwriting' engine order (Mac: Vision text + VLM math; PC: Mimir VLM, then the Mac over BridgeLink, then tesseract). Done: handwriting_mac.rs reads a course photo with VNRecognizeTextRequest (accurate, language correction, the course's word list as custom words) off the main thread; the review screen uses it first on the Mac (low-confidence lines flagged) and falls back to tesseract elsewhere. Checked with cargo check for aarch64-apple-darwin on the module alone; the Mac CI checks the whole app. Not done: document segmentation for the crop, and an engine-order setting.
- [x] **8.11 Clean typed notes PDF via Typst** (M). Items: B4 (part 5 of 5). Needs: 8.9.
  - New src-tauri/src/typst_export.rs: download the typst CLI on first use into app data (win x64, mac arm64/x64), generate .typ from the note Markdown with a vendored local @preview/mitex, compile to '<title>.pdf' in the course folder; falls back to images for math that fails. Also offered as a general 'Export note as PDF'. Done: any note's PDF button (clean or Kalam handwriting font) turns its blocks into Typst (math via @preview/mitex, which Typst fetches; without it math stays as LaTeX text), downloads Typst 0.13.1 (tar.xz via lzma-rs, or zip) and the fonts once, and saves the PDF in the course (or where you choose). The generated source was compiled with the real Typst here (with mitex stubbed: its package host isn't reachable from this sandbox).

## Phase 9: Labs, phone on campus and classmates

Engineering lab tools (circuit checker, drills, lab notebook, Octave reports), a phone page that works on campus and offline, and sharing with lab partners.

- [x] **9.1 Analog circuit checker in Logic via ngspice** (M). Items: 45 (part 1 of 2). Needs: 4.1.
  - Find or bundle ngspice per OS (Windows binary; the existing Mac candidates in engineering/tools.ts:63); Logic exports a netlist with expr.ts values; an 'Analyse' panel shows node voltages, currents and a sweep plot. Done differently: no ngspice to find or bundle. A 'Circuit' note block takes a SPICE-style netlist (R, C, L, V, I, .ac) solved here by modified nodal analysis (lib/mna.ts, complex at a frequency), showing every node voltage and part current, with '? V(out) = 3.4V' checks. No sweep plot yet.
- [x] **9.2 Check-only mode for graded work** (S). Items: 45 (part 2 of 2). Needs: 9.1, 3.3.
  - Per circuit or assignment: the checker answers only right/wrong against the user's entered values and hides simulated values; forced on when aiPolicy is hints/none or in exam mode. Done: a circuit block in a course note whose AI rule isn't 'full' (or any during exam mode) answers only right or 'not right yet' for your own '? … = value' lines and hides every solved value.
- [x] **9.3 Logic drills and predict-then-simulate** (M). Items: 48. Needs: 4.1.
  - Logic drills: K-map minimisation, base conversion and two's complement (expr.ts 0b/0x/0o), with generated items and scoring; 'predict outputs, then simulate' mode for Logic circuits; misses can become cards. Done: a Drills view in Logic (number bases, 8-bit two's complement, K-map minimisation checked by truth table and literal count against minimize()), a running score, and a miss can become a flashcard. 'Predict first' in Logic's Table panel hides the outputs: click each to guess 0 or 1, then Check marks them against the simulation (combinational circuits).
- [x] **9.4 Lab notebook** (M). Items: 47. Needs: 4.1, 2.1.
  - Lab notebook note template: data table with units, % error vs theory (expr.ts), plot (plot.ts), attach Logic/Code files, report export as HTML plus print (logic/report.ts pattern) with figures, and PDF assembly of attachments through pdfwrite. Done: 'Lab notebook' in a course makes a report note (objective, equipment, a circuit block, one calculator block for theory, measurements and % error, results, conclusion) that exports through the note's typeset PDF. Not done: a data table with a plot of measured points, and merging attachments into the PDF.
- [x] **9.5 One-click MATLAB/Octave publish report** (S). Items: 49. Needs: 9.4.
  - Find Octave/MATLAB per OS; run publish() on the current .m file in Code to HTML/PDF and save beside it or attach to the lab notebook. Done: 'Publish report' on a MATLAB script runs publish() with MATLAB (-batch) or Octave (--eval), folds the figures into one HTML file saved beside the script in the shared Code folder, and opens it. Not checked against a real MATLAB here (none installed in this sandbox).
- [x] **9.6 Lab partners and study groups** (M). Items: 50. Needs: 4.9, 1.2.
  - courseSettings partners (name, email); send a deck (deckio CSV/.apkg) or lab data as a file through mailto/share; find a shared free time from class meetings plus partners' pasted schedules (or their .ics), shown on a week grid. Done: 'Lab partner' and 'Classmate' roles under a course's People, with their class times typed as their hours; a Study group card shows the times everyone is free this week (from all your courses' class times and theirs) and emails them the list; decks are shared as the CSV export. Not done: reading a partner's .ics.
- [x] **9.7 Phone page offline flashcards and ticks** (M). Items: 39 (part 1 of 2). Needs: 1.1, 4.3.
  - phone.html caches due cards and the problem list in localStorage, reviews and ticks work offline, and a queued POST syncs to 1.1 state (no service worker, since plain HTTP is not a secure context). Done: the phone snapshot carries up to 80 due cards (all courses, mixed); the phone page reviews them, keeps its last copy for when the computer can't be reached, and queues checklist ticks and reviews in its storage until they're sent; the app applies phone reviews with FSRS in order. Homework problem ticks aren't on the phone page.
- [x] **9.8 Phone page on campus via Tailscale** (M). Items: 39 (part 2 of 2). Needs: 9.7.
  - phone.rs binds the Tailscale 100.x address when present, with optional HTTPS through tailscale cert and rustls (already in Cargo.toml); the QR code shows the Tailscale URL; a setting to turn this on with an exposure warning. Done: a setting (off by default, with the exposure explained) lists the Tailscale address (found by routing to 100.100.100.100, no packet sent) with the link and QR; while it's off, connections from Tailscale addresses are refused. Not done: HTTPS with tailscale cert (Tailscale already encrypts the traffic between devices).

## Notes and caveats

The plan has 9 phases and 67 PRs; almost all are S or M. Each of items 1-50 and B1-B4 sits in exactly one PR or is split across PRs with the split noted: 1 (3.2, 3.3), 4 (5.1, 5.2), 11 (4.4, 5.3), 22 (6.2, 6.5), 27 (3.4, 3.5), 39 (9.7, 9.8), 41 (3.9, 3.10), 45 (9.1, 9.2), B1 (2.4, 8.1-8.3), B3 (8.4-8.7) and B4 (5.5, 8.8-8.11). Foundation PRs (1.2, 1.3, 1.4, 2.1, 3.1, 4.1, 6.1) carry no item by themselves.

Platform caveats:
- Both computers must run builds that include 1.1 (state store) and 1.4 (unknown block kinds) before later PRs write .state files or ink/image blocks. An older BridgeDeck turns unknown blocks into paragraphs and syncs that damage back. Legacy .term.json and .problems.json stay readable until both computers are updated.
- Mimir vision (5.5) has not been verified. The PrismML llama.cpp fork may not load Qwen3.5's mmproj, and -hf may not fetch it. Check this before starting 5.6 and 8.8-8.9. On the 8 GB Mac, prefer the PC over the local network.
- Windows has no good built-in handwriting reader: Windows.Media.Ocr is trained on print, and the handwriting TextRecognizer needs a Copilot+ NPU. The PC therefore depends on the Mimir vision model or on the Mac being online.
- WebView2 cannot decode HEIC. 2.1 adds a clear message and 8.8 adds the Rust conversion. The existing silent failure in CoursePhotos is also fixed in 8.8.
- Sidecar Pencil input probably arrives without pressure, so plan on simulatePressure. The iPad phone page is the main Pencil path.
- The phone page is plain HTTP on the local network with only a key protecting it, so homework, notes and ink cross the network unencrypted. Turning on Tailscale/HTTPS (9.8) increases exposure, so it stays opt-in.
- ngspice and Octave must be found or bundled separately on Windows and Mac.
- 'Hints' policy is enforced only through the prompt. Exam mode is a hard stop only in Rust routes and Mimir's turn check; it cannot block the ChatGPT website in an ordinary browser.

Decisions for the user:
1. CSULB finals table (3.5) must be updated every semester; who keeps it current?
2. Cloze syntax {{c1::}} will not display in Obsidian; is that acceptable?
3. Split books (8.2) move the original PDF to the trash. Should it be kept instead (at the cost of syncing the book twice)?
4. Typst downloads about 30 MB on first use; is that acceptable, or embed the crate and accept a larger app?
5. pdf-lib 1.17.1 is unmaintained; should the plan use the @cantoo/pdf-lib fork instead?
6. Anki .apkg export could ship as CSV-only first.

Risks:
- lopdf memory use and duplicated fonts per chapter on 500 MB scanned books, so test with a real textbook.
- Clock skew in the newest-wins merge, handled with max(now, lastSeen+1).
- The card format must stay identical in cards.ts and mimir_api.rs, so share test vectors between them.
- Canvas downloads (6.6) can be large for Syncthing.
- Vision models can make up text or LaTeX, so the review screen is always shown and never overwrites a note quietly.

Suggested merge order for early, visible testing on the Windows PC: 1.1 → 1.2 → 1.3 → 1.4 → 1.5, then all of phase 2. Most phase 2 PRs are independent of each other and can merge in any order once 1.1, 1.2 or 2.1 is in.

## Decisions (answered)

- **Devices:** the student has an iPad with Apple Pencil, a pen on the Windows PC, and a Mac (with Sidecar). All three ink paths are built: the desktop editor (Windows pen, Sidecar) and the iPad page.
- **Updates:** both computers are usually updated together, but every format change must still work while they run different versions. So the rule stands: readers ship before writers, a version handshake runs over BridgeLink, and legacy files are read on every read until both computers have migrated.
- **Vision and handwriting:** the PC has an RTX 4070 Ti (12 GB) and is on only some of the time. Mimir's vision model runs on the PC when it's reachable. On the Mac, Apple Vision (8.10) is the fallback, so scanning works when the PC is off. The vision spike checks a 7–8B VL model in 12 GB.
- **Obsidian / Anki / Quizlet:** not used, so BridgeDeck has its own versions. Card syntax is our own, with no Obsidian compatibility needed. 4.9 shrinks to our own CSV import and export for backup and sharing. There is no `.apkg` import or export.
- **Font for typed notes:** both. The user picks a clean font (Inter or Source Serif) or a handwriting-style one (Caveat or Patrick Hand) for each note or export.
- **Order:** the book features (8.1–8.3: chapters, book folders, split, download) move to right after Phase 2.

## Earlier open questions (see Decisions)

- Decision: does the user own an iPad and Apple Pencil (which models; the iPad must support Sidecar)? Does the Windows PC have a pen digitizer? If neither, the scope of Phase 8 ink changes completely.
- Decision: will both computers always be updated together? A minimum-peer-version handshake over BridgeLink is needed before any format change (1.1, 1.4, 4.3) starts writing new data.
- Decision: is the PC on and reachable when the Mac or phone need vision or handwriting reading? What GPU and VRAM does the PC have for a vision model?
- Decision: does the user actually use Obsidian on these notes? This affects the cloze syntax and the Markdown fallback for unknown block kinds.
- Decision: lecture recording consent and policy (California two-party consent, CSULB policy). Should recording default to off?
- Decision: are they willing to install and run Tailscale on the PC, Mac and iPhone, and accept HTTPS certificate setup?
- Decision: do they use Anki or Quizlet today? If not, 4.9 could shrink to CSV only.
- Decision: should exam mode on one computer apply to both?
- A Phase 1 PR that writes down the on-disk formats (state store v1, card grammar v1/v2, ink log, .book.json) with version fields and a reader-before-writer rollout rule.
- A rollback plan for each format change: how to downgrade the app if a migrated build misbehaves, e.g. keep legacy files and make the old reader ignore .state/.
- A vision-model feasibility spike in Phase 2 that reports a go/no-go before Phase 5 and 8.
- A shared card test-vector file for the CURRENT v1 grammar (card_parts/card_due vs cards.ts), created before any grammar change.
- An end-to-end two-computer sync test (or a scripted Syncthing simulation with two folders) to run after 1.1, 1.4 and 4.3.
