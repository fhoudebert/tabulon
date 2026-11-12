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
| `src/nn.rs` | réseau de valeur : codage de la position, passe avant (voir « Réseau de valeur ») |
| `src/blitz.rs` | charge éclair : colonnes de cavalerie formables en un tour |
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
`setoption maxturns <n>`, `setoption isolation <0|1>`,
`setoption net <fichier|none>`, `quit`.

## Régler l'évaluation : `kriegspiel-lab`

L'évaluation est une somme pondérée de 50 termes nommés (`eval::FEATURES`),
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
ceux en service (`handmade` plus quatre termes stratégiques, voir plus bas). Le moteur les charge par
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

## Réseau de valeur (étape 1)

Les essais ci-dessus montrent que ni les poids ni la profondeur ne sont le
levier. L'étape 1 remplace donc le jugement des positions par un réseau de
neurones entraîné par auto-jeu, en boucle : on entraîne, on rejoue avec le
nouveau réseau, on réentraîne, et un réseau ne prend le titre que s'il bat le
précédent.

### Où il intervient

Le faisceau **construit** toujours les tours avec l'évaluation pondérée, qui
est rapide (environ 5 µs par état). Le réseau **juge** les positions de fin
de tour aux feuilles de la recherche : il y remplace la réponse adverse
construite par faisceau. Il ne sert donc que quelques dizaines à quelques
centaines de fois par coup. Les fins de partie ne passent jamais par lui.

| fichier | rôle |
|---|---|
| `src/nn.rs` | codage de la position (27 plans 25×20), passe avant du réseau, format `.ksnn` |
| `tools/train/ksnn.py` | le même réseau en PyTorch, lecture des échantillons, export `.ksnn` |
| `tools/train/train.py` | entraînement d'une génération |
| `tools/train/loop.py` | la boucle : auto-jeu, entraînement, match, adoption, journal |
| `tools/train/check_export.py` | vérifie que le moteur et PyTorch calculent la même chose |
| `tools/train/gpu_check.py` | mesure si la carte graphique accélère l'entraînement |

Les plans d'entrée sont décrits en tête de `src/nn.rs`. Outre les unités et
le terrain, ils donnent au réseau les lignes de communication, les unités en
communication et les lignes qui resteraient sans les transmissions : il n'a
pas à réapprendre la règle, et voit le danger d'isolement.

### Stratégies (12 novembre 2026)

Six idées de jeu ont été traduites en termes d'évaluation (`eval::strategy`,
indices 39 à 46) et mesurées une à une, chacune contre le moteur sans elle.
Un terme de poids nul n'est pas calculé ; les tests sont dans
`tests/strategy.rs`.

| idée | terme(s) | mesure |
|---|---|---|
| ne pas laisser d'unité à la merci des forces adverses proches ; rester groupé | `exposed_mover` / `exposed_other` : pour chaque unité, ce que les unités adverses à portée de mouvement + tir pourraient porter contre elle, comparé à sa défense actuelle | **69,8 %** contre `handmade` (+117 −38 =45) |
| avancer en restant groupé | `advance_safe` : progrès vers l'arsenal adverse des seules unités non exposées | 54,0 % en plus de l'exposition |
| cavalerie en colonne avant l'affrontement | `column` : cavaliers flanqués d'un autre, ennemi à 6 cases | 51,5 %, puis 50,5 % en plus de l'exposition |
| raid de cavalerie sur un arsenal non défendu | `race_mover` / `race_other` : arsenal vide atteint (en restant chaque tour là où l'on peut bouger) avant que le propriétaire puisse l'occuper | 44,2 %, puis 47,2 % en plus de l'exposition |
| en infériorité, position défensive et route de l'ennemi coupée | `fort_behind` / `home_behind` | 46,2 %, puis 44,5 % |
| attirer l'ennemi avec une troupe isolée, puis le frapper avec l'armée | pas de terme : cela demande un plan sur plusieurs tours, que ni la recherche (deux tours de profondeur à ce budget) ni l'évaluation ne portent | — |

Poids retenus (`TUNED`) : `exposed_mover −3`, `exposed_other 1,5`,
`advance_safe 6`. Contre l'exposition seule (−2 / 1) : 57,0 % sur 400 parties
(+173 −117 =110) ; contre `handmade` : 70,0 % sur 200 parties (+111 −31 =58).
Le coût est négligeable : profondeur 4 en 3 s, comme avant.

Contre « Fort » de jocly2, 3 s par coup pour le moteur : **6 victoires,
4 défaites, 2 nulles sur 12 parties (58 %, ±28 points)**, 93 coups en
moyenne, profondeur 4,1 ; la ligne de base ci-dessous était de 9 sur 20.
L'échantillon est trop petit pour conclure contre jocly2 : le gain établi est
celui de l'auto-jeu. Les défaites restent des pertes d'arsenaux et
d'anéantissement ; les victoires, presque toutes par isolement.

« Rester groupé » et « se regrouper après un succès » sont couverts par
l'exposition : une unité seule devient une cible dès qu'une force adverse
peut l'atteindre. Le raid et la posture défensive perdent des points tels
qu'ils sont formulés : le raid envoie la cavalerie loin de l'armée, ce que
l'exposition sanctionne ensuite, et la posture fige un camp déjà en retard.
La colonne est neutre : la recherche la forme déjà quand une charge est à un
tour.

### Charge éclair (12 novembre 2026)

Une cavalerie **pré-positionnée** — par exemple deux colonnes de deux
cavaliers, des cases vides entre elles — peut se déployer en un tour en une
colonne de 3 ou 4 alignée sur une cible, dans l'une des huit directions, avec
peu de déplacements ; il en reste pour amener de l'artillerie ou de
l'infanterie à portée avant l'attaque. `blitz.rs` :

- `columns` : contre chaque cible proche, la meilleure colonne formable en un
  tour (cavaliers en communication, destinations par les cases vides, pas de
  charge contre une forteresse ou un col ni depuis une forteresse) ;
- `readiness` : la même mesure, sans allocation, pour l'évaluation
  (`blitz_ready` = 4 × cavaliers de la colonne − déplacements nécessaires) ;
- `play_column` : la colonne jouée dans un ordre légal ; la recherche
  (`Limits::blitz`) ajoute ce tour, complété par les soutiens qui augmentent
  l'attaque sur la cible, aux tours du faisceau.

Charges jouées par chaque camp, pour 200 parties (`kriegspiel-lab match`
les compte désormais) :

| | charges à 1 / 2 / 3 / 4 cavaliers |
|---|---|
| moteur précédent | 342 / 89 / 15 / 3 |
| avec la charge éclair | 379 / 221 / 105 / 29 |

| essai, contre le moteur précédent | score |
|---|---|
| générateur seul | 51,2 % (200 parties) |
| générateur + `blitz_ready 60`, deux séries d'ouvertures | 55,8 % et 51,0 %, soit 53,4 % sur 400 parties |
| idem, à temps égal (0,6 s par coup, `--movetime 600`) | **57,5 %** sur 120 parties (+62 −44 =14) |
| générateur + `blitz_ready 30` | 49,0 % |
| générateur + `blitz_ready 150` | 47,5 % |
| idem + destruction possible au prochain tour (`blitz_kill_*`) | 43,2 % |

En service : le générateur et `blitz_ready 60`. Le terme coûte environ 25 %
de positions par seconde (profondeur 3 au lieu de 4 en 3 s sur une partie des
positions de milieu de partie) ; la mesure à temps égal en tient compte. Le
moteur trouve aussi des charges en plusieurs directions à la fois (deux
cavaliers en colonne droite et un en diagonale chargent chacun à 7).

### Ligne de base (11 novembre 2026, avant tout réseau)

- moteur contre lui-même, profondeur 2 : 50,0 % (+76 −76 =48 sur 200
  parties), 42 coups en moyenne ; fins : isolement 92, arsenaux 58,
  répétition 48, anéantissement 2 ;
- contre « Fort » de jocly2, 3 s par coup pour le moteur : **9 victoires sur
  20 (45 %, ±22 points)**, 80 coups en moyenne, profondeur moyenne atteinte
  4,2. Les deux camps partageaient un même cœur, chacun à son tour.

Le critère de réussite de l'étape 1 se mesure par rapport à ces chiffres :
70 % contre « Fort » sur 100 parties, et 65 % contre le moteur sans réseau
sur 400 parties, à budget égal.

### Ce qu'il coûte (mesuré)

Codage plus passe avant, sur un fil, avec AVX2/FMA (détectés à l'exécution,
repli générique sinon), sur un cœur de la machine de développement :

| réseau | fichier | par évaluation | par seconde |
|---|---|---|---|
| 2 blocs × 16 canaux | 0,3 Mo | 0,65 ms | 1 500 |
| **4 × 32 (retenu)** | **0,6 Mo** | **3,6 ms** | **275** |
| 6 × 32 | 0,7 Mo | 5,1 ms | 200 |
| 6 × 48 | 1,3 Mo | 11 ms | 90 |
| 6 × 64 | 2,1 Mo | 20 ms | 50 |
| 10 × 128 | 12 Mo | 131 ms | 8 |

Sur un cœur du Ryzen AI 9 HX 370, le 4 × 32 coûte 3,1 ms (321 évaluations
par seconde). La commande de mesure est à l'étape 3 de la procédure.

À 3 s par coup, la vitesse limite la taille bien avant le volume du fichier.
Un réseau 4 × 32 à profondeur 3 (16 tours à la racine, 6 à chaque nœud
intérieur) fait environ 100 évaluations, soit 0,6 s sur un seul cœur : il
tient sur un Core i5.

### Les commandes

Écrites depuis le répertoire de la crate (`src-tauri/crates/kriegspiel`).
Sous Windows, les binaires s'appellent `kriegspiel-lab.exe` et
`kriegspiel-engine.exe`, et les chemins s'écrivent avec `\`.

```
# auto-jeu, positions codées pour le réseau (format : write_planes_header, src/bin/lab.rs)
kriegspiel-lab selfplay tests/fixtures/openings.txt 5000 gen000.kspl --planes 1 --threads 12 [--net titre.ksnn]
# match réseau contre réseau (ou contre le moteur sans réseau : none), même profondeur
kriegspiel-lab match tests/fixtures/openings.txt 400 tuned tuned --net-a gen001.ksnn --net-b none --threads 12
# même chose à budget de temps égal (non reproductible)
kriegspiel-lab match tests/fixtures/openings.txt 400 tuned tuned --net-a gen001.ksnn --net-b none --movetime 1000 --threads 12
# le moteur en ligne de commande
setoption net gen001.ksnn        # setoption net none : retour à l'évaluation pondérée
```

Contre l'IA de jocly2, avec un réseau :

```
# Linux
KRIEGSPIEL_NET=gen001.ksnn node tools/duel-jocly.cjs <chemin de jocly2> 2 3000 100
```
```powershell
# Windows (PowerShell)
$env:KRIEGSPIEL_NET = "gen001.ksnn"; node tools\duel-jocly.cjs <chemin de jocly2> 2 3000 100
Remove-Item Env:KRIEGSPIEL_NET     # ensuite, pour revenir à l'évaluation pondérée
```

`match` affiche le score avec sa marge d'erreur à 95 % : ±5 points sur 400
parties, ±10 sur 100.

### Machine d'entraînement : la procédure

Pour le Ryzen AI 9 HX 370, sous Linux (Ubuntu 24.04 ou plus récent) ou sous
Windows 11. Les commandes Windows sont pour **PowerShell**. Deux pièges de
PowerShell :
- une commande qui commence par un chemin entre guillemets doit être
  précédée de `&` : `& "C:\…\python.exe" check_export.py t.kspl` ;
- sans cela, PowerShell répond « Jeton inattendu ». `python check_export.py`
  tout court n'est pas concerné.

**0. Prérequis** (une fois)

- Linux : Rust (`rustup`), Python 3.12 et son module `venv`, Node.js ≥ 22,
  Git.
- Windows :
  - Rust (`rustup`, avec les outils de compilation MSVC de Visual Studio) ;
  - Python **3.12** (`winget install Python.Python.3.12`) : c'est la version
    qu'exigent les paquets PyTorch d'AMD pour Windows ;
  - Node.js ≥ 22 et Git ;
  - pour autoriser l'activation des environnements virtuels, une fois :
    `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**1. Construire et vérifier** (une fois)

```
# Linux
git clone -b <branche de travail> https://github.com/fhoudebert/tabulon
cd tabulon/src-tauri/crates/kriegspiel
cargo build --release
cargo test --release
python3 -m venv ~/ks-venv
. ~/ks-venv/bin/activate
pip install numpy torch --index-url https://download.pytorch.org/whl/cpu     # PyTorch au processeur
cd tools/train
../../target/release/kriegspiel-lab selfplay ../../tests/fixtures/openings.txt 4 /tmp/t.kspl --planes 1
python check_export.py /tmp/t.kspl          # doit finir par « ok »
```
```powershell
# Windows (PowerShell)
git clone -b <branche de travail> https://github.com/fhoudebert/tabulon
cd tabulon\src-tauri\crates\kriegspiel
cargo build --release
cargo test --release
py -3.12 -m venv $HOME\ks-venv
& $HOME\ks-venv\Scripts\Activate.ps1
pip install numpy torch --index-url https://download.pytorch.org/whl/cpu    # PyTorch au processeur
cd tools\train
..\..\target\release\kriegspiel-lab.exe selfplay ..\..\tests\fixtures\openings.txt 4 $env:TEMP\t.kspl --planes 1
python check_export.py $env:TEMP\t.kspl     # doit finir par « ok »
```

Dans chaque nouveau terminal, réactiver l'environnement avant les commandes
`python` : `. ~/ks-venv/bin/activate` sous Linux,
`& $HOME\ks-venv\Scripts\Activate.ps1` sous Windows.

**2. La carte graphique sert-elle ?** AMD fournit PyTorch avec ROCm pour la
Radeon 890M (gfx1150) du HX 370, sous Linux et sous Windows 11 (paquets pour
Python 3.12 sous Windows). Les retours restent inégaux, donc on mesure.
Installer ROCm et le PyTorch correspondant en suivant le guide d'AMD
« ROCm on Radeon and Ryzen » (rocm.docs.amd.com/projects/radeon-ryzen),
rubrique Ryzen, pour votre système :
- sous Linux, il demande un noyau OEM 6.14 sur Ubuntu 24.04 ;
- sous Windows, un pilote Adrenalin récent.

Faire cette installation dans un **second** environnement virtuel, pour
garder intact celui de l'étape 1, puis, toujours dans `tools/train` :

```
python gpu_check.py          # compare processeur et carte graphique, et conclut
```

Il conclut à la carte graphique si elle va au moins 1,5 fois plus vite. Dans
ce cas, lancer la boucle depuis ce second environnement avec `--device cuda`
(ROCm se présente sous ce nom) ; sinon, depuis le premier, avec
`--device cpu`. L'étape 1 se fait au processeur dans tous les cas ; la carte
graphique ne fait que raccourcir l'entraînement.

**3. Mesurer la vitesse du réseau sur un cœur** (le coût par coup sur la
machine des joueurs la plus modeste) :

```
# Linux
taskset -c 0 ../../target/release/kriegspiel-lab nnbench ../../tests/fixtures/openings.txt --channels 32 --blocks 4
```
```powershell
# Windows (PowerShell) : /affinity 1 = premier cœur
cmd /c start /b /wait /affinity 1 ..\..\target\release\kriegspiel-lab.exe nnbench ..\..\tests\fixtures\openings.txt --channels 32 --blocks 4
```

Au-dessus de 6 ms par évaluation, prendre `--channels 24` ou `--blocks 3`
dans la boucle.

**4. Annoncer la durée, puis lancer.** `calibrate` joue deux
mini-générations chronométrées et extrapole aux volumes demandés, sans rien
garder. Les commandes `python loop.py` sont identiques sous Linux et sous
Windows (sous Windows, `runs\r1` ou `runs/r1`, au choix) :

```
python loop.py calibrate --run runs/r1 --threads 12 --device cpu
python loop.py run       --run runs/r1 --threads 12 --device cpu --generations 12   # une nuit
```

- `--threads 12` : un fil par cœur physique pour l'auto-jeu et les matchs.
  Sans cette option, la boucle prend tous les fils logiques (24 sur le
  HX 370).
- La boucle reprend où elle s'est arrêtée si on la relance avec la même
  commande.
- Sous Windows, empêcher la mise en veille pendant la nuit : dans les
  paramètres d'alimentation, ou avec
  `powercfg /change standby-timeout-ac 0`.

Pendant qu'elle tourne :

```
# Linux
cat runs/r1/generations.md        # tableau par génération, mis à jour à chaque génération
tail -f runs/r1/log.txt           # commandes et sorties brutes
```
```powershell
# Windows (PowerShell)
Get-Content runs\r1\generations.md
Get-Content runs\r1\log.txt -Wait -Tail 20
```

Les options par défaut sont celles du plan validé : réseau 4 × 32,
5 000 parties par génération (profondeur 2, 10 % de coups au hasard),
entraînement sur les 3 dernières générations en 4 passes, titre au-delà de
55 % sur 400 parties, et mesure contre le moteur sans réseau toutes les
3 générations. Disque : environ 0,35 Go d'échantillons par génération
(`--keep-samples 3` efface les plus anciens).

**5. Mesurer contre jocly2**, seul sur la machine, avec le réseau en titre
(`runs/r1/best.ksnn`). `generations.md` donne la commande exacte, chemins
compris :

```
# Linux
KRIEGSPIEL_NET=runs/r1/best.ksnn node ../duel-jocly.cjs <chemin de jocly2> 2 3000 100
```
```powershell
# Windows (PowerShell)
$env:KRIEGSPIEL_NET = "runs\r1\best.ksnn"; node ..\duel-jocly.cjs <chemin de jocly2> 2 3000 100
```

Critères de réussite : au moins 70 % contre « Fort » sur 100 parties ; au
moins 65 % contre le moteur sans réseau sur 400 parties, à budget égal
(`match --movetime`). Tant qu'ils ne sont pas atteints, le niveau garde son
nom « Moyen (moteur) ».

**6. Verser au dépôt et livrer.**
- Dans le dépôt : `runs/r1/generations.md`, `generations.jsonl` et
  `config.json` (graine, options), qui suffisent à refaire le run. Les
  échantillons et les réseaux intermédiaires restent hors du dépôt.
- Le réseau retenu se publie à part, comme les réseaux de KataGo, sous le
  nom `kriegspiel-value.ksnn`.

### Dans Tabulon

Tabulon cherche `kriegspiel-value.ksnn` aux emplacements des moteurs
(`engine/` à côté de l'exécutable d'abord), ou à l'endroit désigné par la
variable `TABULON_KRIEGSPIEL_NET`. Il le charge à la première sonde ou
recherche. Absent ou illisible, le moteur garde l'évaluation pondérée. La
sonde dit ce qui est en service, et la console de l'interface l'affiche :
`[engine-native] moteur du Jeu de la guerre : Kriegspiel 0.1.0 — reseau …`.

## Limites de cette version

- pas de table de transposition entre les nœuds ;
- pas de détection des répétitions : c'est Jocly qui arbitre la nulle ;
- évaluation réglée à la main quand aucun réseau n'est installé : voir
  ci-dessus ce qui a été essayé ;
- le réseau ne juge que les feuilles ; la construction des tours reste
  confiée au faisceau et à l'évaluation pondérée (c'est ce que l'étape 2,
  politique et MCTS, changerait) ;
- un seul fil par recherche : les 12 cœurs du Ryzen ne servent pas encore à
  chercher plus profond (recherche partagée à la racine, à faire si les
  mesures le justifient) ;
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
