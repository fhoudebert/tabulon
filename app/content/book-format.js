// app/content/book-format.js
//
// VOCABULAIRE. Un "ply" (PGN) est un COUP : le coup d'un seul camp. Ce que
// les echecs numerotent "1." est une PAIRE DE COUPS (full move), soit deux
// coups. [PlyCount "9"] annonce donc 9 coups, c'est-a-dire 4 paires de coups
// et demie. Partout ici et dans l'interface, "coup" = ply.
//
// Lecture et ecriture des formats de partie : PJN/PGN (texte) et solutions
// JSON (format de joclyMatch.save()). Module PUR -- aucun DOM, aucun Tauri --
// pour etre testable directement sous Node, comme localized-field.js ou
// css-url-rewrite.js. Utilise par book.js (chargement), history.js
// (sauvegarde) et hub.js (aiguillage a l'ouverture d'un fichier).

/**
 * Commentaires d'une partie, dans l'ordre, rattaches au coup qu'ils suivent.
 * C'est ce que ExtractMoves JETTE : la matiere pedagogique d'un probleme
 * commente ("un sacrifice d'attraction pour liberer le passage") est dans les
 * accolades, pas dans la notation.
 *
 * Renvoie [{ number, move, comment }] :
 *   - une entree sans `move` en tete = commentaire d'introduction, ecrit avant
 *     le premier coup ;
 *   - `number` est le numero PGN quand il est ecrit ("16.", "16..."), null
 *     sinon -- le format ne le repete pas a chaque demi-coup ;
 *   - `comment` est null quand le coup n'est pas commente.
 *
 * Deux nettoyages, parce que le texte brut est illisible sinon :
 *   - les COMMANDES entre crochets dans un commentaire ([%clk 0:00:15],
 *     [%csl Gd8,Ge7], [%eval ...]) sont des annotations machine de lichess et
 *     consorts. Un fichier d'UltraBullet en porte une par demi-coup ; les
 *     afficher noierait le texte. Un commentaire qui ne contenait que ca
 *     disparait.
 *   - les variantes (…) sont retirees comme dans ExtractMoves : ce sont des
 *     lignes secondaires, elles ne se rattachent pas au coup joue et il
 *     faudrait un arbre pour les rendre correctement.
 */
export function BookCommentary(text) {
    const parts = String(text || '').replace(/\r\n?/g, '\n').split(/\n\n+/);
    let s = (parts.length > 1 ? parts.slice(1) : parts).join('\n');
    while (/\([^()]*\)/.test(s)) s = s.replace(/\([^()]*\)/g, ' ');

    const clean = (c) => c.replace(/\[%[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    const out = [];
    let pending = null;                    // numero lu, en attente de son coup
    // Un seul balayage : accolades OU jeton. Les accolades peuvent contenir
    // des espaces et de la ponctuation, on ne peut pas se contenter de
    // decouper sur les blancs.
    const re = /\{([^}]*)\}|(\S+)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        if (m[1] !== undefined) {
            const c = clean(m[1]);
            if (!c) continue;
            // Plusieurs accolades de suite se rattachent au meme coup.
            if (out.length && out[out.length - 1].comment) out[out.length - 1].comment += ' ' + c;
            else if (out.length && out[out.length - 1].move) out[out.length - 1].comment = c;
            else out.push({ number: null, move: null, comment: c });
            continue;
        }
        let tok = m[2];
        if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
        if (/^\$\d+$/.test(tok)) continue;
        // Numerotation, collee ou non au coup ("16.", "16...", "16.Qb8+").
        const num = /^(\d+\.+)(.*)$/.exec(tok);
        if (num) { pending = num[1]; tok = num[2]; if (!tok) continue; }
        out.push({ number: pending, move: tok, comment: null });
        pending = null;
    }
    return out;
}

/**
 * Extrait les coups d'un texte PGN/PJN : retire les tags, les commentaires
 * {…}, les variantes (…), les numeros de coups, les NAG $n et le resultat.
 */
export function ExtractMoves(text) {
    const parts = String(text).replace(/\r\n?/g, '\n').split(/\n\n+/);
    const movesPart = (parts.length > 1 ? parts.slice(1) : parts).join('\n');
    let s = movesPart.replace(/\{[^}]*\}/g, ' ');
    while (/\([^()]*\)/.test(s)) s = s.replace(/\([^()]*\)/g, ' ');
    // Numerotation ecrite a la main : "4 ." au lieu de "4.". Sans cette
    // normalisation le "4" devient un faux coup ET le vrai coup garde un
    // point en tete (".FKi10-k12+"), donc deux jetons irrecuperables.
    // On la retire ici, une fois, plutot que jeton par jeton.
    s = s.replace(/(^|\s)(\d+)\s*\.+/g, '$1');
    return s.split(/\s+/)
        .map(tok => tok.replace(/^\d+\.+/, ''))     // "12.Nf3" → "Nf3"
        .filter(tok => tok
            && !/^\d+\.+$/.test(tok)                 // "12."
            && !/^\$\d+$/.test(tok)                  // NAG
            && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok) // résultat
            && !/^\[/.test(tok));
}

/**
 * Rejoue une liste de jetons de notation. Les deux operations sont fournies
 * par l'appelant, ce qui garde ce module pur (play.js passe joclyMatch) :
 *   pick(str) -> coup Jocly, ou null si la notation ne designe aucun coup
 *                LEGAL dans la position courante (aucun effet de bord) ;
 *   play(move) -> applique le coup et avance la position.
 *
 * Deux tolerances, dans cet ordre :
 *  1. decorations finales (+ # ! ?) retirees si le jeton entier est refuse ;
 *  2. jetons COLLES. Beaucoup de fichiers ecrits a la main soudent un coup
 *     au suivant quand le premier finit par un signe d'echec :
 *     "FKi10-k12+Kl11xk12". Aucun decoupage syntaxique ne peut trancher --
 *     "+" ouvre aussi les pieces promues du shogi ("+L") -- alors on demande
 *     au moteur : le PLUS LONG prefixe qu'il accepte est le coup, le reste
 *     retourne dans la file. Du plus long au plus court, pour ne pas couper
 *     "…-k12+" en "…-k12" et laisser un "+" parasite devant le suivant.
 *
 * Renvoie {played, unresolved} — unresolved est le premier jeton refuse
 * (la lecture s'arrete la, comme dans JoclyBoard), ou null si tout a passe.
 */
export async function ReplayBookMoves(tokens, { pick, play }) {
    const queue = (tokens || []).slice();
    let played = 0;
    while (queue.length) {
        const tok = queue.shift();
        if (!tok) continue;
        let move = await pick(tok);
        let rest = '';
        if (!move) {
            const bare = tok.replace(/[+#!?]+$/, '');
            if (bare !== tok) move = await pick(bare);
        }
        for (let len = tok.length - 1; !move && len >= 2; len--) {
            move = await pick(tok.slice(0, len));
            if (move) rest = tok.slice(len);
        }
        if (!move) return { played, unresolved: tok };
        await play(move);
        played++;
        if (rest) queue.unshift(rest);
    }
    return { played, unresolved: null };
}

/**
 * Libelle lisible d'une partie, pour la liste de la fenetre livre ET le pied
 * de la fenetre de jeu (meme fonction des deux cotes : le meme fichier doit
 * s'annoncer pareil partout).
 *
 * L'ancien libelle venait de la commande Rust parse_pjn, qui ecrivait
 * litteralement "? vs ?" des que [White]/[Black] manquaient -- c'est-a-dire
 * pour TOUS les fichiers ecrits par Tabulon, qui ne posait pas ces tags. On
 * ne se rabat plus sur "?" : on descend une echelle de repli jusqu'a quelque
 * chose qui existe vraiment.
 *
 *   1. les joueurs, s'ils sont nommes          -> "Alice vs Bob"
 *   2. sinon [Event]                           -> "es3"
 *   3. sinon le nom du fichier, sans extension -> "es3"
 *   4. sinon [Date], sinon le jeu              -> "2026.8.11"
 *
 * EXCEPTION quand le fichier contient plusieurs parties (opts.count > 1) :
 * le nom du fichier passe APRES le jeu, parce qu'il est le meme pour toutes
 * les entrees et ne distingue donc rien. Un livre de 12 parties de 12 jeux
 * differents (cas reel : all-tests.pgn) s'affichait "all-tests" douze fois.
 *
 * puis, quand l'information existe, le resultat ([Result] autre que "*") et
 * le nombre de coups. `opts.plies` sert de repli quand le fichier ne porte
 * pas de [PlyCount] : l'appelant a deja les coups extraits, autant compter
 * dessus.
 */
export function BookLabel(tags, opts = {}) {
    tags = tags || {};
    const clean = (v) => {
        const s = typeof v === 'string' ? v.trim() : '';
        // "?" est la valeur PGN pour "inconnu" : la traiter comme absente.
        return (!s || s === '?') ? '' : s;
    };
    const white = clean(tags.White), black = clean(tags.Black);
    const stem  = clean(opts.fileName).replace(/^.*[/\\]/, '').replace(/\.[^.]*$/, '');

    const game = BookGame(tags) || clean(tags.Variant);
    let head = '';
    if (white || black) head = (white || '?') + ' vs ' + (black || '?');
    else if (opts.count > 1) head = clean(tags.Event) || game || stem || clean(tags.Date) || '';
    else head = clean(tags.Event) || stem || clean(tags.Date) || game || '';

    const bits = [];
    const result = clean(tags.Result);
    if (result && result !== '*') bits.push(result);
    const plies = Number(tags.PlyCount) || Number(opts.plies) || 0;
    if (plies > 0) bits.push(plies + ' ' + (opts.pliesLabel || 'plies'));

    let label = [head, bits.join(', ')].filter(Boolean).join(' — ');
    // Numero d'ordre : utile SEULEMENT quand le fichier contient plusieurs
    // parties, sinon "#1" est du bruit sur une liste d'une ligne.
    if (opts.count > 1 && opts.index != null) label += ' #' + (opts.index + 1);
    return label || String(opts.index != null ? '#' + (opts.index + 1) : '?');
}

/**
 * Position de depart declaree dans les tags, ou null si la partie commence a
 * la position standard du jeu. Le tag normalise est [FEN], que [SetUp "1"]
 * accompagne d'ordinaire sans etre indispensable ; on accepte aussi le nom
 * Jocly [InitialBoard].
 */
export function BookFen(tags) {
    if (!tags) return null;
    for (const key of ['FEN', 'Fen', 'fen', 'InitialBoard']) {
        const v = tags[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
}

/**
 * Jeu Jocly declare dans les tags, ou null. [JoclyGame] est le nom ecrit par
 * Tabulon ; [Game] est la forme courte utilisee a la main et par des fichiers
 * tiers. Le nom n'est PAS valide ici -- l'appelant doit verifier qu'il existe
 * dans le catalogue avant de s'en servir.
 */
export function BookGame(tags) {
    if (!tags) return null;
    for (const key of ['JoclyGame', 'Game', 'joclyGame', 'game']) {
        const v = tags[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
}

/**
 * Variante Fairy-Stockfish declaree par le fichier ([Variant], le tag que
 * Fairy-Stockfish, lichess et cutechess ecrivent). Ce n'est PAS un nom de jeu
 * Jocly : "shako" cote Fairy-Stockfish s'appelle "shako-chess" chez Jocly.
 * La correspondance se fait par le catalogue -- voir FairyGameIndex().
 */
export function BookVariant(tags) {
    if (!tags) return null;
    for (const key of ['Variant', 'variant', 'UCI_Variant']) {
        const v = tags[key];
        if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase();
    }
    return null;
}

// Orthographes de [Variant] qui designent une variante Fairy-Stockfish sous
// un autre nom. La table reste DANS la nomenclature du moteur (orthographe ->
// nom Fairy), jamais vers un nom Jocly : c'est le catalogue qui fait ensuite
// la traduction, et une table qui sauterait cette etape se retrouverait a
// devoir suivre les 189 jeux (voir le releve : 5 correspondances sur 13
// ecrites a la main etaient fausses).
//
// Seules figurent ici les orthographes vraiment repandues : "Standard" est ce
// qu'ecrivent lichess, chess.com et la specification PGN pour les echecs
// orthodoxes, la ou Fairy-Stockfish dit "chess".
const VARIANT_ALIASES = {
    'standard': 'chess',
    'from position': 'chess',
    'classical': 'chess',
    'chess960': 'fischerandom',
    'antichess': 'antichess',
    'losing chess': 'antichess',
    'giveaway': 'antichess',
};

/**
 * Nom Fairy-Stockfish canonique d'une orthographe de [Variant].
 */
export function FairyVariantAlias(name) {
    const key = String(name || '').trim().toLowerCase();
    return VARIANT_ALIASES[key] || key || null;
}

/**
 * Index variante Fairy-Stockfish -> nom de jeu Jocly, construit a partir du
 * CATALOGUE plutot que d'une table ecrite a la main : chaque jeu qui sait se
 * faire jouer par Fairy-Stockfish declare deja la variante correspondante
 * dans ses niveaux (`levels[].ai === 'fairy-stockfish'`, champ `variant`),
 * c'est jocly2/src/games/chessbase/index.js qui la pose. Une table recopiee
 * ici divergerait au premier jeu ajoute.
 *
 * `configs` : { gameName -> config Jocly }. Un jeu peut declarer plusieurs
 * variantes (levels[].variants, pour les jeux a prelude) : toutes sont
 * indexees. Premier arrive, premier servi -- l'ordre du catalogue est stable.
 */
export function FairyGameIndex(configs) {
    const index = {};
    for (const [name, cfg] of Object.entries(configs || {})) {
        for (const lvl of cfg?.model?.levels || []) {
            if (lvl?.ai !== 'fairy-stockfish') continue;
            const declared = [lvl.variant, ...(lvl.variants || []).map(v => v?.variant)];
            for (const v of declared)
                if (typeof v === 'string' && v && !index[v.toLowerCase()])
                    index[v.toLowerCase()] = name;
        }
    }
    return index;
}

/**
 * Construit le texte PJN d'une partie.
 *
 * `initialBoard` non nul = la partie ne part PAS de la position standard
 * (probleme, finale). Sans les tags [FEN]/[SetUp], le fichier se rechargerait
 * depuis la position initiale du jeu et les coups seraient introuvables des
 * le premier -- c'est tout l'interet de les ecrire.
 */
export function BuildPJN(gameName, moveStrings, initialBoard, date, meta) {
    const d = date || new Date();
    const moves = moveStrings || [];
    const m = meta || {};
    const tag = (k, v) => (typeof v === 'string' && v.trim())
        ? '[' + k + ' "' + v.trim().replace(/"/g, "'") + '"]' : null;
    const tags = [
        '[JoclyGame "' + gameName + '"]',
        // Tags du roster PGN standard, dans l'ordre habituel. Ecrits
        // seulement quand ils disent quelque chose : un [White "?"] ne vaut
        // pas mieux que pas de tag du tout, et c'est precisement ce qui
        // faisait afficher "? vs ?" a la relecture.
        tag('Event', m.event),
        // [Variant] : le nom Fairy-Stockfish, quand la partie en vient. On
        // l'ecrit A COTE de [JoclyGame] au lieu de convertir l'un en l'autre.
        // Les deux nomenclatures se ressemblent sans coincider ("knightmate"
        // cote moteur, "knightmate-chess" cote Jocly ; "minishogi" contre
        // "mini-shogi") : une table de conversion ecrite a la main se trompe,
        // et le fichier converti a alors perdu le nom d'origine, seule chose
        // qui aurait permis de rattraper l'erreur. Garder les deux ne coute
        // qu'une ligne et rend le fichier reparable.
        tag('Variant', m.variant),
        '[Date "' + d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate() + '"]',
        tag('White', m.white),
        tag('Black', m.black),
        tag('Result', m.result),
        '[PlyCount "' + moves.length + '"]',
    ].filter(Boolean);
    if (initialBoard) {
        tags.push('[FEN "' + String(initialBoard).replace(/"/g, "'") + '"]');
        tags.push('[SetUp "1"]');
    }
    // Numerotation separee par des ESPACES ("1. a b 2. c") : colles, les coups
    // seraient indissociables au rechargement.
    const numbered = moves
        .map((mv, i) => (i % 2 === 0 ? Math.floor(i / 2) + 1 + '. ' : '') + mv)
        .join(' ');
    return tags.join('\n') + '\n\n' + numbered + '\n';
}

/**
 * Reconnait une sauvegarde/solution Jocly au format JSON
 * ({game, initialBoard, playedMoves}). Renvoie l'objet, ou null si ce n'est
 * pas ca -- le fichier part alors dans le circuit PGN/PJN.
 */
export function ParseSolution(text) {
    if (typeof text !== 'string' || text.trimStart()[0] !== '{') return null;
    let o;
    try { o = JSON.parse(text); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    // Une sauvegarde Jocly a au moins une liste de coups OU une position.
    if (!Array.isArray(o.playedMoves) && typeof o.initialBoard !== 'string') return null;
    return o;
}
