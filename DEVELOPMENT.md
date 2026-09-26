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
└── engine  (expert mode)
    └── nnue  (optionnal)
    └── fairy-stockfish[.exe]  (expert engine)
```

## Extensions (import/export games)

When an external dist is active, the **Extensions** screen (hub sidebar,
Configuration group) lets you export any installed game as a single
`<game>.tabulon-ext` file, import one, or uninstall it. An extension contains
strictly what the game's config declares: the code bundles
(`<game>-config/-model/-view.js`), the rules/credits/description pages, the
thumbnail and the visuals — plus the index declaration in `extension.json`.

**Trust model.** An extension is *code*, not data: its model and view run
in the Jocly iframe, which is same-origin with the app and therefore
reaches `window.__TAURI__` and every Rust command (`save_text_file` writes
any absolute path). Its title, summary and rules are also inserted with
`innerHTML`. Sanitizing that HTML would not change anything while the game
code itself runs, so the boundary is the install step: the README tells
users to install only trusted extensions. Hardening worth doing later:
limit `save_text_file` / `save_data_uri_file` to paths the native save
dialog just returned, and set a CSP (`app.security.csp` is `null`).
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

**Reading the dist index.** `read_index()` (`extension_cmds.rs`) parses the
`exports.games = {…}` literal of `browser/jocly-allgames.js` with json5
(jocly's own build leaves keys unquoted). One extra step is needed for a
dist built in **production** mode: terser minifies booleans, so
`"obsolete": false` becomes `obsolete:!1` — valid JavaScript, but not JSON5,
and the whole screen used to fail with *"index non parseable (json5)"* on
such a dist (56 occurrences were enough in a real build).
`restore_minified_booleans()` turns `!0`/`!1` back into `true`/`false`
before parsing, leaving string contents untouched (a summary could contain
"!1"). Covered by unit tests for both a dev-style and a prod-style index.

**Localized summaries.** The command returns the game's `summary` **raw**
(string or `{locale: text}` object, see the i18n section) and the screen
localizes it with `pickLocalized()`, exactly like the hub — the summary is
shown under each game and is searchable. The `.tabulon-ext` manifest keeps
an English string (`summary_text()`), since it is a distribution artifact;
the full declaration, translations included, still travels inside it.

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
The sections below describe the **current state**; the commit log holds
the development history.

### Common architecture

- `players[key]` in `play.js` accepts a third shape alongside `null`
  (local human) and a level object (AI): `{remote:true, matchId,
  relayUrl}` for a relay opponent, or `{remote:true, peer:true, matchId}`
  for a peer-to-peer one. `gameLoop()` branches three ways: local human
  turn, local AI turn, remote turn (waits for the opponent's move from the
  active channel). Every move played *locally* — from the board, the AI,
  or the "Possible moves" window — is pushed to the active channel.
- `RemoteChannel` (`app/content/remote-channel.js`) is the
  transport-agnostic interface (`start`/`stop`/`push`/`onRemoteMove`, plus
  `onRemoteTakeback`/`onSettingsChange` and the `allowTakeback` setting
  shared by both implementations),
  with two implementations: `HttpRelayChannel` and `PeerChannel`.
  `ensureRemoteChannel()` picks the class from the player config; a side
  configured as remote gets its channel **immediately** (not lazily), so
  a host's first move is always pushed. Every "abort the current turn"
  spot (pause, takeback, restart, player reconfiguration, board/game
  loading, rollback) also cancels a pending wait for a remote move.
- **Taking back a move against a remote player** is a *setting of the
  match*, chosen by the host when creating the invitation (checkbox
  "Allow taking back moves", **unchecked by default**, remembered with the
  other invitation settings). It travels in the relay link as `tb=1` /
  `tb=0` (query string, not the fragment: joclymatch's page must read it)
  and in the peer code as `tb`; it is then copied into **every** write —
  `matchDetails.allowTakeback` for the jocly-simple-match codec,
  `allowTakeback` in our own envelope. Both codecs rebuild their details
  object on each save, so a field one side does not copy is erased by its
  first save: the copy is deliberate on both sides.
  - **The file wins over the link** (`resolveAllowTakeback`): the relay
    file is the same for both players, survives a reload and a truncated
    link. When nobody says anything, it is **forbidden** — the rule shared
    with joclymatch and mogichex: the other end of such a match may be an
    older client that cannot follow a takeback. Receiving a takeback never
    depends on the setting.
  - **Only on your own turn.** joclymatch polls the relay only while it
    waits for the opponent; during its own turn it sits in `userTurn()` and
    would never see a takeback — its next move, computed on the old
    position, would silently overwrite it. During *our* turn it is waiting,
    hence polling. Take back is therefore enabled when the match allows it,
    a local human input is pending (`localHumanTurn`, set around
    `userTurn()` in `gameLoop`) **and** at least two moves are played — on
    our turn the last move is the opponent's, and with a single one (A's
    first move seen by B) taking back would undo *their* move. The rule is
    the pure `remoteTakebackBlock()` in `remote-relay-protocol.js`, the same
    as joclymatch and mogichex; the tooltip names the reason
    (`play.remoteTakebackForbidden` / `NotYourTurn` / `NothingYet`), and the
    handler keeps a defensive guard. Against a remote side, Take back
    returns to *our* previous turn (our move and its answer).
  - **Restart is never offered against a remote side**
    (`play.remoteRestartForbidden`), as in joclymatch and mogichex: wiping
    the whole game on the opponent's board goes well beyond a takeback. A
    restart *received* from another client (`nbTurns` back to 0) is still
    followed.
  - **Sending** (`PublishTakeback`): after the local rollback, push the new
    `nbTurns` **and** the full state; `push()` moves the channel baseline
    itself — no `resetBaseline()` beforehand, which would let a poll reread
    the old file and see a move in it.
  - **Receiving**: a *decreasing* `nbTurns` is a takeback
    (`hasOpponentTakenBack`), routed to `onRemoteTakeback`, never to
    `onRemoteMove` — the latter would pop and replay the last move, undoing
    the takeback by one ply while animating a move nobody played (the same
    trap once fixed in joclymatch, a `!=` turned into `>` / `<`).
    `ApplyRemoteTakeback` loads the state as is, cancels the pending remote
    wait *after* loading, re-arms the loop, and shows a banner — the board
    changed on its own. Takebacks are queued, never interleaved.
  - **Stale reads**: a poll sent before our write may return after it,
    with the old, now *higher*, move count. `HttpRelayChannel` drops any
    poll answer read across a write or a baseline reset (`_generation`,
    `_pushing`). Peer-to-peer needs no such guard: TCP delivers lines in
    order and each one is a new message.
  - **Known limits.** An opponent client that predates the setting ignores
    it (an old joclymatch can still take back in a match created with the
    box unchecked; Tabulon follows its takeback anyway to stay in sync).
  - **Other position changes are refused against a remote side**
    (`remotePositionLocked()`, `play.remotePositionLocked`): `rollback-to`
    from the History window, loading a file, loading a board state. They
    only changed the local board, and the opponent's next move was then
    replayed on a different position. The History window still gets its
    acknowledgement (autoplay waits for it) and a `move-played` event so its
    selection returns to the real position. The move list can be read, not
    used to go back — as in mogichex.

- Remote play is **set up** in the Invitation window (both roles: join or
  create) and, for a guest only, from the **Invitation** entry in the hub
  sidebar — paste a relay link or a peer code and connect, without having
  to pick a game first (the game name comes from the invitation itself).
  Host-side actions stay in the Invitation window, since they need a
  selected game. The player dropdowns (footer quick select and Players
  window) show a disabled "Remote player (via Invitation)" entry: it
  exists to display the state of a side made remote by an invitation —
  the browser refuses to select it, and the label itself says where
  remote play is set up. The one exception: in the Players window, a side
  that is *currently* remote keeps the entry selectable, so switching
  away can be undone before Save (the original config is preserved via
  `lastReceivedRemote`).

- The Players window shows a remote side as "Remote player" and
  **preserves** its full configuration (`codec`, `gameName`, `relayUrl`,
  peer flags) on Save as long as the match id field is left unchanged;
  typing a new match id manually falls back to a plain relay config on
  the default relay. The footer's quick player select mirrors the remote
  state (display-only; picking it opens the Players window).

### HTTP relay mode

- `HttpRelayChannel` polls a relay speaking the wire protocol of
  joclymatch's `fileio.php` — a dumb per-match-id key/value store. Any
  existing instance works as-is (default: the biscandine.fr test
  instance). Two projects provide one, and either can host a Tabulon
  match — moves and chat alike:
  - [joclymatch](https://github.com/fhoudebert/joclymatch/): its own
    `fileio.php`.
  - [mogichex](https://github.com/fhoudebert/mogichex/) (branch `next`
    onwards): `deploy/fileio.php`, a translator in front of its
    `match.php` — it maps `gameioaction/gameid/gamedata` to mogichex's
    `action/mid/data`, serves `chatioaction` itself, and copies
    `X-Match-Mtime` into `X-File-Mtime`. Nothing to configure in Tabulon:
    the relay URL is the mogichex folder's `fileio.php`
    (e.g. `https://biscandine.fr/variantes/mogichex/fileio.php`). A link
    received from mogichex (`…/mogichex/index.html?game=…`) already leads
    there, since `parseInvitationUrl` swaps the last path segment for
    `fileio.php`. A link *created* by Tabulon on that relay points to
    `…/mogichex/index.php`, which does not exist: mogichex's `.htaccess`
    answers any missing file with its `index.html`, so the mogichex app
    opens on it anyway — it works *because of* that single-page rule.
  - Tauri only lets the relay requests out to the hosts listed in
    `src-tauri/capabilities/default.json` (`http:default` → `allow[].url`,
    today `https://biscandine.fr/*`). A joclymatch or mogichex hosted
    anywhere else needs its host added there first; otherwise the request
    is refused before it leaves the application.
- Requests go through `tauri-plugin-http`
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
  probing the relay URL before playing. A reply is not enough to pass
  (`classifyRelayProbe`): a mogichex folder *without* `fileio.php`
  answers 200 with its own `index.html`, and an error status means no
  script there either. A PHP warning still passes — that is what an
  original jocly-simple-match relay says about an unknown id.

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

### Which way the board faces

A remote match is opened **seen from the side you play**: the invitation
says which one (`player` is the *local* side), and `play.js` reads it
*before* `attachElement()` so the view is built the right way round
rather than flipped afterwards — a post-attach flip is visible on screen
and leaves the pending turn armed on the old view. It overrides the
per-game stored `viewAs` (the side you play is a fact of *this* match,
the preference talks about local games) and is deliberately **not**
written back to `view-options:<game>`, so the next local game of that
game is unaffected. Jocly ignores `viewAs` for games whose view is not
`switchable`, so nothing special is needed for those. Fixture:
`tests/test-play-viewas.mjs`.

### Conversation (chat, presence, nudge)

- A **separate channel** from the move channel (`ChatChannel`, with
  `RelayChatChannel` and `PeerChatChannel`): both relays are
  last-write-wins on a match id, so a message written into the same key
  would overwrite a move not yet read.
- **On a relay the thread is joclymatch's own** (`chatioaction=save/load`
  on the match id): the server *appends* one line per message, both
  players write into the same file, so there is no concurrency to avoid
  and nothing to rewrite. This replaced an earlier form — two ordinary
  match keys, `<matchId>-ca` / `-cb`, each rewritten whole — which
  avoided concurrency without asking anything of the server but left
  Tabulon **alone**: a joclymatch player in the same match saw nothing of
  what was said, and vice versa. Messages are still merged and
  deduplicated by id (`mergeThreads`); the whole thread comes back on
  every read, so catching up after a reconnection is unchanged. mogichex
  (branch `next` onwards) writes into the same thread through its own
  `fileio.php`, so a Tabulon player and a mogichex player read each other
  too.
- **The wire envelope is joclymatch's, plus optional fields** (`kind`,
  `quick`, `state`, `enc`) — see `toRelayMessage` / `fromRelayMessage`.
  A client that ignores them is not harmed: `kind` absent means `chat`,
  and joclymatch skips what it cannot render instead of showing it
  wrong. Two details are only visible when the two applications actually
  talk: `msg` carries the **translated label** of a quick message so the
  other end does not display an empty bubble, and joclymatch's `pseudo`
  is carried through `decodeThread` so the correspondent keeps the name
  they chose. Both are covered in `tests/test-remote-chat-protocol.mjs`.
- **The chat log fills up, and the conversation carries on.** The relay
  bounds the chat file (`$chatMaxBytes`, 256 KB); it now drops the *oldest*
  messages to make room (`$chatTrimOldest`) instead of closing the thread,
  because a correspondence game lasts weeks and a frozen conversation in the
  middle of a live game is the worse failure. Three consequences here:
  - `_readThread()` **merges** into what we already hold rather than
    replacing it, so a trim on the relay never makes messages vanish from a
    window someone is reading — joclymatch behaves the same way, its panel
    never removes a bubble. The freshly read copy wins on identity ties: the
    same message can change between two polls (a sealed body becomes
    readable after switching to clear), and the stale copy must not win.
    Our own confirmed messages are dropped from `_mine` once the shared file
    carries them; it is only a pending-display buffer.
  - the save answers `{"ok":true,"trimmed":n}`; the channel counts them
    (`chan.trimmed`) and logs them. What is lost is what a player *opening*
    the match now would see, which is worth knowing when debugging a thread
    that looks shorter on one side than the other.
  - two refusals remain and they read differently: `chat-too-long` is about
    that one message (bigger than the whole log — shorten it, the input
    stays open, `chat.tooLong` says so), `chat-full` only comes from a relay
    that kept the old refusal, and then the window closes the input. The
    message is removed from our own thread in both cases rather than left
    showing as if it had gone.
- **Free text is sealed, on both transports.** `sealMessage()` is the
  single rule: a chat message carrying a `body` travels sealed and
  carries `enc:1`, and `decodeThread()` refuses to display a body
  lacking that marker (it shows as a locked message, `reason:'unsealed'`,
  rather than silently vanishing). Peer-to-peer used to skip sealing on
  the grounds that nothing transits a server — which made free text
  **unusable** there, key or not: every message arrived at the other end
  as "sent unprotected". It is sealed there too now, and the reasoning
  was wrong in the first place: the TCP stream has no TLS, so over the
  Internet it is the transport that protects least. Sealing itself is in
  Rust (`seal_cmds.rs`): `crypto.subtle` needs a secure context, which
  `tauri://` under WebKitGTK does not guarantee.
- **Two regimes, and the invitation link decides which.** A link with
  `#k=` (or `#kid=`) means sealed; a joclymatch link, which has no
  fragment, means clear. The fragment reaches no server, so both clients
  reach the same conclusion without negotiating anything. Clear is an
  **explicit permission** passed by the caller (`allowClear`), never
  inferred from the absence of a sealer: a sealer that failed to build —
  damaged key, Rust command unavailable — must not amount to permission
  to write in the clear. That is exactly how a protection gets lost
  without anyone deciding it.
- Peer-to-peer has no clear regime: it only exists between two Tabulon
  instances and its invitation code always carries a key, so free text
  without a sealer is a programming error there, not a configuration.
- **The awkward case, and its answer.** A Tabulon link carries a key but
  points at `index.php`, so it can be opened in joclymatch — which
  ignores the fragment and writes in the clear. The conversation was then
  one-way in both directions: their messages showed as "sent
  unprotected — not shown", ours were unreadable to them. A
  **"continue without protection"** button appears *only* once that has
  actually happened (an incoming message locked with `reason:'unsealed'`
  from the opponent's side), because offering to give up a protection
  nothing says is in the way would be the wrong question. Accepting is
  remembered per match — the link still carries the key, so every
  reopening would otherwise hide the messages again — and what is stored
  is a **list of match ids, never a key**. The sealer is kept so that
  what was already said under protection stays readable; only later
  messages travel clear. There is no way back: text left in the clear on
  a relay is there for good, and offering to "restore protection" would
  suggest otherwise. `allowClearFrom()` in the channel,
  `AcceptChatClear()` in `play.js`.
- Quick messages and presence flags travel as *identifiers* translated by
  the reader, carry nothing personal, and therefore need no key — they
  work in a keyless match, which is the point of "I'm taking a break".
- **Where the key comes from**: the fragment of the invitation link, or
  the peer invitation code, or a *community key* designated by its
  fingerprint (`chatKeyId`) — the key itself never circulates then, both
  sides derive the match key from what they already have.
  `resolveInviteChatKey()` (in `remote-secret.js`) does that resolution
  and is shared by **both** doors into a match, the Invitation window and
  the hub's Invitation panel; the panel used to drop the key entirely, so
  the same invitation gave a conversation through one door and nothing
  through the other.

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

The **cross-application** path has its own probe: Tabulon's real
`RelayChatChannel` run under Node with an injected `fetchImpl`, against a
live joclymatch `fileio.php`, with a joclymatch page in a browser at the
other end. That is what turned up the empty quick-message bubble, the
dropped `pseudo` and a duplicated seal in `PeerChatChannel` — none of
which any single-application test could see.

Open items, from the design comparison below: push/WebSocket instead of
polling for the relay transport; a saved-contact address book for
peer-to-peer; a match-resume story (persist `matchId` + side + transport
with the game, piggybacking on the existing Save/Load format rather than
inventing a new one); and the WebRTC re-evaluation noted above.

The relay dialects are aligned: Tabulon speaks
`gameioaction/gameid/gamedata`, joclymatch also accepts mogichex's
`action/mid/data`, and mogichex's `deploy/fileio.php` translates the
first into the second before handing it to `match.php`. One server of
either kind serves all three applications.

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
- **Why these two transports**: a relay is the shortest path and reuses
  any existing instance — its cost is that *someone* hosts it, and the
  relay sees the moves. Peer-to-peer needs no server at all; WebRTC was
  ruled out empirically (see above). Other mailboxes (a synced folder, a
  message per move over email or XMPP) would fit behind `RemoteChannel`
  too — that is the point of the interface.
- **Minimal security posture, stated**: unguessable match ids (UUID-class)
  for the relay, the 128-bit token for peer sessions, and no claim of
  confidentiality — neither transport encrypts by itself (the relay is
  only as private as its HTTPS and its operator; the peer stream is plain
  TCP).

## Native engine (Fairy-Stockfish "Expert" levels)

**Status: wired up.** The Rust driver and the JavaScript bridge are both in
place; supply a binary (see below) and Expert levels run on it. Without one,
nothing changes: Jocly falls back to its native AI exactly as before.

### Why a native binary at all

Jocly ships a **multi-threaded** (Emscripten pthreads) wasm build of
Fairy-Stockfish. Inside a Tauri webview that build cannot run a search:

- On Linux/WebKitGTK the page is not cross-origin isolated under the
  `tauri://` scheme (measured: `crossOriginIsolated === false`,
  `SharedArrayBuffer` undefined, while `isSecureContext === true`), so
  pthreads — which hard-require `SharedArrayBuffer` — are unavailable and
  Jocly falls back to its native AI with a warning.
- On Windows/WebView2 the isolation *does* work, the engine reports
  `engine ready` — and then the first search hangs forever. The network
  panel shows the pthread worker `stockfish.worker.js` stuck at **pending
  with no status**, under both the embedded and the external dist, i.e.
  including through Tauri's *built-in* protocol. No thread starts, no UCI
  line is ever printed, and `RunSearch` waits for a `bestmove` that never
  comes.

A native binary has no worker, no wasm and no custom protocol to go
through: it removes the cause instead of working around it, and it is
considerably stronger and faster than any wasm build.

### Why not `externalBin` (Tauri's real "sidecar")

Declaring the binary in `tauri.conf.json` makes it **mandatory at build
time** — verified here: `tauri-build` fails with
`resource path binaries/fairy-stockfish-<triple> doesn't exist`. Every
Tabulon build would then depend on shipping one binary per platform, even
for people who do not care about Expert levels. The engine is therefore
resolved **at runtime**, exactly like the external dist
(`dist_override::external_dist`). Switching to real bundling later needs no
change to `engine_cmds.rs`.

### Where the binary is looked up

In order (`commands::engine_cmds::engine_path`):

1. `TABULON_ENGINE` — full path to the executable. Escape hatch for tests
   and for using a custom build without reinstalling.
2. `engine/fairy-stockfish[.exe]`, then `fairy-stockfish[.exe]`, next to the
   application — same base directories as the external dist (`$APPIMAGE`
   for AppImages, the `.app` bundle on macOS).
3. Nothing found: Expert degrades to Jocly's native AI, and the play window
   shows the existing `#play-warning` banner.

The `PATH` is deliberately **not** searched: silently running an arbitrary
executable found in the environment would be an unpleasant surprise.

You must supply the binary yourself: take it from the
[Fairy-Stockfish releases](https://github.com/fairy-stockfish/Fairy-Stockfish/releases)
(pick the build matching your CPU) or compile it. Rename it to
`fairy-stockfish` (`fairy-stockfish.exe` on Windows) and drop it next to the
application, or point `TABULON_ENGINE` at it. It is GPLv3, like Jocly's own
copy; redistributing it in a bundle carries the usual source-availability
obligation.

### Process model

One process per search. Deliberate: a long-lived engine's state (current
variant, options, position) is a classic source of hard bugs, while a
sub-second `go` makes start-up cost irrelevant for a board game. The child
handle is kept only so `engine_stop` can interrupt a search.

Every search has a **finite budget** (`search_budget`). This is the central
guarantee of the module: unlike the wasm path it replaces, no search can
freeze the UI, whatever the engine does — including going silent.

### Commands

| Command | Role |
|---|---|
| `engine_probe` | Is a usable engine present? Returns its UCI name. |
| `engine_search` | One search; takes exactly the fields Jocly already sends its wasm worker. |
| `engine_stop` | Kills the search in flight, if any. |

The UCI logic proper (`classify`, `search_commands`, `search_budget`) is
pure and covered by unit tests — including the ordering constraint that
`VariantPath` must precede `UCI_Variant`, and the detection of
`info string ERROR:`, which is how Stockfish reports a fatal configuration
failure (typically an invalid NNUE network) right before exiting without
ever printing a `bestmove`.

### The JavaScript bridge

`app/content/engine-native.js` makes Jocly use the commands above **without
any change to Jocly itself**. Jocly builds its engine with
`new Worker(baseURL + "jocly.fairyworker.js")` and then speaks a small message
protocol to it, so supplying an object with the same interface is enough:

| Jocly sends | The bridge replies |
|---|---|
| `Init` | `Ready`, or `Error` when no binary is installed |
| `Search` | `Done` with the move, `Error`, or `Aborted` |
| `Stop` | `Aborted` |

That `Error` on `Init` is the *normal* path when no engine is present: Jocly
tags the engine unavailable, falls back to its strongest native level, and
`play.js` shows the `#play-warning` banner.

Jocly runs inside an iframe, so it is the **iframe's** `Worker` that gets
replaced (`play.js` installs the bridge right after `attachElement`). The
iframe is same-origin and the installed function still belongs to the top
window's realm, so the shim keeps access to Tauri without depending on
`window.__TAURI__` being present inside the iframe — which is not established.

`asset-rewrite.js` also wraps `Worker` (to redirect `jocly.aiworker.js` to the
external dist). Both wrappers delegate to the previous one and match disjoint
URLs, so installation order does not matter.

`tests/test-engine-native.mjs` covers the protocol with an injected RPC — no
binary and no webview needed (20 assertions).

### Optional NNUE networks

`evalFile` (e.g. `nnue/shako.nnue`) is resolved **relative to the engine
binary's own directory**, not to the dist: with the binary in `engine/`, the
network goes to `engine/nnue/shako.nnue`. Absolute paths and any `..` are
rejected — the value comes from a game's config, so possibly from a
third-party extension.

A missing network is never an error: it is logged and the search runs on
classical evaluation, exactly like the wasm worker did.

One subtlety is worth knowing. Fairy-Stockfish only activates a network when
the **file name starts with the variant name** (`on_eval_file_change` in
`evaluate.cpp`) — which is why Jocly's wasm worker always writes the network
into its virtual FS as `/<variant>.nnue` rather than under its original name,
so that one net can serve several same-piece-set variants. The native path
applies the same rule: if the file name already matches, it is used as is;
otherwise a copy named `<variant>.nnue` is placed in the temp directory
(cached by size, since these files can be tens of megabytes and there is one
process per search). Without this, NNUE would stay silently inactive for any
generically-named network.

`EvalFile` is set **after** `UCI_Variant`, since changing the variant is what
triggers the engine's network re-check.

**A network can exist and still be unusable by *this* build** — networks are
tied to the engine's architecture, so a net built for the standard board is
rejected by a largeboard binary. The engine then stops, sometimes with
`info string ERROR: If the UCI option "Use NNUE" is set to true, network
evaluation parameters compatible with the engine must be available.`, and
sometimes by simply exiting with no message at all. Observed for real:
xiangqi and losing-chess (explicit error), spartan (silent exit), while
capablanca-chess, kyoto-shogi, shako and shogi loaded fine.

A search is therefore **retried once with NNUE switched off** whenever an
attempt that used a network fails that way (`looks_like_nnue_failure`). A
strength upgrade must never cost the game. The retry has to set
`Use NNUE value false` explicitly: Fairy-Stockfish defaults that option to
`true`, so merely *not* mentioning NNUE is not enough — which is exactly why
the failures survived the first fix.

**Never set `Use NNUE` to true.** Forcing it to `true` makes a missing or
incompatible network *fatal*: the engine prints
`info string ERROR: If the UCI option "Use NNUE" is set to true, network
evaluation parameters compatible with the engine must be available.` and
exits, so the search fails instead of quietly running on classical
evaluation. Observed for real on losing-chess. Jocly's wasm worker sets only
`EvalFile`; the native path does the same, and a test guards against the
option coming back.

Note that this module's `log::info!` output goes to the application's log,
**not** to the webview console. `SearchResult.evalFileUsed` therefore reports
what was actually loaded, and `engine-native.js` logs it once per variant —
otherwise there is no way for a player to tell whether Expert is running with
its network or without.

## Native engine (Scan, draughts "Expert" levels)

Same rationale, same shape and the same fallback as the Fairy-Stockfish
driver above, for the draughts/checkers family: `scan_cmds.rs` drives a
native **Scan** binary (Fabien Letouzey), `engine-native.js` stands in for
`jocly.scanworker.js`. Put the binary in `engine/scan`
(`engine\scan.exe` on Windows), or point `TABULON_SCAN` at it. Official
builds: <https://hjetten.home.xs4all.nl/scan/scan.html> (GPLv3).

Without it nothing breaks: the probe fails, Jocly marks the engine
unavailable and plays with its native AI — the console says so explicitly
(`moteur de dames indisponible — …`), as it does on success
(`moteur de dames natif : Scan 3.1`).

Three things differ from Fairy-Stockfish and each one is a trap:

- **Scan speaks the Hub 2 protocol, not UCI**, and only if launched with a
  `hub` command-line argument — without it, it starts in interactive text
  mode and never answers. Sequence: `hub` → `id …`/`param …`/`wait` →
  `init` → `ready`, then `pos` / `level` / `go think` → `info …` →
  `done move=32-28`. Parameters (`variant`, `book`) must be set *before*
  `init`, since they drive what data gets loaded.
- **The position format is not the one Jocly sends.** `jocly.scan.js`
  builds `fen.cpp`'s dialect (`W:W31-50:B1-20`); Hub wants 51 characters —
  the side to move plus one letter per square (`e`/`w`/`W`/`b`/`B`).
  `fen_to_hub_pos()` does the conversion and is the one place where a bug
  would produce a silently *wrong move* rather than a visible failure, so
  it is heavily tested (kings, ranges, isolated squares, empty side) and
  rejects anything it does not fully understand.
- **Scan reads `scan.ini` and its `data/` directory relative to its working
  directory**, so the child process is started with the binary's own folder
  as CWD. Otherwise it cannot find its evaluation weights and fails at
  `init`.

Two more details: `level move-time` is in **seconds** (Jocly supplies
milliseconds), and a `done` line with no `move=` is a *terminal position*,
not a failure — it is passed through as `bestMove: null`, which is what
`jocly.scan.js` expects. No move-notation translation is needed at all:
Scan's natural notation is already what `checkersbase-model.js` produces.


## Native engine (KataGo, Go levels)

Same rationale, same shape and the same fallback as the two drivers above,
for Go: `katago_cmds.rs` drives a native **KataGo** binary over GTP,
`engine-native.js` stands in for `jocly.kataworker.js`. Put the binary in
`engine/katago` (`engine\katago.exe` on Windows), or point `TABULON_KATAGO`
at it. KataGo is MIT-licensed, unlike the two GPL engines beside it.

Without it nothing breaks: the probe fails, Jocly marks the engine
unavailable and plays with its native AI — the console says so explicitly
(`moteur de go indisponible — …`), as it does on success
(`moteur de go natif : KataGo v1.13 - réseau … - goban 19`).

Three things differ from Fairy-Stockfish, and each one is a trap:

- **KataGo cannot start without its network.** Fairy-Stockfish without an
  NNUE runs a classical evaluation — a missing network there is a detail.
  KataGo takes `-model` as a *launch* argument: a missing network is a
  failed probe, not a degraded mode. It also refuses to start without
  `-config`, so `engine/katago.cfg` is required too; the `gtp_example.cfg`
  shipped with KataGo does. Both are reported separately by
  `install_status`, so the panel can say which one is missing.
- **The position is a move list, not a FEN.** `jocly.kata.js` sends
  `moves: [{loc, col}]`, `toPlay` and `komi`, because that is what the wasm
  ABI wants — it replays the game itself. In GTP that becomes a run of
  `play` commands, so `loc` has to be translated. `loc_to_gtp` /
  `gtp_to_loc` are the one place where a bug would produce a silently
  *wrong move* rather than a visible failure, so they are round-tripped
  over every intersection of 9x9, 13x13 and 19x19.

  The convention is Jocly's own (`go-model.js`, `CoordToString`): columns
  A..T skipping I, rows numbered from the bottom. The wasm bridge does not
  settle the axis — it passes `loc` straight through, which it can afford
  to do, since the two conventions differ by a reflection applied on the way
  in and on the way out. GTP text fixes the direction, so here a choice has
  to be made, and it is the one the player sees on screen.

- **The network and the board size arrive with `Init`, not with `Search`.**
  KataGo needs both at launch. The shim therefore remembers what `Init`
  carried and sends it with every search; a shim that forgets leaves the
  Rust side with nothing to start the engine, and the failure only shows at
  the first move.

One process per search, like the other two — but this is the engine where
that trade-off deserves re-measuring. Fairy-Stockfish starts in
milliseconds; KataGo has to load its network, which is seconds on a CPU. If
it proves tiresome in play, the way out is a persistent process driven over
GTP (`clear_board` between games), at the cost of the shared state that
`engine_cmds.rs` warns about. Measure before deciding.

The search budget comes from the level, not from `katago.cfg`:
`-override-config maxVisits=…,maxTime=…` is what makes "Easy" and "Strong"
differ without editing the config file.

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

### Localized game manifests (`summary`)

A game's `summary` may be a plain string or an object keyed by locale, the
same shape the `rules` field already uses:

    "summary": "an Ultima cousin on a 10x10 board with an edge ring"
    "summary": { "en": "an Ultima cousin…", "fr": "Un cousin de Ultima…" }

Both forms work side by side — existing games keep their string, new ones
can translate. `pickLocalized()` (`app/content/localized-field.js`, pure,
tested by `tests/test-localized-field.mjs`) resolves it: exact locale
(`fr-CA`), then language (`fr`), then English, then any translation
present rather than nothing, and always returns a string — the hub's
filter calls `.toLowerCase()` on it, and an object there used to be a
`TypeError` (the list showed `[object Object]`). `hub.js` reduces the
field **once**, right out of `Jocly.listGames()`, so the list, the filter
and the detail panel all see a real string; the detail panel resolves
`config.model.summary` the same way.

Two places have no UI locale and take English (or any translation
available) instead: `summary_text()` in `extension_cmds.rs` — the
extensions list and the `.tabulon-ext` manifest, where a translated
summary previously came out **empty** because `as_str()` returns `None`
on an object — and `scripts/export-all.mjs`, whose catalogue pages are
static artifacts published as-is.

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
| `fix-appimage.mjs` | Post-build: strips the bundled `libwayland-*` from the AppImage and repacks it (Arch/Manjaro `EGL_BAD_PARAMETER` fix — see Troubleshooting). Run after every `cargo tauri build` that produces an AppImage. |
| `check-webrtc-webview.py` | Empirical probe: does the embedded webview (WebKitGTK on Linux) expose `RTCPeerConnection`? Loads an offscreen WebView and, if the API exists, runs a full local WebRTC loopback (offer/answer, ICE without STUN, DataChannel ping/pong) and prints a JSON verdict. Current verdict (Ubuntu 24.04 / WebKitGTK 2.52): **no** — distribution builds are compiled without WebRTC, the finding that steered peer-to-peer play to the Rust TCP transport. **Keep it around to re-evaluate WebRTC in the future**: rerun on new distros/WebKitGTK releases; if it ever reports a working DataChannel, WebRTC (with STUN/TURN) becomes a candidate transport adding the NAT traversal TCP lacks. Needs `python3-gi gir1.2-webkit2-4.1 xvfb`; run: `xvfb-run -a python3 scripts/check-webrtc-webview.py`. Linux-only by nature (WebView2/Chromium on Windows ships WebRTC). |
| `check-remote-relay.mjs` | Live smoke test of the remote-play HTTP protocol against a real jocly-simple-match `fileio.php` instance: `node scripts/check-remote-relay.mjs [relay-url]` (default: biscandine.fr's instance). Writes/reads only a randomly-generated test match id. |
| `check-jocly-compat.mjs` | Same idea, for the `'jocly-simple-match'` codec specifically: `node scripts/check-jocly-compat.mjs [relay-url]`. Confirms both directions — what Tabulon writes has the exact shape `control.js` expects, and Tabulon correctly reads a payload shaped exactly like what `control.js` itself writes. |
| `check-syntax.mjs` | `npm run lint`. Runs `node --check` over `app/content/`, `scripts/` and `tests/` — real syntax errors only, no style rules, **no dependency**, and it exits non-zero when it finds something. Replaces `jshint`, removed in favour of this: jshint's own last release (2.13.6) pinned `cli@1.0.1`, which brought every security advisory and both deprecation warnings in the repo, and with no `.jshintrc` it linted ES2020 code as ES5 and reported 2169 false errors that `|| true` silently discarded. If real linting is wanted later, ESLint is the candidate — there were no jshint rules to preserve. |
| `set-version.mjs` | Propagates the release number. **`package.json` (root) is the single source**; `npm version <x.y.z>` bumps it and the `version` lifecycle hook runs this script to update `app/package.json`, `src-tauri/Cargo.toml` and both spots in `package-lock.json`. `npm run set-version <x.y.z>` does the same without the git commit/tag; with no argument it just re-propagates the current number. `src-tauri/tauri.conf.json` is *not* written: its `version` field holds `"../package.json"`, a documented form of the field, so Tauri reads the source directly. `tests/test-version-sync.mjs` fails the build if any of these drift apart. |

### Dependencies

`npm audit` is clean in both workspaces and no install prints a deprecation
warning; keep it that way. Two deliberate non-upgrades, so they don't get
"fixed" by reflex:

- **jquery stays on 3.x.** It is not used by Tabulon's own code at all — it is
  loaded as a global because *Jocly* needs it (`jocly.game.js`,
  `jocly-xdview.js`). jQuery 4 removes long-deprecated APIs, so bumping it
  would be a change to a third party's runtime, decided from the wrong repo.
  3.7.1 carries no advisory.
- **`@tauri-apps/*` are `^2` ranges** and already resolve to the latest 2.x;
  there is nothing to pin or bump by hand.

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
npm run test:rust      # Rust unit tests (cargo test in src-tauri)
npm run test:all       # both
```

**Continuous integration.** `.github/workflows/tests.yml` runs both on every
push and pull request: it builds the jocly2 dist from the branch named by
`JOCLY2_REF` (the one this Tabulon branch ships with — update it together
with the target branch), then `check:dist`, `npm test` and `npm run
test:rust`. Before the workflow existed, a Rust test had gone stale for
weeks without anyone noticing.

Prerequisites: `dist/` in place (see above), `dist-minimal/` generated
(`npm run check:dist`) and `npm --prefix app install` (jsdom). The runner
checks all three and tells you what is missing. The whole run takes about
a minute.

**Mocking Tauri.** jsdom suites load pages under a Tauri URL
(`https://tauri.localhost/...`), so `tauri-bridge.js` waits for a *complete*
injection before evaluating the page. Pass the mock through
`completeTauriInjection()` (`tests/helpers/tauri-mock.mjs`): it fills the
namespaces the suite does not simulate with methods that throw a named
error when called. A partial mock without it makes every suite wait for
the bridge's 8-second timeout — that used to be three quarters of the run.

### Useful commands

```bash
# Type/borrow-check the Rust backend without a full build
cargo check --manifest-path src-tauri/Cargo.toml

# Regenerate app icons from a source PNG (square, ≥1024×1024)
cargo tauri icon path/to/source.png
```

---

## Windows-only traps (all fixed — keep them fixed)

Three Windows/WebView2 behaviours have each cost a debugging session. The
fixes are in place; the point of this section is that they must not be
undone.

**1. Never create a webview window from a synchronous command.** Tauri's
own documentation states: *"On Windows, this function deadlocks when used
in a synchronous command or event handlers"* — WebView2 creation needs the
main-thread message loop, which a synchronous command blocks. Symptom:
every window opened after the hub is blank **and frozen**, killable only
from the Task Manager. All 16 window-opening commands
(`window_cmds.rs`, `match_cmds.rs`) are therefore `async`. The hub escapes
because it is created in `setup()`; Linux/macOS escape because their
webviews do not depend on that message pump.

**2. `window.__TAURI__` can arrive late in secondary webviews**
(tauri-apps/tauri#12990, #12694): initialization scripts may run *after* a
page's `<script type="module">`, inconsistently and CPU-load-dependent.
Every `tauri-bridge.js` call then throws and the page boots into empty
`data-i18n` skeletons. The bridge waits for the injection with a top-level
`await`, which suspends the whole module graph and delays
`DOMContentLoaded` — so no page code had to change. The wait only arms in
a real Tauri page (`isTauriPage()`; Node test stubs must keep the lazy
behaviour and never wait), and after 8 s logs a *non-fatal* error meaning
the injection never arrived at all — a different problem (CSP,
`withGlobalTauri` off, broken build). Both predicates are pure and covered
by `tests/test-tauri-bridge-injection.mjs`.

**3. At `document_start`, `document.documentElement` can be `null`.** The
external-dist rewriter used to call
`observe(document.documentElement, …)` inside a `try/catch` that swallowed
the resulting `TypeError`, so on Windows its `MutationObserver` was simply
never installed — silently, and only there (WebKitGTK already had the
element). Anything inserted with `innerHTML` then escaped rewriting, since
the other hooks only see `.src` assignments and `setAttribute`: game
thumbnails came back **500** from the app protocol for externally-loaded
games. It now observes `document` (always present, `subtree: true` covers
everything) and the `catch` logs instead of hiding. Two lessons worth
keeping: a silent `catch` around setup code buys nothing, and a hook set
matters less than the *insertion paths* it actually covers.

## Internal architecture

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
| `hub.html/js` | Main window: sidebar (All/Favorites/Invitation/Templates/Extensions/About), game list with Quick play and Rules shortcuts, detail panel (animated visuals, action buttons — including Invitation — and the game's templates). Tablet-responsive (icon sidebar < 900 px, list **or** detail view < 680 px). |
| `play.html/js` | The board + the match's brain: game loop (`userTurn`/`machineSearch`/remote channel), clock state, JSON save/load, snapshot, fork, pause, A/B player and skin (2D/3D) selectors in the footer. The `…` button toggles button bar ⟷ selectors. |
| `invitation.html/js` | Remote-play entry point: join a relay match from a link, create one (id + shareable link, relay Test button), or peer-to-peer host/connect with a `TBP1-…` code. See "Remote play" above. |
| `extensions.html/js` | Import/export/uninstall of game and module extensions (Games/Modules tabs); the hub is notified through `relay_to_window('main','extensionsChanged')` and reloads its list. |
| `clock-setup.html/js` | Clocked-game configuration → `new_match(game, clock)`. |
| `clock.html/js` | Clock display (7-segment font); pure view over play.js state. |
| `history.html/js` | Played-moves navigation (takeback, replay, resume from a position). |

**Anything that changes the position ends with `rearmAfterPositionChange()`**
(take back, restart, load a game, load a position). Two bugs made this
necessary, both fixed there:

- *Order.* These handlers start with `abortUserTurn()` to stop what is in
  flight; `gameLoop()` catches the abort and immediately re-enters
  `userTurn()` — i.e. `HumanTurn()` — on the **old** position, racing the
  rollback that follows. jocly's `rollback()` redraws the board (`BackTo` +
  `DisplayBoard`) but re-arms nothing, so the clickable elements built for
  the previous position survive: after taking back `Ph3i4` in Rococo, `i4`
  was still selectable and `h3` inert, on a board that showed the rewound
  position. jocly's own `examples/browser/control.html` does it the other
  way round — `rollback(...)` **then** `RunMatch()` — and is unaffected.
  The helper therefore re-arms once the position is settled.
- *Game over.* `gameLoop()` sets `loopActive = false` when a game ends, so
  taking back after a loss restored the position but armed no turn — mute
  board, "player B wins" still on screen. The helper restarts the loop in
  that case, and the take-back handler now also clears the footer and emits
  `move-played` (the History window was not refreshed either).

`HumanTurn()` is never called directly — it is jocly-internal, reached
through `userTurn()`.
| `players.html/js`, `view-options.html/js`, `camera-view.html/js`, `save-template.html/js`, `info.html/js`, `book.html/js`, `moves`, `open-position`, `show-position` | Various satellites. `info` loads localized rules/description/credits (see i18n). `view-options` includes a "View as" (player A/B) select for games whose view is switchable (`config.view.switchable`), mirroring the `#view-as` control of jocly2's `examples/browser/control.html`; the choice goes through the regular `set-view-options` round-trip and is persisted per game like every other view option. On `set-view-options`, `play.js` also re-arms the current user turn (`abortUserTurn()`, which makes `gameLoop()` re-enter `userTurn()`) — see the note below. |

**Why `set-view-options` re-arms the turn.** Jocly's `setViewOptions()`
rebuilds the view (`GameDestroyView`/`GameInitView`/`DisplayBoard`) but does
*not* re-run `HumanTurn()` — and `HumanTurn()` is what draws the
possible-move hints, reading `mShowMoves` at that moment. Unchecking "show
moves" therefore only took effect on the *next* turn: the hints already on
screen stayed until a move was played. Measured in a real browser on a
`classic-chess` 2D board: 10 hint cells at opacity 1 with the turn armed →
still 10 at opacity 1 after `setViewOptions({showMoves:false})` alone → 0
after aborting and re-arming the turn. jocly's own
`examples/browser/control.html` does the same thing by calling `RunMatch()`
right after `setViewOptions()`. The abort is deliberately limited to the
user turn: an AI search or a wait for a remote move is left untouched.

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

- `fs_cmds`: `parse_pjn`, `save_text_file`,
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

**S-Chess (Seirawan++) notation.** Two things set this game apart from every
other chess variant Tabulon reads or writes.

- *Gating is part of the move.* jocly writes it after a slash — `Bc8-b7/M`,
  and at castling the square too (`O-O/Ce1`), since two squares are freed
  there. PGN (PyChess, Fairy-Stockfish) writes the same thing in SAN:
  `Bb7/E`, `O-O/He1`, check last (`Qh5/E+`). `SplitGate()` detaches the
  suffix on both sides; `ParseSanMove` returns it as `gate: {piece, square}`,
  `SanMatches` refuses a move whose gating doesn't match (`Nf3` and `Nf3/H`
  are two different moves), and `BuildSanMove` writes it back.
- *The prelude picks the letters.* The pair of pieces is chosen before the
  first move, so the same game writes `C`/`M` (cardinal, marshall) in one
  arrangement and `H`/`I` (phoenix, kirin) in another. The mapping to the
  engine's letters lives in the manifest, **per arrangement**
  (`levels[].variants[].pieceMap`, `{C: 'H', M: 'E'}` for arrangement 0), not
  in a per-game table like `SAN_PIECE_ALIASES` — a per-game table would
  rename the khan's marshall too. It is passed as `options.pieceMap` to
  `SanMatches`/`BuildSanMove`; `FairyProfile()` reads it from the answered
  prelude.
- *[Variant] on the way out and in.* Arrangement 0 **is** the S-Chess, so it
  declares `pgnVariant: "seirawan"` — that is what a PGN must say to be read
  elsewhere, and what `FairyGameIndex` maps back to arrangement 0. The other
  arrangements keep their section name (`jocly-seirawan-chu`…), which only
  Tabulon and the engine understand.
- *The [FEN] of a PyChess file* carries the waiting pieces in a pocket and
  the still-open gating squares in the castling field
  (`…/RNBQKBNR[HEhe] w KQBCDFGkqbcdfg - 0 1`). **jocly now reads and writes
  that same shape** for this game (its old grid FEN lost the gating rights
  altogether, so a saved middlegame reopened with all sixteen gates reopened).
  What is left to Tabulon is the *alphabet*: `SChessFen()` turns the file's
  letters into jocly's through the arrangement's `pieceMap` (`H`→`C`,
  `E`→`M`). That is not cosmetic — `H` and `E` also exist here, as the chu
  phoenix and the shako elephant, so an untranslated pocket would name two
  pieces from two different arrangements; jocly refuses such a pocket rather
  than open a plausible, wrong game. Starting position or middlegame, the same
  path applies. `NormalizeBookFen()` holds the order of the dialects in one
  place (S-Chess before `PgnFenToShogiSfen`, which would read that pocket as a
  shogi hand) and is used by play.js, the hub and the book window alike.
- *Older files.* A jocly predating the fix wrote a fake promotion when a
  back-rank move gave check (`Qd1-h5=Q+`, `Qd1-h5=C+/C`).
  `NormalizeSChessNatural()` puts those PJN tokens back into today's form
  before replay — left alone, they are equidistant from two current moves and
  `pickMove` could play the other one. `SanMatches` ignores the same artefact.

Covered end to end by `tests/import/test-seirawan.mjs` (the PyChess fixture
replayed and rewritten token for token, PGN and PJN round trips in two
arrangements, a middlegame position translated and reloaded).

**A file that cannot be opened says so, and opens nothing.** Two refusals used
to be silent, and both ended the same way — a window opened on the wrong game
or on an empty board, with the reason in the console only:

- the hub fell back to the *selected* game whenever a file declared a game or
  variant it could not map, so a PyChess file dropped while an Ultima card was
  on screen opened Ultima. A file that declares nothing still falls back (the
  user chose), but a declared-and-unknown one is now refused by name;
- the book window opened the match before knowing whether its `[FEN]` loads.
  It now tries the position first — `NormalizeBookFen()` then a throwaway
  `Jocly.createMatch().load()` — and shows the engine's own reason in place,
  keeping the list visible, since the other games in the file may be fine.

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
   window) rewrites `browser/**` and `games/**` on the fly to that
   protocol: element attributes (`src`/`href` on script/img/link **and on
   audio/source/video**, including via `setAttribute`), `fetch`, `XHR`,
   `Image().src`, the CSSOM (background set from JS), the AI worker,
   **and CSS text** — the text of a `<style>` element and inline
   `style="…url(…)…"` attributes. `content/**` is never redirected: the
   UI shell always stays embedded.
4. `get_dist_info` exposes the state (external/embedded + path) to the UI.

The CSS-text case (point 3) was a real gap: a game's rules page may
illustrate its pieces with a **sprite**, i.e. a `background-image` inside a
`<style>` block (Ultima does; werewolf uses plain `<img>`, which the
attribute hook already covered). Stylesheet text is parsed by the CSS
engine without passing through any JS hook, so the URL stayed on the app
protocol, where the externally-loaded game does not exist — the built-in
`tauri://` protocol answers **500** for a missing asset, hence the
`ultima-picto-sprites.png … 500 (Internal Server Error)` seen in the help
window. Two layers now cover it: `info.js` rewrites the `url(...)` of a
rules page **before** injecting it (so no request is ever fired at the
wrong URL), and `asset-rewrite.js` rewrites any `<style>` added to the DOM
as a general safety net. The shared rewriting logic lives in
`app/content/css-url-rewrite.js` (pure, tested by
`tests/test-css-url-rewrite.mjs`, which also guards the inline copy inside
`asset-rewrite.js` against divergence).

Sounds were the same gap in a different disguise: jocly builds them in
`UpdateSounds()` with `$("<source/>").attr("src", …)` on a **detached**
element, and neither the tag list of the `setAttribute` hook nor the
observer's selector included `source`/`audio`/`video` — so `.ogg`/`.mp3`
came back 500 for externally-loaded games. Both lists now cover them.
**A 500 is the signature of this whole family**: `dist_override.rs` only
ever answers 200 or 404, so a 500 means the asset was never rewritten and
went to the app protocol.

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

## Troubleshooting: AppImage fails with `EGL_BAD_PARAMETER` on some distros

Symptom (diagnosed end-to-end on a Manjaro host, X11 session, where the
*native* binary runs fine):

    Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...

(The `Failed to load module "appmenu-gtk-module"` line that may precede it
is unrelated host-GTK noise — harmless.)

**Root cause, established by elimination on an affected machine:** the
AppImage produced by `cargo tauri build` bundles the whole
`libwayland-*` family (client, cursor, egl, server) alongside the bundled
Debian-built WebKitGTK. On Arch-family hosts these bundled wayland
libraries poison the bundled WebKit's EGL initialisation against the
host's Mesa — even in an X11 session. The WebKit environment variables
(`WEBKIT_DISABLE_DMABUF_RENDERER` either way,
`WEBKIT_DISABLE_COMPOSITING_MODE`) change nothing, because the failure
precedes them. Removing only the `libwayland-*` files from the extracted
AppDir fixes it; removing the bundled WebKit instead **breaks** the app
(the bundled GTK/GLib are incompatible with the host's WebKit — don't go
down that road). The official AppImage excludelist
(AppImageCommunity/pkg2appimage) indeed forbids bundling
`libwayland-client.so.0`; Tauri's bundler ships it anyway.

**The fix — one command, build included (preferred):**

    ./compil.sh

`compil.sh` (repo root) chains `npm run build` → the purge below → a
**proof step** that re-extracts each produced AppImage and fails loudly
if any `libwayland-*` remains. It exists because the purge is a
post-processing step that is otherwise easy to forget — a rebuild without
it reproduces the exact same `EGL_BAD_PARAMETER` failure, which happened
in real testing. Manual equivalent, run after every AppImage build:

    node scripts/fix-appimage.mjs            # finds the AppImage under
                                             # src-tauri/target/release/bundle/appimage/
    node scripts/fix-appimage.mjs path/to/Tabulon.AppImage   # or explicit

The script extracts the AppImage (no FUSE needed), removes exactly the
`libwayland-*` libraries (nothing else — the scope validated on the
affected machine), repacks it with `appimagetool` **reusing the original
AppImage's runtime** (no network needed for the runtime; `appimagetool`
itself is taken from `$APPIMAGETOOL`, the PATH, or downloaded once into
`~/.cache/tabulon/`), and keeps the untouched original as
`<name>.AppImage.orig`. Pure logic covered by
`tests/test-fix-appimage.mjs`; the end-to-end mechanics (extract → strip
→ repack → still runs) were validated against a synthetic AppImage.

The startup safeguard in `src-tauri/src/appimage_compat.rs`
(`WEBKIT_DISABLE_DMABUF_RENDERER=1`, AppImage-only, user-overridable)
remains: it addresses the *other*, driver-level failure mode of the same
symptom (NVIDIA-proprietary and similar mixes) and was confirmed harmless
on the machine above.

## License

AGPL-3.0 (see `package.json`).

