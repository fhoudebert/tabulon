// app/content/book-format.js
//
// Lecture et ecriture des formats de partie : PJN/PGN (texte) et solutions
// JSON (format de joclyMatch.save()). Module PUR -- aucun DOM, aucun Tauri --
// pour etre testable directement sous Node, comme localized-field.js ou
// css-url-rewrite.js. Utilise par book.js (chargement), history.js
// (sauvegarde) et hub.js (aiguillage a l'ouverture d'un fichier).

/**
 * Extrait les coups d'un texte PGN/PJN : retire les tags, les commentaires
 * {…}, les variantes (…), les numeros de coups, les NAG $n et le resultat.
 */
export function ExtractMoves(text) {
    const parts = String(text).replace(/\r\n?/g, '\n').split(/\n\n+/);
    const movesPart = (parts.length > 1 ? parts.slice(1) : parts).join('\n');
    let s = movesPart.replace(/\{[^}]*\}/g, ' ');
    while (/\([^()]*\)/.test(s)) s = s.replace(/\([^()]*\)/g, ' ');
    return s.split(/\s+/)
        .map(tok => tok.replace(/^\d+\.+/, ''))     // "12.Nf3" → "Nf3"
        .filter(tok => tok
            && !/^\d+\.+$/.test(tok)                 // "12."
            && !/^\$\d+$/.test(tok)                  // NAG
            && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok) // résultat
            && !/^\[/.test(tok));
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
 * Construit le texte PJN d'une partie.
 *
 * `initialBoard` non nul = la partie ne part PAS de la position standard
 * (probleme, finale). Sans les tags [FEN]/[SetUp], le fichier se rechargerait
 * depuis la position initiale du jeu et les coups seraient introuvables des
 * le premier -- c'est tout l'interet de les ecrire.
 */
export function BuildPJN(gameName, moveStrings, initialBoard, date) {
    const d = date || new Date();
    const moves = moveStrings || [];
    const tags = [
        '[JoclyGame "' + gameName + '"]',
        '[Date "' + d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate() + '"]',
        '[PlyCount "' + moves.length + '"]',
    ];
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
