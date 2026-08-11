// app/content/problem.js  —  Fenêtre « Voir » d'un exemple
//
// Lecture seule : titre, image en grand, puis le commentaire. C'est ce que
// les fichiers d'exemple contiennent réellement et que l'écran de chargement
// ne pouvait pas montrer — une vignette de 42 px et un nom de fichier ne
// disent pas qu'on a sous les yeux la position de la partie de l'Opéra.
//
// Le contenu arrive par le store (`problem:{id}`), déposé par le hub : la
// vignette est en base64 et pèse plusieurs dizaines de kilo-octets, donc hors
// de question de la passer dans l'URL.
//
// La fenêtre ne lance rien et n'écrit rien. Lancer et Enregistrer restent sur
// la vignette du hub : dupliquer ces actions ici demanderait de refaire la
// résolution du jeu (catalogue, alias Fairy-Stockfish, indice du dossier) pour
// un gain nul — la fenêtre se ferme d'un geste.
import tRpc from './tabulon-rpc.js';
import twu from './tabulon-winutils.js';
import { Store } from './tauri-bridge.js';
import { initI18n, t } from './tabulon-i18n.js';
import { BookCommentary, BookGame, BookFen, BookVariant, ParseSolution, ExtractMoves }
    from './book-format.js';

const problemId = new URLSearchParams(window.location.search).get('id') || '';

const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
};

// Tags qu'on affiche sous un titre, dans cet ordre. Le reste des tags PGN
// (UTCTime, Termination, WhiteElo…) est du bruit pour quelqu'un qui regarde
// un problème : on ne montre que ce qui aide à situer la position.
const SHOWN_TAGS = ['Date', 'White', 'Black', 'Result', 'Opening', 'ECO', 'PlyCount'];

function RenderTags(tags) {
    const bits = [];
    for (const key of SHOWN_TAGS) {
        const v = (tags[key] || '').trim();
        if (v && v !== '?' && v !== '*') bits.push(key + ' ' + v);
    }
    if (BookFen(tags)) bits.push(t('problem.fromPosition'));
    return bits.length ? el('div', 'problem-tags', bits.join(' · ')) : null;
}

// Un lien vers la source, quand le fichier en porte un — les PGN d'étude
// lichess en ont toujours un, et c'est là que se trouve le cours complet.
function RenderLink(tags) {
    const url = (tags.ChapterURL || tags.Site || '').trim();
    if (!/^https?:\/\//.test(url)) return null;
    const a = el('a', 'problem-link', url);
    a.href = url;
    a.target = '_blank';
    return a;
}

// Les coups avec leur commentaire. Le commentaire d'introduction (celui qui
// précède le premier coup) est mis en avant : c'est l'énoncé du problème.
function RenderCommentary(text) {
    const items = BookCommentary(text);
    const box = el('div', 'problem-moves');
    for (const item of items) {
        if (!item.move) { box.appendChild(el('p', 'problem-intro', item.comment)); continue; }
        const line = el('div', 'problem-move');
        if (item.number) line.appendChild(el('span', 'problem-num', item.number));
        line.appendChild(el('span', 'problem-san', item.move));
        if (item.comment) line.appendChild(el('span', 'problem-note', item.comment));
        box.appendChild(line);
    }
    return box;
}

async function Render(problem) {
    const title = document.getElementById('problem-title');
    const image = document.getElementById('problem-image');
    const body  = document.getElementById('problem-body');

    // 1. Solution JSON : pas de tags, pas de commentaire. On dit ce qu'il y a,
    //    plutôt que d'afficher une page vide qui ferait croire à une panne.
    const solution = ParseSolution(problem.text);
    if (solution) {
        title.textContent = problem.file;
        body.appendChild(el('p', 'problem-intro',
            t('problem.solutionFile', { game: solution.game, plies: solution.playedMoves.length })));
        if (solution.initialBoard) body.appendChild(el('code', 'problem-fen', solution.initialBoard));
        return;
    }

    // 2. PJN/PGN : découpage par la commande Rust, la même que partout ailleurs.
    let matches = [];
    try { matches = await tRpc.call('parse_pjn', problem.text) || []; }
    catch (e) { console.error('[problem] parse_pjn:', e); }

    if (!matches.length) {
        title.textContent = problem.file;
        body.appendChild(el('p', 'problem-intro', t('problem.unreadable')));
        return;
    }

    // Le titre de la fenêtre vient de [Event] de la première partie, qui est
    // le nom que l'auteur a donné au problème. Le nom de fichier ne sert que
    // de repli — « matOpera.pgn » n'apprend rien.
    const first = matches[0].tags || {};
    title.textContent = (first.Event || '').trim() || problem.file;

    for (let i = 0; i < matches.length; i++) {
        const tags = matches[i].tags || {};
        // Fichier à plusieurs parties : chacune reprend son propre titre, sauf
        // la première qui est déjà en tête de fenêtre.
        if (i > 0 || matches.length > 1) {
            const heading = (tags.Event || '').trim() || t('problem.gameN', { n: i + 1 });
            if (i > 0 || heading !== title.textContent) body.appendChild(el('h5', 'problem-heading', heading));
        }
        const tagLine = RenderTags(tags);
        if (tagLine) body.appendChild(tagLine);
        const link = RenderLink(tags);
        if (link) body.appendChild(link);
        body.appendChild(RenderCommentary(matches[i].text));

        const game = BookGame(tags) || BookVariant(tags);
        const plies = ExtractMoves(matches[i].text).length;
        body.appendChild(el('div', 'problem-footer',
            [game, plies ? plies + ' ' + t('book.plies') : null].filter(Boolean).join(' — ')));
    }

    // 3. L'image en dernier dans le code, en premier à l'écran : elle n'est
    //    insérée que si le fichier en a une, et le CSS la place au-dessus.
    if (problem.thumbnail) {
        const img = el('img');
        img.src = problem.thumbnail;
        img.alt = title.textContent;
        image.appendChild(img);
    } else {
        image.remove();
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    try {
        const store = await Store.load('tabulon.json');
        const problem = await store.get('problem:' + problemId);
        if (!problem) {
            document.getElementById('problem-title').textContent = t('problem.notFound');
            return;
        }
        await Render(problem);
        // Le titre de fenetre pose par Rust vient du hub (nom du fichier) ;
        // une fois le contenu lu on connait le vrai titre de l'exemple.
        await twu.init(document.getElementById('problem-title').textContent);
        // Dépôt à usage unique : le contenu porte une image en base64, le
        // laisser dans le store ferait grossir tabulon.json à chaque « Voir ».
        await store.delete('problem:' + problemId);
    } catch (e) {
        console.error('[problem]', e);
        document.getElementById('problem-title').textContent = t('problem.notFound');
        await twu.init(t('problem.notFound')).catch(() => {});
    }
    twu.ready();
});
