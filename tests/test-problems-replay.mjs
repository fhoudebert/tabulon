// tests/test-problems-replay.mjs — les problèmes d'exemple se rejouent-ils ?
//
// Les autres suites qui touchent aux fichiers de problèmes travaillent sur des
// mocks : elles vérifient que Tabulon lit les bons tags, choisit le bon jeu et
// transmet le bon texte, mais jamais qu'un coup écrit dans le fichier est un
// coup LÉGAL du jeu visé. Celle-ci ferme la boucle en passant chaque fichier
// de tests/fixtures-problems/ au vrai moteur, par le même chemin que play.js :
// résolution du jeu → chargement du FEN → ReplayBookMoves.
//
// C'est ce qui permet d'affirmer qu'une variante nouvellement ajoutée au dist
// est réellement jouable et navigable, et pas seulement listée. Le cas qui a
// motivé cette suite : khans-chess, dont les pièces (centaur, knibis, kniroo
// et deux pièces personnalisées définies par un variants.ini embarqué) ne sont
// jouables que si le dist les fournit — un catalogue à jour ne suffit pas.
//
// Ajouter un problème dans tests/fixtures-problems/<jeu>/ le fait entrer ici
// automatiquement : c'est le même dossier que l'écran « Charger une partie ».
// Usage : npm test  (ou node tests/test-problems-replay.mjs)
import { createRequire } from 'module';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { ExtractMoves, BookGame, BookFen, BookVariant, ParseSolution,
         ReplayBookMoves, FairyGameIndex, FairyVariantAlias } from '../app/content/book-format.js';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const Jocly = require(path.join(root, 'dist/node/jocly.core.js'));

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

function ParseTags(block) {
    const tags = {};
    for (const line of block.split('\n')) {
        const m = /^\s*\[(\S+)\s+(.*)\]\s*$/.exec(line.trim());
        if (m) tags[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    return tags;
}
// Même découpage que la commande Rust parse_pjn : un bloc de tags apparié avec
// le bloc de coups qui le suit.
function SplitGames(text) {
    const blocks = text.replace(/\r\n?/g, '\n').split('\n\n').map(b => b.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < blocks.length; ) {
        if (!blocks[i].startsWith('[')) { i++; continue; }
        let j = i + 1;
        while (j < blocks.length && !blocks[j].startsWith('[')) j++;
        out.push({ tags: ParseTags(blocks[i]), text: [blocks[i], ...blocks.slice(i + 1, j)].join('\n\n') });
        i = j;
    }
    return out;
}

const catalogue = await Jocly.listGames();
const names = Object.keys(catalogue);

// Index variante Fairy-Stockfish → jeu Jocly, construit depuis le catalogue,
// exactement comme le fait hub.js.
const configs = {};
for (const n of names) configs[n] = await Jocly.getGameConfig(n).catch(() => null);
const fairy = FairyGameIndex(configs);

// Résolution du jeu, dans l'ordre où hub.js s'y prend : le tag Jocly, puis la
// variante Fairy-Stockfish, puis le nom du sous-dossier.
function ResolveGame(tags, folder) {
    const declared = BookGame(tags);
    if (declared && names.includes(declared)) return declared;
    const variant = FairyVariantAlias(BookVariant(tags) || declared);
    if (variant && fairy[variant]) return fairy[variant];
    return names.includes(folder) ? folder : null;
}

const problems = path.join(root, 'tests', 'fixtures-problems');
const folders = readdirSync(problems, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name).sort();
ok(folders.length > 0, `${folders.length} dossier(s) de problèmes : ${folders.join(', ')}`);

for (const folder of folders) {
    console.log(`${folder}`);
    const files = readdirSync(path.join(problems, folder))
        .filter(f => /\.(pjn|pgn|json)$/i.test(f)).sort();

    for (const file of files) {
        const text = readFileSync(path.join(problems, folder, file), 'utf-8');

        // Sauvegarde Jocly : les coups sont déjà des objets, joclyMatch.load()
        // les rejoue lui-même. Une erreur ici serait une position illégale.
        const solution = ParseSolution(text);
        if (solution) {
            let err = null;
            try {
                const match = await Jocly.createMatch(solution.game);
                await match.load(solution);
            } catch (e) { err = e; }
            ok(!err, `${file} : ${solution.playedMoves.length} coup(s) rejoué(s) par load()`
                     + (err ? ' — ' + err.message : ''));
            continue;
        }

        for (const [i, game] of SplitGames(text).entries()) {
            const label = files.length > 1 || i > 0 ? `${file}#${i + 1}` : file;
            const name = ResolveGame(game.tags, folder);
            if (!name) { ok(false, `${label} : aucun jeu résolu (le dist ne le contient pas ?)`); continue; }

            const tokens = ExtractMoves(game.text);
            const announced = Number(game.tags.PlyCount);
            if (announced) ok(tokens.length === announced,
                `${label} : ${tokens.length} coup(s) extrait(s), ${announced} annoncé(s) par [PlyCount]`);

            const match = await Jocly.createMatch(name);
            await match.load({ game: name, initialBoard: BookFen(game.tags) || undefined, playedMoves: [] });

            let last = null;
            const r = await ReplayBookMoves(tokens, {
                pick: (s) => match.pickMove(s).catch(() => null),
                play: async (m) => { last = await match.playMove(m); },
            });
            ok(r.unresolved === null && r.played === tokens.length,
               `${label} : ${r.played}/${tokens.length} coup(s) rejoué(s) dans ${name}`
               + (r.unresolved ? ` — bloqué sur « ${r.unresolved} »` : ''));

            // [Result "1-0"] sur un problème veut dire que la ligne finit par
            // un mat. Si le moteur ne déclare pas la partie terminée, le
            // fichier ment ou la variante ne se comporte pas comme prévu.
            if (game.tags.Result === '1-0' && r.unresolved === null) {
                ok(last?.finished === true,
                   `${label} : la ligne se termine bien par un mat, comme annoncé par [Result]`);
                ok((await match.getPossibleMoves()).length === 0,
                   `${label} : aucune réponse possible après le dernier coup`);
            }

            // Ce que la fenêtre Historique afficherait : play.js répond à
            // get-played-moves avec getMoveString() sur chaque coup joué.
            if (r.unresolved === null && r.played > 0) {
                const played = await match.getPlayedMoves();
                const strings = [];
                for (const m of played) strings.push(await match.getMoveString(m));
                ok(strings.length === tokens.length && strings.every(s => s && s !== '?'),
                   `${label} : ${strings.length} coup(s) libellés pour l'Historique — ${strings.join(' ')}`);
            }
        }
    }
}

console.log('');
console.log(`RESULTAT problems-replay: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
