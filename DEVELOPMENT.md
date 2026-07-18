# Tabulon — developer guide

A cross-platform desktop app for playing 125 board games, built with **Tauri 2** and the **Jocly** JS library. A migration of [JoclyBoard](https://github.com/mi-g/joclyboard) (Electron) to Tauri.

Main features: 2D/3D boards, human vs AI play, clocked games, game import/export, per-game rules, favorites and templates, any number of simultaneous games, English/French UI (locale detected from the system).

For the internal architecture (window inventory, JS ⇄ Rust protocol, satellite-window events), see the "Internal architecture" section below.

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
import dialog accepts both `.tabulon-ext` and `.zip`. The whole catalogue is
produced in one shot by `node scripts/export-all.mjs [outdir] [--dist path]`:
it packages **every module** into `outdir/modules/` and **every game** into
`outdir/games/`, each with a static `index.html` (games grouped by module,
then alphabetically) plus a small landing page — the `outdir` content is
published as-is under `ext/`. Published extensions are (or will be)
downloadable from:

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

## Remote play 

Two ways to play a Jocly game against a remote human, both entered through
the **Invitation** window (hub game panel, next to Quick play / Clocked
play): a shared **HTTP relay**, or **peer-to-peer with no server at all**.
The sections below describe the **current state**, not the development
history (that history is in the branch's commit log); the "Design
background" subsection at the end keeps the still-relevant parts of the
original design analysis.

### Common architecture

- `players[key]` in `play.js` accepts a third shape alongside `null`
  (local human) and a level object (AI): `{remote:true, matchId,
  relayUrl}` for a relay opponent, or `{remote:true, peer:true, matchId}`
  for a peer-to-peer one. `gameLoop()` branches three ways: local human
  turn, local AI turn, remote turn (waits for the opponent's move from the
  active channel). Every move played *locally* — from the board, the AI,
  or the "Possible moves" window — is pushed to the active channel.
- `RemoteChannel` (`app/content/remote-channel.js`) is the
  transport-agnostic interface (`start`/`stop`/`push`/`onRemoteMove`),
  with two implementations: `HttpRelayChannel` and `PeerChannel`.
  `ensureRemoteChannel()` picks the class from the player config; a side
  configured as remote gets its channel **immediately** (not lazily), so
  a host's first move is always pushed. Every "abort the current turn"
  spot (pause, takeback, restart, player reconfiguration, board/game
  loading, rollback) also cancels a pending wait for a remote move.
- **Known limitation**: takeback/rollback/restart change the local
  position without propagating (neither transport has an "unplay"
  concept). `resetBaseline()` keeps the local channel bookkeeping
  consistent, but the two sides can desync until the next pushed move.
  A resync story (e.g. pushing the full engine state on demand, which the
  `'jocly-simple-match'` codec already does on every move) is an open
  item.
- The Players window shows a remote side as "Remote player" and
  **preserves** its full configuration (`codec`, `gameName`, `relayUrl`,
  peer flags) on Save as long as the match id field is left unchanged;
  typing a new match id manually falls back to a plain relay config on
  the default relay. The footer's quick player select mirrors the remote
  state (display-only; picking it opens the Players window).

### HTTP relay mode

- `HttpRelayChannel` polls a relay speaking the wire protocol of
  jocly-simple-match's `fileio.php`
  (<https://framagit.org/jcfrog/jocly-simple-match>) — a dumb per-match-id
  key/value store. Any existing instance works as-is (default: the
  biscandine.fr test instance). Requests go through `tauri-plugin-http`
  (`httpFetch` in `tauri-bridge.js`), not the webview's `fetch` (the relay
  sends no CORS headers); allowed relay hosts are scoped in
  `src-tauri/capabilities/default.json` (`http:default` → `allow[].url`).
- Two wire codecs (`remote-relay-protocol.js`): `'tabulon'` (our JSON
  envelope, default) and `'jocly-simple-match'` (their exact format,
  `matchdata` = full engine state via `joclyMatch.save()`). Games joined
  or created through an invitation link use the latter automatically, so
  **a Tabulon player and a jocly-simple-match web player can share the
  same match on the same relay** — validated live in both directions
  (`scripts/check-jocly-compat.mjs`).
- The Invitation window **joins** a match from a pasted
  `index.php?game=…&mid=…&player=…` link, or **creates** one: it
  generates a match id, shows the link for the opponent (`player=b`),
  publishes the starting position to the relay immediately (so the relay
  is never empty for whoever opens the link — `fileio.php` returns a PHP
  warning, not JSON, for a never-saved id), and offers a **Test** button
  probing the relay URL's reachability before playing.

### Peer-to-peer mode (no server at all)

- **Why not WebRTC — an empirical finding, revisitable.** Distribution
  builds of WebKitGTK (Tauri's Linux webview engine; checked on Ubuntu
  24.04, WebKitGTK 2.52) are **compiled without WebRTC**:
  `typeof RTCPeerConnection === 'undefined'`, regardless of the
  `enable-webrtc` setting or GStreamer plugins — the symbols are absent
  from the library. Reproduce (or re-check on a newer distro) with
  `scripts/check-webrtc-webview.py`. Moreover, with "no server at all" as
  the requirement there is no STUN/TURN, so WebRTC would yield only
  *host* ICE candidates — exactly the reachability of plain TCP. The
  transport therefore lives in **Rust**
  (`src-tauri/src/commands/peer_cmds.rs`): identical on all three OSes,
  independent of each webview engine, owned by the app (the Invitation
  window establishes the session, the game window attaches afterwards),
  and needing **one** manual code instead of WebRTC's offer + answer.
  **Future work**: WebRTC is worth re-evaluating if webviews start
  shipping it — with a STUN/TURN server it would add the NAT traversal
  TCP cannot offer; the probe script is the tool for tracking that.
- **The transport**: the host listens on TCP (OS-assigned ephemeral port,
  or a **fixed port** entered in the Invitation window — a taken port is
  a visible error, never a silent fallback that would break a router
  forwarding rule). The guest tries each address from the invitation
  code. A one-line JSON handshake carries a 128-bit session token; a
  wrong token is refused and the host keeps listening. Both sides then
  relay newline-delimited JSON lines (the `'tabulon'` envelope). Received
  lines are broadcast to the webviews (`tabulon-peer://message`); the
  last one is kept (`peer_last_message`) so a game window subscribing
  after session establishment catches up. One peer session at a time.
- **The invitation code** (`remote-peer-protocol.js`, pure logic):
  `TBP1-<base64url of {v,gameName,ips,port,token}>`, single line,
  whitespace-tolerant, accepted with or without its `TBP1-` prefix (a
  double-click copy easily loses it). Addresses: optional **public
  IP/host names first** (DynDNS-style names resolve via `ToSocketAddrs`;
  several allowed), then the default-route local IP and `127.0.0.1` as
  fallback; IPv6 literals are bracketed on connect.
- **Flow**: the host picks "peer-to-peer" in the Invitation window,
  optionally fills the Port and public-address fields (for Internet play:
  port-forward on the router, same port both sides is simplest), clicks
  *Create a code* and sends it; the guest pastes it and clicks *Connect*.
  Host plays A, guest plays B; the host's *Start* unlocks when the
  connection lands. `PeerChannel` attaches to the Rust session; a
  disconnection is surfaced in the footer — **no automatic
  reconnection**, a fresh code starts a new session.
- **Limits, stated plainly** (the price of "no server at all"): no NAT
  traversal — the guest must be able to route to the host (same LAN, VPN,
  or public IP + port forwarding; CGNAT/strict-NAT hosts cannot host and
  should use the relay mode). The stream is **unencrypted** — the token
  gates access, the moves travel in clear. The host's public IP, when
  provided, is embedded in the code — share it accordingly.

### Validation and open items

The Rust transport is exercised by `cargo test` with a **real TCP
session** on localhost (handshake, bidirectional relay, wrong-token
refusal with the listener surviving, fixed-port binding, clean shutdown).
The JS side is covered by the `tests/test-remote-*.mjs` suites (protocol,
channels, invitation codes — including a real-world regression fixture
for the prefix-less code) and the live probes `scripts/check-remote-relay.mjs`
and `scripts/check-jocly-compat.mjs`. The full two-machine flow (two
Tabulon instances exchanging a code over a real network) is the part only
a manual test exercises.

Open items, from the design comparison below: push/WebSocket instead of
polling for the relay transport; a saved-contact address book for
peer-to-peer; a match-resume story (persist `matchId` + side + transport
with the game, piggybacking on the existing Save/Load format rather than
inventing a new one); and the WebRTC re-evaluation noted above.

### Design background

Distilled from the original design analysis; kept here because it still
explains *why* the current shape was chosen.

- **The Jocly engine is transport-agnostic** — proven by
  jocly-simple-match: `Match` exposes everything needed (`save()`,
  `load()`, `playMove()`, `getTurn()`, `userTurn()`, `abortUserTurn()`)
  without knowing anything about the network. Their whole "server" is a
  per-match text file (`fileio.php`) holding
  `{matchDetails, matchdata (= match.save()), time, key}`; the client
  polls while waiting (a full reload only on a fraction of the ticks) and,
  when `nbTurns` changed, loads the state *before* the last move then
  `playMove()`s it — so the opponent's move is animated instead of the
  board jumping to the final position. Player identity is just the
  `?player=a`/`?player=b` link; the `key` field is never actually
  verified — security rests entirely on the match id being unguessable.
  That contract (matchId + serialized `match.save()` + move detection by
  turn count) is exactly what `HttpRelayChannel` reproduces.
- **Transports considered, and why these two**: a relay (polling now,
  push/WebSocket as an upgrade path) is the shortest path and can reuse
  any existing jocly-simple-match instance — its cost is that *someone*
  hosts it, and the relay sees the moves. Peer-to-peer avoids any server;
  WebRTC was ruled out empirically (see above), and without STUN/TURN it
  would not have connected anything plain TCP cannot reach anyway.
  Also considered and set aside: a synced folder (Dropbox/Syncthing) as a
  mailbox — zero network code but latency and tooling assumptions on both
  sides; move-per-message over email/XMPP/Matrix — correspondence-play
  UX, no live feel. Both remain possible `RemoteChannel` implementations
  if ever wanted, which is the point of the interface.
- **Minimal security posture, stated**: unguessable match ids (UUID-class)
  for the relay, the 128-bit token for peer sessions, and no claim of
  confidentiality — neither transport encrypts by itself (the relay is
  only as private as its HTTPS and its operator; the peer stream is plain
  TCP).

## Internationalization (i18n)

`app/content/tabulon-i18n.js` holds an `en`/`fr` dictionary (`en` is the
source of truth; unknown keys fall back to it). The locale comes from the
**system** (`os.locale()` from plugin-os, falling back to
`navigator.language`, then `en`; the bridge is imported as a namespace on
purpose, so a missing export degrades instead of killing the page); the
detected locale is shown in the About panel. Static HTML text is wired
with `data-i18n` (`textContent`), `data-i18n-title` (`title`), or
`data-i18n-placeholder` (`placeholder`) — `translateDom()` applies the
dictionary to every element carrying one of these on `DOMContentLoaded`,
automatically, for any page that imports the module (most satellite windows
already do, for the window title). Dynamic JS text uses `t('key', vars)`
after `await initI18n()`.

Every satellite window has its static labels wired with `data-i18n*`
attributes — importing the module and calling `initI18n()` is not enough
on its own: a label with no attribute just stays in the language the HTML
was written in, dictionary entry or not. Keep that in mind when adding a
window or a label.

One thing `data-i18n` can't reach: AI level labels (`levels[i].label` in the
Players/footer dropdowns, e.g. "Easy", "Fast [1sec]", "Papa") come from the
Jocly engine's own game modules, not from Tabulon's HTML — there's nothing
to put a `data-i18n` attribute on. `translateLevelLabel()` in
`tabulon-i18n.js` is a small overlay for this specific case: a table of the
level-label vocabulary found across jocly2's games (surveyed directly in the
engine source, not guessed), translating the base word and leaving any
`[Nsec]`/`(Nsec)` duration suffix untouched. A label outside that table
(a game not covered, or a genuinely new one added later) is returned
unchanged rather than left blank — no dictionary entry means no visible gap,
just English where French would be nicer to have.

**Localized rules pages** (`info.js::DocCandidates`), in priority order:
1) the language key declared by the game's `*-config.js` (e.g. `rules.fr` —
free-form file name); 2) probing an `_fr` suffix next to the `en` file;
3) the `en` file.

## Scripts

All scripts live in `scripts/` and run with Node (≥ 20), no install needed.

| Script | Role |
|---|---|
| `check-dist.mjs` | Build guard, run automatically by `npm run dev` / `npm run build`. Validates `dist-minimal/` (engine present, non-empty index) and generates it — default selection — only when missing or invalid. **Never modifies a valid `dist-minimal/`**: the builder's selection is kept as is, whatever the `dist/` timestamps. |
| `make-minimal-dist.mjs` | Builds `dist-minimal/` (the embedded library) from a full `dist/`. The module selection belongs to whoever builds: `node scripts/make-minimal-dist.mjs chessbase checkers` (default: `fourinarow`; also `TABULON_MODULES="a,b"`). Fails loudly — and leaves nothing behind — if the selection keeps no game or a game file is missing. Remember `rm -rf src-tauri/target` afterwards so the build re-embeds it. |
| `make-extension.mjs` | Packages extensions without the app — the tool that feeds the extension catalogue. Game: `node scripts/make-extension.mjs seireigi out/`. Module: `node scripts/make-extension.mjs --module margo out/`. Source: the repo's `dist/` by default, or any dist via `--dist path` (including a single-module gulp build). Mirrors the Rust logic in `src-tauri/src/commands/extension_cmds.rs` — keep both in sync. |
| `export-all.mjs` | One-shot full export of a dist into the publishable catalogue: every module to `modules/`, every game to `games/`, each with a static `index.html` (download links; games grouped by module then sorted by title) and a landing page. `node scripts/export-all.mjs [outdir=ext] [--dist path]`, then publish `outdir` content under `ext/` on GitHub Pages. Reuses `make-extension.mjs`; a failing item is reported and does not stop the run (exit 1 at the end). |
| `check-webrtc-webview.py` | Empirical probe: does the embedded webview (WebKitGTK on Linux) expose `RTCPeerConnection`? Loads an offscreen WebView and, if the API exists, runs a full local WebRTC loopback (offer/answer, ICE without STUN, DataChannel ping/pong) and prints a JSON verdict. Current verdict (Ubuntu 24.04 / WebKitGTK 2.52): **no** — distribution builds are compiled without WebRTC, the finding that steered peer-to-peer play to the Rust TCP transport. **Keep it around to re-evaluate WebRTC in the future**: rerun on new distros/WebKitGTK releases; if it ever reports a working DataChannel, WebRTC (with STUN/TURN) becomes a candidate transport adding the NAT traversal TCP lacks. Needs `python3-gi gir1.2-webkit2-4.1 xvfb`; run: `xvfb-run -a python3 scripts/check-webrtc-webview.py`. Linux-only by nature (WebView2/Chromium on Windows ships WebRTC). |
| `check-remote-relay.mjs` | Live smoke test of the remote-play HTTP protocol against a real jocly-simple-match `fileio.php` instance: `node scripts/check-remote-relay.mjs [relay-url]` (default: biscandine.fr's instance). Writes/reads only a randomly-generated test match id. |
| `check-jocly-compat.mjs` | Same idea, for the `'jocly-simple-match'` codec specifically: `node scripts/check-jocly-compat.mjs [relay-url]`. Confirms both directions — what Tabulon writes has the exact shape `control.js` expects, and Tabulon correctly reads a payload shaped exactly like what `control.js` itself writes. |

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

## Internal architecture

> History: a SharedWorker architecture ("one application brain") was
> explored and **abandoned**. In the current architecture, each match's
> business core lives in its own `play.html` window.

```
┌────────────────────────────┐
│ hub.html  (single window)  │  game list + detail panel
└──────────┬─────────────────┘
           │ tRpc.call('new_match', …)          [Tauri invoke]
           ▼
┌────────────────────────────┐   1 window per match; Jocly runs here
│ play.html #matchId         │   (attachElement → iframe): game loop
│  = the match's brain       │   human/AI/remote, clock, save/load, skins
└──────────┬─────────────────┘
           │ Tauri events  play-req / play-rep / play-event :{matchId}:*
           ▼
┌────────────────────────────┐   satellite windows = pure views
│ history, clock, players,   │   (no business state; they query play.js
│ view-options, info, camera │    and listen to its pushes)
└────────────────────────────┘
```

- **Rust** (`src-tauri/`): window management (creation, persisted
  geometry), store, favorites/templates, native dialogs, file writing,
  video recording (ffmpeg), extension packaging
  (`extension_cmds.rs`, mirrored by `scripts/make-extension.mjs`), the
  peer-to-peer TCP session (`peer_cmds.rs`), and the external-dist
  protocol. **No game logic.**
- **`window.Jocly`**: loaded in every page that needs it via
  `<script src="../browser/jocly.js">` (the jocly2 build copied into
  `dist/`, merged at the web root by `frontendDist: ["../app", "../dist"]`).

### Window inventory

| File (app/content/) | Role |
|---|---|
| `hub.html/js` | Main window: sidebar (All/Favorites/Templates/Extensions/About), game list with shortcuts (favorite, rules, quick play), detail panel (animated visuals, action buttons — including Invitation — and the game's templates). Tablet-responsive (icon sidebar < 900 px, list **or** detail view < 680 px). |
| `play.html/js` | The board + the match's brain: game loop (`userTurn`/`machineSearch`/remote channel), clock state, JSON save/load, snapshot, fork, pause, A/B player and skin (2D/3D) selectors in the footer. The `…` button toggles button bar ⟷ selectors. |
| `invitation.html/js` | Remote-play entry point: join a relay match from a link, create one (id + shareable link, relay Test button), or peer-to-peer host/connect with a `TBP1-…` code. See "Remote play" above. |
| `extensions.html/js` | Import/export/uninstall of game and module extensions (Games/Modules tabs); the hub is notified through `relay_to_window('main','extensionsChanged')` and reloads its list. |
| `clock-setup.html/js` | Clocked-game configuration → `new_match(game, clock)`. |
| `clock.html/js` | Clock display (7-segment font); pure view over play.js state. |
| `history.html/js` | Played-moves navigation (takeback, replay, resume from a position). |
| `players.html/js`, `view-options.html/js`, `camera-view.html/js`, `save-template.html/js`, `info.html/js`, `book.html/js`, `moves`, `open-position`, `show-position` | Various satellites. `info` loads localized rules/description/credits (see i18n). |

Shared modules: `tauri-bridge.js` (access to `window.__TAURI__`; see its
header for the `withGlobalTauri` rationale), `tabulon-rpc.js`
(name → payload mapping of Rust commands), `tabulon-i18n.js`,
`tabulon-winutils.js` (window init/title/ready), `remote-channel.js` /
`remote-relay-protocol.js` / `remote-peer-channel.js` /
`remote-peer-protocol.js` (remote play), `asset-rewrite.js` (external
dist), `tabulon.css`.

### Communication protocols

**UI → Rust (request/response)**: `tRpc.call('name', ...args)` →
`invoke('name', mappedPayload)`. The args → payload mapping is centralized
in `tabulon-rpc.js`: **every new Rust command must be added there.**
Current inventory (from `lib.rs`'s `generate_handler`):

- `fs_cmds`: `parse_pjn`, `read_text_file`, `save_text_file`,
  `save_data_uri_file`, `get_dist_info`
- `hub_cmds`: `get_app_info`, `notify_user_response`
- `match_cmds`: `new_match`, `is_favorite`, `set_favorite`,
  `notify_user`, `open_show_position`
- `template_cmds`: `play_template`, `save_template`, `remove_template`,
  `is_template_name_valid`
- `video_cmds`: `start_recording`, `record_frame`, `stop_recording`
- `window_cmds`: `open_history`, `open_clock`, `open_clock_setup`,
  `open_players`, `open_view_options`, `open_camera_view`,
  `open_save_template`, `open_info`, `open_invitation`,
  `open_extensions`, `open_board_state`, `open_book`, `open_moves`,
  `open_position`, `relay_to_window`
- `extension_cmds`: `list_extension_games`, `export_extension`,
  `import_extension`, `remove_extension`, `export_module`,
  `remove_module`
- `peer_cmds`: `peer_host_start`, `peer_connect`, `peer_send`,
  `peer_last_message`, `peer_status`, `peer_stop`

**Rust → UI (fire-and-forget pushes)**: hub listens to `updateFavorites`,
`updateTemplates`, `notifyUser` (banner + reply via
`notify_user_response`) and `extensionsChanged`; every window can receive
`tabulon-peer://message` / `tabulon-peer://status` (peer session).

**Satellites ⇄ play.js** (the central protocol), per match, defined in
`play.js::initSatelliteListeners()`:

```
request : emit('play-req:{matchId}:{action}', payload)      satellite → play
reply   : listen('play-rep:{matchId}:{action}')             play → satellite
push    : listen('play-event:{matchId}:{event}')            play → satellites
```

Served actions: `get-clock`, `get-view-options`/`set-view-options`,
`get-players`/`set-players`, `get-possible-moves`,
`input-move`/`show-move` (Possible moves window),
`get-camera`/`set-camera` (3D camera view),
`get-board-state`/`load-board-state` (show/open-position windows),
`rollback-to`, `get-played-moves`… Pushes: `update-clock` (turn change,
game end), `move-played` (after every move, a Load or a book replay).

**PGN/PJN books**: hub.js drops the file content into the store
(`book:{game}`); book.html parses it through the Rust `parse_pjn` command
(tolerates \r\n and repeated empty lines) and lists the games; on click,
the extracted SAN moves are stored under `fork:{id}` with a `book` marker
and `new_match` opens a board that replays them via `pickMove`/`playMove`
(game paused, navigation through the History window).

### The clock (JoclyBoard model, ported)

State lives in `play.js`: `{mode, 1: ms, -1: ms, xtrasec_±1, mps_±1,
turn, t0}`. On every turn change, `ClockTurn()` debits the elapsed time
from the player who just moved (+ per-move bonus / per-session re-credit
in countdown mode) then sets `t0`/`turn`; `ClockStop()` settles at game
end. Without a clocked game, a *countup* clock still runs (cumulated
thinking time). `clock.html` only displays (current time computed
view-side from `turn`/`t0`).

### Store (plugin-store, `tabulon.json`)

Notable keys: `nav-last`, `last-game`, `favoriteGames`, `templates`,
`view-options:{game}`, `clock` (last setup values), `play-footer-bar`
(visible button bar), `window:{label}` (geometry), `fork:{id}` (position
transfer on fork), `book:{game}` (book file content).

### Video capture

`play.js` pumps JPEG frames (`viewControl('takeSnapshot',
{format:'jpeg', quality})`) to the Rust `record_frame` command, which
pushes them onto the stdin of an ffmpeg spawned by `start_recording`
(`-f mjpeg … libx264`; `-loglevel error` is mandatory with a piped stderr,
otherwise the buffer deadlocks). Sequential self-rescheduling loop (no
`setInterval` piling up concurrent 3D captures); idle periods are skipped
after `video-record:ignoreIdenticalFrames` identical frames (default 30);
capture is unavailable in 2D skins (Jocly limitation: WebGL rendering
required — buttons greyed with a tooltip). **Ending a recording**: the MP4
is only readable after ffmpeg's stdin is closed (moov atom); three paths
lead there — the Record video toggle, the dedicated Stop button, and two
automatic safety nets when the game window closes mid-recording
(`beforeunload` JS-side + a `WindowEvent::Destroyed` hook on `play-{id}`
in lib.rs → `finalize_recording`). Prerequisite: ffmpeg in the PATH.

### External dist, under the hood

The user-facing behaviour is in "Bundled games vs full library" above;
the mechanism (`dist_override.rs` + `asset-rewrite.js`):

1. `dist_override::external_dist()` looks for a usable dist —
   `TABULON_DIST`, `$APPIMAGE` (the .AppImage's folder, not the temporary
   mount), `<exe>/dist`, with .app/AppImage walk-ups — resolved once
   (`OnceLock`).
2. If present, a custom `tabulon-dist://` protocol serves its files
   (falling back to the embedded `asset_resolver()`), with a traversal
   guard (`..` rejected).
3. `asset-rewrite.js` (injected through `initialization_script` on every
   window) rewrites `browser/**` and `games/**` on the fly (script/img/
   link + fetch + XHR) to that protocol. `content/**` is never redirected:
   the UI shell always stays embedded.
4. `get_dist_info` exposes the state (external/embedded + path) to the UI.

Without an external dist the protocol is never hit and the script not
injected — behaviour identical to before the feature.


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
events. Details in the "Internal architecture" section above.

## License

AGPL-3.0 (see `package.json`).
