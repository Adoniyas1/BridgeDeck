# Third-party source used by BridgeDeck

BridgeDeck is designed to vendor upstream open-source projects so their engines can be inspected and customized instead of treated as opaque external applications.

| Component | Pinned version | License | Intended use |
| --- | --- | --- | --- |
| Syncthing | 2.1.5 | MPL-2.0 | Continuous file synchronization |
| LocalSend | 1.18.2 | Apache-2.0 | Native local file-transfer core linked into BridgeDeck |

The authoritative upstream source, commit pin, repository URL, and platform scope live in `vendor-lock.json`.

When the source is fetched, the upstream license files remain inside each `vendor/<component>/` directory. Do not remove those notices when redistributing modified source or binaries.

## Tauri Dialog Plugin
BridgeDeck v0.7 uses `tauri-plugin-dialog` / `@tauri-apps/plugin-dialog` for native file and folder selection. The Tauri plugin is available under MIT OR Apache-2.0 terms. It is a package dependency rather than one of the large vendored application source trees.

## LocalSend core integration

BridgeDeck v0.7 links directly to the pinned Apache-2.0 LocalSend Rust core as a Cargo path dependency. Keep the upstream LocalSend license and notices with redistributed source/binaries as required by its license.

## KaTeX
The Notes tab renders `$math$` and `$$math$$` with KaTeX (`katex` on npm), MIT licence, © Khan Academy and other contributors. It is a package dependency; its licence ships inside `node_modules/katex`.

## claude-skills (downloaded on request)
Mimir's optional skill packs come from alirezarezvani/claude-skills, MIT, © 2025 Alireza Rezvani. BridgeDeck does not ship them: they are downloaded at a pinned commit only when the user installs packs in Settings, and each pack keeps the repository's licence terms.

## ts-fsrs
Study flashcards are scheduled with ts-fsrs (`ts-fsrs` on npm), an implementation of the FSRS algorithm, MIT, © open-spaced-repetition and contributors. It is a package dependency; its licence ships inside `node_modules/ts-fsrs`.

## epub.js
EPUB books are read in the Study tab with epub.js (`epubjs` on npm), BSD-2-Clause, © futurepress. It is a package dependency; its licence ships inside `node_modules/epubjs`.

## Excalidraw
Drawings in notes use Excalidraw (`@excalidraw/excalidraw` on npm), MIT, © Excalidraw contributors; its fonts (OFL and similar open licences) are bundled except the large Chinese/Japanese one. It is a package dependency; its licence ships inside `node_modules/@excalidraw/excalidraw`.

## Transformers.js, ONNX Runtime and Whisper (lecture transcription)
Lecture recordings are transcribed on the computer with Transformers.js (`@huggingface/transformers`, Apache-2.0, © Hugging Face) and ONNX Runtime Web (`onnxruntime-web`, MIT, © Microsoft). Its small loader is bundled; its WebAssembly and the Whisper models (OpenAI Whisper tiny.en / base.en, MIT, in the ONNX versions published by onnx-community on Hugging Face) are downloaded once when the user asks, not shipped.

## EasyList and EasyPrivacy (downloaded)
The ad blocker for web pages uses the EasyList and EasyPrivacy filter lists (easylist.to), © The EasyList authors, dual-licensed GPLv3 and CC BY-SA 3.0. BridgeDeck does not ship them: it downloads them from easylist.to and refreshes them every few days.

## uBlock Origin Lite (downloaded on request, Windows)
"Get uBlock Origin Lite" downloads the extension's latest Chromium release from github.com/uBlockOrigin/uBOL-home (GPLv3, © Raymond Hill and contributors). BridgeDeck does not ship it.

## Tesseract.js
Text recognition for scanned book pages uses Tesseract.js (`tesseract.js` on npm, Apache-2.0, © Jerome Wu and contributors), its WebAssembly build of Tesseract OCR (`tesseract.js-core`, Apache-2.0, © Google and contributors) and the English model (`@tesseract.js-data/eng`, from tesseract-ocr/tessdata, Apache-2.0). The worker, engine and English model are bundled into the app at `/ocr/` and run on the computer. Other languages chosen in Settings (also from tesseract-ocr/tessdata, Apache-2.0) are downloaded once from npm (`@tesseract.js-data/<language>`). Their licences ship inside `node_modules/tesseract.js` and `node_modules/tesseract.js-core`.

## PDF.js
The Study tab reads textbooks with PDF.js (`pdfjs-dist` on npm), Apache-2.0, © Mozilla and contributors. It is a package dependency; its licence ships inside `node_modules/pdfjs-dist`.
