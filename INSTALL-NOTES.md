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
| `engines-<os>.zip` | `engine/fairy-stockfish`, `engine/scan`, `engine/katago` | dépend du système, et c'est la seule qui contienne des binaires tiers |
| `katago.zip` | `engine/katago-nnetwork.bin.gz`, `engine/katago.cfg` | indépendante du système, volumineuse, et sans elle KataGo ne démarre pas |
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
                       engine/katago
katago.zip          →  engine/katago-nnetwork.bin.gz
                       engine/katago.cfg
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

## Redistribuer les moteurs : ce que la GPL v3 demande

KataGo, lui, est sous **licence MIT** : rien à joindre, une mention de
copyright suffit. Ses réseaux se redistribuent librement aussi ; ceux
republiés par Pachi
(<https://github.com/pasky/pachi/releases/#release-katago_models>) sont la
source la plus stable, les entraînements de KataGo bougeant avec leurs noms de
fichiers. Notez que **son réseau n'est pas facultatif** : contrairement au NNUE
de Fairy-Stockfish, KataGo ne joue pas sans lui, et il lui faut en plus un
`katago.cfg` — d'où l'archive séparée ci-dessus.

Les deux autres moteurs sont sous **GNU GPL v3** — Fairy-Stockfish comme Scan. Cette
licence est permissive sur l'usage : on peut redistribuer, empaqueter, même
vendre. Elle pose **une seule vraie condition**, et c'est celle qui nous
concerne :

> Chaque fois que vous distribuez le programme, vous devez inclure le code
> source complet, **ou un lien vers l'endroit où trouver le code source**
> permettant de générer exactement le binaire distribué. Toute modification
> apportée à la source doit elle aussi être publiée sous GPL.

Trois conséquences pratiques :

1. **Le lien suffit** — nul besoin d'embarquer des sources dans les archives.
   C'est pourquoi le panneau « Installation » porte les liens vers les deux
   dépôts : ils sont atteignables depuis l'application, là où se trouve
   quelqu'un qui a reçu une archive toute faite et n'a jamais vu la page de
   release.
2. **« exactement le binaire distribué »** est la partie exigeante. Un binaire
   pris dans les artefacts de CI correspond à un commit précis : le lien doit
   permettre de le retrouver. Noter le commit dans les notes de release, ou
   nommer l'archive d'après lui, coûte peu et lève l'ambiguïté.
3. **Aucune modification n'est faite** — les binaires sont redistribués tels
   quels. Rien à republier de ce côté, mais il faut que cela reste vrai.

Tabulon lui-même est sous AGPL v3 : redistribuer du GPL v3 à côté ne pose pas
de difficulté de compatibilité, les deux archives restant distinctes.

---

## Les réseaux NNUE : lier plutôt que recopier

Les réseaux courants sont publiés et documentés par le projet lui-même, sur
[la page NNUE de Fairy-Stockfish](https://fairy-stockfish.github.io/nnue/).

**Y renvoyer plutôt que les recopier** règle trois choses d'un coup : la
question de la provenance ne se pose plus, l'utilisateur obtient toujours le
réseau courant sans qu'on ait à republier, et le poids des archives reste
raisonnable.

Reste la difficulté qui, elle, ne se règle pas par un lien : **le nommage**.
Un réseau téléchargé depuis cette page ne porte pas forcément le nom que le
moteur attend, et un fichier mal nommé est chargé sans effet et sans message.
C'est précisément ce que la liste affichée dans le panneau résout — elle donne
les neuf noms exacts, à recopier tels quels.

Une archive `nnue.zip` garde donc son intérêt comme **commodité** : elle évite
neuf téléchargements et neuf renommages. Mais elle n'est plus la seule voie, et
c'est mieux ainsi.

---

## Le principe

**Nommer les auteurs, lier leurs sources, et ne présenter Tabulon que pour ce
qu'il est** — une application qui indique où poser des logiciels qu'elle n'a
pas écrits. Une archive de commodité reste une archive de commodité ; elle ne
change pas la paternité, à condition de le dire et de porter les liens.
