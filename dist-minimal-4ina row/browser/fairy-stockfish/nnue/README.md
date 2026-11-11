# Optional NNUE evaluation networks

This directory holds **optional** NNUE (neural network) evaluation files for
the Fairy-Stockfish "Expert" AI levels. **None are bundled in this
repository** — by default the engine runs on its built-in handcrafted
("classical") evaluation, which is what you get out of the box.

Everything degrades gracefully: if a network referenced by a level config is
missing from this directory (or fails to download at runtime), the worker
logs it once and the engine simply keeps using classical evaluation. No
build step, level config, or game breaks by adding or removing files here.

## Why bother

Variant-specific NNUE networks are typically several hundred Elo stronger
than the classical evaluation — for shogi the documented gap is the largest
of any variant (over +1000 Elo). See:

- Overview and per-variant Elo gains: https://fairy-stockfish.github.io/nnue/
- Background: https://fairy-stockfish.github.io/about-nnue/

## How to add networks

Download the network(s) you want from the official list above (they are
hosted in a Google Drive folder linked from that page), drop them in this
directory, and rebuild (`gulp build`). The build copies `*.nnue` from here
into `dist/browser/fairy-stockfish/nnue/` — zero, some, or all files, it
doesn't matter which are present.

File names expected by the level configs, which live in
`src/games/chessbase/manifest/*.js` (rename the downloaded files
accordingly). This table is generated from those configs - if it disagrees
with them, they are right and it is stale:

| file                    | used by (Jocly game) | Fairy-Stockfish variant         |
|-------------------------|----------------------|---------------------------------|
| `3check.nnue`           | three-check-chess    | 3check                          |
| `antichess.nnue`        | losing-chess         | antichess                       |
| `capablanca-chess.nnue` | capablanca-chess     | capablanca (& 8 prelude setups) |
| `crazyhouse.nnue`       | crazyhouse           | crazyhouse                      |
| `grand.nnue`            | grand-chess          | grand                           |
| `horde.nnue`            | horde-chess          | horde                           |
| `khans.nnue`            | khans-chess          | khans                           |
| `kyotoshogi.nnue`       | kyoto-shogi          | kyotoshogi                      |
| `makruk.nnue`           | makruk               | makruk                          |
| `minishogi.nnue`        | mini-shogi           | minishogi                       |
| `seirawan.nnue`         | seirawan-chess       | jocly-seirawan-marshall-cardinal |
| `shako.nnue`            | shako-chess          | shako                           |
| `shogi.nnue`            | shogi                | shogi                           |
| `spartan.nnue`          | spartan-chess        | spartan                         |
| `xiangqi.nnue`          | xiangqi              | xiangqi                         |

Declaring an `evalFile` costs nothing when the file is absent, so a level may
name a network the upstream list does not (yet) publish - `antichess.nnue` is
one such at the time of writing. The level keeps working on classical
evaluation and picks the network up the day it is dropped in here.

The on-disk names here are free-form: Fairy-Stockfish itself only accepts a
network whose *file name* starts with the current variant's name, but
`src/browser/jocly.fairyworker.js` handles that by always re-writing the
fetched file into the engine's virtual filesystem under
`/<variant>.nnue` — built from the level's own `variant` field — before
setting the `EvalFile` UCI option. That is why a single
`capablanca-chess.nnue` can also serve the Capablanca prelude setups
(Gothic, Embassy, Bird, Carrera, Ladorean, Grotesque, Schoolbook, Univers),
which share Capablanca's exact piece set on the same 10x8 board: the same
downloaded file is re-written as `/gothic.nnue`, `/joclybird.nnue`, etc. as
needed. It also means you can keep the upstream hash-suffixed name
(e.g. `shogi-878ca61334a7.nnue`) if you update the matching `evalFile`
entry in the manifest instead of renaming the file.

To wire a network up for another game's Expert level, add an
`"evalFile": "nnue/<file>.nnue"` field to that level's config in
`src/games/chessbase/manifest/` (path relative to the `fairy-stockfish/`
asset directory). Only do this where the network's variant matches the
level's `variant` (or shares its exact piece set and board size) — a
network with mismatched feature dimensions will fail Fairy-Stockfish's own
load-time validation and the engine falls back to classical evaluation.

## Licensing note

The networks are distributed by the Fairy-Stockfish project/community
through the page above; they are not part of this repository and their
redistribution terms are theirs. Check before committing any `.nnue` file
to a public fork.
