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
        'hub.search': 'Search game', 'hub.selectGame': 'Select a game',
        'hub.back': 'Games', 'hub.templates': 'Templates',
        'btn.quickPlay': 'Quick play', 'btn.clockedPlay': 'Clocked play',
        'btn.openBook': 'Open book', 'btn.boardState': 'Board state',
        'btn.favorite': 'Favorite', 'btn.notFavorite': 'Not favorite',
        'btn.rulesCredits': 'Rules, credits, about',
        'tip.quickPlay': 'Quick play', 'tip.clockedPlay': 'Clocked play',
        'tip.rules': 'Rules, credits, about',
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
        'play.thinking': 'Thinking...', 'play.draw': 'Draw',
        'play.aWins': 'Player A wins', 'play.bWins': 'Player B wins',
        'play.loadFailed': 'Load failed: wrong game file?',
        'play.title': '{game} #{id}',
        'play.saveFilter': 'Jocly match',
        'common.playerA': 'Player A', 'common.playerB': 'Player B',
        'common.human': 'Human', 'common.level': 'Level {n}',
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
        // players
        'players.heading': 'Players', 'players.name': 'Player name',
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
        'hub.search': 'Rechercher un jeu', 'hub.selectGame': 'Sélectionnez un jeu',
        'hub.back': 'Jeux', 'hub.templates': 'Modèles',
        'btn.quickPlay': 'Partie rapide', 'btn.clockedPlay': 'Partie chronométrée',
        'btn.openBook': 'Ouvrir un livre', 'btn.boardState': 'État du plateau',
        'btn.favorite': 'Favori', 'btn.notFavorite': 'Pas favori',
        'btn.rulesCredits': 'Règles, crédits, à propos',
        'tip.quickPlay': 'Partie rapide', 'tip.clockedPlay': 'Partie chronométrée',
        'tip.rules': 'Règles, crédits, à propos',
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
        'play.thinking': 'Réflexion...', 'play.draw': 'Partie nulle',
        'play.aWins': 'Le joueur A gagne', 'play.bWins': 'Le joueur B gagne',
        'play.loadFailed': 'Échec du chargement : mauvais fichier de jeu ?',
        'play.title': '{game} #{id}',
        'play.saveFilter': 'Partie Jocly',
        'common.playerA': 'Joueur A', 'common.playerB': 'Joueur B',
        'common.human': 'Humain', 'common.level': 'Niveau {n}',
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
        'players.heading': 'Joueurs', 'players.name': 'Nom du joueur',
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
