# Les conversations du jeu à distance

Ce document explique ce que devient une conversation entre deux joueurs
Tabulon (ou entre Tabulon et joclymatch ou mogichex) : par où elle passe,
qui peut la lire, combien de temps elle reste sur un serveur, et où sont
rangées les clés. La référence technique, en anglais, est la section
*Remote play* de [DEVELOPMENT.md](DEVELOPMENT.md).

## Ce qui circule pendant une partie

| Quoi | Exemple | Protégé par la clé ? |
|---|---|---|
| Les coups et l'état de la partie | la position, la liste des coups | **Jamais** |
| Le texte libre | « On fait une revanche demain ? » | **Oui**, si la partie a une clé (sauf bascule en clair, voir plus bas) |
| Les messages rapides | « Bien joué », « À vous » | Non (voir ci-dessous) |
| La présence | « Je fais une pause », « Je reviens » | Non |

Les **messages rapides** et la **présence** ne portent aucun texte
personnel : ils voyagent comme des identifiants (`quick`, `state`), que
chaque Tabulon traduit dans sa langue. Pour que joclymatch, qui ne connaît
pas ces identifiants, n'affiche pas une bulle vide, le libellé traduit dans
la langue de l'expéditeur est aussi écrit en clair dans le champ `msg`. Ils
fonctionnent donc même dans une partie sans clé, et ils sont lisibles par le
relai dans tous les cas.

## Les deux transports

**Par un relai** (le cas par défaut : `https://biscandine.fr/variantes/joclymatch/fileio.php`,
ou un relai mogichex). Le relai garde deux fichiers par partie :

- l'état de la partie (`<partie>.txt` chez joclymatch, `<partie>.json` chez
  mogichex), réécrit à chaque coup ;
- le fil de la conversation (`<partie>-chat.txt`, ou `<partie>-chat.jsonl`
  chez mogichex), **une ligne JSON par message, ajoutée par le serveur**. Les
  deux joueurs écrivent dans le même fichier, et joclymatch, mogichex et
  Tabulon le partagent.

Le relai n'a **ni compte ni mot de passe** : connaître l'identifiant de la
partie suffit pour lire et écrire. Cet identifiant est un UUID impossible à
deviner, mais il figure dans le lien d'invitation : toute personne qui a le
lien le connaît, et l'hébergeur du relai voit tout ce qui y est déposé.

**En pair-à-pair** (code d'invitation, liaison TCP directe entre les deux
postes). Rien n'est stocké sur aucun serveur. La liaison TCP **n'est pas
chiffrée** (pas de TLS) : les coups y passent en clair, et c'est pourquoi le
texte libre y est toujours scellé (voir plus bas).

## La protection (le « sceau »)

Quand une partie a une clé, chaque texte libre est chiffré **sur le poste de
l'expéditeur, avant de partir**, avec XChaCha20-Poly1305 (chiffrement
authentifié, nonce aléatoire de 192 bits tiré à chaque message). Le calcul est
fait en Rust (`src-tauri/src/commands/seal_cmds.rs`) et non dans la page :
`crypto.subtle` exige un contexte sécurisé, que rien ne garantit pour
`tauri://` sous WebKitGTK.

Sur le relai, la ligne ressemble à ceci :

```json
{"data":{"msg":"k3Vt…base64…","player":1,"time":1762351200000,"key":"9f2c4a1e0b7d3c58","enc":1}}
```

`msg` contient `base64(nonce ‖ texte chiffré)`, et `enc: 1` indique qu'il est
scellé. Le relai ne peut pas lire le texte. Il voit en revanche : qui écrit (le
camp), quand, la longueur du message (le sceau ajoute 40 octets fixes avant l'encodage base64), les messages rapides et
la présence, et les coups.

Un message scellé que l'on ne sait pas ouvrir (autre clé, texte abîmé) reste
**visible**, marqué « verrouillé » : un trou silencieux dans une conversation
serait pire. Le sceau étant authentifié, un message fabriqué par quelqu'un qui
connaît l'identifiant de partie mais pas la clé est rejeté à l'ouverture plutôt
qu'affiché. Cela n'empêche pas d'**écrire** dans le fil : le relai n'a aucun
moyen de le refuser.

### D'où vient la clé d'une partie

Elle ne passe **jamais** par le relai. Trois cas :

1. **Clé tirée pour l'invitation.** Tabulon tire 32 octets au hasard et les
   met dans le *fragment* du lien (`…#k=<64 caractères hexadécimaux>`), la partie
   après `#`, qu'un navigateur n'envoie jamais au serveur. Quiconque a le lien
   complet a donc la clé : il faut le transmettre par un canal de confiance.
2. **Clé de communauté** (Préférences › Conversations). Le lien ne porte que
   son **empreinte** (`#kid=<16 caractères>`), qui désigne la clé sans la
   donner. Chaque joueur recalcule de son côté la clé de la partie :
   `HMAC-SHA256(clé de communauté, "tabulon/chat/v1:" + identifiant de partie)`.
   Rien ne circule, et chaque partie a sa propre clé.
3. **Pair-à-pair.** La clé est dans le code d'invitation (champ `k`), que les
   joueurs s'échangent eux-mêmes.

On peut aussi coller une clé à la main dans la fenêtre de conversation, ou
choisir une autre clé de communauté quand on ne se lit pas.

Pour vérifier avant de jouer que deux personnes ont bien la même clé de
communauté : Préférences › Conversations › **Tester**. On y compare les
empreintes, ou on chiffre un mot que l'autre déchiffre.

## Les conversations sans protection

### Quand une conversation est-elle sans protection ?

- **La partie n'a aucune clé** : typiquement un lien venu d'un serveur
  joclymatch d'une version antérieure au chiffrement, ou un lien dont le
  fragment (`#k=…`) s'est perdu au copier-coller.
- **On a renoncé à la protection** pour cette partie, de deux façons :
  - « **Continuer sans protection** », proposé quand l'adversaire écrit en
    clair alors que la partie a une clé (par exemple un lien Tabulon ouvert
    dans un joclymatch d'avant le chiffrement, ou une partie protégée par une
    clé de communauté, que ni joclymatch ni mogichex ne connaissent) ;
  - le bouton discret **clé barrée**, à côté de la liste des clés, pour écrire
    sans protection d'emblée avec un joueur avec qui on n'a échangé aucune
    clé.

Le renoncement demande une confirmation et est **sans retour pour la partie**.
Ce qui avait déjà été dit sous protection reste scellé, donc lisible par qui a
la clé. Seuls les messages suivants partent en clair. Il est mémorisé pour
la partie (liste d'identifiants `chat-clear-matches`, **jamais une clé**),
sinon chaque réouverture redemanderait. La fenêtre affiche alors « Cette
conversation est sans protection ».

### Le texte est-il en clair, ou avec une protection minimale ?

**En clair, sans aucune protection minimale.** Il n'y a ni chiffrement
faible, ni obscurcissement, ni même d'encodage : le texte est écrit tel quel
dans le champ `msg`, sans le marqueur `enc`.

```json
{"data":{"msg":"On fait une revanche demain ?","player":1,"time":1762351200000,"key":"9f2c4a1e0b7d3c58"}}
```

Conséquences :

- **l'hébergeur du relai** le lit dans le fichier, sans rien avoir à faire ;
- **toute personne qui connaît l'identifiant de partie** (donc qui a eu le
  lien d'invitation) peut relire le fil avec une simple requête `load` ;
- **le texte reste lisible sur le serveur** tant que le fichier existe (voir
  la durée de vie plus bas). Une sauvegarde de l'hébergement le conserve
  au-delà.

La seule protection qui demeure est celle du **transport** : avec un relai en
`https://` (le relai par défaut l'est), le texte est chiffré **pendant le
trajet** entre le poste et le serveur par TLS, mais il est stocké en clair à
l'arrivée. Avec un relai en `http://`, il est aussi lisible en chemin.

C'est délibéré : une « protection minimale » (un encodage, une clé connue de
tous) n'arrêterait personne et donnerait l'illusion d'une protection. Le texte
est donc soit réellement scellé, soit franchement en clair, et la fenêtre dit
lequel.

**En pair-à-pair, le régime clair n'existe pas pour le texte libre** : sans
clé, la saisie est fermée (seuls les messages rapides et la présence restent
disponibles), et un texte non scellé reçu s'affiche « [message envoyé sans
protection — non affiché] ». La liaison TCP n'étant pas chiffrée, le
contraire reviendrait à l'envoyer lisible sur le réseau.

## Combien de temps une conversation reste sur un relai

| Relai | Fichiers | Durée de vie sans activité (défaut) | Plafond du fil (défaut) |
|---|---|---|---|
| joclymatch `fileio.php` | partie + fil | 30 jours (`$saveTTL`) | 256 Ko, les plus anciens messages retirés (`$chatMaxBytes`) |
| mogichex `match.php` + `fileio.php` | partie + fil | 30 jours (`$matchTTL`) | 256 Ko, idem |
| mogichex `signal.php` | salons de signalisation | 1 heure (`$signalTTL`) | — |

**Ces durées ne sont pas fixées par Tabulon : ce sont des réglages des
serveurs relais.** 30 jours est la valeur par défaut écrite dans le code des
relais joclymatch et mogichex, celle qu'on obtient quand l'hébergeur n'a rien
réglé. Chaque hébergeur peut la changer, comme le plafond du fil :

- **joclymatch** : dans `localconf.php`, à la racine du site (modèle commenté :
  `localconf.php.example`) ;
- **mogichex** : dans `matchconf.php`, ou à défaut `signalconf.php`, à côté de
  `match.php` (modèle commenté : `deploy/signalconf.php.example`).

Tabulon ne peut donc pas connaître la durée réellement appliquée par le relai
d'une partie : celle d'un relai que vous n'hébergez pas est celle que son
hébergeur a choisie, et un relai d'une version antérieure à novembre 2026 peut
ne faire aucun ménage efficace (voir plus bas). Pour être sûr, demandez-le à
qui gère le relai, ou hébergez le vôtre.

**Effacement à la fin de la partie.** Quand une partie à distance se termine
sur un coup **reçu** du relai, Tabulon efface la partie et sa conversation
(`gameioaction=drop`) **à la fermeture de la fenêtre de jeu**.

- **Pourquoi ce joueur-là.** Celui qui a reçu le dernier coup sait que les deux
  côtés ont vu la fin. Celui qui l'a joué ne le sait pas, et effacer de son côté
  pourrait retirer le coup avant que l'autre l'ait lu.
- **Pourquoi à la fermeture.** Les mots échangés après le dernier coup restent
  lisibles tant que la fenêtre est ouverte.
- **Reprise.** Une reprise de coup après la fin annule l'effacement prévu.
- **Qui l'envoie.** C'est la partie Rust de l'application (`relay_cmds.rs`) qui
  envoie la requête, après la destruction de la page.

Limites : si l'application entière se ferme au même moment, la requête peut
être coupée ; un message envoyé après l'effacement recrée un fil ; une partie
dont ce joueur ne revient jamais reste jusqu'à la durée de vie du relai. En
pair-à-pair, il n'y a rien à effacer.

joclymatch et mogichex appliquent la même règle depuis novembre 2026 : celui
qui a reçu le dernier coup efface la partie en fermant sa page (joclymatch,
mogichex) ou en revenant au catalogue (mogichex), par `navigator.sendBeacon`.
mogichex n'arme l'effacement que si la page a vu la partie en cours : une
partie rouverte déjà finie n'est jamais effacée par ce chemin.

**Le ménage par ancienneté.** Faute de tâche planifiée sur un hébergement
mutualisé, chaque relai fait son ménage pendant les requêtes ordinaires, en
vérifiant 40 fichiers par requête. Jusqu'au correctif de novembre 2026, ces
40 étaient toujours les mêmes (l'ordre de `readdir` est stable) : au-delà
d'une quarantaine de parties actives, plus aucune partie expirée n'était
effacée. Ils sont désormais tirés au hasard (correctifs de `fileio.php` pour
joclymatch, de `match.php`, `signal.php` et `fileio.php` pour mogichex). Un
relai qui ne reçoit aucune requête ne fait aucun ménage.

## Où sont rangées les clés sur le poste

Toutes les préférences, clés comprises, sont dans un seul fichier JSON écrit
par Tauri (`tauri-plugin-store`) dans le dossier de données de l'application
(identifiant `fr.biscandine.tabulon`) :

| Système | Fichier |
|---|---|
| Linux | `~/.local/share/fr.biscandine.tabulon/tabulon.json` (ou `$XDG_DATA_HOME/…`) |
| Windows | `%APPDATA%\fr.biscandine.tabulon\tabulon.json` |
| macOS | `~/Library/Application Support/fr.biscandine.tabulon/tabulon.json` |

| Entrée | Contenu | Durée |
|---|---|---|
| `community-keys` | les clés de communauté : `{id, name, key}`, la clé en hexadécimal **en clair** | jusqu'à leur suppression |
| `community-key-current` | l'identifiant de la clé sélectionnée | idem |
| `invite:<id>` | l'invitation qu'on vient de créer ou de rejoindre, **avec la clé de la partie** | quelques instants : supprimée dès que la fenêtre de jeu l'a lue |
| `chat-clear-matches` | les parties où l'on a renoncé à la protection : **identifiants seulement** | les 100 dernières |

À savoir :

- le fichier **n'est pas chiffré**. Il est créé avec les droits par défaut
  (en général lisible par tous, `0644`), et c'est le dossier personnel (en
  `0700` sur la plupart des distributions) qui empêche les autres comptes de le
  lire. Quiconque accède au compte, à une sauvegarde ou à une synchronisation
  de ce dossier lit les clés de communauté ;
- **la clé d'une partie n'est pas conservée** : après l'ouverture de la
  fenêtre de jeu, elle ne vit qu'en mémoire. Les clés de communauté permettent
  de la recalculer ;
- Tabulon **n'utilise pas le `localStorage`** de la webview. La bibliothèque
  Jocly s'en sert pour des préférences d'affichage, et aucune clé n'y est
  écrite ;
- aucune clé ne part vers un relai, ni dans une requête, ni dans un fichier
  de partie.

## Avec joclymatch et mogichex

Les trois applications partagent le même fil sur le relai et **le même sceau**,
à l'octet près (XChaCha20-Poly1305, clé de 32 octets dans `#k=`). Un test Rust
de Tabulon (`opens_a_message_sealed_by_mogichex`) et le test de joclymatch
(`tests/test-chat-seal.mjs`) ouvrent le même message scellé par mogichex.

- **joclymatch** chiffre depuis novembre 2026 (sa version `next`). Une partie
  créée depuis son panneau des jeux reçoit une clé, dans le fragment des deux
  liens, et la conversation y est protégée comme dans Tabulon. Le pseudo y
  est scellé lui aussi (champ `pseudoEnc`, que Tabulon ignore : il affiche le
  camp). Un serveur joclymatch d'une version antérieure ne chiffre pas : il
  écrit en clair et affiche « Message chiffré — ce client n'a pas la clé pour
  le lire » pour un message de Tabulon. D'où l'offre « Continuer sans
  protection » côté Tabulon.
- **mogichex** scelle avec le même format : la conversation peut y être
  protégée.
- **Ni l'un ni l'autre n'a de trousseau** : une partie que Tabulon protège par
  une clé de communauté (`#kid=`) n'est pas lisible chez eux. joclymatch y
  écrit alors en clair (et le dit), mogichex n'y propose que les messages
  rapides.
- Tous deux **retirent la clé de la barre d'adresse** une fois lue (elle reste
  dans l'onglet, pour un rechargement). L'historique du navigateur garde
  toutefois l'adresse visitée, clé comprise, comme le message qui contenait le
  lien.
