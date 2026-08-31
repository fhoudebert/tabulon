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
 * Le meme texte PGN/PJN, PRIVE DE SES COUPS : tags conserves, corps vide.
 *
 * C'est ce que « Essayer » charge. Un probleme est fait pour etre cherche :
 * ouvrir d'emblee la position AVEC sa solution rejouee ne laisse rien a
 * trouver. Le [FEN] suffit a poser l'echiquier, les coups sont precisement ce
 * qu'il faut retirer.
 *
 * On coupe le texte plutot que de reconstruire des tags : un fichier tiers
 * porte des tags qu'on ne connait pas ([StudyName], [Orientation], [ECO]...)
 * et les jeter changerait le libelle, le titre et la resolution du jeu. Toutes
 * les parties du fichier sont traitees, pas seulement la premiere -- un livre
 * de trois tsumeshogi doit rester un livre de trois positions.
 */
export function StripBookMoves(text) {
    const blocks = String(text || '').replace(/\r\n?/g, '\n')
        .split(/\n\n+/).map(b => b.trim()).filter(Boolean);
    const out = [];
    for (const block of blocks) {
        // Un bloc de tags est suivi de son bloc de coups : on garde le
        // premier, on jette le second. Un bloc de coups sans tags devant
        // (fichier sans en-tete) est jete aussi.
        if (!block.startsWith('[')) continue;
        const tags = block.replace(/\[PlyCount\s+[^\]]*\]\n?/g, '') + '\n[PlyCount "0"]';
        // Le corps ne peut pas etre VIDE : le decoupage apparie un bloc de
        // tags avec le bloc suivant, et deux blocs de tags de suite feraient
        // passer le second pour les coups du premier -- un fichier de trois
        // problemes n'en montrerait plus qu'un et demi. On ecrit donc le
        // marqueur de resultat PGN "*" (partie inachevee), qui est exactement
        // ce que la position represente et que l'extraction des coups ignore.
        out.push(tags + '\n\n*');
    }
    return out.length ? out.join('\n\n') + '\n' : '';
}

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
    // Commentaire de LIGNE « ; … » : il court jusqu'au bout de la ligne, et
    // c'est la seconde forme que la specification PGN autorise. Sans le
    // retirer, chaque mot du commentaire devient un faux coup — le fichier
    // d'exemples de variantes en porte plusieurs, et sa premiere ligne
    // « ; variants-examples.pgn » suffisait a produire trois coups fantomes.
    let s = movesPart.replace(/(^|\s);[^\n]*/g, '$1').replace(/\{[^}]*\}/g, ' ');
    while (/\([^()]*\)/.test(s)) s = s.replace(/\([^()]*\)/g, ' ');
    // Numerotation ecrite a la main : "4 ." au lieu de "4.". Sans cette
    // normalisation le "4" devient un faux coup ET le vrai coup garde un
    // point en tete (".FKi10-k12+"), donc deux jetons irrecuperables.
    // On la retire ici, une fois, plutot que jeton par jeton.
    s = s.replace(/(^|\s)(\d+)\s*\.+/g, '$1');
    const out = [];
    for (let tok of s.split(/\s+/)) {
        tok = tok.replace(/^\d+\.+/, '');            // "12.Nf3" → "Nf3"
        // Le marqueur de resultat TERMINE la partie, il ne se saute pas.
        //
        // Un fichier peut porter du texte apres sa derniere partie -- notes,
        // resume, extrait colle d'un autre format -- et le decoupage en blocs
        // n'a aucun moyen de savoir ou la partie s'arrete : il rattache tout
        // ce qui suit les tags jusqu'aux tags suivants, ce qui est la seule
        // regle possible quand un commentaire peut aussi PRECEDER les coups.
        // C'est ici que la question se tranche, et la specification PGN donne
        // la reponse : une partie finit a son jeton de resultat. Sans cet
        // arret, un fichier de crazyhouse suivi de quelques paragraphes
        // donnait 240 "coups" au lieu de 136.
        if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) break;
        if (!tok) continue;
        if (/^\d+\.+$/.test(tok)) continue;          // "12."
        if (/^\$\d+$/.test(tok)) continue;           // NAG
        if (/^\[/.test(tok)) continue;
        out.push(tok);
    }
    return out;
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
 * `exact(str)` -> coup, ou null. Fourni pour les notations dont un jeton ne
 * se devine pas : il court-circuite les deux tolerances ci-dessus, qui
 * feraient plus de mal que de bien. Voir MoveFormat().
 *
 * Renvoie {played, unresolved} — unresolved est le premier jeton refuse
 * (la lecture s'arrete la, comme dans JoclyBoard), ou null si tout a passe.
 */
export async function ReplayBookMoves(tokens, { pick, play, exact }) {
    const queue = (tokens || []).slice();
    let played = 0;
    while (queue.length) {
        const tok = queue.shift();
        if (!tok) continue;

        // Resolution EXACTE quand l'appelant en fournit une (coups en USI).
        // Aucune des tolerances ci-dessous ne s'applique alors, et c'est le
        // point : `pick` passe par GetBestMatchingMove, qui choisit par
        // distance d'edition et ne peut pas echouer -- il y a toujours un plus
        // proche. Donner "12i12h" a une position de chu shogi n'y renverrait
        // pas « inconnu » mais un coup ressemblant, joue en silence. Tolerer
        // les decorations d'un PGN ecrit a la main est une chose ; traduire
        // d'un systeme de coordonnees a un autre en est une autre, et la
        // deuxieme exige de savoir dire non.
        if (exact) {
            const move = await exact(tok);
            if (!move) return { played, unresolved: tok };
            await play(move);
            played++;
            continue;
        }

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
    // Orthographes des exportateurs de variantes : PyChess et chessvariants
    // ecrivent le nom du jeu en toutes lettres, Fairy-Stockfish le colle.
    'kyoto shogi': 'kyotoshogi',
    'mini shogi': 'minishogi',
    'tori shogi': 'torishogi',
    'chu shogi': 'chu',
    'los alamos': 'losalamos',
    'grand chess': 'grand',
    'capablanca chess': 'capablanca',
    'shako chess': 'shako',
    'from position': 'chess',
    'classical': 'chess',
    'chess960': 'fischerandom',
    'antichess': 'antichess',
    'losing chess': 'antichess',
    'giveaway': 'antichess',
};

/**
 * Le meme SFEN, trait inverse — ou null si ce n'est pas un SFEN.
 *
 * POURQUOI. Le trait fait deux inversions entre ChuShogiLite et jocly, et
 * elles ne se compensent pas :
 *
 *   SFEN            "b" = sente = les majuscules  (le parseur lit
 *                   isWhite = char === char.toLowerCase())
 *   jocly           note ce meme trait "w"        -> ImportSFEN echange les
 *                                                   deux, dans les deux sens
 *   [FEN] d'un PGN  ChuShogiLite y ecrit "w" la ou son SFEN porte "b"
 *                   (« CSL player b = sente = PGN white », dit son code)
 *
 * Les deux inversions se COMPENSENT : un [FEN] de PGN arrive dans la
 * convention de jocly et ne doit PAS etre retouche (voir PgnFenToJocly). Cette
 * fonction sert au cas restant, celui d'un SFEN a quatre champs dont on ne
 * sait pas s'il vient d'un export brut ou d'un producteur qui l'a deja
 * inverse. On ne peut pas deviner ; on peut verifier : la position et le
 * premier coup doivent s'accorder. C'est ce que fait play.js — un essai, puis
 * le trait inverse, et un message si c'est la deuxieme lecture qui est bonne.
 *
 * Ne touche qu'a un SFEN (3 ou 4 champs). Un FEN jocly en a six et repart
 * inchange : l'inverser serait une corruption silencieuse.
 */
export function FlipSfenTurn(fen) {
    const fields = String(fen || '').trim().split(/\s+/);
    if (fields.length < 3 || fields.length > 4) return null;
    if (fields[1] !== 'b' && fields[1] !== 'w') return null;
    fields[1] = fields[1] === 'b' ? 'w' : 'b';
    return fields.join(' ');
}

/**
 * Le [FEN] d'un PGN ChuShogiLite, recompose en FEN jocly — ou null.
 *
 * CSL ecrit CINQ champs : le plateau, le trait, la case de la derniere prise
 * de Lion, puis « 0 1 » ajoutes pour ressembler a un FEN d'echecs. jocly en
 * attend six (il reconnait aussi un SFEN a trois ou quatre champs, mais cinq
 * ne ressemble a rien de connu et part en « FEN should have 6 parts »).
 *
 * Le trait, LUI, ne bouge pas. C'est contre-intuitif et ca se demontre en
 * deux temps : le SFEN note « b » le trait de sente, jocly note ce meme trait
 * « w », et CSL ecrit « w » dans son [FEN] la ou son SFEN porte « b ». Les
 * deux inversions se compensent, et un [FEN] de PGN arrive donc dans la
 * convention de jocly. C'est un SFEN a quatre champs qu'il faudrait inverser,
 * et jocly s'en charge tout seul dans ImportSFEN.
 *
 * La case de prise de Lion est perdue : jocly la relit dans son historique
 * (locust-move-model.js) et non dans une position. Consequence a connaitre --
 * la regle d'anti-echange ne sera pas armee sur le tout premier coup d'une
 * position ainsi chargee.
 */
export function PgnFenToJocly(fen) {
    const f = String(fen || '').trim().split(/\s+/);
    if (f.length !== 5) return null;
    if (f[1] !== 'b' && f[1] !== 'w') return null;
    const move = /^\d+$/.test(f[4]) ? f[4] : '1';
    return `${f[0]} ${f[1]} - - 0 ${move}`;
}

/**
 * Notation « occidentale » de ChuShogiLite : "+Hxe11", "Tc11", "+Oxc7,b8".
 *
 * Elle ressemble a celle de jocly sans lui etre identique, et c'est le piege :
 *   - la lettre est l'abreviation FEN de la piece ("+H") la ou jocly ecrit son
 *     abreviation naturelle ("+DH") ;
 *   - la case de DEPART est omise ;
 *   - les deux pas du Lion sont separes par une virgule, jocly par un tiret.
 * Donnee a pickMove, "+Hxe11" trouverait donc un « plus proche » et le
 * jouerait. D'ou cette lecture explicite, qui rend les elements a comparer.
 *
 * Renvoie { piece, steps:[{capture, square}] } ou null si ce n'en est pas.
 */
export function ParseWesternMove(token) {
    const m = /^(\+?[A-Z]+)?((?:[-x]?[a-l][0-9]{1,2})(?:\s*,\s*[-x]?[a-l][0-9]{1,2})*)([+=!?#]*)$/
        .exec(String(token || '').trim());
    if (!m) return null;
    const steps = m[2].split(',').map(part => {
        const p = /^\s*([-x]?)([a-l][0-9]{1,2})\s*$/.exec(part);
        return p ? { capture: p[1] === 'x', square: p[2] } : null;
    });
    if (steps.some(x => !x)) return null;
    // Le "+" final est une PROMOTION, pas une decoration d'echec.
    //
    // Au shogi la promotion est facultative : jocly produit les deux versions
    // du meme deplacement, et il faut donc savoir laquelle le fichier demande
    // -- sinon les deux correspondent et le jeton est refuse pour ambiguite,
    // ce qui arrete la lecture net. Le fichier de reference ne marque nulle
    // part l'echec, dans une position ou presque chaque coup en donne un : le
    // "+" ne peut donc pas vouloir dire ca.
    return { piece: m[1] || null, steps, promote: /\+/.test(m[3] || '') };
}

/**
 * La meme lecture, sur une chaine produite par jocly (format `natural`) :
 * "+DHh8xe11+", "a4-a5", "+KNxc7-b8" — ce dernier, un coup a deux pas, n'a
 * pas de case de depart chez jocly non plus.
 *
 * Renvoie { piece, from, steps:[{capture, square}] } ou null.
 */
export function ParseNaturalMove(text) {
    const raw = String(text || '').trim();
    // "=<abbrev>" : le type obtenu. jocly ne l'ecrit que lorsqu'un CHOIX
    // existait, et les types promus sont ceux dont l'abreviation commence par
    // "+" -- refuser de promouvoir donne "=KN", promouvoir "=+KN".
    const promo = /=(\+?[A-Z]+)/.exec(raw);
    const s = raw.replace(/[+#!?]*$/, '').replace(/=.*$/, '');
    const m = /^(\+?[A-Z]+)?(?:([a-l][0-9]{1,2}))?((?:[-x][a-l][0-9]{1,2})+)$/.exec(s);
    if (!m) {
        // Forme SANS SEPARATEUR : le xiangqi de jocly ecrit « c9e7 », ni
        // abreviation ni tiret. Faute de la reconnaitre, la case de DEPART
        // restait nulle -- et sans depart, pas de rivales, donc pas de
        // desambiguisation : l'export ecrivait « Ee8 » la ou deux elephants
        // visaient la meme case, et le fichier produit ne se rechargeait pas.
        const flat = /^([a-l][0-9]{1,2})([a-l][0-9]{1,2})$/.exec(s);
        if (!flat) return null;
        return {
            piece: null, from: flat[1],
            // La prise n'apparait pas dans cette forme : l'appelant la connait
            // par l'objet coup, on ne l'invente pas ici.
            steps: [{ capture: false, square: flat[2] }],
            promote: promo ? promo[1].startsWith('+') : null,
        };
    }
    const steps = [];
    const re = /([-x])([a-l][0-9]{1,2})/g;
    let step;
    while ((step = re.exec(m[3])) !== null) steps.push({ capture: step[1] === 'x', square: step[2] });
    return {
        piece: m[1] || null, from: m[2] || null, steps,
        // null quand aucun choix ne se posait : il n'y a alors rien a comparer.
        promote: promo ? promo[1].startsWith('+') : null,
    };
}

/**
 * Un coup jocly correspond-il au jeton occidental lu ?
 *
 * On compare la SUITE DES CASES et les prises, qui sont dites de la meme
 * facon des deux cotes. La lettre de piece ne peut pas se comparer
 * directement — abreviation FEN contre abreviation naturelle — d'ou
 * `letterAt` : l'appelant fournit la lettre que porte le plateau sur une case,
 * qui est justement l'abreviation FEN. Sans case de depart connue (coup a deux
 * pas), la lettre n'est pas verifiee et c'est la suite des cases qui doit
 * suffire a distinguer.
 */
export function WesternMatches(parsedToken, naturalText, letterAt) {
    const nat = ParseNaturalMove(naturalText);
    if (!nat || !parsedToken) return false;
    if (nat.steps.length !== parsedToken.steps.length) return false;
    for (let i = 0; i < nat.steps.length; i++) {
        if (nat.steps[i].square !== parsedToken.steps[i].square) return false;
        // La prise n'est comparee strictement que sur le PREMIER pas. Sur un
        // coup a deux pas, ChuShogiLite n'ecrit le "x" que devant la premiere
        // case : "+Oxc7,b8" designe le coup que jocly nomme "+KNxc7xb8", ou
        // les DEUX pas sont des prises. Exiger la correspondance sur le
        // second refuserait un coup parfaitement valide ; la case, elle,
        // reste comparee a l'identique, et c'est l'unicite qui tranche.
        if (i === 0 && nat.steps[i].capture !== parsedToken.steps[i].capture) return false;
    }
    // La promotion n'est comparee que lorsque jocly a offert le choix. Quand il
    // ne l'a pas offert, un "+" dans le fichier ne peut designer que l'echec,
    // et le comparer refuserait un coup parfaitement identifie.
    if (nat.promote !== null && nat.promote !== parsedToken.promote) return false;
    if (!parsedToken.piece || !nat.from || !letterAt) return true;
    const onBoard = letterAt(nat.from);
    return !onBoard || onBoard.toUpperCase() === parsedToken.piece.toUpperCase();
}

/**
 * Le camp qui n'a AUCUNE piece royale dans une position, ou null si les deux
 * en ont une.
 *
 * Sert a prevenir : jocly tient pour perdu un camp sans piece royale, donc une
 * telle position se pose sur un plateau fige -- aucun coup legal, aucun
 * message. C'est normal pour un probleme de mat (le mode tsume est fait pour
 * ca) et c'est une faute de frappe le reste du temps ; dans les deux cas
 * l'utilisateur merite de l'apprendre avant de rester devant un plateau muet.
 *
 * La lettre du roi n'est pas la meme partout ("K" aux echecs et au shogi,
 * mais un jeu peut en definir une autre) : `royals` la laisse a l'appelant,
 * qui la tient du catalogue. "K" par defaut, ce qui couvre le cas courant.
 */
export function SideWithoutKing(fen, royals) {
    const board = String(fen || '').trim().split(/\s+/)[0];
    if (!board) return null;
    const letters = (royals && royals.length ? royals : ['K']).join('');
    const upper = new RegExp('[' + letters.toUpperCase() + ']');
    const lower = new RegExp('[' + letters.toLowerCase() + ']');
    const hasWhite = upper.test(board), hasBlack = lower.test(board);
    if (hasWhite && hasBlack) return null;
    if (!hasWhite && !hasBlack) return 'both';
    return hasWhite ? 'black' : 'white';
}

/**
 * L'ecriture d'un coup en notation « occidentale » — l'inverse exact de
 * ParseWesternMove, pour produire un PGN que ChuShogiLite relit.
 *
 * `move`   : le coup, tel que ParseNaturalMove le rend, plus `from` (la case
 *            de depart, que jocly omet sur les coups a deux pas et que
 *            l'appelant tient de l'objet coup).
 * `letter` : l'abreviation FEN de la piece — celle du plateau, pas celle de
 *            jocly. « +H » et non « +DH ».
 * `rivals` : les autres coups LEGAUX de la meme position qui menent aux memes
 *            cases avec la meme piece. C'est eux qui decident de la
 *            desambiguisation ; sans rival, la case de depart est omise.
 *
 * Les regles sont celles de chushogi-lite.js (moveToSAN, getSANDisambiguation) :
 *   - coup ordinaire  : piece + desambiguisation + ("x" si prise) + arrivee
 *   - coup a deux pas : piece + desambiguisation + ("x" si UNE prise au moins)
 *                       + passage + "," + arrivee
 *   - suffixe         : "+" promotion, "=" promotion refusee, rien sinon
 *   - desambiguisation : la colonne si elle suffit, sinon la rangee, sinon la
 *                        case entiere
 *
 * A noter, parce que ce n'est pas symetrique : en notation PGN, CSL n'ecrit
 * PAS le "-" du coup sans prise (son format « shogi » le fait, son format PGN
 * non). ParseWesternMove accepte les deux, l'ecriture suit le PGN.
 */
export function BuildWesternMove(move, letter, rivals) {
    if (!move || !move.steps || !move.steps.length) return null;
    const steps = move.steps;
    const captures = steps.some(st => st.capture);

    let disambig = '';
    const from = move.from || '';
    if (from && rivals && rivals.length) {
        const file = from[0], rank = from.slice(1);
        if (!rivals.some(r => r && r[0] === file)) disambig = file;
        else if (!rivals.some(r => r && r.slice(1) === rank)) disambig = rank;
        else disambig = from;
    }

    // La lettre est TOUJOURS en majuscules : CSL ecrit le TYPE de la piece
    // (« T », « +M »), pas la lettre coloree du plateau, ou la minuscule
    // designe le camp. Sans cette mise en forme le fichier reste relisible --
    // WesternMatches compare sans la casse -- mais il ne ressemble plus a ce
    // que l'applet produit, et c'est justement ce qu'on cherche a obtenir.
    const head = String(letter || move.piece || '').toUpperCase() + disambig;
    const body = steps.length > 1
        ? (captures ? 'x' : '') + steps.map(st => st.square).join(',')
        : (steps[0].capture ? 'x' : '') + steps[0].square;
    const suffix = move.promote === true ? '+' : (move.promote === false ? '=' : '');
    return head + body + suffix;
}

/**
 * Le [FEN] d'un PGN ChuShogiLite, ecrit depuis un SFEN — l'inverse de
 * PgnFenToJocly.
 *
 * Cinq champs : plateau, trait INVERSE, case de la derniere prise de Lion,
 * puis « 0 1 ».
 *
 * Le trait s'inverse ici alors qu'il ne bouge pas dans PgnFenToJocly, et ce
 * n'est pas une incoherence : il y a trois conventions, pas deux.
 *
 *   SFEN   « b » = sente = les majuscules
 *   jocly  note ce meme trait « w » — ImportSFEN echange les deux
 *   PGN    ChuShogiLite y ecrit l'inverse de son SFEN
 *
 * Donc PGN == jocly, et SFEN == l'inverse des deux. PgnFenToJocly va de PGN a
 * jocly : rien a faire. Cette fonction-ci part du SFEN, celui que rend
 * getBoardState('sfen') : il faut inverser une fois.
 */
export function SfenToPgnFen(sfen) {
    const f = String(sfen || '').trim().split(/\s+/);
    if (f.length < 3 || f.length > 4) return null;
    if (f[1] !== 'b' && f[1] !== 'w') return null;
    return `${f[0]} ${f[1] === 'b' ? 'w' : 'b'} ${f[2] || '-'} 0 1`;
}

/**
 * Construit un PGN lisible par ChuShogiLite : tags de l'applet, [FEN] a cinq
 * champs, coups en notation occidentale.
 *
 * Distinct de BuildPJN, et pas une option de celui-ci : les deux formats ne
 * partagent ni les tags ([JoclyGame] n'a pas de sens ici), ni la notation, ni
 * la position ([FEN] SFEN contre FEN jocly). Les melanger produirait un
 * fichier que ni l'un ni l'autre ne relit entierement.
 *
 * `moves` sont deja en notation occidentale — c'est play.js qui les produit,
 * seul a disposer du moteur (voir BuildWesternMove).
 */
export function BuildPGN(moves, sfen, meta) {
    const m = meta || {};
    const d = m.date || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const tag = (k, v) => '[' + k + ' "' + String(v).replace(/"/g, "'") + '"]';
    const tags = [
        tag('Event', m.event || 'Tabulon PGN Record'),
        tag('Site', 'Tabulon'),
        tag('Date', `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`),
        tag('Round', '-'),
        tag('White', m.white || '?'),
        tag('Black', m.black || '?'),
        tag('Result', m.result || '*'),
        tag('Variant', m.variant || 'chu'),
    ];
    // [SetUp] AVANT [FEN] : c'est l'ordre qu'impose la specification PGN, et
    // celui qu'ecrit l'applet.
    const fen = SfenToPgnFen(sfen);
    if (fen) { tags.push(tag('SetUp', '1')); tags.push(tag('FEN', fen)); }

    // Numerotation par paires, le numero sur le coup des Blancs. Le camp qui
    // commence vient du trait de la position : quand ce sont les Noirs, leur
    // premier coup porte « 1... », seule occurrence de cette forme.
    const blackStarts = fen ? fen.split(' ')[1] === 'b' : false;
    const list = (moves || []).map((mv, i) => {
        const white = blackStarts ? i % 2 === 1 : i % 2 === 0;
        if (blackStarts && i === 0) return '1... ' + mv;
        if (!white) return mv;
        return (blackStarts ? Math.floor((i + 1) / 2) + 1 : Math.floor(i / 2) + 1) + '. ' + mv;
    });
    const head = m.tsume ? '{Tsume} ' : '';
    return tags.join('\n') + '\n\n' + head + list.join(' ') + (list.length ? ' ' : '') + '*\n';
}

/**
 * Le [FEN] d'un PGN de shogi (PyChess, lishogi) ramene a un SFEN que jocly
 * accepte — ou null si ce n'en est pas un.
 *
 * PyChess ecrit la reserve A LA MANIERE DU CRAZYHOUSE, entre crochets et
 * collee au plateau, la ou le SFEN standard en fait un champ separe :
 *
 *   PyChess   lnsgkgsnl/…/LNSGKGSNL[-] w 0 1
 *   SFEN      lnsgkgsnl/…/LNSGKGSNL b - 1
 *
 * Sans conversion, jocly compte les crochets comme des cases et refuse la
 * position (« rank 9 covers 12 files, expected 9 »), puis le chargement
 * echoue plus loin sur un plateau a moitie construit.
 *
 * LE TRAIT S'INVERSE, et c'est la meme mecanique qu'au chu shogi : un [FEN]
 * de PGN est dans la convention de jocly, un SFEN dans l'inverse, et
 * ImportSFEN echangera les deux. On ne peut pas ici produire un FEN jocly
 * directement — la reserve du shogi est faite de COLONNES de plateau, pas
 * d'un champ — donc on passe par le SFEN et on inverse une fois.
 */
export function PgnFenToShogiSfen(fen) {
    const text = String(fen || '').trim();
    const m = /^(\S+?)\[([^\]]*)\]\s+([bw])\b(.*)$/.exec(text);
    if (!m) return null;
    const hand = m[2].trim() === '' ? '-' : m[2].trim();
    // Le dernier nombre de la queue est le numero de coup ; PyChess ecrit
    // « 0 1 » a la maniere des echecs (demi-coups puis coups).
    const tail = m[4].trim().split(/\s+/).filter(Boolean);
    const move = tail.length ? tail[tail.length - 1] : '1';
    return `${m[1]} ${m[3] === 'w' ? 'b' : 'w'} ${hand} ${/^\d+$/.test(move) ? move : '1'}`;
}

/**
 * Lecture d'un KIF de chu shogi — le format « kifu » japonais, celui que
 * ChuShogiLite exporte et importe, et le seul des quatre a ne pas etre du
 * texte latin.
 *
 * Ce qu'on en tire, et pourquoi c'est PLUS simple que le PGN de la meme
 * partie : chaque coup y porte sa case de DEPART, entre parentheses
 * (« 9十二角行 （←10十一） »). La piece nommee est donc redondante, et il n'y a
 * ni desambiguisation a refaire ni abreviation a traduire — deux cases
 * suffisent a designer le coup sans ambiguite. Le nom de piece est tout de
 * meme relu, mais comme un CONTROLE : s'il contredit le plateau, le fichier
 * est douteux et mieux vaut le dire.
 *
 * Coordonnees : colonnes en chiffres arabes comptees depuis la DROITE, rangees
 * en kanji depuis le HAUT — le meme systeme que l'USI, et l'exact inverse de
 * celui de jocly.
 *
 * Renvoie { board, turn, moves, tsume, comments } ou null si ce n'est pas un
 * KIF. `moves` est une liste de « depart-arrivee » en coordonnees jocly, que
 * l'appelant resout EXACTEMENT contre les coups legaux.
 */
const KIF_PIECES = {
    '歩': 'P',
    '仲': 'I',
    '銅': 'C',
    '銀': 'S',
    '金': 'G',
    '豹': 'F',
    '虎': 'T',
    '象': 'E',
    '鳳': 'X',
    '麒': 'O',
    '香': 'L',
    '反': 'A',
    '横': 'M',
    '竪': 'V',
    '角': 'B',
    '飛': 'R',
    '馬': 'H',
    '龍': 'D',
    '奔': 'Q',
    '獅': 'N',
    '玉': 'K',
    '成歩': '+P',
    '成象': '+I',
    '成横': '+C',
    '成竪': '+S',
    '成飛': '+G',
    '成角': '+F',
    '鹿': '+T',
    '太': '+E',
    '成奔': '+X',
    '成獅': '+O',
    '駒': '+L',
    '鯨': '+A',
    '猪': '+M',
    '牛': '+V',
    '成馬': '+B',
    '成龍': '+R',
    '鷹': '+H',
    '鷲': '+D',
};
// Rangees : 一..十二, du haut vers le bas.
const KIF_RANKS = ['\u4e00', '\u4e8c', '\u4e09', '\u56db', '\u4e94', '\u516d',
                   '\u4e03', '\u516b', '\u4e5d', '\u5341', '\u5341\u4e00', '\u5341\u4e8c'];

// « 9十二 » -> « d1 » : colonne depuis la droite, rangee depuis le haut.
function KifSquare(file, rankKanji, size) {
    const f = parseInt(file, 10);
    const r = KIF_RANKS.indexOf(rankKanji);
    if (!(f >= 1 && f <= size) || r < 0 || r >= size) return null;
    return String.fromCharCode(97 + (size - f)) + (size - r);
}

// ── KIF du shogi orthodoxe (logiciels japonais, shogidb2, lishogi) ──────────
//
// Un dialecte distinct de celui du chu shogi, et rien n'y ressemble :
//
//   手合割：平手      en-tete « cle：valeur » ; « 平手 » est la partie a egalite
//   1 ２六歩(27)      colonne et piece en PLEINE largeur, depart entre
//                     parentheses en DEMI-largeur
//   11 同　銀(68)     « meme case » que le coup precedent
//   47 ７四歩打       parachutage (打), sans case de depart
//   10 ７七角成(22)   promotion (成) ; « 不成 » la refuse explicitement
//   188 投了          abandon : la partie s'arrete la
//
// Pas de plateau dessine, contrairement au chu : c'est ce qui distingue les
// deux dialectes a coup sur.
//
// Les colonnes se comptent depuis la DROITE (1 a 9) et les rangees en kanji
// depuis le HAUT -- le meme systeme que l'USI, l'inverse de celui de jocly.
const KIF_SHOGI_DIGITS = { '\uff10':0, '\uff11':1, '\uff12':2, '\uff13':3, '\uff14':4,
                           '\uff15':5, '\uff16':6, '\uff17':7, '\uff18':8, '\uff19':9 };
const KIF_SHOGI_RANKS = ['\u4e00','\u4e8c','\u4e09','\u56db','\u4e94',
                         '\u516d','\u4e03','\u516b','\u4e5d'];

// Les pieces, pour les PARACHUTAGES : le KIF nomme la piece posee, et jocly
// l'attend aussi. Un parachutage sans lettre serait ambigu -- « @c6 » vaut
// aussi bien pour un pion que pour un fou en main.
const KIF_SHOGI_PIECES = {
    '\u6b69': 'P', '\u9999': 'L', '\u6842': 'N', '\u9280': 'S',
    '\u91d1': 'G', '\u89d2': 'B', '\u98db': 'R', '\u7389': 'K', '\u738b': 'K',
};

// « 2 » (colonne, depuis la droite) et « 六 » (rangee, depuis le haut) -> « h4 ».
function KifShogiSquare(file, rank, size) {
    if (!(file >= 1 && file <= size) || !(rank >= 1 && rank <= size)) return null;
    return String.fromCharCode(97 + size - file) + (size + 1 - rank);
}

/**
 * Est-ce un KIF de shogi orthodoxe ? On exige l'en-tete des coups, que ces
 * fichiers portent tous, et l'ABSENCE du plateau dessine qui signe le
 * dialecte du chu shogi -- lire l'un pour l'autre donnerait n'importe quoi.
 */
export function IsShogiKif(text) {
    const t = String(text || '');
    return /\u624b\u6570-+\u6307\u624b/.test(t) && !/^\+-+\+$/m.test(t);
}

/**
 * Lecture d'un KIF de shogi. Renvoie { moves, handicap, comments }, ou null si
 * ce n'en est pas un.
 *
 * `moves` est une liste de « depart-arrivee » en coordonnees jocly, avec « + »
 * pour une promotion, « = » pour un refus explicite, et « @arrivee » pour un
 * parachutage -- la meme forme que pour le chu shogi, que l'appelant resout
 * contre les coups legaux.
 */
export function ParseShogiKif(text, size) {
    if (!IsShogiKif(text)) return null;
    const board = size || 9;
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const moves = [], comments = [];
    let handicap = null, previous = null;

    for (const line of lines) {
        // En-tete « cle：valeur ». Le deux-points PLEINE largeur est celui des
        // fichiers japonais ; le demi-largeur apparait dans les exports.
        const header = /^([^\s：:]+)[：:](.*)$/.exec(line.trim());
        if (header) {
            if (header[1] === '\u624b\u5408\u5272') handicap = header[2].trim();
            continue;
        }
        const comment = /^\s*[*\u3000]\s?(.*)$/.exec(line);
        if (comment) { comments.push(comment[1]); continue; }

        const move = /^\s*\d+\s+(.*)$/.exec(line);
        if (!move) continue;
        // Le temps consomme, entre parentheses, ne fait pas partie du coup ;
        // et « 同　銀(68) » porte une ESPACE IDEOGRAPHIQUE (U+3000) au milieu,
        // que JavaScript compte comme un blanc. Un simple \S+ s'arretait donc
        // sur « 同 » et perdait la case de depart -- le fichier entier etait
        // refuse au 11e coup.
        const body = move[1]
            .replace(/\s*[（(]\d+:\d\d[/\uff0f][\d:]+[）)]\s*$/, '')
            .replace(/[\s\u3000]+/g, '');
        if (!body) continue;
        // 投了 (abandon), 中断, 千日手, 持将棋, 詰み, 切れ負け : la partie
        // s'arrete, et ce qui suit n'est plus un coup.
        if (/^(\u6295\u4e86|\u4e2d\u65ad|\u5343\u65e5\u624b|\u6301\u5c06\u68cb|\u8a70\u307f|\u5207\u308c\u8ca0\u3051)/.test(body))
            break;

        // « 同 » : meme case d'arrivee que le coup precedent. Une erreur ici se
        // propagerait en silence sur toute la suite, d'ou le refus net quand
        // il n'y a pas de coup precedent.
        let to;
        if (/^\u540c/.test(body)) {
            if (!previous) return null;
            to = previous;
        } else {
            const file = KIF_SHOGI_DIGITS[body[0]];
            const rank = KIF_SHOGI_RANKS.indexOf(body[1]) + 1;
            to = KifShogiSquare(file, rank, board);
            if (!to) return null;
        }
        previous = to;

        // « 成 » promeut, « 不成 » refuse. Le « 成 » de « 成銀 » (un argent
        // DEJA promu qui joue) precede le nom de piece, celui d'une promotion
        // le suit : on ne regarde donc que la fin du jeton.
        // La promotion se lit AVANT les parentheses de la case de depart : dans
        // « ７七角成(22) », le « 成 » ne termine pas le jeton. Et il faut bien
        // regarder la FIN de ce prefixe : le « 成 » de « 成銀 » -- un argent
        // deja promu qui joue -- le PRECEDE, et ne promeut rien.
        const named = body.replace(/[（(].*$/, '');
        // L'ABSENCE de « 成 » vaut refus explicite, pas indifference : le KIF
        // note toujours la promotion quand elle est prise. Sans cela, un coup
        // qui entre dans la zone de promotion correspond aux DEUX versions
        // que jocly propose, et la resolution refuse pour ambiguite -- ce qui
        // arretait une partie de lishogi au 3e coup.
        const promote = /\u6210$/.test(named) && !/\u4e0d\u6210$/.test(named) ? '+' : '=';

        // Parachutage : « 打 », et aucune case de depart.
        if (/\u6253/.test(body)) {
            // La lettre de la piece posee : « ７四歩打 » parachute un pion.
            const letter = KIF_SHOGI_PIECES[named.replace(/^..(\u6210)?/, '')[0]]
                || KIF_SHOGI_PIECES[named[2]] || '';
            moves.push(letter + '@' + to);
            continue;
        }

        const from = /[（(](\d)(\d)[）)]/.exec(body);
        if (!from) return null;
        const start = KifShogiSquare(parseInt(from[1], 10), parseInt(from[2], 10), board);
        if (!start) return null;
        moves.push(start + '-' + to + promote);
    }
    return { moves, handicap, comments };
}

/**
 * Est-ce un KIF de chu shogi ? On exige le dessin du plateau (bordure « +---+ »)
 * ET une ligne de coups « N 手目 » : le KIF du shogi orthodoxe, qui n'a ni l'un
 * ni l'autre sous cette forme, n'est pas concerne et doit etre refuse plutot
 * que lu de travers.
 */
export function IsChuKif(text) {
    const t = String(text || '');
    return /^\+-+\+$/m.test(t) && /\d+\s*\u624b\u76ee/.test(t);
}

export function ParseKif(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const border = /^\+-+\+$/;
    let i = lines.findIndex(l => border.test(l.trim()));
    if (i < 0) return null;
    i++;

    // Le plateau : douze rangees de douze cellules de trois caracteres, un
    // « v » devant les pieces du camp qui joue en second.
    const rows = [];
    for (let r = 0; r < 12; r++, i++) {
        if (i >= lines.length) return null;
        const body = lines[i].replace(/^\|/, '').replace(/\|[^|]*$/, '');
        let row = '', empty = 0;
        for (let f = 0; f < 12; f++) {
            const cell = body.slice(f * 3, f * 3 + 3).trim();
            if (!cell || cell === '\u30fb') { empty++; continue; }
            const gote = cell.startsWith('v');
            const letter = KIF_PIECES[gote ? cell.slice(1) : cell];
            if (!letter) return null;
            if (empty) { row += empty; empty = 0; }
            // Majuscules = le camp qui ouvre, comme dans un SFEN.
            row += gote ? letter.toLowerCase() : letter;
        }
        if (empty) row += empty;
        rows.push(row || '12');
    }
    if (rows.length !== 12) return null;
    if (i < lines.length && border.test(lines[i].trim())) i++;

    // Les coups : « 1 手目 9十二角行 （←10十一） ». Les commentaires (« * … »)
    // portent la marque {Tsume}, comme dans le PGN de l'applet.
    const moves = [], comments = [];
    let turn = 'b';
    // « 11 手目一歩目 … » / « 11 手目二歩目 … » : les coups a DEUX PAS du Lion,
    // du Faucon et de l'Aigle occupent deux lignes portant le meme numero. Les
    // lire comme deux coups distincts donnait 31 coups la ou le PGN de la meme
    // partie en compte 33 : le premier pas n'est pas un coup, c'est la moitie
    // d'un coup. On les recolle sur le numero.
    // La rangee est reconnue par la LISTE des kanji, les plus longs d'abord,
    // et non par « un ou deux ideogrammes ». Sans cela « 1十二奔王 » se lit
    // rangee 十 puis piece 二奔王 : la case tombe une rangee plus loin, le coup
    // reste souvent legal, et la partie rejouee n'est plus celle du fichier --
    // une faute silencieuse, la pire espece.
    const RANK = '(?:' + KIF_RANKS.slice().sort((a, b) => b.length - a.length).join('|') + ')';
    const MOVE = new RegExp('^\\s*(\\d+)\\s*\u624b\u76ee(\u4e00\u6b69\u76ee|\u4e8c\u6b69\u76ee)?'
        + '\\s*(\\d{1,2})(' + RANK + ')([^\\s（(]*)\\s*[（(]\u2190(\\d{1,2})(' + RANK + ')[）)]');
    let pending = null;   // premier pas en attente de son second
    for (; i < lines.length; i++) {
        const line = lines[i];
        const comment = /^\s*\*\s?(.*)$/.exec(line);
        if (comment) { comments.push(comment[1]); continue; }
        if (/^\s*\u5f8c\u624b\u756a/.test(line)) { turn = 'w'; continue; }
        const m = MOVE.exec(line);
        if (!m) continue;
        const to = KifSquare(m[3], m[4], 12);
        const from = KifSquare(m[6], m[7], 12);
        if (!to || !from) return null;
        // Suffixe du nom de piece : « 成 » promeut, « 不成 » refuse
        // explicitement. Au shogi la promotion est facultative et jocly
        // produit les deux versions du meme deplacement : sans ce suffixe les
        // deux correspondent et la lecture s'arrete sur une ambiguite.
        const name = m[5] || '';
        const promote = /\u4e0d\u6210$/.test(name) ? '=' : (/\u6210$/.test(name) ? '+' : '');
        const second = m[2] === '\u4e8c\u6b69\u76ee';
        if (second && pending && pending.num === m[1]) {
            moves.push(pending.from + '-' + pending.to + '-' + to + promote);
            pending = null;
            continue;
        }
        if (pending) moves.push(pending.from + '-' + pending.to + pending.promote);
        pending = { num: m[1], from, to, promote };
    }
    if (pending) moves.push(pending.from + '-' + pending.to + pending.promote);
    return {
        board: rows.join('/'),
        turn,
        moves,
        comments,
        tsume: comments.some(c => /tsume/i.test(c)),
    };
}

// Lettres de pieces du xiangqi : convention OCCIDENTALE (PyChess, WXF, la
// plupart des sites) contre celle de jocly.
//
//   PyChess   rnbakabnr   n = knight (cavalier), b = bishop (elephant)
//   jocly     rheakaehr   h = horse,             e = elephant
//
// Le plateau est le meme, les lettres non : un FEN de PyChess est refuse par
// jocly (« FEN invalid board spec n ») alors que la position est parfaitement
// valide. La correspondance est bijective et ne touche qu'a deux types.
const XIANGQI_LETTERS = { n: 'h', N: 'H', b: 'e', B: 'E' };

// Kyoto Shogi : chaque piece a DEUX faces et se retourne a chaque coup. Les
// deux notations disent la meme chose autrement --
//
//   PyChess   TSKGP     une lettre par face : T = tokin, G = or
//   jocly     +LSK+NP   la face « promue » de la lance et du cavalier
//
// Ce ne sont pas des pieces differentes mais deux facons de nommer le meme
// retournement, et la correspondance est bijective. Sans elle, un FEN de
// PyChess se charge a moitie -- « FEN invalid board spec g » -- en laissant un
// plateau ou il ne reste qu'un pion.
const KYOTO_LETTERS = { t: '+l', T: '+L', g: '+n', G: '+N' };

/**
 * Un FEN de variante, ramene a ce que le jeu Jocly vise attend — ou le FEN
 * inchange quand il n'y a rien a faire.
 *
 * Deux conversions, l'une et l'autre constatees sur des fichiers reels :
 *
 *  - XIANGQI : les lettres ci-dessus. Seul le champ PLATEAU est touche ; les
 *    autres champs ne portent pas de lettres de piece.
 *
 *  - KYOTO SHOGI et les autres shogi a reserve : un FEN a quatre champs
 *    « plateau trait 0 1 » est un SFEN dont le champ de main a ete omis. On le
 *    recompose, trait inverse — meme mecanique qu'au chu shogi, le [FEN] d'un
 *    PGN etant dans la convention de jocly et le SFEN dans l'inverse.
 */
export function VariantFen(fen, game) {
    const text = String(fen || '').trim();
    if (!text) return fen;
    const f = text.split(/\s+/);

    if (game === 'xiangqi') {
        return [f[0].replace(/[nbNB]/g, (c) => XIANGQI_LETTERS[c]), ...f.slice(1)].join(' ');
    }
    if (game === 'kyoto-shogi') {
        // Traduire d'abord les lettres, normaliser la forme ensuite : les deux
        // conversions sont independantes et un fichier peut n'avoir besoin que
        // de l'une. Un « + » deja present protege la lettre qui suit.
        f[0] = f[0].replace(/\+?[tTgG]/g, (c) => (c[0] === '+' ? c : KYOTO_LETTERS[c]));
    }
    // « plateau trait 0 1 » : quatre champs dont les deux derniers sont des
    // nombres — la forme qu'ecrit PyChess pour les shogi sans piece en main.
    if (/shogi/.test(String(game || '')) && f.length === 4
        && (f[1] === 'b' || f[1] === 'w') && /^\d+$/.test(f[2]) && /^\d+$/.test(f[3])) {
        return `${f[0]} ${f[1] === 'w' ? 'b' : 'w'} - ${f[3]}`;
    }
    return text;
}

/**
 * Le fichier annonce-t-il un probleme de mat (tsume) ?
 *
 * ChuShogiLite ne pose pas de tag : il ecrit le nom du probleme en COMMENTAIRE
 * devant le premier coup — « {Tsume A22} ». On lit donc le commentaire, et on
 * accepte aussi un tag explicite pour qui voudrait en poser un.
 *
 * Pourquoi le declarer plutot que le deduire : un tsume donne a l'attaquant
 * ses pieces d'attaque et rien d'autre, pas de roi, et jocly tient pour perdu
 * un camp sans piece royale. L'option `tsume` de jocly leve ce seul verdict.
 * On pourrait la poser des qu'un camp n'a pas de roi -- mais une position sans
 * roi est bien plus souvent une faute de frappe qu'un probleme, et l'activer
 * en silence transformerait une erreur visible en partie bancale.
 */
export function IsTsume(text, tags) {
    for (const key of ['Tsume', 'tsume', 'Problem']) {
        const v = tags && tags[key];
        if (typeof v === 'string' && v.trim() && v.trim() !== '0') return true;
    }
    return /\{\s*tsume\b/i.test(String(text || ''));
}

/**
 * Un jeton est-il de l'USI ? Une case USI est un NUMERO de colonne suivi
 * d'une LETTRE de rangee ("12i", "7g") ; la notation naturelle de jocly fait
 * l'inverse ("a4-a5"), et son format `engine` aussi ("f4f5"). Les deux ne
 * peuvent donc pas se confondre, meme sur quatre caracteres.
 *
 * Trois formes :
 *   depart+arrivee         "7g7f", avec "+" suffixe pour une promotion
 *   depart+milieu+arrivee  "12i11h10g" — les coups a deux pas du Lion, du
 *                          Faucon et de l'Aigle du chu shogi
 *   parachutage            "P*5e" — la lettre de la piece, une etoile, la case
 */
export function IsUSIToken(token) {
    return /^(?:[A-Za-z]\*[0-9]{1,2}[a-l]|(?:[0-9]{1,2}[a-l]){2,3}\+?)$/.test(String(token || ''));
}

/**
 * Format des coups d'une partie : 'usi' ou 'natural'.
 *
 * Exiger que TOUS les jetons soient de l'USI, et non la majorite : un fichier
 * ou un seul jeton n'en serait pas est un fichier qu'on ne comprend pas, et
 * mieux vaut le rejouer en mode tolerant -- qui refusera bruyamment le jeton
 * fautif -- que d'imposer une resolution exacte a une notation qui n'est
 * peut-etre pas celle qu'on croit.
 */
export function MoveFormat(tokens) {
    const list = (tokens || []).filter(Boolean);
    if (!list.length) return 'natural';
    if (list.every(IsUSIToken)) return 'usi';
    // « Occidentale » = tous les jetons se lisent comme tels. Ce n'est qu'une
    // CANDIDATURE : la notation SAN des echecs se lit aussi de cette facon
    // ("Qb8+"), et la resolution exacte y serait plus juste que la floue mais
    // refuserait un roque ou une promotion. C'est donc a l'appelant de
    // verifier que le premier coup se resout avant d'engager tout le fichier
    // dans cette lecture -- voir BookReplay dans play.js.
    // Le WXF avant l'occidentale : « C2=5 » se lit aussi comme une piece C et
    // une case... non, « 2=5 » n'est pas une case. Mais « P7+1 » et un SAN de
    // variante peuvent se ressembler, et le WXF est le plus contraint des
    // deux -- cinq caracteres, une grammaire fermee -- donc le plus sur a
    // reconnaitre en premier.
    if (list.every(tok => ParseWxfMove(tok))) return 'wxf';
    // Le SAN avant l'occidentale : les deux se ressemblent, mais le SAN a des
    // formes que l'autre n'a pas (roque, desambiguisation, promotion « =Q »)
    // et surtout une lecture opposee du « + » final -- echec ici, promotion
    // la-bas. Une partie d'echecs lue comme du chu shogi cherche des coups
    // promouvants et n'en trouve aucun.
    if (list.some(tok => /^(?:O-O|0-0)/.test(tok) || /=[A-Z]/.test(tok) || /^[A-Z][@*]/.test(tok)
                      || /^[KQRBNACMEHJ][a-o]?[0-9]{0,2}x?[a-o][0-9]{1,2}[+#]?$/.test(tok))
        && list.every(tok => ParseSanMove(tok))) return 'san';
    if (list.every(tok => ParseWesternMove(tok))) return 'western';
    return 'natural';
}

/**
 * Jeux Jocly designes par un [Variant] qui n'est PAS un nom de variante
 * Fairy-Stockfish.
 *
 * Table separee de VARIANT_ALIASES a dessein : celle-ci reste dans la
 * nomenclature du moteur (orthographe -> nom Fairy), c'est le catalogue qui
 * traduit ensuite vers un nom Jocly. Ici il n'y a pas de moteur du tout --
 * "chu" est ce qu'ecrit ChuShogiLite, dont le chu shogi n'est joue par aucune
 * variante Fairy-Stockfish. Les rares cas de ce genre sont ecrits a la main,
 * et c'est le catalogue qui a le dernier mot : un nom absent du catalogue est
 * ignore, jamais impose.
 */
const VARIANT_GAMES = {
    'chu': 'chu-shogi',
    // Jeux que le catalogue ne rattache a aucune variante Fairy-Stockfish :
    // sans entree ici, leur [Variant] ne designe rien et le fichier n'ouvre
    // aucune partie.
    'janggi': 'janggi',
    'korean chess': 'janggi',
    'shoshogi': 'kotaishi-shogi',
    'sho shogi': 'kotaishi-shogi',
    'chushogi': 'chu-shogi',
    'chu shogi': 'chu-shogi',
};

/**
 * Jeu Jocly designe directement par un [Variant], ou null.
 */
export function VariantGame(name) {
    return VARIANT_GAMES[String(name || '').trim().toLowerCase()] || null;
}

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
    // Probleme de mat : la marque va en COMMENTAIRE devant le premier coup,
    // et non dans un tag. C'est la forme qu'ecrit ChuShogiLite -- « {Tsume A22} »
    // -- et celle que IsTsume() relit ; un tag de notre invention obligerait
    // l'autre bout a apprendre notre convention pour rien. Sans cette marque,
    // un tsume enregistre se rouvre sur un plateau fige : le camp attaquant
    // n'a pas de roi, et jocly le tient pour perdu d'avance.
    const head = m.tsume ? '{Tsume} ' : '';
    return tags.join('\n') + '\n\n' + head + numbered + '\n';
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
