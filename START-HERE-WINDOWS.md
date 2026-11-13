# BridgeDeck on Windows

There are two ways to get BridgeDeck on a Windows PC:

| | Download the installer | Build from source |
| --- | --- | --- |
| Time | About 5 minutes | About 45 minutes the first time |
| Needs | Nothing extra | Visual Studio Build Tools, Node.js, Rust, Go, Git |
| **Mimir** (the assistant tab) | Not included | Included |
| Updates | One click, from GitHub releases | One click, rebuilt from the latest code |

Mimir runs from the source folder, so if you want the assistant (or the PC's local AI models for
the Mac to use), build from source.

- [Download the installer](#download-the-installer)
- [Build from source](#build-from-source)
- [First launch on Windows](#first-launch-on-windows)
- [Optional tools for some tabs](#optional-tools-for-some-tabs)
- [Check that everything works](#check-that-everything-works)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)

Windows 10 or 11, 64-bit, is needed.

## Download the installer

1. Open [the Releases page](https://github.com/Adoniyas1/BridgeDeck/releases) (sign in to GitHub
   if the repository is private) and download `BridgeDeck_<version>_x64-setup.exe` from the newest
   release.
2. Run it. The installer isn't signed, so Windows shows **"Windows protected your PC"**: press
   **More info**, then **Run anyway**.
3. It installs for your user only (no administrator password needed) into
   `%LOCALAPPDATA%\BridgeDeck`, and adds BridgeDeck to the Start menu.
4. Continue with [First launch on Windows](#first-launch-on-windows).

If no release exists yet, someone with access to the repository makes one: **Actions → Release →
Run workflow**.

## Build from source

### 1. Install the tools (once)

Open **PowerShell** (Start → type "PowerShell") and run these one at a time. `winget` comes with
Windows 10 and 11; accept its prompts.

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install Rustlang.Rustup
winget install GoLang.Go
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --wait"
```

- **Git** fetches the code. **Node.js** builds the window. **Rust** builds the core. **Go** builds
  the Syncthing engine behind the Sync tab.
- **Visual Studio Build Tools** with "Desktop development with C++" is the compiler Rust needs on
  Windows. The last command installs just that; it takes a while.
- **WebView2**, which shows BridgeDeck's window, is already part of Windows 10 and 11. If it's
  missing, install the Evergreen Runtime from Microsoft.
- Node.js 22 is what BridgeDeck is tested with. If `winget` gives you a newer major version and
  something fails, install 22 from [nodejs.org](https://nodejs.org) instead.

**Close PowerShell and open a new window** so it finds the new programs, then check them. Each
should print a version:

```powershell
git --version
node --version
rustc --version
go version
```

If `rustc` isn't found, run `rustup default stable-msvc` and open a new window again.

### 2. Build BridgeDeck

```powershell
git clone https://github.com/Adoniyas1/BridgeDeck.git $HOME\BridgeDeck
cd $HOME\BridgeDeck
npm install
npm run vendor:fetch      # the pinned LocalSend and Syncthing source
npm run runtime:build     # builds BridgeDeck's own Syncthing (needs Go)
npm run verify:project
npm run tauri build
```

The installer is built in `src-tauri\target\release\bundle\nsis\`. Install it (it replaces any
older copy and starts BridgeDeck):

```powershell
scripts\install-windows-silent.cmd
```

or double-click the `BridgeDeck_<version>_x64-setup.exe` in that folder.

Keep the `$HOME\BridgeDeck` folder: Mimir and source updates run from it.

To try changes without installing, run `npm run tauri dev` instead of `npm run tauri build`.

## First launch on Windows

- **Firewall:** Windows asks whether BridgeDeck may use the network. Tick **Private networks** and
  press **Allow**. Without it the Mac can't find the PC, and Files, Sync and Remote don't work.
  Your home network should be set to **Private** (Settings → Network & internet → your
  connection → Network profile type).
- **Remote control of this PC** needs no extra permission. The PC shows a banner and a **Stop**
  button whenever it's being controlled, and can be set to ask first.
- **Messages** (iMessage) lives on the Mac. On the PC you read and send them through the paired
  Mac.
- **Spotify** starts in app mode on Windows, because Windows' web view can't play Spotify's
  protected music. Install the Spotify app and BridgeDeck controls it.
- **Browser:** Chrome extensions work on Windows. Add them in **Settings → Web pages →
  Extensions**.

## Optional tools for some tabs

Most things work straight away. A few tabs use programs from your PC, and each tells you what's
missing with the fix. In the **Code** tab, click the compiler's version at the top right, then
**Check all** to test every language at once.

| For | Install |
| --- | --- |
| C, C++ (Code) | [MSYS2](https://msys2.org) and its gcc (`winget install MSYS2.MSYS2`), or Visual Studio's clang |
| Python (Code) | `winget install Python.Python.3.12`, or [python.org](https://python.org) (tick **Add python.exe to PATH**) |
| MATLAB (Code) | MATLAB with your school's licence, or free GNU Octave: `winget install GNU.Octave` |
| Java (Code) | `winget install EclipseAdoptium.Temurin.21.JDK` |
| JavaScript, Go, Rust (Code) | Already installed if you built from source; otherwise nodejs.org, go.dev, rustup.rs |
| Verilog (Code) | Icarus Verilog from [bleyer.org/icarus](https://bleyer.org/icarus) |
| Shell scripts (Code) | Git for Windows includes bash (`winget install Git.Git`) |
| Arduino (Code) | Press **Set up Arduino** in the Arduino panel; BridgeDeck installs arduino-cli |
| Lectures from a link (Study) | BridgeDeck downloads yt-dlp when first used |
| SolidCraft CAD (CAD) | BridgeDeck downloads it (30 MB) when you press **Download SolidCraft** |
| Typeset PDF of a note (Notes) | BridgeDeck downloads Typst the first time you make one |

After installing a compiler, close and reopen BridgeDeck (or press **Check all**) so it finds it.

**Mimir** (from-source installs only): open the **Mimir** tab and press **Set up Mimir**. BridgeDeck
builds it once (a few minutes) and starts it with the app from then on. Pick its AI in ⚙ inside
the tab. On a PC with a graphics card, Mimir can set up local models (llama.cpp behind llama-swap)
and share them with the Mac on port 8080.

## Check that everything works

**Settings → About → Check new features** runs each newer feature for real on this PC (CAD,
circuit simulation, chapter splitting, the KiCad viewer, Arduino, lecture downloads, Anki import,
SolidCraft, Mimir) and says what to fix. **Copy the report** gives one text you can paste into a
chat or an issue. **Report a problem** on the same page sends the error log.

## Updating

Updates never install on their own. When a newer version is out, a banner at the top of the
window offers it: press **Update now** (BridgeDeck restarts when it's done). To look yourself, open
**Settings → Computers & updates** and press **Check now** under Updates.

- An installed release downloads and installs the newest GitHub release.
- A from-source copy pulls the newest code and rebuilds itself, which takes a while. Its
  **Rebuild from source** button also picks up changes that aren't in a release yet.

The paired Mac can also start an update on this PC; you approve it here first.

## Troubleshooting

- **`npm install` fails with EPERM, EBUSY or UNKNOWN:** something holds the files open.
  1. Quit BridgeDeck and stop Node: `Get-Process node -ErrorAction SilentlyContinue | Stop-Process`.
  2. Delete the `node_modules` folder.
  3. Run `npm install` again.
- **npm says install scripts were blocked:** run `npm approve-scripts`, then `npm rebuild`.
- **`'tauri' is not recognized`:** `npm install` didn't finish. Run it again, and always use
  `npm run tauri …`, not a global `tauri`.
- **`npm run runtime:build` says Go is missing:** install Go, open a **new** PowerShell window, and
  run it again. It makes `runtime\windows\syncthing\syncthing.exe`, which the Sync tab runs hidden.
- **`link.exe` not found, or "linker `link.exe` not found":** the Visual Studio Build Tools aren't
  installed with "Desktop development with C++". Run the Build Tools command above again.
- **rustc crashes during `npm run tauri build`:** build with less at once:

  ```powershell
  $env:CARGO_BUILD_JOBS="1"; $env:CARGO_PROFILE_RELEASE_OPT_LEVEL="2"; $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS="16"; npm run tauri build
  ```

- **The Mac can't find the PC:** allow BridgeDeck through the firewall on **Private** networks
  (Windows Security → Firewall & network protection → Allow an app through firewall), and make sure
  your network profile is Private. UDP 41415 and 41416 must be open between the two computers.
- **Mimir says Node.js isn't installed:** install Node.js 22 from nodejs.org, restart BridgeDeck,
  then press **Start**.

See [docs/SECURITY.md](docs/SECURITY.md) before pairing, and
[docs/SOURCE_SYNC.md](docs/SOURCE_SYNC.md) for how the two computers share work.
