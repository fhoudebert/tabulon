# Publier des archives d'appoint — sans s'attribuer le travail d'autrui

Deux difficultés pratiques rendent l'installation manuelle pénible, et aucune
ne se résout par de la documentation :

- **la version du moteur**. Jouer aux variantes récentes (Khan's) demande une
  build récente de Fairy-Stockfish, disponible seulement dans les artefacts
  d'intégration continue du projet — pas dans ses releases. Demander à
  l'utilisateur d'aller chercher un artefact de CI n'est pas raisonnable.
- **le nom des réseaux**. Fairy-Stockfish n'active un `.nnue` que si son nom
  **commence par celui de la variante** (`evaluate.cpp`, `on_eval_file_change`),
  règle que `nnue_name_matches` applique déjà côté Rust. Un réseau correct mais
  renommé est chargé sans effet **et sans message**. Tous les réseaux ne sont
  d'ailleurs pas publiés.

---

## La proposition

Publier, dans les releases de **tabulon**, des archives d'appoint séparées :

| archive | contenu | pourquoi séparée |
|---|---|---|
| `engines-<os>.zip` | `engine/fairy-stockfish`, `engine/scan` | dépend du système, et c'est la seule qui contienne des binaires tiers |
| `nnue.zip` | `engine/*.nnue` aux noms attendus | indépendante du système, et volumineuse |
| `dist-extras-visuals.zip` | les images purgées du `dist` | indépendante du système, purement décorative |

Séparer plutôt que tout empaqueter a une raison simple : **seule la première
contient du logiciel écrit par d'autres**. Les deux autres se téléchargent sans
question de licence, se mettent à jour à leur rythme, et n'obligent pas à
republier un binaire à chaque nouvelle image.

Le bundle « tout-en-un » par système (comme
`unzip-for-windows-quick-install.zip`) garde sa place pour qui découvre : c'est
la voie la plus courte, et elle évite trois téléchargements à quelqu'un qui
veut juste jouer. Mais il ne dispense pas des archives séparées, qui sont ce
qu'on met à jour.

### Structure des archives

Chaque archive se déballe **à côté de l'exécutable**, sans rien déplacer :

```
engines-linux.zip   →  engine/fairy-stockfish
                       engine/scan
nnue.zip            →  engine/shogi.nnue
                       engine/minishogi.nnue
                       engine/kyotoshogi.nnue
                       engine/makruk.nnue
                       engine/shako.nnue
                       engine/capablanca-chess.nnue
                       engine/grand.nnue
                       engine/khans.nnue
                       engine/spartan.nnue
```

C'est exactement là que Tabulon cherche (`binary_path`, puis le répertoire du
moteur pour les réseaux), et c'est ce que le panneau « Installation » affiche.
Les noms de la seconde archive ne sont pas un choix esthétique : ce sont les
seuls que le moteur reconnaîtra.

---

## Ce qu'il faut vérifier avant de publier des binaires tiers

Je ne peux pas trancher ces points, et il ne faut pas les deviner :

1. **La licence de Fairy-Stockfish** (GPL) impose des obligations à qui
   redistribue un binaire — au minimum accompagner la distribution de l'offre
   de la source correspondante, et conserver les mentions de copyright.
   Redistribuer une build issue de la CI du projet demande de vérifier ce que
   cette licence exige exactement, et de le faire.
2. **La licence de Scan** est à vérifier séparément : c'est un autre projet,
   d'un autre auteur.
3. **La provenance des réseaux NNUE** : qui les a entraînés, sous quelles
   conditions de réutilisation.

Le principe qui en découle est déjà appliqué dans le panneau « Installation » :
**nommer les auteurs, renvoyer vers leurs projets, et ne présenter Tabulon que
pour ce qu'il est** — une application qui indique où poser des logiciels
qu'elle n'a pas écrits. Une archive de commodité reste une archive de
commodité ; elle ne change pas la paternité, à condition de le dire.
