# pean — moteur de Péan (niveau « Strategos », Στρατηγός, autrefois « Maréchal »)

Moteur du wargame à hexagones *Péan* de jocly2 (`src/games/pean`), lié à Tabulon : bibliothèque sans autre
dépendance que serde, appelée directement par `src/commands/pean_cmds.rs` (pas de binaire à fournir à côté de
l'application). L'exécutable `pean-engine` (une requête JSON par ligne) sert aux tests et aux matchs de mesure.

| module | rôle |
|---|---|
| `ctx` | le contexte d'un scénario, tel que jocly2 l'exporte (`PeanRules.exportContext`) : le moteur ne lit jamais les scénarios |
| `rules` | les règles, portage fidèle de `pean-rules.js` : mêmes contrôles, même ordre, mêmes codes d'erreur |
| `ai` | évaluation et tours candidats, portage de `pean-ai.js` ; destinations mises en cache d'un tour candidat à l'autre |
| `search` | alpha-bêta (négamax) à approfondissement itératif sur les tours candidats ; l'arbre est gardé d'une itération à l'autre |
| `service` | une requête JSON (`{ context, state, moveTimeMs }`), une réponse JSON (`{ move, score, depth, nodes, ms }`) |

## Référence et tests

`pean-rules.js` reste la référence. `tests/differential.rs` rejoue des positions de parties produites par jocly2
(`tests/make-fixture.cjs`) et compare tout : destinations et chemins d'unités et de groupes, cibles et rapports de
force, verdicts et codes d'erreur de tours valides ou abîmés exprès, états obtenus, issues, évaluation statique et
tours candidats (avec le générateur pseudo-aléatoire de jocly2).

```sh
node tests/make-fixture.cjs <racine jocly2> [parties par scénario] [--full]   # refait tests/fixtures/
cargo test --release
```

Les fixtures livrées réduisent destinations et états à une empreinte FNV-1a de leur JSON ; `--full` les écrit en
clair pour un diagnostic.

## Mesure

`tools/duel.cjs` : le Strategos contre un niveau jocly2 (Taxiarchos par défaut, tel quel : 5 s par tour), camps alternés,
une partie à la fois ; chaque tour du moteur est validé par jocly2.

```sh
cargo build --release
node tools/duel.cjs <racine jocly2> --games 13
```

Novembre 2026, 2,5 s par tour, 13 parties par scénario, contre « Taxiarchos » après la correction de pean-ai.js :

| scénario | Strategos contre Taxiarchos |
|---|---|
| Bataille libre | 11 V / 0 N / 2 D |
| Leuctres | 9 V / 0 N / 4 D |
| Platées | 6 V / 2 N / 5 D |
| Laurion | 9 V / 0 N / 4 D |
| total | 35 V / 2 N / 15 D, 69 % ; tour le plus long 2,56 s |

(Avant la correction, contre un « Taxiarchos » plus faible : 40 V / 1 N / 11 D, 78 %.)
