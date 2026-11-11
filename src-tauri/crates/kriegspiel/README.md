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
| `src/bin/lab.rs` | `kriegspiel-lab`, le banc de réglage de l'évaluation |

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

## Régler l'évaluation : `kriegspiel-lab`

L'évaluation est une somme pondérée de 39 termes nommés (`eval::FEATURES`),
mesurés du point de vue du camp au trait. `kriegspiel-lab` sert à en comparer
les poids, sans jocly2 et sans horloge (budget en profondeur : les parties
sont reproductibles).

```
# A contre B, chaque ouverture avec les deux couleurs
kriegspiel-lab match tests/fixtures/openings.txt 200 essai.txt handmade
# ce que rapporte un tour de recherche de plus
kriegspiel-lab match tests/fixtures/openings.txt 200 handmade handmade --depth 3 --depth-b 2
# parties moteur contre lui-même, termes et résultat de chaque position
kriegspiel-lab selfplay tests/fixtures/openings.txt 1000 echantillons.txt
# régression logistique sur ces échantillons
kriegspiel-lab fit echantillons.txt --out poids.txt
```

Un fichier de poids contient `nom valeur` par ligne ; les termes absents
gardent leur valeur. `handmade` désigne les poids réglés à la main, `tuned`
ceux en service (les mêmes pour l'instant). Le moteur les charge par
`setoption weights <fichier>`, et `features` affiche les termes d'une position.

`tests/fixtures/openings.txt` (200 débuts de partie) vient des gabarits de
déploiement de jocly2 : `node tests/make-openings.cjs <chemin de jocly2>`.

La force réelle se mesure contre l'IA de jocly2, plus lentement (une
demi-minute à deux minutes par partie) :

```
node tools/duel-jocly.cjs <chemin de jocly2> 2 3000 20    # contre « Fort », 3 s par coup
```

### Ce que les mesures ont donné (novembre 2026)

Parties à profondeur 2, sauf mention ; 160 à 200 parties par ligne, soit une
incertitude d'environ ±3,5 points.

| essai, contre les poids réglés à la main | score |
|---|---|
| poids issus de la régression logistique (1000 parties, 43 495 positions) | 24,5 % |
| unités isolées comptées à 30 % de leur valeur au lieu de 65 % | 46,8 % |
| idem à 10 % | 40,9 % |
| `advance` à −4 / à 0 (au lieu de −12) | 49,6 % / 43,5 % |
| `fragile` à −150 / −400 | 50,9 % / 48,4 % |
| `signal_threat_other` à −2000 | 47,8 % |
| `no_anchor` à −2500 / −6000 | 48,8 % / 47,8 % |
| `one_signal` à −800 | 48,4 % |
| `hunt_mover` / `hunt_other` à ±3000, puis +6000 / −8000 | 50,7 % / 50,2 % |
| tours construits selon un plan (`--plans 1`) contre le faisceau seul | 50,0 % |
| profondeur 2 contre profondeur 1, mêmes poids | 52,5 % |
| profondeur 3 contre profondeur 2, mêmes poids | 54,1 % |

Les tours « selon un plan » (`search::Plan` : mise à l'abri des transmissions,
avance en ordre par la tête ou par la queue, retour vers une ligne directe
d'arsenal) s'ajoutent aux tours du faisceau et sont jugés par la même
évaluation. Ils ne changent rien au score et ne sont donc pas en service
(`Limits::plans`, faux par défaut).

Aucun réglage essayé ne bat les poids de départ, et un tour de recherche de
plus ne rapporte que 2 à 4 points. La régression échoue pour une raison
classique : sur des parties d'un seul joueur, elle apprend ce qui accompagne
la victoire, pas ce qui la cause.

Deux parties sur trois se terminent en une vingtaine de tours par isolement :
le perdant a porté son armée loin de ses arsenaux, elle ne tient plus que par
ses deux unités de transmission, et l'adversaire les détruit en deux tours.
Le moteur ne voit pas ce danger assez tôt, et le pénaliser dans l'évaluation
ne suffit pas. Le facteur limitant n'est donc ni le poids des termes ni la
profondeur, mais la construction des tours (un faisceau glouton sur
l'évaluation statique) et l'absence de plan à plusieurs tours.

## Limites de cette version

- pas de table de transposition entre les nœuds ;
- pas de détection des répétitions : c'est Jocly qui arbitre la nulle ;
- évaluation réglée à la main : voir ci-dessus ce qui a été essayé ;
- une seule recherche à la fois : le drapeau d'arrêt est commun.

## Dans Tabulon

Le moteur est lié à l'application (`kriegspiel = { path = "crates/kriegspiel" }`
dans `src-tauri/Cargo.toml`, compilé en `opt-level = 3` même en debug). Les
commandes `kriegspiel_probe`, `kriegspiel_search` et `kriegspiel_stop`
(`src/commands/kriegspiel_cmds.rs`) n'appellent que `service::search_text`.
Côté interface, `app/content/engine-native.js` remplace le Worker
`jocly.kriegspielworker.js` de jocly par `NativeKriegspielWorker` ; c'est le
niveau « Moyen (moteur) » du jeu (`"ai": "kriegspiel"`) qui le demande. Sans Tabulon,
ce niveau se rabat sur l'IA de jocly et l'annonce.
