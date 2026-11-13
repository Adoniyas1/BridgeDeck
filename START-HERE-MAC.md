# BridgeDeck on the Mac

There are two ways to get BridgeDeck on a Mac:

| | Download the app | Build from source |
| --- | --- | --- |
| Time | About 5 minutes | About 30 minutes the first time |
| Needs | Nothing extra | Xcode tools, Node.js, Rust, Go |
| **Mimir** (the assistant tab) | Not included | Included |
| Updates | One click, from GitHub releases | One click, rebuilt from the latest code |

Mimir runs from the source folder, so if you want the assistant, build from source.

- [Download the app](#download-the-app)
- [Build from source](#build-from-source)
- [Permissions macOS asks for](#permissions-macos-asks-for)
- [Optional tools for some tabs](#optional-tools-for-some-tabs)
- [Check that everything works](#check-that-everything-works)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)

macOS 13 (Ventura) or newer is needed. Both Apple-silicon and Intel Macs work.

## Download the app

1. Open [the Releases page](https://github.com/Adoniyas1/BridgeDeck/releases) (sign in to GitHub
   if the repository is private) and download `BridgeDeck_<version>_universal.dmg` from the newest
   release.
2. Open the `.dmg` and drag **BridgeDeck** into **Applications**.
3. Open BridgeDeck from Applications. The app isn't signed by Apple, so the first time macOS stops it:
   - **macOS 15 or newer:** macOS says it can't check the app. Press **Done**, open
     **System Settings → Privacy & Security**, scroll down to the message about BridgeDeck, press
     **Open Anyway**, and enter your password.
   - **macOS 13 or 14:** right-click (or Control-click) BridgeDeck in Applications, choose **Open**,
     then **Open** again.
   - **"BridgeDeck is damaged and can't be opened":** the download is fine; macOS marks unsigned
     downloads this way. In Terminal, run the command below, then open the app again.

     ```sh
     xattr -dr com.apple.quarantine /Applications/BridgeDeck.app
     ```

4. Continue with [Permissions macOS asks for](#permissions-macos-asks-for).

If no release exists yet, someone with access to the repository makes one: **Actions → Release →
Run workflow**.

## Build from source

### 1. Install the tools (once)

Open **Terminal** (Applications → Utilities) and run each step.

1. **Xcode Command Line Tools** (the C compiler, git and more):

   ```sh
   xcode-select --install
   ```

   A window opens; press **Install**. If it says they're already installed, go on.

2. **Node.js 22:** download the macOS installer for version 22 (LTS) from
   [nodejs.org](https://nodejs.org) and run it. With Homebrew you can run `brew install node@22`
   instead and follow the PATH line it prints.

3. **Rust:**

   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

   Press Enter for the default install, then close Terminal and open a new window.

4. **Go** (builds the Syncthing engine behind the Sync tab): the macOS installer from
   [go.dev/dl](https://go.dev/dl), or `brew install go`.

Check them in a **new** Terminal window. Each should print a version:

```sh
node --version    # v22.x
rustc --version
go version
```

### 2. Build BridgeDeck

```sh
git clone https://github.com/Adoniyas1/BridgeDeck.git ~/BridgeDeck
cd ~/BridgeDeck
npm install
npm run vendor:fetch      # the pinned LocalSend and Syncthing source
npm run runtime:build     # builds BridgeDeck's own Syncthing (needs Go)
npm run verify:project
npm run mac:signing       # optional, once: see below
npm run build:mac
```

The app is built at `src-tauri/target/release/bundle/macos/BridgeDeck.app`. Copy it into
Applications:

```sh
cp -R src-tauri/target/release/bundle/macos/BridgeDeck.app /Applications/
```

Keep the `~/BridgeDeck` folder: Mimir and source updates run from it.

**Why `npm run mac:signing`:** it makes a free signing certificate on this Mac (macOS asks for your
password once). Builds signed with it keep the permissions you gave (Screen Recording, Accessibility,
Full Disk Access) after every update. Without it, macOS treats each new build as a new app and
asks again.

To try changes without installing, run `npm run tauri dev` instead of `npm run build:mac`.

## Permissions macOS asks for

BridgeDeck asks when a feature first needs something. Allow the ones for the features you use;
**Home** shows any that are still missing, with a button to the right page of System Settings.

| Permission | Where in System Settings | Needed for |
| --- | --- | --- |
| Local Network, incoming connections | asked on first launch | Pairing, Remote, Files, Sync |
| Keychain: choose **Always Allow** | asked on first launch | Keeping credentials safe without asking each time |
| Full Disk Access | Privacy & Security → Full Disk Access | Messages (reading the Messages database) |
| Automation | Privacy & Security → Automation | Sending iMessages, saving contacts, controlling the Spotify app |
| Screen Recording | Privacy & Security → Screen & System Audio Recording | Letting the PC control this Mac (Remote) |
| Accessibility | Privacy & Security → Accessibility | Remote mouse and keyboard |
| Microphone | asked when used | Talking to Mimir; recording lectures |
| Camera | asked when used | Mimir taking a photo when you ask it to look at something |
| Calendars, Reminders | asked when turned on | Showing Apple Calendar and Reminders in Calendar |

After turning on Full Disk Access, Screen Recording or Accessibility, quit BridgeDeck and open it
again so macOS applies it.

## Optional tools for some tabs

Most things work straight away. A few tabs use programs from your Mac, and each tells you what's
missing with the fix. In the **Code** tab, click the compiler's version at the top right, then
**Check all** to test every language at once.

| For | Install |
| --- | --- |
| C, C++ (Code) | `xcode-select --install` |
| Python (Code) | Comes with the Xcode tools, or [python.org](https://python.org) |
| MATLAB (Code) | MATLAB with your school's licence, or free GNU Octave: `brew install octave` |
| Java (Code) | `brew install openjdk`, or a JDK from [adoptium.net](https://adoptium.net) |
| JavaScript, Go, Rust (Code) | Already installed if you built from source; otherwise nodejs.org, go.dev, rustup.rs |
| Verilog (Code) | `brew install icarus-verilog` |
| Arduino (Code) | Press **Set up Arduino** in the Arduino panel; BridgeDeck installs arduino-cli |
| Lectures from a link (Study) | BridgeDeck downloads yt-dlp when first used |
| SolidCraft CAD (CAD) | BridgeDeck downloads it (30 MB) when you press **Download SolidCraft** |
| Typeset PDF of a note (Notes) | BridgeDeck downloads Typst the first time you make one |

`brew` is [Homebrew](https://brew.sh). If you don't use it, every tool above has a regular
installer on its own website.

**Mimir** (from-source installs only): open the **Mimir** tab and press **Set up Mimir**. BridgeDeck
builds it once (a few minutes) and starts it with the app from then on. Pick its AI in ⚙ inside
the tab: Claude with an API key, Ollama, or a local model server that Mimir can set up for you. On an
8 GB Mac, keep to the small models it suggests.

## Check that everything works

**Settings → About → Check new features** runs each newer feature for real on this Mac (CAD,
circuit simulation, chapter splitting, the KiCad viewer, Arduino, lecture downloads, Anki import,
SolidCraft, Mimir) and says what to fix. **Copy the report** gives one text you can paste into a
chat or an issue. **Report a problem** on the same page sends the error log.

## Updating

Updates never install on their own. When a newer version is out, a banner at the top of the
window offers it: press **Update now** (BridgeDeck restarts when it's done). To look yourself, open
**Settings → Computers & updates** and press **Check now** under Updates.

- A downloaded app installs the newest GitHub release.
- A from-source app pulls the newest code and rebuilds itself, which takes a few minutes. Its
  **Rebuild from source** button also picks up changes that aren't in a release yet.
- **Keep permissions after updates** (in the same place) sets up the signing certificate described
  above, so macOS stops asking for Screen Recording and Accessibility after each update.

The paired PC can also start an update on this Mac; you approve it here first.

## Troubleshooting

- **The window is blank or a tab says something is blocked:** run **Check new features** and
  send the report.
- **Permissions keep being asked after updates:** press **Keep permissions after updates** in
  **Settings → Computers & updates** (or run `npm run mac:signing` once and rebuild).
- **Messages shows nothing:** give BridgeDeck Full Disk Access, then quit and reopen it.
- **The PC can't find this Mac:** check that both are on the same network (or Tailscale), and that
  Local Network access is on in **System Settings → Privacy & Security → Local Network**.
- **`npm run build:mac` runs out of memory on an 8 GB Mac:** close other apps and run it again.
- **Mimir says Node.js isn't installed:** install Node.js 22 from nodejs.org (BridgeDeck also
  finds Node installed with Homebrew, nvm or Volta), then press **Start**.

See [docs/SECURITY.md](docs/SECURITY.md) before pairing, and
[docs/SOURCE_SYNC.md](docs/SOURCE_SYNC.md) for how the two computers share work.
