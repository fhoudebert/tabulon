# KataGo (kataeval) for Jocly

KataGo's evaluation and search compiled to WebAssembly, from
[saigo-online/katago-webgpu](https://github.com/saigo-online/katago-webgpu).
KataGo itself is MIT-licensed, which is compatible with Jocly's AGPL-3.0.

Driven by `src/browser/jocly.kataworker.js`, which is started by
`src/core/jocly.kata.js` when a level declares `"ai": "kata"` — the same shape
as the Fairy-Stockfish and Scan integrations next door.

## Which build is used

| file | what it is | shipped by the build |
|------|------------|----------------------|
| `kataeval.js` / `kataeval.wasm` | the plain build: no threads, one blocking `kgeSearch()` per position | **yes** |

The plain build is what Jocly asks an engine for: one move for one position.
`kgeSearch(moveLocs, moveCols, numMoves, toPla, komi, maxVisits, maxTimeMs, …)`
runs a batched MCTS to a budget and hands back a point, and blocking is what a
worker is for.

The threaded build is stronger and would give live statistics through
`kgeSearchBegin` / `kgePollAll`, but it needs `-pthread`, a 33-thread pool,
512 MB of initial memory, and a **cross-origin isolated page** (`COOP`/`COEP` —
see `third-party/fairy-stockfish/.htaccess`, which already sets those headers
for the same reason). Moving to it changes only the inside of
`jocly.kataworker.js`; `jocly.kata.js` would gain live progress and lose
nothing.

Until that happens, `kataeval-mt.*` is 2.1 MB in the repository that nothing
loads, and `kata-worker.js` is upstream code Jocly never runs. Both are
rebuildable from the upstream repository, so removing them costs only the
convenience of having the reference to hand.

## Networks

**No network is bundled here**, the way no NNUE is bundled under
`fairy-stockfish/nnue`. The build globs `*.bin.gz`, so it works with none, one
or all of them present.

A missing network is not harmless, though, and this is where KataGo differs
from Fairy-Stockfish: a missing NNUE falls back to a classical evaluation,
whereas KataGo cannot play at all without its net. `jocly.kataworker.js`
reports the failure and `jocly.kata.js` leaves the move to Jocly rather than
inventing one.

The `kata` levels in `src/games/go/index.js` all name
**`katago-nnetwork.bin.gz`**, so whichever network you choose, drop it here
under that name. One fixed name means switching networks is a file copy rather
than a manifest edit, and it stops the levels naming a file that has since
moved — which is what happened to the one they named first.

Not `nnue`. NNUE is a chess and shogi term — an *efficiently updatable* shallow
network, recomputed incrementally as an alpha-beta search makes and unmakes
moves, which is what `fairy-stockfish/nnue` next door holds. KataGo's is a
convolutional residual policy-value network evaluated whole, on a batch of
positions, by an MCTS. Same idea in the abstract, entirely different animal,
and calling it NNUE would send anyone reading the manifest looking for the
wrong thing.

### Where to get one

Pachi republishes converted KataGo networks, which is the most durable source
of them — KataGo's own training runs move and their file names go with them,
which is exactly what happened to the network these levels used to name:

<https://github.com/pasky/pachi/releases/#release-katago_models>

The one used to develop this integration:

```
curl -L -o third-party/katago/katago-nnetwork.bin.gz \
  https://github.com/pasky/pachi/releases/download/katago_models/g170e-b10c128-s1141046784-d204142634.bin.gz
```

That is `g170e-b10c128`, about 11 MB. Smaller networks from the same release
page (b6c96 around 3.8 MB, b5c192 around 7 MB) work as well under the same
name.

Bigger is stronger per visit and slower per visit, so on the CPU fallback the
small one at more visits often plays better than the large one at fewer. Try
b6c96 first if a level feels sluggish, before lowering its visit count.

## Backend

The wasm build prefers WebGPU and falls back to Eigen on the CPU
(`kgeSetForceCpu`). The worker reports which it got in its `Ready` message, so
it shows up in the console rather than only as a difference in speed.

`kgeSetGumbel(n)` selects the root move by Gumbel-top-n with sequential halving
rather than plain PUCT. It is stronger at the low visit counts a browser can
afford, which is the regime every level here plays in; `n <= 0` restores PUCT.
