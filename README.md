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
game of the module). Whole **modules** can also be exported/imported (Modules tab): a module
extension contains the full `games/<module>/` tree plus the index declarations
of its games; importing it has no prerequisite (the module is the payload) and
merges over an existing module, uninstalling removes the whole module folder
and its games. The engine baseline (root `res/`, fairy-stockfish, `scan/` —
the draughts engine, only useful with checkers but kept at the jocly level)
never travels in extensions. Extensions can also be built without the app:
`node scripts/make-extension.mjs <game> [outdir]` or
`node scripts/make-extension.mjs --module <module> [outdir]` — with a full
dist or a single-module gulp build
(`gulp --no-default-games --modules src/games/<module> build`) as source —
the packaging tool that feeds the downloadable extension catalogue.

A `.tabulon-ext` file **is a standard zip** (rename or open it as one); the
import dialog accepts both `.tabulon-ext` and `.zip`. Published extensions
are (or will be) downloadable from:

- <https://fhoudebert.github.io/tabulon/ext/> — catalogue
- <https://fhoudebert.github.io/tabulon/ext/games> — game extensions
- <https://fhoudebert.github.io/tabulon/ext/modules> — module extensions

The "Get extensions…" link in the Extensions screen opens the page matching
the active tab. After an import or uninstall, the hub reloads its game list
automatically (the Jocly script loader caches the games index for the page
lifetime, so the hub performs a full reload).

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

## Remote play (experimental, `remoteplay` branch)

Playing a Jocly game against a remote human is being built incrementally on
the `remoteplay` branch — see `ANALYSE-JEU-DISTANCE.md` for the full design
(transport options compared: HTTP relay, WebRTC/direct P2P, other).

Step 1 landed the transport building block, developed and validated in
isolation:

- `app/content/remote-relay-protocol.js` — pure encode/decode logic for the
  relay's wire format (no fetch, no DOM — plain functions, unit-tested).
- `app/content/remote-channel.js` — the transport-agnostic `RemoteChannel`
  interface (`start`/`stop`/`push`/`onRemoteMove`) plus its first
  implementation, `HttpRelayChannel`: HTTP polling against a relay speaking
  the same wire protocol as jocly-simple-match's `fileio.php`
  (<https://framagit.org/jcfrog/jocly-simple-match>) — a dumb key/value
  store per match id, no server-side validation of the payload. This makes
  it usable, as-is, against an existing instance such as
  <https://biscandine.fr/variantes/joclymatch/fileio.php>, or a fresh
  deployment of the same PHP script.
- Requests go through `tauri-plugin-http` (`httpFetch` in `tauri-bridge.js`),
  not the webview's native `fetch` — the relay doesn't send CORS headers, so
  a browser-side `fetch` would be blocked; the Rust-side HTTP client isn't
  subject to that. Allowed relay hosts are scoped in
  `src-tauri/capabilities/default.json` (`http:default` → `allow[].url`);
  add a host there before pointing `HttpRelayChannel` at it.
- `scripts/check-remote-relay.mjs` exercises the protocol against a **real**
  jocly-simple-match instance from plain Node (no CORS there, so no plugin
  needed) — useful to check compatibility with a given relay before wiring
  it into the app.

Step 2 wires it into the game window:

- `players[key]` in `play.js` now accepts a third shape alongside `null`
  (local human) and a level object (AI): `{remote:true, matchId, relayUrl}`.
  Exactly one side would normally be remote — the other stays a local human
  (or even an AI, if you want to let it play unattended against a remote
  friend; nothing enforces "remote implies the other side is human").
- `gameLoop()` branches three ways: local human turn (`userTurn()`,
  unchanged), local AI turn (`machineSearch()`+`playMove()`, unchanged), and
  remote turn (waits for the next move from the active `HttpRelayChannel`,
  then `playMove()`s it). After any turn played *locally* (human or AI), if
  a remote channel is active, the move is pushed to it.
- The **Players** satellite window (`players.html`/`players.js`) gained a
  "Remote player" option per side, with a match id field (plus a "Generate"
  button — a non-guessable id, since — like jocly-simple-match — the relay
  itself has no real authentication, only the id's secrecy — and a "Copy"
  button to hand it to the other player through whatever channel you like:
  chat, email...) and a relay URL field (defaults to the same test instance
  as `check-remote-relay.mjs`).
- Every existing "abort the current turn" spot (pause, takeback, restart,
  reconfiguring players, loading a board state, rolling back, playing a move
  from the "possible moves" window) also cancels a pending wait for a remote
  move, so the game loop never hangs.
- **Known limitation, not addressed at this step**: takeback/rollback while
  a remote channel is active does not "unplay" anything on the relay side —
  the relay has no such concept (see `ANALYSE-JEU-DISTANCE.md` §6). The
  local game can desync from the relay's move counter until the next local
  move is pushed. Fine for now (this is still an experimental branch); a
  proper fix would mean periodically pushing a full state snapshot for
  resync, the way jocly-simple-match falls back to a full reload.

Still open: an actual invitation *screen* (currently just the match id/relay
url fields — good enough to test with a friend, copy-paste over chat, but no
dedicated "create/join a remote game" flow from the hub), and match resume
after the window is closed and reopened (the remote config isn't persisted
anywhere yet — reopening `play.html` for a fork/template/store-based resume
loses it, same as it does for the players' human/AI configuration today).

## Scripts

All scripts live in `scripts/` and run with Node (≥ 20), no install needed.

| Script | Role |
|---|---|
| `check-dist.mjs` | Build guard, run automatically by `npm run dev` / `npm run build`. Validates `dist-minimal/` (engine present, non-empty index) and generates it — default selection — only when missing or invalid. **Never modifies a valid `dist-minimal/`**: the builder's selection is kept as is, whatever the `dist/` timestamps. |
| `make-minimal-dist.mjs` | Builds `dist-minimal/` (the embedded library) from a full `dist/`. The module selection belongs to whoever builds: `node scripts/make-minimal-dist.mjs chessbase checkers` (default: `fourinarow`; also `TABULON_MODULES="a,b"`). Fails loudly — and leaves nothing behind — if the selection keeps no game or a game file is missing. Remember `rm -rf src-tauri/target` afterwards so the build re-embeds it. |
| `make-extension.mjs` | Packages extensions without the app — the tool that feeds the extension catalogue. Game: `node scripts/make-extension.mjs seireigi out/`. Module: `node scripts/make-extension.mjs --module margo out/`. Source: the repo's `dist/` by default, or any dist via `--dist path` (including a single-module gulp build). Mirrors the Rust logic in `src-tauri/src/commands/extension_cmds.rs` — keep both in sync. |
| `check-remote-relay.mjs` | Live smoke test of the remote-play HTTP protocol against a real jocly-simple-match `fileio.php` instance: `node scripts/check-remote-relay.mjs [relay-url]` (default: biscandine.fr's instance). Writes/reads only a randomly-generated test match id. |

Environment variables understood by the app itself: `TABULON_DIST`
(absolute path to an external dist, or `embedded`/empty to force the
embedded library — handy for testing the fallback), and at build time
`TABULON_MODULES` (default selection for `make-minimal-dist.mjs`).

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
