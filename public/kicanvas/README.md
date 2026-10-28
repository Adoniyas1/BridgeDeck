# KiCanvas (vendored)

The KiCad viewer in Projects. Built from https://github.com/theacodes/kicanvas at commit
b031159eb74aaa7eef2b026fd85d35bc05ff2095 (2026-04-29) with `npm ci && node scripts/build.js`, after
one change: the Google Fonts link added at start-up was removed from
`src/kicanvas/elements/kicanvas-embed.ts`, so the viewer loads nothing from the internet (system
fonts are used). MIT licensed; see LICENSE.md for it and the works it includes.
