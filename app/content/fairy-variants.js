// app/content/fairy-variants.js
//
// Lecture d'un variants.ini de Fairy-Stockfish.
// https://github.com/fairy-stockfish/Fairy-Stockfish/blob/master/src/variants.ini
//
// CE QUE CE FICHIER EST, ET CE QU'IL N'EST PAS. Un variants.ini ne contient
// AUCUNE partie : c'est une declaration de REGLES, lue par le moteur. On ne
// peut donc pas "charger un variants.ini" comme on charge un PGN. Ce que
// Tabulon peut en tirer, et que ce module extrait :
//
//   - startFen : la position de depart de chaque variante, qui EST ouvrable
//     comme etat de plateau si un jeu Jocly partage la meme geometrie ;
//   - maxRank/maxFile : la taille du plateau, qui permet d'ecarter tout de
//     suite les jeux incompatibles ;
//   - le texte de la section, qui est exactement ce qu'attend le champ
//     `customVariantIni` de jocly2 (voir src/core/jocly.fairy.js) pour faire
//     jouer une variante non native par le moteur.
//
// Module PUR -- aucun DOM, aucun Tauri -- donc testable sous Node comme
// book-format.js.

// Une ligne de section : "[nom]" ou "[enfant:parent]".
const SECTION = /^\[\s*([^\]:\s]+)\s*(?::\s*([^\]\s]+)\s*)?\]$/;

/**
 * Decoupe un variants.ini en sections, sans resoudre l'heritage.
 * Renvoie [{ name, parent, keys, text }] dans l'ordre du fichier.
 *
 * Format : commentaires en "#", cles "cle = valeur" (espaces libres autour
 * du "="), valeurs prises telles quelles jusqu'a la fin de ligne -- un FEN
 * contient des espaces et ne doit pas etre coupe.
 */
export function ParseVariantsIni(text) {
    const out = [];
    let cur = null;
    for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.replace(/^\s+|\s+$/g, '');
        // Un "#" n'apparait jamais en milieu de valeur dans ce format ; on
        // coupe donc le commentaire de fin de ligne sans etat d'ame.
        const code = line.replace(/\s*#.*$/, '').trim();
        if (!code) continue;
        const sec = SECTION.exec(code);
        if (sec) {
            cur = { name: sec[1], parent: sec[2] || null, keys: {}, text: code };
            out.push(cur);
            continue;
        }
        if (!cur) continue;                 // cles avant toute section : ignorees
        const eq = code.indexOf('=');
        if (eq < 0) continue;
        const key = code.slice(0, eq).trim();
        const val = code.slice(eq + 1).trim();
        if (!key) continue;
        cur.keys[key] = val;
        cur.text += '\n' + key + ' = ' + val;
    }
    return out;
}

/**
 * Resout l'heritage "[enfant:parent]" : les cles du parent sont recopiees
 * dans l'enfant, l'enfant gardant les siennes. Fairy-Stockfish le fait de
 * meme (parser.cpp) ; sans ca, "[upsidedown:chess]" n'aurait ni pieces ni
 * taille de plateau, seulement son startFen.
 *
 * `builtin` : cles des variantes NATIVES du moteur, dont on n'a pas la
 * definition ici (chess, xiangqi, shogi...). Un heritage qui pointe dessus
 * est laisse tel quel plutot que traite comme une erreur -- c'est le cas le
 * plus courant du fichier officiel.
 *
 * Les cycles sont coupes (un ini fabrique a la main peut en contenir) : on
 * s'arrete au deuxieme passage sur un meme nom.
 */
export function ResolveVariants(sections, builtin) {
    const byName = {};
    for (const s of sections || []) byName[s.name] = s;

    const resolve = (s, seen) => {
        if (!s.parent) return { ...s.keys };
        if (seen.has(s.name)) return { ...s.keys };
        seen.add(s.name);
        const parent = byName[s.parent];
        const base = parent ? resolve(parent, seen) : { ...((builtin || {})[s.parent] || {}) };
        return { ...base, ...s.keys };
    };

    return (sections || []).map(s => {
        const keys = resolve(s, new Set());
        // Chaine d'heritage complete ? Sinon la variante parente est native
        // au moteur et ses cles nous manquent : on ne conclut rien.
        const complete = !s.parent || !!byName[s.parent] || !!((builtin || {})[s.parent]);
        return {
            name: s.name,
            parent: s.parent,
            keys,
            text: s.text,
            startFen: keys.startFen || null,
            // 8x8 est le defaut documente de Fairy-Stockfish (variant.h) : on
            // ne l'applique QUE si toute la chaine d'heritage est connue,
            // sinon la taille reelle est peut-etre declaree chez un parent
            // qu'on n'a pas lu, et repondre "8x8" serait une invention.
            files: Number(keys.maxFile) || (complete ? 8 : null),
            ranks: Number(keys.maxRank) || (complete ? 8 : null),
            // Cette section seule ne suffit pas au moteur quand elle herite
            // d'une variante non native : `customVariantIni` doit alors
            // porter aussi la definition du parent.
            resolved: complete,
        };
    });
}

/**
 * Raccourci : texte du fichier -> variantes resolues.
 */
export function ReadVariantsIni(text, builtin) {
    return ResolveVariants(ParseVariantsIni(text), builtin);
}

/**
 * Reconnait un variants.ini. Un tel fichier n'a ni tags PGN entre crochets
 * SUIVIS d'une valeur ([Event "x"]) ni accolade JSON : ses crochets sont des
 * sections nues. On exige au moins une section ET au moins une cle connue du
 * format, pour ne pas confondre avec un .ini quelconque.
 */
export function IsVariantsIni(text) {
    if (typeof text !== 'string') return false;
    const t = text.trimStart();
    if (!t || t[0] === '{') return false;
    const sections = ParseVariantsIni(t);
    if (!sections.length) return false;
    const known = ['startFen', 'maxRank', 'maxFile', 'pieceToCharTable', 'king', 'pawn',
                   'castling', 'promotionPieceTypes', 'customPiece1'];
    return sections.some(s => known.some(k => k in s.keys));
}

/**
 * Jeux Jocly susceptibles d'ouvrir la position de depart d'une variante :
 * ceux dont la geometrie correspond. On ne compare QUE les dimensions -- un
 * plateau de la bonne taille peut refuser le FEN pour cause de pieces
 * inconnues, et c'est Jocly qui le dira ; l'inverse (bonne piece, mauvaise
 * taille) est en revanche sans espoir et inutile a proposer.
 *
 * `fairyIndex` (variante -> jeu Jocly, voir FairyGameIndex) court-circuite
 * tout : si la variante est deja jouee nativement par un jeu, c'est celui-la.
 */
export function MatchGames(variant, fairyIndex, geometries) {
    const direct = (fairyIndex || {})[String(variant?.name || '').toLowerCase()];
    if (direct) return [direct];
    if (!variant?.files || !variant?.ranks) return [];
    return Object.entries(geometries || {})
        .filter(([, g]) => g && g.files === variant.files && g.ranks === variant.ranks)
        .map(([name]) => name);
}
