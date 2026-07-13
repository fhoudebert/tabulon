# Tabulon — Architecture

Notes d'architecture interne. Pour l'installation et les commandes de build, voir [README.md](./README.md).

Application de bureau multiplateforme (Tauri 2 + Jocly) pour jouer aux jeux de plateau. Migration de [JoclyBoard](https://github.com/mi-g/joclyboard) (Electron).

> Historique : une architecture à SharedWorker (« un cerveau applicatif unique ») a été explorée puis **abandonnée**. L'architecture actuelle, décrite ici, place le cœur métier de chaque partie dans sa propre fenêtre `play.html`.

---

## Vue d'ensemble

```
┌────────────────────────────┐
│ hub.html  (fenêtre unique) │  liste des 125 jeux + panneau de détail
└──────────┬─────────────────┘
           │ tRpc.call('new_match', …)          [invoke Tauri]
           ▼
┌────────────────────────────┐   1 fenêtre par partie ; Jocly y tourne
│ play.html #matchId         │   (attachElement → iframe) : boucle de jeu
│  = cerveau du match        │   humain/IA, horloge, save/load, skins
└──────────┬─────────────────┘
           │ events Tauri  play-req / play-rep / play-event :{matchId}:*
           ▼
┌────────────────────────────┐   fenêtres satellites = vues pures
│ history, clock, players,   │   (aucun état métier ; elles interrogent
│ view-options, info, camera │    play.js et écoutent ses pushes)
└────────────────────────────┘
```

- **Rust** (`src-tauri/`) : gestion des fenêtres (création, géométrie persistée), store, favoris/templates, dialogues natifs, écriture de fichiers, enregistrement vidéo (ffmpeg). **Aucune logique de jeu.**
- **`window.Jocly`** : chargé dans chaque page qui en a besoin via `<script src="../browser/jocly.js">` (build de jocly2 copié dans `dist/`, fusionné à la racine web par `frontendDist: ["../app", "../dist"]`).

## Inventaire des fenêtres

| Fichier (app/content/) | Rôle |
|---|---|
| `hub.html/js` | Fenêtre principale : sidebar (All/Favorites/Templates/About), liste des jeux avec raccourcis (favori, règles, quick play), panneau de détail (visuels animés, boutons d'action, templates du jeu). Responsive tablette (sidebar en icônes < 900 px, vue liste **ou** détail < 680 px). |
| `play.html/js` | Le plateau + le cerveau du match : boucle de jeu (`userTurn`/`machineSearch`), état d'horloge, save/load JSON, snapshot, fork, pause, sélecteurs joueurs A/B et skin (2D/3D) dans le footer. Le bouton `…` bascule barre de boutons ⟷ sélecteurs. |
| `clock-setup.html/js` | Configuration d'une partie chronométrée → `new_match(game, clock)`. |
| `clock.html/js` | Affichage de l'horloge (police 7 segments) ; vue pure sur l'état tenu par play.js. |
| `history.html/js` | Navigation dans les coups joués (takeback, replay, reprise depuis une position). |
| `players.html/js`, `view-options.html/js`, `camera-view.html/js`, `save-template.html/js`, `info.html/js`, `book.html/js`, `moves`, `open-position`, `show-position` | Satellites divers. `info` charge règles/description/crédits localisés (voir i18n). |
| *(book-history : supprimé)* | Le rejeu d'une partie de livre passe par play.html (pickMove/playMove) et se navigue via la fenêtre History. |

Modules partagés : `tauri-bridge.js` (accès `window.__TAURI__`, cf. son en-tête pour le pourquoi de `withGlobalTauri`), `tabulon-rpc.js` (mapping nom → payload des commandes Rust), `tabulon-i18n.js` (voir plus bas), `tabulon-winutils.js` (init/titre/ready des fenêtres), `tabulon.css`.

## Protocoles de communication

### 1. UI → Rust : commandes (requête/réponse)

`tRpc.call('nom', ...args)` → `invoke('nom', payloadMappé)`. Le mapping args → payload est centralisé dans `tabulon-rpc.js` : **toute nouvelle commande Rust doit y être ajoutée**. Inventaire actuel (généré depuis les sources) :

- `fs_cmds` : `parse_pjn`, `read_text_file`, `save_text_file`
- `hub_cmds` : `get_app_info`, `notify_user_response`
- `match_cmds` : `close_window`, `is_favorite`, `set_favorite`, `match_ended`, `new_match`, `notify_user`, `open_book_window`, `open_show_position`, `open_window_for_match`, `show_error_dialog`
- `template_cmds` : `is_template_name_valid`, `play_template`, `remove_template`, `save_template`
- `video_cmds` : `start_recording`, `record_frame`, `stop_recording`
- `window_cmds` : `open_board_state`, `open_book`, `open_book_history`, `open_book_match`, `open_camera_view`, `open_clock`, `open_clock_setup`, `open_history`, `open_info`, `open_moves`, `open_players`, `open_position`, `open_save_template`, `open_view_options`, `relay_to_window`

### 2. Rust → UI : pushes (fire-and-forget)

Events Tauri écoutés par le hub : `updateFavorites`, `updateTemplates`, `notifyUser` (bannière + réponse via `notify_user_response`).

### 3. Satellites ⇄ play.js (le protocole central)

Convention par match, définie dans `play.js::initSatelliteListeners()` :

```
requête  : emit('play-req:{matchId}:{action}', payload)      satellite → play
réponse  : listen('play-rep:{matchId}:{action}')             play → satellite
push     : listen('play-event:{matchId}:{event}')            play → satellites
```

Actions servies : `get-clock`, `get-view-options` / `set-view-options`, `get-players` / `set-players`, `get-possible-moves`, `input-move` / `show-move` (fenêtre Possible moves), `get-camera` / `set-camera` (vue caméra 3D), `get-board-state` / `load-board-state` (fenêtres show/open-position), `rollback-to`, `get-played-moves`… Pushes émis : `update-clock` (changement de tour, fin de partie), `move-played` (après chaque coup, un Load ou un rejeu de livre).

**Livres PGN/PJN** : hub.js dépose le contenu dans le store (`book:{game}`) ; book.html le parse via la commande Rust `parse_pjn` (tolère \r\n et lignes vides multiples) et liste les parties ; au clic, les coups SAN extraits sont déposés sous `fork:{id}` avec un marqueur `book` et `new_match` ouvre un plateau qui les rejoue par `pickMove`/`playMove` (partie en pause, navigation via History).

## L'horloge (modèle JoclyBoard porté)

L'état vit dans `play.js` : `{mode, 1: ms, -1: ms, xtrasec_±1, mps_±1, turn, t0}`. À chaque changement de tour, `ClockTurn()` débite le temps écoulé du joueur qui vient de jouer (+ bonus par coup / re-crédit par session en countdown) puis pose `t0`/`turn` ; `ClockStop()` solde à la fin. Sans partie chronométrée, une horloge *countup* tourne quand même (temps de réflexion cumulé). `clock.html` ne fait qu'afficher (calcul du temps courant côté vue via `turn`/`t0`).

## Internationalisation (fr/en)

`tabulon-i18n.js` : locale déduite du **système** (`os.locale()` du plugin-os → secours `navigator.language` → défaut `en` ; import *namespace* du bridge, volontairement, pour qu'un export manquant ne tue pas la page). Chaînes statiques via attributs `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` (traduits automatiquement au DOMContentLoaded) ; chaînes dynamiques via `t('clé', {vars})` après `await initI18n()`. La locale retenue est affichée dans le panneau About.

**Règles de jeu localisées** (`info.js::DocCandidates`), par priorité : 1) clé de langue du `*-config.js` du jeu (ex. `rules.fr` — nom de fichier libre) ; 2) sonde du suffixe `_fr` sur le fichier `en` ; 3) fichier `en`.

## Store (plugin-store, `tabulon.json`)

Clés notables : `nav-last`, `last-game`, `favoriteGames`, `templates`, `view-options:{game}`, `clock` (derniers réglages du setup), `play-footer-bar` (barre de boutons visible), `window:{label}` (géométrie), `fork:{id}` (transfert de position au fork).

## Capture vidéo

`play.js` pompe des frames JPEG (`viewControl('takeSnapshot', {format:'jpeg', quality})`) vers la commande Rust `record_frame`, qui les pousse sur le stdin d'un ffmpeg spawné par `start_recording` (`-f mjpeg … libx264`, `-loglevel error` obligatoire avec stderr pipé sous peine de deadlock du buffer). Boucle séquentielle auto-replanifiée (pas de setInterval qui empile des captures concurrentes en 3D), saut des temps morts après `video-record:ignoreIdenticalFrames` doublons (défaut 30), capture indisponible en skin 2D (limitation Jocly : rendu WebGL requis — boutons grisés avec tooltip).

**Fin d'enregistrement** : le MP4 n'est lisible qu'après fermeture du stdin d'ffmpeg (écriture de l'atome moov) — sinon "unrecognized file format". Trois chemins y mènent : re-clic sur le bouton Record video (bascule, état `.recording` rouge), le bouton Stop dédié, et deux filets automatiques si la fenêtre de jeu se ferme en cours d'enregistrement (`beforeunload` côté JS + hook `WindowEvent::Destroyed` sur `play-{id}` dans lib.rs → `video_cmds::finalize_recording`). Prérequis : ffmpeg dans le PATH.

## Dist externe (jeux chargés à côté de l'exécutable)

`frontendDist: ["../app", "../dist"]` embarque `app/` et `dist/` dans le binaire.
Pour charger un `dist/` **externe** (posé à côté de l'exe) sans rebuild, on ne
peut pas se reposer sur frontendDist : les pages chargent le moteur/les jeux par
URL relatives (`../browser/jocly.js`, `../games/…`) résolues sur les assets
embarqués. Mécanisme (`dist_override.rs` + `asset-rewrite.js`) :

1. `dist_override::external_dist()` cherche un dist utilisable : `TABULON_DIST`,
   `$APPIMAGE` (dossier du .AppImage, pas le montage temporaire), `<exe>/dist`, remontées pour .app/AppImage (résolu une fois, `OnceLock`).
2. Si présent, un protocole custom `tabulon-dist://` sert ses fichiers (repli
   sur `asset_resolver()` embarqué), avec garde anti-traversée (`..` rejeté).
3. `asset-rewrite.js` (injecté via `initialization_script` sur toutes les
   fenêtres — main créée par code, satellites via `open_window`) réécrit à la
   volée `browser/**` et `games/**` (script/img/link + fetch + XHR) vers ce
   protocole. `content/**` n'est jamais redirigé : le shell UI reste embarqué.
4. `get_dist_info` expose l'état (externe/embarqué + chemin) à l'UI.

Sans dist externe, le protocole n'est jamais sollicité et le script pas injecté
— comportement identique à avant.

## Pièges connus

- **`src-tauri/target/` à supprimer** après tout ajout/suppression de fichier dans `app/` (assets embarqués périmés → symptômes de fichiers « fantômes »).
- `.hidden { display:none !important }` dans tabulon.css : ne jamais poser cette classe sur un élément révélé via `style.display` en JS — utiliser `style="display:none"` inline.
- Headers COOP/COEP activés dans `tauri.conf.json` (SharedArrayBuffer pour Fairy-Stockfish WASM).
- Versions des fichiers frontend : `hub.js`/`hub.html` (et consorts) vont par paires — un HTML périmé est détecté par `hub.js` (mode dégradé + message console) plutôt que de bloquer la liste.

## Tests

`tests/` : 6 suites d'intégration jsdom (vrai JS + vrai HTML + vrai `dist/` Jocly, seul `window.__TAURI__` mocké). `npm test` lance tout via `tests/run-tests.mjs`. Couverture : navigation du hub, i18n fr/en + règles localisées, clock-setup, fenêtre clock, save/load (dont le détecteur de double boucle de jeu), mode dégradé.

## Travaux restants

- Commandes Rust sans mapping rpc (`close_window`, `match_ended`, `open_book_window`, `open_window_for_match`, `show_error_dialog`) : vérifier leurs usages internes et retirer les orphelines.
- `engine.html/js` (moteurs externes UCI/CECP) : présent mais non finalisé.
- ~~Retirer photon.css~~ **fait** : photonkit désinstallé, la police photon-entypo vit dans `app/fonts/`, tout le style est dans `tabulon.css`.


## Extensions (.tabulon-ext)

Import/export/désinstallation de jeux quand le dist est EXTERNE (l'embarqué est
en lecture seule). Une extension = zip `extension.json` (manifeste : déclaration
d'index, module, liste de fichiers) + `games/<module>/…` contenant STRICTEMENT
le déclaré de la config (code bundles, rules/credits/description, thumbnail,
visuals). Les ressources partagées du module (css, sons, `res/<set>/*`,
`graphs/*`, fairy-stockfish) restent liées au module : jamais exportées ni
supprimées ; l'import exige le module présent dans le dist cible. Logique en
double : Rust `commands/extension_cmds.rs` (commandes list/export/import/
remove, index lu en json5 — clés non quotées du build jocly — réécrit en JSON
strict avec `.bak`) et Node `scripts/make-extension.mjs` (outillage hors app,
miroir testé par `tests/test-extensions.mjs`) — garder les deux synchronisés.
<<<<<<< HEAD
UI : `content/extensions.html` (fenêtre `open_extensions`, onglets Jeux /
Modules), hub notifié par `relay_to_window('main','extensionsChanged')` →
`ListGames()`.

Extensions de MODULE (manifeste v2, `type: "module"`, v1 accepté en lecture) :
contenu = TOUT `games/<module>/` + les déclarations d'index de ses jeux (champ
`games`), sans liste `files` — l'extraction est bornée au PRÉFIXE
`games/<module>/` avec garde anti-traversée par entrée. Import par FUSION
(jamais de suppression préalable : un jeu importé individuellement survit),
aucune exigence « module présent » ; désinstallation = dossier entier + entrées
d'index. Le socle (moteur, `res/` racine, fairy-stockfish, `scan/` — moteur
Scan des dames, utile au seul module checkers mais maintenu au niveau jocly)
n'est jamais embarqué ni supprimé. Source d'un module hors app : le dist
complet OU un build `gulp --no-default-games --modules src/games/<module>
build` (mêmes fichiers sous `games/<module>/`), empaqueté par
`scripts/make-extension.mjs --module <module>`.
=======
UI : `content/extensions.html` (fenêtre `open_extensions`), hub notifié par
`relay_to_window('main','extensionsChanged')` → `ListGames()`.
>>>>>>> 84d9dc4 (export/import games)
