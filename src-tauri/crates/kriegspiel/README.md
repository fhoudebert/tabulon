# kriegspiel — moteur du Jeu de la guerre

Moteur Rust du *Jeu de la guerre* de Guy Debord, pour le niveau fort de
Tabulon. Aucune dépendance. Les règles sont celles du module `kriegspiel` de
jocly2 (`src/games/kriegspiel/kriegspiel-rules.js`), qui reste la référence.

| fichier | rôle |
|---|---|
| `src/rules.rs` | les règles, portage terme à terme de `kriegspiel-rules.js` |
| `src/eval.rs` | évaluation statique |
| `src/search.rs` | recherche : tours construits par faisceau, alpha-bêta sur les tours |
| `src/proto.rs` | format texte des positions et des coups |
| `src/main.rs` | `kriegspiel-engine`, le moteur en ligne de commande |

## Construire et tester

```
cargo build --release
cargo test --release
```

- `tests/differential.rs` rejoue `tests/fixtures/differential.txt`, produit à
  partir de la référence JavaScript : communications, destinations de chaque
  unité, attaques, coups acceptés ou refusés (avec le code du refus),
  position résultante et issue doivent coïncider.
- `tests/search.rs` vérifie ce que la recherche doit trouver à coup sûr, et
  que tout coup rendu passe le validateur des règles.

Quand les règles de jocly2 changent, régénérer le fichier puis relancer les
tests :

```
node tests/make-fixture.cjs <chemin de jocly2>
```

## Utiliser la bibliothèque

```rust
use kriegspiel::{proto, search, Ctx};

let ctx = Ctx::new(400, true);            // maxTurns, isolationVictory
let (state, who) = proto::parse_position(text)?;
let limits = search::Limits { movetime_ms: 2000, ..Default::default() };
let result = search::best_move(&ctx, &state, who, &limits, None)?;
println!("{}", proto::format_move(&result.best));
```

`best_move` refuse la phase de placement : le déploiement reste aux gabarits
de jocly2.

## Format

Position : `<trait N|S> <phase> <coups> <arsenaux> <retraite|-> <grille>`.
Les arsenaux sont quatre chiffres 0/1 dans l'ordre D8 B15 T3 T23. La grille
donne les 500 cases, ligne A d'abord : `ICAHTE` pour le Nord (H : artillerie
à cheval), `icahte` pour le Sud, un nombre pour des cases vides consécutives.

Coup : `pass`, ou dans l'ordre du tour `r:137-112` (retraite), `137-112`
(déplacement), `x212` (attaque), `d453` (arsenal détruit). Une case est
`ligne * 25 + colonne - 1`, comme dans le modèle Jocly.

## Ligne de commande

```
position N 2 2 1111 - 60IIII...
go movetime 2000
  info depth 4 score 226 nodes 115913 time 607 pv C8-B8 E9-F10 ...
  bestmove 57-32 108-134 ...
```

Autres commandes : `moves` (tours candidats), `eval`, `play <coup>`, `d`,
`setoption maxturns <n>`, `setoption isolation <0|1>`, `quit`.

## Limites de cette version

- pas de table de transposition entre les nœuds ;
- pas de détection des répétitions : c'est Jocly qui arbitre la nulle ;
- évaluation réglée à la main, sur peu de parties ;
- pas encore branché dans Tabulon (commandes Tauri et faux Worker à écrire).
