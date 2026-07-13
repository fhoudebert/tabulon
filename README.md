# Tabulon

A cross-platform desktop app for playing 125 board games, built with **Tauri 2** and the **Jocly** JS library. A migration of [JoclyBoard](https://github.com/mi-g/joclyboard) (Electron) to Tauri.

Main features: 2D/3D boards, human vs AI play, clocked games, game import/export, per-game rules, favorites and templates, any number of simultaneous games, English/French UI (locale detected from the system).

For the internal architecture (window inventory, JS ⇄ Rust protocol, satellite-window events), see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Prerequisites

- **Rust** (stable) + Cargo — via [rustup](https://www.rust-lang.org/tools/install)
- **Node.js ≥ 20** (npm)
- **Tauri CLI**: `cargo install tauri-cli --version "^2"`
- **ffmpeg** (only needed for the in-app video recording feature)
- **Linux only** — system packages for Tauri's WebView (Debian/Ubuntu):

  ```bash
  sudo apt update
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  See the [official Tauri prerequisites page](https://v2.tauri.app/start/prerequisites/) for other distros / macOS / Windows.

---

## Building Jocly

Tabulon does not depend on Jocly through npm. Jocly is built separately from
[jocly2](https://github.com/fhoudebert/jocly2), then its `dist/` output is
copied as-is to the root of this repo (`tabulon/dist/`, **not**
`node_modules/`):

```bash
git clone https://github.com/fhoudebert/jocly2.git
cd jocly2
npm install
npm run build          # runs `gulp build --prod`, produces jocly2/dist/

# copy the result into this repo, next to app/ and src-tauri/
cp -r dist /path/to/tabulon/dist
```

Rebuild and re-copy `dist/` whenever you update jocly2. Tauri merges `app/`
and `dist/` at the virtual web root (`frontendDist` in `tauri.conf.json`),
so `browser/jocly.js` and `games/**` resolve at runtime.

---

## Building Tabulon

From the `tabulon/` root, once `dist/` is in place:

```bash
# 1. Root dependencies (Tauri CLI wrapper scripts)
npm install

# 2. Frontend dependencies (@tauri-apps/*, jquery, photonkit, jsdom for tests)
npm --prefix app install

# 3. Run in development mode
npm run dev            # equivalent to: cargo tauri dev

# 4. Production build
npm run build          # bundles in src-tauri/target/release/bundle/
```

> **After changing files in `app/`** (or deleting/adding any frontend file),
> remove `src-tauri/target/` before rebuilding: stale embedded assets are the
> most common cause of "my change has no effect" / broken-page symptoms.

## Bundled games vs full library (externalized dist)

The compiled app embeds a **minimal** dist (`dist-minimal/`: the Jocly engine +
a few self-contained games), generated from a full `dist/` by
`scripts/make-minimal-dist.mjs` and produced automatically at build time. This
keeps the installer small and lets Tabulon run on its own.

To play the **full 125-game library**, drop a complete `dist/` folder next to
the executable — no rebuild needed:

```
tabulon/
├── tabulon.exe          (or tabulon.AppImage, Tabulon.app)
└── dist/                a full jocly2 build (browser/ + games/)
```

## Extensions (import/export games)

When an external dist is active, the **Extensions** screen (hub sidebar,
Configuration group) lets you export any installed game as a single
`<game>.tabulon-ext` file, import one, or uninstall it. An extension contains
strictly what the game's config declares: the code bundles
(`<game>-config/-model/-view.js`), the rules/credits/description pages, the
thumbnail and the visuals — plus the index declaration in `extension.json`.
Shared module resources (css, sounds, `res/` sprites/textures, rules graphs,
fairy-stockfish engines) always stay with the module: importing a game
requires its module to already exist in the target external dist, and
uninstalling never removes shared files (nor files still declared by another
game of the module). Extensions can also be built without the app:
`node scripts/make-extension.mjs <game> [outdir]` — the packaging tool for a
future downloadable extension list.

At startup Tabulon looks for a usable external dist in this order: the
`TABULON_DIST` environment variable (absolute path), then `dist/` next to the
program. For an **AppImage**, "next to the program" means next to the
`.AppImage` file itself (resolved via `$APPIMAGE`), not the temporary mount —
so place `dist/` in the same folder as `tabulon.AppImage`. For a macOS `.app`
bundle, place `dist/` next to the bundle. If found, requests for `browser/**` and `games/**` are
served from it (falling back to the embedded minimal dist for anything
missing); otherwise only the bundled games are available. The active source is
reported by the `get_dist_info` command (About panel / Extensions screen). The
app shell (`content/**`) always comes from the embedded build, so a stale
external dist cannot break the UI itself.

## Running the tests

Integration test suites live in [`tests/`](./tests). They exercise the real
frontend JS against the real HTML in jsdom, with only `window.__TAURI__`
mocked, plus the real Jocly `dist/` for game data:

```bash
npm test               # runs every tests/test-*.mjs and summarizes
node tests/test-i18n.mjs   # or any single suite
```

Prerequisites: `dist/` in place (see above) and `npm --prefix app install`
(jsdom). The runner checks both and tells you what is missing.

### Useful commands

```bash
# Type/borrow-check the Rust backend without a full build
cargo check --manifest-path src-tauri/Cargo.toml

# Regenerate app icons from a source PNG (square, ≥1024×1024)
cargo tauri icon path/to/source.png
```

---

## Project layout

```
tabulon/
├── app/            Frontend: one HTML/JS pair per window (hub, play,
│                   clock, history, …) + shared modules (tabulon-rpc.js,
│                   tabulon-i18n.js, tauri-bridge.js, tabulon.css)
├── dist/           Jocly build output — see "Building Jocly" above
├── src-tauri/      Rust backend: window management, store, favorites/
│                   templates, video recording — no game logic
├── tests/          Integration suites (jsdom) + run-tests.mjs runner
└── package.json    Root npm scripts (dev / build / test)
```

Game logic runs in `play.html` (Jocly attached in an iframe); satellite
windows (history, clock, players, …) are pure views talking to it over Tauri
events. Details in [ARCHITECTURE.md](./ARCHITECTURE.md).

## License

AGPL-3.0 (see `package.json`).
