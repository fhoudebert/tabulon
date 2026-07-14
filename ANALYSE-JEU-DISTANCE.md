# Jouer à distance contre un humain — analyse (Tabulon)

## 1. Ce que fait Tabulon aujourd'hui (local uniquement)

Dans `app/content/play.js`, `gameLoop()` est la boucle centrale : à chaque tour,
elle regarde `players[turn]` :

- `null` → joueur humain local → `joclyMatch.userTurn()` (le moteur Jocly, en
  iframe proxy, joue le coup lui-même et retourne `{move, finished, winner}`) ;
- un objet `level` → IA locale → `joclyMatch.machineSearch({level})` puis
  `joclyMatch.playMove(result.move)`.

Aucune notion de « joueur distant » n'existe : les deux joueurs sont
nécessairement devant le même écran (ou la même IA).

## 2. Ce que montre jocly-simple-match (jcfrog)

`jocly-simple-match` prouve que le moteur Jocly est **transport-agnostique** :
la classe `Match` expose déjà tout ce qu'il faut (`save()`, `load()`,
`playMove()`, `getTurn()`, `userTurn()`, `abortUserTurn()`) sans rien savoir
du réseau. Le projet ne fait qu'y brancher un transport très simple :

- **Stockage** : un fichier texte par partie (`fileio.php`), contenant le
  JSON `{ matchDetails, matchdata (= sortie de match.save()), time, key }`.
  Un second fichier gère un chat texte, même mécanisme.
- **Écriture** : après chaque coup joué localement (`userTurn()` résolu),
  `saveGameIfNecessary()` appelle `match.save()` et POST le JSON complet.
- **Lecture** : quand ce n'est pas le tour du joueur local, le client
  attend (`checkIfOtherUserPlayed`, 500 ms) et recharge périodiquement
  (`loadMatchFromID`, un load complet sur 1 essai sur 6, sinon on ne fait
  rien). Si `nbTurns` a changé côté serveur, il ne rejoue pas tout : il
  reprend le dernier coup de `matchdata.playedMoves`, fait `match.load()`
  sur l'état *avant* ce coup puis `match.playMove(lastMove)` — pour
  préserver l'animation/l'affichage du coup adverse plutôt que de sauter
  directement à la position finale.
- **Identité des joueurs** : un lien par joueur (`?player=a` / `?player=b`),
  aucune authentification réelle — la « clé » présente dans le JSON n'est
  jamais vérifiée. La sécurité repose uniquement sur le caractère
  non-devinable de l'URL.
- C'est du **polling pur, pas de push** : pas de notification si la fenêtre
  est fermée, requêtes régulières tant qu'on attend l'adversaire.

Ce contrat (matchId + `match.save()` sérialisé + détection du dernier coup
par comptage) est exactement ce qu'il faut reproduire dans Tabulon — seul le
transport change.

## 3. Ce qu'il faut ajouter côté Tabulon

**a) Un 3ᵉ type de joueur.** Aujourd'hui `players[playerKey]` vaut `null`
(humain) ou un `level` (IA). Ajouter un troisième cas, par ex.
`{ remote: true, channel }`, et adapter `gameLoop()` :
- tour local (humain) : comme aujourd'hui (`userTurn()`), puis **pousser**
  le coup joué vers le canal distant (dernier élément de
  `getPlayedMoves()`, ou `match.save()` complet comme jocly-simple-match) ;
- tour distant : **ne pas** appeler `userTurn()` (personne localement pour
  jouer) — attendre la réception d'un coup via le canal, puis
  `joclyMatch.playMove(coupReçu)`.

**b) Une interface de transport unique côté client**, par ex.
`remote-channel.js`, indépendante du moyen choisi :
`send(move)` / `onMove(callback)` / `getMatchId()` / `dispose()`. Le reste du
code (gameLoop, IHM) n'a pas à savoir si ça part par HTTP, WebSocket ou P2P.

**c) Un écran d'invitation** : proposer « Joueur distant » dans les
`select-player-a/-b`, générer un identifiant de partie non-devinable
(UUID), et donner un lien/code à transmettre à l'ami (par le canal que
l'utilisateur veut — mail, messagerie... rien à coder côté Tabulon pour ça).

**d) Reprise de partie.** Le mécanisme `save()`/`load()` existe déjà dans
Tabulon (templates, fork de partie) — il suffit de mémoriser `matchId
distant + rôle (A/B) + transport` dans le store local de la partie pour
pouvoir rouvrir une partie à distance après fermeture de la fenêtre, comme
le fait le simple lien de jocly-simple-match.

**e) Tauri/CSP** : la CSP du projet est actuellement `null` et aucun plugin
réseau n'est déclaré (`Cargo.toml` : store/shell/dialog/os/fs/updater/cli,
pas de `tauri-plugin-http`). `fetch()` et `WebSocket` fonctionnent nativement
depuis le JS de la fenêtre sans plugin Rust supplémentaire pour un simple
client HTTP/WS sortant. Un plugin Rust ne devient nécessaire que si on veut
héberger soi-même un service (serveur de signalisation embarqué, écoute
d'un port en mode « hôte P2P direct », etc.).

## 4. Solutions de transport

### A. Serveur relais (polling ou push), façon jocly-simple-match

Un petit service (Node, PHP, ou autre) qui stocke le dernier `match.save()`
et/ou la liste des coups par `matchId`, et que chaque client interroge.

- **Le plus proche de l'existant**, le plus simple/rapide à porter :
  réutilise directement le format de données de jocly-simple-match.
- Deux variantes :
  - *polling* (comme jocly-simple-match) : simple, marche partout, mais
    latence liée à l'intervalle et trafic inutile pendant l'attente ;
  - *push* (WebSocket, ou SSE) : coup transmis immédiatement, moins de
    requêtes, mais il faut quand même persister côté serveur pour le cas
    asynchrone (l'adversaire revient plus tard, après déconnexion).
- **Inconvénient principal : il faut héberger et maintenir ce serveur**
  (coût, disponibilité, qui en a la responsabilité pour un projet open
  source ?). Un serveur tiers voit passer tous les coups en clair.
- Variante « sans devoir héberger soi-même » : s'appuyer sur un service
  cloud existant à API simple et offre gratuite (base temps réel type
  Firebase/Supabase, ou même un simple stockage clé-valeur exposé en
  HTTPS) comme « boîte aux lettres » par `matchId` — on retrouve exactement
  le modèle fileio.php, sans avoir à coder ni opérer un backend.

### B. Pair à pair (WebRTC DataChannel, ou connexion directe)

- Pas de serveur permanent pour le trafic de jeu lui-même (juste, en
  général, un petit échange de signalisation au moment de la mise en
  relation : offer/answer/ICE).
- Latence minimale, aucun tiers ne stocke la partie.
- Complexité nettement plus élevée : traversée NAT, besoin de serveurs
  STUN (et parfois TURN) publics ou à héberger, et il faut vérifier le
  support de `RTCPeerConnection` dans la webview embarquée sur chaque OS
  (WebView2 / WebKitGTK / WKWebView — a priori présent, moteurs
  navigateurs modernes, mais à valider en pratique sur Tabulon).
- Variante plus simple mais moins « grand public » : connexion directe
  entre les deux machines sans vrai WebRTC — l'hôte de la partie ouvre un
  port et écoute (TCP/WS), l'autre joueur se connecte par IP:port. Demande
  une IP joignable (redirection de port, VPN, ou tunnel façon ngrok) ;
  pratique en LAN/VPN, peu pratique pour deux inconnus sur Internet.
- La signalisation elle-même peut être manuelle (copier-coller un « code
  d'invitation », comme certains outils P2P grand public) pour éviter tout
  serveur, au prix d'un aller-retour utilisateur supplémentaire.

### C. Autres pistes

- **Fichier partagé / synchro cloud** (Dropbox, Drive, Syncthing…) : chaque
  coup écrit un petit JSON dans un dossier synchronisé, lu par l'autre
  client. Zéro code réseau, mais dépend d'un outil de synchro déjà en
  place chez les deux joueurs, et c'est intrinsèquement asynchrone (pas de
  présence en direct, latence = celle de la synchro).
- **Relais par messagerie existante** (email, XMPP, Matrix…) : chaque coup
  = un message envoyé à l'adversaire. Très peu de développement réseau
  propre (protocole standard réutilisé), mais UX de jeu « par
  correspondance », pas de sensation de partie en direct.

## 5. Recommandation

Pour rester fidèle à l'esprit « moteur Jocly transport-agnostique »
démontré par jocly-simple-match, une progression par étapes semble la plus
sûre :

1. **Définir l'interface `RemoteChannel`** côté client (send/onMove/
   matchId/dispose), indépendante du transport — valide toute la partie
   IHM (gameLoop, écran d'invitation, reprise de partie) sans complexité
   réseau.
2. **Implémenter d'abord un relais HTTP + polling**, sur le modèle
   éprouvé de jocly-simple-match (juste `matchId` + `match.save()` +
   dernier coup). C'est le chemin le plus court vers une fonctionnalité
   utilisable, et il peut s'appuyer sur un service cloud existant plutôt
   que sur un serveur à opérer soi-même.
3. **Option : passer ce même relais en push (WebSocket)** pour la
   réactivité, en gardant le polling en secours.
4. **Option : ajouter un mode P2P (WebRTC)** pour les utilisateurs qui
   préfèrent ne dépendre d'aucun serveur tiers — développement plus
   lourd, à traiter comme un second transport derrière la même interface
   `RemoteChannel`, pas comme un point de départ.

## 6. Points d'attention Tabulon/Tauri à trancher

- Sécurité minimale : identifiant de partie non-devinable (UUID), et
  clarté sur le fait que sans HTTPS/WSS le canal n'est ni chiffré ni fiable
  (jocly-simple-match n'a aucune vérification réelle malgré son champ
  « key »).
- `fetch()`/`WebSocket` natifs suffisent pour un simple client sortant (CSP
  actuellement `null`) ; un plugin Rust (`tauri-plugin-http` ou serveur
  embarqué type `axum`/`tiny_http`) ne devient nécessaire que si Tabulon
  doit lui-même héberger un service (signalisation P2P, mode « hôte »).
- Choix de qui est A/B et gestion du cas où l'appli est fermée puis
  rouverte (le lien/identifiant doit suffire à reprendre, comme dans
  jocly-simple-match).
