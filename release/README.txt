BridgeDeck v0.7 release bundle (rebuilt 2026-09-29)
====================================================
- BridgeDeck-macOS.app        : built, locally-signed macOS app (unsigned by Apple; right-click > Open
                                on first launch). Includes the contact-editing security fix (Allow/Deny
                                dialog + rate limiting for remote /contacts/save).
- BridgeDeck-macOS-0.7.0.dmg  : the same app as an installer image
- BridgeDeck-source.zip       : full project source (no vendor/, node_modules/, build output). Builds on
                                either macOS or Windows; see START-HERE-MAC.md / START-HERE-WINDOWS.md.

No Windows .exe/.msi is included: BridgeDeck is built natively on each computer and no Windows build
was available on this Mac. To get a Windows build, run the source on the Windows PC:
  npm install
  npm run vendor:fetch   (or reuse an existing vendor/ tree)
  npm run tauri build
The installer lands in src-tauri/target/release/bundle/nsis/ (or msi/).
