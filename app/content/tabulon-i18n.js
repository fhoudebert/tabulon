// app/content/tabulon-i18n.js
//
// Internationalisation fr/en de Tabulon.
//
// - La locale est déduite du SYSTÈME : plugin-os locale() (couvert par
//   os:default), avec navigator.language en secours. fr* → fr, sinon en.
// - Chaînes statiques des HTML : attributs data-i18n (textContent),
//   data-i18n-title (title) et data-i18n-placeholder, traduits par
//   translateDom() — lancé automatiquement au DOMContentLoaded dès que ce
//   module est importé quelque part dans la page.
// - Chaînes dynamiques des JS : t('clé') / t('clé', {var}) après
//   `await initI18n()`.
// - Le dictionnaire `en` contient les chaînes d'origine : en anglais,
//   translateDom() est un no-op visuel et toute clé manquante retombe sur en.
// Import namespace VOLONTAIRE : contrairement à `import { locale } ...`,
// il ne plante pas au chargement si le tauri-bridge.js en place ne fournit
// pas (encore) l'export `locale` — bridge.locale vaut alors simplement
// undefined et on retombe sur navigator.language puis 'en'. Un import nommé
// manquant est une SyntaxError à la résolution du module, impossible à
// rattraper, qui tuerait toutes les pages important ce module (vécu :
// "Importing binding name 'locale' is not found" → liste des jeux vide).
import * as bridge from './tauri-bridge.js';

const DICT = {
    en: {
        // hub — navigation
        'nav.games': 'Games', 'nav.all': 'All', 'nav.favorites': 'Favorites',
        'nav.configuration': 'Configuration', 'nav.templates': 'Templates',
        'nav.about': 'About',
        // hub — liste et détail
        'hub.search': 'Search game',
        'hub.joclyMissing': 'Game engine not found (jocly.js)',
        'hub.joclyMissingHint': 'dist/ was missing at build time, or src-tauri/target is stale — delete target/ and rebuild.', 'hub.selectGame': 'Select a game',
        'hub.back': 'Games', 'hub.templates': 'Templates',
        'nav.extensions': 'Extensions',
        'ext.title': 'Extensions',
        'ext.import': 'Import an extension…',
        'ext.noDist': 'Extensions require an external dist/ folder next to the executable. The embedded games library is read-only.',
        'ext.distPath': 'External dist:',
        'ext.search': 'Search game',
        'ext.module': 'module',
        'ext.export': 'Export',
        'ext.remove': 'Uninstall',
        'ext.removeConfirm': 'Uninstall "{game}"? Its declared files will be removed from the external dist (shared module resources are kept).',
        'ext.exported': '"{game}" exported ({files} files).',
        'ext.imported': '"{game}" imported.',
        'ext.updated': '"{game}" updated.',
        'ext.removed': '"{game}" uninstalled.',
        'ext.error': 'Error: {msg}',
<<<<<<< HEAD
<<<<<<< HEAD
        'ext.tabGames': 'Games', 'ext.tabModules': 'Modules',
        'ext.site': 'Get extensions…',
=======
        'ext.tabGames': 'Games', 'ext.tabModules': 'Modules',
>>>>>>> cfb5b73 (export import module)
        'ext.searchModule': 'Search module',
        'ext.moduleGames': '{count} game(s)',
        'ext.moduleExported': 'Module "{module}" exported ({count} games, {files} files).',
        'ext.moduleImported': 'Module "{module}" imported ({count} games).',
        'ext.moduleRemoved': 'Module "{module}" uninstalled ({count} games).',
        'ext.moduleRemoveConfirm': 'Uninstall the whole "{module}" module? Its {count} games (including any imported individually) will be removed from the external dist.',
        'ext.readOnly': 'The external dist is read-only (insufficient permissions): games can be exported, but importing or uninstalling extensions is disabled. Move the dist to a writable folder or adjust its permissions.',
<<<<<<< HEAD
=======
>>>>>>> 84d9dc4 (export/import games)
=======
>>>>>>> cfb5b73 (export import module)
        'btn.quickPlay': 'Quick play', 'btn.clockedPlay': 'Clocked play',
        'btn.openBook': 'Open book', 'btn.boardState': 'Board state',
        'btn.favorite': 'Favorite', 'btn.notFavorite': 'Not favorite',
        'btn.rulesCredits': 'Rules, credits, about', 'btn.invitation': 'Invitation',
        'tip.quickPlay': 'Quick play', 'tip.clockedPlay': 'Clocked play',
        'tip.rules': 'Rules, credits, about',
        'tip.invitation': 'Join a remote game from an invitation link',
        'tip.favorite': 'Favorite', 'tip.unfavorite': 'Unfavorite',
        'tip.removeTemplate': 'Remove',
        // hub — about (contenu du commit "pretraduction")
        'about.version': 'Version',
        'about.locale': 'Language:',
        'lang.en': 'English', 'lang.fr': 'French',
        'about.intro': 'Tabulon is a multi-platform desktop application to play board games, based on the',
        'about.joclyLib': 'Jocly library',
        'about.license': 'Jocly and Tabulon are released under AGPL v3.0 license.',
        'about.features': 'Main features :',
        'about.feat.ui': '2D and 3D user interface available',
        'about.feat.resize': 'Fully resizeable game windows',
        'about.feat.preview': 'Possible moves preview',
        'about.feat.impexp': 'Game import/export',
        'about.feat.clock': 'Clocked games',
        'about.feat.rules': 'Rules available for every game',
        'about.feat.multi': 'Multi-windows: any number of games can be launched simultaneously',
        // play — tooltips
        'tip.players': 'Players', 'tip.viewOptions': 'View options',
        'tip.takeBack': 'Take back', 'tip.restart': 'Restart',
        'tip.history': 'History', 'tip.clock': 'Clock',
        'tip.replay': 'Replay last move', 'tip.pause': 'Pause',
        'tip.resume': 'Resume', 'tip.fullscreen': 'Full screen',
        'tip.save': 'Save', 'tip.load': 'Load', 'tip.snapshot': 'Take snapshot',
        'tip.saveTemplate': 'Save template', 'tip.fork': 'Fork',
        'tip.cameraView': 'Camera view', 'tip.toggleBar': 'Show/hide buttons',
        'tip.stopRecording': 'Stop recording',
        // play — dynamiques
        'tip.recordVideo': 'Record video', 'play.videoSaved': 'Video saved: {path}', 'play.videoError': 'Recording failed: {error}', 'play.capture3dOnly': 'Snapshot and video require a 3D skin',
        'play.thinking': 'Thinking...', 'play.draw': 'Draw',
        'play.waitingRemote': 'Waiting for the remote player…',
        'play.peerDisconnected': 'Peer-to-peer connection lost — the game can no longer sync.',
        'play.aWins': 'Player A wins', 'play.bWins': 'Player B wins',
        'play.loadFailed': 'Load failed: wrong game file?',
        'play.title': '{game} #{id}',
        'play.saveFilter': 'Jocly match',
        'common.playerA': 'Player A', 'common.playerB': 'Player B',
        'common.human': 'Human', 'common.level': 'Level {n}', 'common.remote': 'Remote player',
        // clock-setup
        'clockSetup.title': '{game} clock setup',
        'clockSetup.same': 'Same for both players',
        'clockSetup.different': 'Players have different clocks',
        'clockSetup.time': 'Time', 'clockSetup.timeA': 'Time — Player A',
        'clockSetup.timeB': 'Time — Player B',
        'clockSetup.extra': 'Extra time per move', 'clockSetup.mps': 'Moves per session',
        'unit.seconds': 'seconds', 'unit.minutes': 'minutes',
        'unit.hours': 'hours', 'unit.moves': 'moves',
        'common.cancel': 'Cancel', 'common.save': 'Save',
        'common.close': 'Close', 'common.play': 'Play', 'common.help': 'Help',
        // fenêtres satellites — titres
        'clock.title': 'Clock #{id}', 'history.title': 'History #{id}',
        'players.title': 'Players #{id}', 'viewOptions.title': 'View Options #{id}',
        'info.title': 'About {game}', 'cameraView.title': 'Camera View #{id}',
        'saveTemplate.title': 'Save #{id} as template',
        'saveTemplate.hint': 'Templates remembers players, view options, window size and position so you can start playing from a defined configuration',
        'openPosition.hint': 'If supported by the game implementation, use FEN notation or equivalent',
        'openPosition.placeholder': 'Board position', 'openPosition.open': 'Open',
        'showPosition.hint': 'The board state format depends on the game implementation',
        // players
        'players.heading': 'Players', 'players.name': 'Player name',
        'players.matchId': 'Match ID', 'players.relayUrl': 'Relay URL',
        'players.copy': 'Copy', 'players.copied': 'Copied!',
        'players.test': 'Test', 'players.testChecking': 'Checking…',
        'players.testOk': 'Relay reachable', 'players.testFail': 'Unreachable (network/CORS?)',
        'invitation.title': 'Remote game', 'invitation.join': 'Join',
        'invitation.joinHeading': 'Join a game',
        'invitation.intro': 'Paste a link received from a jocly-simple-match instance (e.g. biscandine.fr) to join that game as the player it was sent to.',
        'invitation.placeholder': 'https://.../index.php?game=...&mid=...&player=a',
        'invitation.invalidLink': 'Not a recognized invitation link (needs game, mid and player).',
        'invitation.gameMismatch': 'This link is for "{game}" — opening that game instead.',
        'invitation.createHeading': 'Or create a new game',
        'invitation.createIntro': 'Creates a match id on the relay below and gives you a link to send the other player. You\'ll play as player A.',
        'invitation.create': 'Create', 'invitation.start': 'Start',
        'invitation.peerHeading': 'Or play peer-to-peer (no server at all)',
        'invitation.peerIntro': 'A direct connection between the two Tabulon apps — no game relay, no signalling server. The host creates a code and sends it to the other player (chat, email…); the guest pastes it and connects. Only works when the guest can reach the host directly: same local network, VPN, or a public IP/port-forward — no NAT traversal, and the connection is not encrypted.',
        'invitation.peerInternetIntro': 'To play over the Internet: forward a TCP port on the host\u2019s router to this machine, enter that port below, and give your public IP (or a DynDNS-style host name) so it goes into the code \u2014 the guest will try it first. Leave both empty for local network play.',
        'invitation.peerExtraAddr': 'Public IP or host name (optional, comma-separated)',
        'invitation.peerPort': 'Port (optional)',
        'invitation.peerBadPort': 'Invalid port \u2014 use a number between 1 and 65535.',
        'invitation.peerHost': 'Create a code',
        'invitation.peerCodePlaceholder': 'Paste the code received from the host (TBP1-…)',
        'invitation.peerJoin': 'Connect',
        'invitation.peerWaiting': 'Code ready — send it to the other player, waiting for them to connect…',
        'invitation.peerConnected': 'Opponent connected — press Start.',
        'invitation.peerConnecting': 'Connecting…',
        'invitation.peerHostFail': 'Could not start listening: {error}',
        'invitation.peerInvalidCode': 'Not a valid peer-to-peer invitation code.',
        'invitation.peerConnectFail': 'Could not reach the host (are you on the same network? firewall?).',
        // history
        'tip.start': 'Start', 'tip.stepBack': 'Step back',
        'tip.stepForward': 'Step forward', 'tip.playMoves': 'Play',
        'tip.pauseMoves': 'Pause', 'tip.end': 'End',
        'tip.saveBook': 'Save book', 'tip.loadBoardState': 'Load board state',
        'tip.displayBoardState': 'Display board state',
        'tip.resumeFromPosition': 'Resume from position',
        // view-options
        'view.skin': 'Skin', 'view.sounds': 'Sounds', 'view.notation': 'Notation',
        'view.showMoves': 'Show moves', 'view.autoComplete': 'Auto-complete moves',
        'view.anaglyph': 'Anaglyph', 'view.viewAs': 'View as',
        // save-template
        'template.name': 'Template name',
        // info
        'info.rules': 'Rules', 'info.description': 'Description',
        'info.credits': 'Credits',
        // book / camera
        'book.loading': 'Loading ...',
        'book.noGame': 'No game found in this file',
        'book.noContent': 'Book content not found — reopen the book from the game page',
        'book.parseError': 'Could not parse file:',
        'camera.viewPoints': 'View points', 'camera.addViewPoint': 'Add view point',
        'camera.spin': 'Spin', 'camera.spinCcw': 'Spin counter-clockwise',
        'camera.spinCw': 'Spin clockwise', 'camera.pauseSpin': 'Pause spin',
        'camera.speeds': 'Speeds', 'camera.addSpeed': 'Add speed',
        'camera.smooth': 'Smooth factor',
    },
    fr: {
        'nav.games': 'Jeux', 'nav.all': 'Tous', 'nav.favorites': 'Favoris',
        'nav.configuration': 'Configuration', 'nav.templates': 'Modèles',
        'nav.about': 'À propos',
        'hub.search': 'Rechercher un jeu',
        'nav.extensions': 'Extensions',
        'ext.title': 'Extensions',
        'ext.import': 'Importer une extension…',
        'ext.noDist': 'Les extensions nécessitent un dossier dist/ externe à côté de l\'exécutable. La ludothèque embarquée est en lecture seule.',
        'ext.distPath': 'Dist externe :',
        'ext.search': 'Rechercher un jeu',
        'ext.module': 'module',
        'ext.export': 'Exporter',
        'ext.remove': 'Désinstaller',
        'ext.removeConfirm': 'Désinstaller « {game} » ? Ses fichiers déclarés seront retirés du dist externe (les ressources partagées du module sont conservées).',
        'ext.exported': '« {game} » exporté ({files} fichiers).',
        'ext.imported': '« {game} » importé.',
        'ext.updated': '« {game} » mis à jour.',
        'ext.removed': '« {game} » désinstallé.',
        'ext.error': 'Erreur : {msg}',
<<<<<<< HEAD
<<<<<<< HEAD
        'ext.tabGames': 'Jeux', 'ext.tabModules': 'Modules',
        'ext.site': 'Obtenir des extensions…',
=======
        'ext.tabGames': 'Jeux', 'ext.tabModules': 'Modules',
>>>>>>> cfb5b73 (export import module)
        'ext.searchModule': 'Rechercher un module',
        'ext.moduleGames': '{count} jeu(x)',
        'ext.moduleExported': 'Module « {module} » exporté ({count} jeux, {files} fichiers).',
        'ext.moduleImported': 'Module « {module} » importé ({count} jeux).',
        'ext.moduleRemoved': 'Module « {module} » désinstallé ({count} jeux).',
        'ext.moduleRemoveConfirm': 'Désinstaller le module « {module} » entier ? Ses {count} jeux (y compris importés individuellement) seront retirés du dist externe.',
        'ext.readOnly': 'Le dist externe est en lecture seule (droits insuffisants) : l\'export des jeux reste possible, mais l\'import et la désinstallation d\'extensions sont désactivés. Déplacez le dist dans un dossier accessible en écriture ou ajustez ses permissions.',
<<<<<<< HEAD
=======
>>>>>>> 84d9dc4 (export/import games)
=======
>>>>>>> cfb5b73 (export import module)
        'hub.joclyMissing': 'Moteur de jeu introuvable (jocly.js)',
        'hub.joclyMissingHint': 'dist/ manquait au moment du build, ou src-tauri/target est périmé — supprimer target/ et rebuilder.', 'hub.selectGame': 'Sélectionnez un jeu',
        'hub.back': 'Jeux', 'hub.templates': 'Modèles',
        'btn.quickPlay': 'Partie rapide', 'btn.clockedPlay': 'Partie chronométrée',
        'btn.openBook': 'Ouvrir un livre', 'btn.boardState': 'État du plateau',
        'btn.favorite': 'Favori', 'btn.notFavorite': 'Pas favori',
        'btn.rulesCredits': 'Règles, crédits, à propos', 'btn.invitation': 'Invitation',
        'tip.quickPlay': 'Partie rapide', 'tip.clockedPlay': 'Partie chronométrée',
        'tip.rules': 'Règles, crédits, à propos',
        'tip.invitation': 'Rejoindre une partie à distance depuis un lien d’invitation',
        'tip.favorite': 'Mettre en favori', 'tip.unfavorite': 'Retirer des favoris',
        'tip.removeTemplate': 'Supprimer',
        'about.version': 'Version',
        'about.locale': 'Langue :',
        'lang.en': 'Anglais', 'lang.fr': 'Français',
        'about.intro': 'Tabulon est une application de bureau multi-plateformes pour jouer aux jeux de plateau, basée sur la',
        'about.joclyLib': 'bibliothèque Jocly',
        'about.license': 'Jocly et Tabulon sont publiés sous licence AGPL v3.0.',
        'about.features': 'Fonctionnalités principales :',
        'about.feat.ui': 'Interface 2D et 3D',
        'about.feat.resize': 'Fenêtres de jeu entièrement redimensionnables',
        'about.feat.preview': 'Aperçu des coups possibles',
        'about.feat.impexp': 'Import/export des parties',
        'about.feat.clock': 'Parties chronométrées',
        'about.feat.rules': 'Règles disponibles pour chaque jeu',
        'about.feat.multi': 'Multi-fenêtres : autant de parties simultanées que souhaité',
        'tip.players': 'Joueurs', 'tip.viewOptions': "Options d'affichage",
        'tip.takeBack': 'Reprendre un coup', 'tip.restart': 'Recommencer',
        'tip.history': 'Historique', 'tip.clock': 'Horloge',
        'tip.replay': 'Rejouer le dernier coup', 'tip.pause': 'Pause',
        'tip.resume': 'Reprendre', 'tip.fullscreen': 'Plein écran',
        'tip.save': 'Enregistrer', 'tip.load': 'Charger',
        'tip.snapshot': "Capture d'écran",
        'tip.saveTemplate': 'Enregistrer comme modèle', 'tip.fork': 'Dupliquer la partie',
        'tip.cameraView': 'Vue caméra', 'tip.toggleBar': 'Afficher/masquer les boutons',
        'tip.stopRecording': "Arrêter l'enregistrement",
        'tip.recordVideo': 'Enregistrer une vidéo', 'play.videoSaved': 'Vidéo enregistrée : {path}', 'play.videoError': "Échec de l'enregistrement : {error}", 'play.capture3dOnly': 'Capture et vidéo nécessitent un habillage 3D',
        'play.thinking': 'Réflexion...', 'play.draw': 'Partie nulle',
        'play.waitingRemote': "En attente du joueur distant…",
        'play.peerDisconnected': 'Connexion pair à pair perdue — la partie ne peut plus se synchroniser.',
        'play.aWins': 'Le joueur A gagne', 'play.bWins': 'Le joueur B gagne',
        'play.loadFailed': 'Échec du chargement : mauvais fichier de jeu ?',
        'play.title': '{game} #{id}',
        'play.saveFilter': 'Partie Jocly',
        'common.playerA': 'Joueur A', 'common.playerB': 'Joueur B',
        'common.human': 'Humain', 'common.level': 'Niveau {n}', 'common.remote': 'Joueur distant',
        'clockSetup.title': 'Horloge — {game}',
        'clockSetup.same': 'Même horloge pour les deux joueurs',
        'clockSetup.different': 'Horloges différentes par joueur',
        'clockSetup.time': 'Temps', 'clockSetup.timeA': 'Temps — Joueur A',
        'clockSetup.timeB': 'Temps — Joueur B',
        'clockSetup.extra': 'Temps bonus par coup', 'clockSetup.mps': 'Coups par session',
        'unit.seconds': 'secondes', 'unit.minutes': 'minutes',
        'unit.hours': 'heures', 'unit.moves': 'coups',
        'common.cancel': 'Annuler', 'common.save': 'Enregistrer',
        'common.close': 'Fermer', 'common.play': 'Jouer', 'common.help': 'Aide',
        'clock.title': 'Horloge #{id}', 'history.title': 'Historique #{id}',
        'players.title': 'Joueurs #{id}', 'viewOptions.title': "Options d'affichage #{id}",
        'info.title': 'À propos de {game}', 'cameraView.title': 'Vue caméra #{id}',
        'saveTemplate.title': 'Enregistrer #{id} comme modèle',
        'saveTemplate.hint': 'Les modèles retiennent les joueurs, les options d\u2019affichage, la taille et la position de la fenêtre, pour repartir d\u2019une configuration définie',
        'openPosition.hint': 'Si le jeu le permet, utilisez la notation FEN ou équivalente',
        'openPosition.placeholder': 'Position du plateau', 'openPosition.open': 'Ouvrir',
        'showPosition.hint': 'Le format de l\u2019état du plateau dépend du jeu',
        'players.heading': 'Joueurs', 'players.name': 'Nom du joueur',
        'players.matchId': 'Identifiant de partie', 'players.relayUrl': 'URL du relai',
        'players.copy': 'Copier', 'players.copied': 'Copié !',
        'players.test': 'Tester', 'players.testChecking': 'Vérification…',
        'players.testOk': 'Relai joignable', 'players.testFail': 'Injoignable (réseau/CORS ?)',
        'invitation.title': 'Partie à distance', 'invitation.join': 'Rejoindre',
        'invitation.joinHeading': 'Rejoindre une partie',
        'invitation.intro': 'Collez un lien reçu d’une instance jocly-simple-match (ex. biscandine.fr) pour rejoindre cette partie en tant que joueur destinataire du lien.',
        'invitation.placeholder': 'https://.../index.php?game=...&mid=...&player=a',
        'invitation.invalidLink': 'Lien d’invitation non reconnu (il faut game, mid et player).',
        'invitation.gameMismatch': 'Ce lien concerne « {game} » — ouverture de ce jeu à la place.',
        'invitation.createHeading': 'Ou créer une nouvelle partie',
        'invitation.createIntro': 'Crée un identifiant de partie sur le relai ci-dessous et donne un lien à envoyer à l’autre joueur. Vous jouerez le joueur A.',
        'invitation.create': 'Créer', 'invitation.start': 'Démarrer',
        'invitation.peerHeading': 'Ou jouer en pair à pair (aucun serveur)',
        'invitation.peerIntro': 'Une connexion directe entre les deux applications Tabulon — ni relai de jeu, ni serveur de signalisation. L’hôte crée un code et l’envoie à l’autre joueur (messagerie, email…) ; l’invité le colle et se connecte. Ne fonctionne que si l’invité peut joindre l’hôte directement : même réseau local, VPN, ou IP publique/redirection de port — pas de traversée NAT, et la connexion n’est pas chiffrée.',
        'invitation.peerInternetIntro': 'Pour jouer à travers Internet : redirigez un port TCP de la box de l\u2019hôte vers cette machine, saisissez ce port ci-dessous, et indiquez votre IP publique (ou un nom d\u2019hôte type DynDNS) pour qu\u2019elle soit incluse dans le code \u2014 l\u2019invité l\u2019essaiera en premier. Laissez vide pour jouer en réseau local.',
        'invitation.peerExtraAddr': 'IP publique ou nom d\u2019hôte (optionnel, virgules pour plusieurs)',
        'invitation.peerPort': 'Port (optionnel)',
        'invitation.peerBadPort': 'Port invalide \u2014 saisissez un nombre entre 1 et 65535.',
        'invitation.peerHost': 'Créer un code',
        'invitation.peerCodePlaceholder': 'Collez le code reçu de l’hôte (TBP1-…)',
        'invitation.peerJoin': 'Se connecter',
        'invitation.peerWaiting': 'Code prêt — envoyez-le à l’autre joueur, en attente de sa connexion…',
        'invitation.peerConnected': 'Adversaire connecté — appuyez sur Démarrer.',
        'invitation.peerConnecting': 'Connexion…',
        'invitation.peerHostFail': 'Impossible de démarrer l\u2019écoute : {error}',
        'invitation.peerInvalidCode': 'Ce n’est pas un code d’invitation pair à pair valide.',
        'invitation.peerConnectFail': 'Impossible de joindre l’hôte (même réseau ? pare-feu ?).',
        'tip.start': 'Début', 'tip.stepBack': 'Coup précédent',
        'tip.stepForward': 'Coup suivant', 'tip.playMoves': 'Lecture',
        'tip.pauseMoves': 'Pause', 'tip.end': 'Fin',
        'tip.saveBook': 'Enregistrer le livre', 'tip.loadBoardState': 'Charger un état du plateau',
        'tip.displayBoardState': "Afficher l'état du plateau",
        'tip.resumeFromPosition': 'Reprendre depuis cette position',
        'view.skin': 'Habillage', 'view.sounds': 'Sons', 'view.notation': 'Notation',
        'view.showMoves': 'Montrer les coups', 'view.autoComplete': 'Compléter les coups',
        'view.anaglyph': 'Anaglyphe', 'view.viewAs': 'Voir comme',
        'template.name': 'Nom du modèle',
        'info.rules': 'Règles', 'info.description': 'Description',
        'info.credits': 'Crédits',
        'book.loading': 'Chargement ...',
        'book.noGame': 'Aucune partie dans ce fichier',
        'book.noContent': 'Contenu du livre introuvable — rouvrez le livre depuis la fiche du jeu',
        'book.parseError': 'Fichier illisible :',
        'camera.viewPoints': 'Points de vue', 'camera.addViewPoint': 'Ajouter un point de vue',
        'camera.spin': 'Rotation', 'camera.spinCcw': 'Rotation anti-horaire',
        'camera.spinCw': 'Rotation horaire', 'camera.pauseSpin': 'Suspendre la rotation',
        'camera.speeds': 'Vitesses', 'camera.addSpeed': 'Ajouter une vitesse',
        'camera.smooth': 'Facteur de lissage',
    },
};

let locale = 'en';
let readyPromise = null;

/** Détecte la locale système (une seule fois) : fr* → 'fr', sinon 'en'. */
export function initI18n() {
    if (!readyPromise) {
        readyPromise = (async () => {
            let sys = null;
            // 1. locale système via plugin-os ; 2. navigator.language ;
            // 3. défaut : 'en'. Chaque étape peut échouer sans conséquence.
            try { sys = await bridge.locale?.(); } catch { /* plugin/export absent */ }
            try { sys = sys || (typeof navigator !== 'undefined' && navigator.language); } catch { /* rien */ }
            locale = /^fr/i.test(String(sys || '')) ? 'fr' : 'en';
            return locale;
        })().catch(() => (locale = 'en'));
    }
    return readyPromise;
}

export const getLocale = () => locale;

/** Traduit une clé, avec interpolation {var}. Clé inconnue → fallback en → clé. */
export function t(key, vars) {
    const s = DICT[locale]?.[key] ?? DICT.en[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : s;
}

// -- Libellés de niveau IA (levels[i].label côté moteur Jocly) --------------
// Ces libellés viennent des modules de jeu Jocly (games/*/index.js), pas de
// Tabulon -- on ne peut pas les faire passer par data-i18n. Relevé exhaustif
// sur l'ensemble des jeux jocly2 (juillet 2026) : les "difficultés" standard
// reviennent dans plusieurs jeux, le reste est un thème propre au jeu
// (marin/pirate, samouraï...). Traduction en overlay : un libellé connu est
// traduit mot a mot (le suffixe "[Nsec]"/"(Nsec)" est toujours conservé tel
// quel) ; un libellé inconnu (jeu futur, non couvert ici) ressort inchangé
// -- jamais de texte manquant, au pire on affiche l'anglais d'origine.
const LEVEL_LABEL_MAP = {
    fr: {
        'easy': 'Facile', 'medium': 'Moyen', 'hard': 'Difficile',
        'strong': 'Fort', 'fast': 'Rapide', 'slow': 'Lent',
        'beginner': 'Débutant', 'expert': 'Expert', 'confirmed': 'Confirmé',
        'baby': 'Bébé', 'mama': 'Maman', 'papa': 'Papa',
        'sailor': 'Marin', 'cabin boy': 'Mousse', 'officer': 'Officier',
        'captain': 'Capitaine', 'admiral': 'Amiral',
        'warrior': 'Guerrier', 'samurai': 'Samouraï',
    },
};

/**
 * Traduit un libellé de niveau IA venu du moteur Jocly (ex. "Easy",
 * "Fast [1sec]", "Papa"). Le mot de base est traduit si connu ; un éventuel
 * suffixe entre crochets/parenthèses (durée) est toujours préservé tel quel.
 * Libellé absent ou non reconnu -> renvoyé inchangé (jamais de trou d'affichage).
 * @param {string} rawLabel
 */
export function translateLevelLabel(rawLabel) {
    if (!rawLabel) return rawLabel;
    const table = LEVEL_LABEL_MAP[locale];
    if (!table) return rawLabel;   // locale 'en' = langue d'origine des libellés
    const m = /^(.*?)\s*([\[(].*[\])])\s*$/.exec(rawLabel);
    const base = (m ? m[1] : rawLabel).trim();
    const suffix = m ? m[2] : '';
    const translated = table[base.toLowerCase()];
    if (!translated) return rawLabel;
    return suffix ? `${translated} ${suffix}` : translated;
}

/** Applique le dictionnaire aux éléments porteurs de data-i18n*. */
export async function translateDom(root = document) {
    await initI18n();
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}

// Traduction automatique du DOM de toute page qui importe ce module.
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', () => translateDom());
    else
        translateDom();
}
