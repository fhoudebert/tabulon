// test-css-url-rewrite.mjs — réécriture des `url(...)` CSS (dist externe).
// Couvre le cas terrain : la page de règles d'Ultima illustre ses pièces
// avec un sprite en background-image, dans un <style> — texte CSS qui
// échappe à tous les autres hooks d'asset-rewrite.js et partait donc sur les
// assets embarqués (500).
//
// Usage : node tests/test-css-url-rewrite.mjs

import { readFile } from 'node:fs/promises';
import { rewriteCssUrls } from '../app/content/css-url-rewrite.js';

let passed = 0;
function assert(cond, msg) {
    if (!cond) { console.error('  ✗ ' + msg); process.exit(1); }
    console.log('  ✓ ' + msg); passed++;
}

// Imite window.__distURL : /browser/… et /games/… → protocole custom.
const PROTO = 'tabulon-dist://localhost/';
const distURL = (u) => {
    const m = String(u).match(/\/((?:browser|games)\/.*)$/);
    return m ? PROTO + m[1] : u;
};

// ── 1. Le cas réel : page de règles d'Ultima ─────────────────────────────────
{
    const css = '.u-icon { background-image: url(/browser/games/chessbase/res/ultima/ultima-picto-sprites.png); }';
    const out = rewriteCssUrls(css, distURL);
    assert(out.includes(PROTO + 'browser/games/chessbase/res/ultima/ultima-picto-sprites.png'),
        'sprite d\'Ultima réécrit vers tabulon-dist://');
    assert(!out.includes('url(/browser/games/chessbase/res/ultima/ultima-picto-sprites.png)'),
        'l\'URL d\'origine (qui provoquait le 500) a disparu');
    assert(out.startsWith('.u-icon { background-image: url(') && out.endsWith('); }'),
        'le reste de la règle CSS est intact');
}

// ── 2. Formes de quotes et occurrences multiples ─────────────────────────────
{
    const css = `a{background:url("/games/x/a.png")}b{background:url('/games/x/b.png')}c{background:url(/games/x/c.png)}`;
    const out = rewriteCssUrls(css, distURL);
    assert(out.includes(`url("${PROTO}games/x/a.png")`), 'guillemets doubles préservés');
    assert(out.includes(`url('${PROTO}games/x/b.png')`), 'guillemets simples préservés');
    assert(out.includes(`url(${PROTO}games/x/c.png)`), 'sans quotes préservé');
    assert((out.match(/tabulon-dist/g) || []).length === 3, 'les trois occurrences sont réécrites');
}

// ── 3. Espaces internes tolérés ──────────────────────────────────────────────
{
    const out = rewriteCssUrls('x{background:url( /games/x/a.png )}', distURL);
    assert(out.includes(PROTO + 'games/x/a.png'), 'espaces autour de l\'URL tolérés');
}

// ── 4. Ce qui ne doit PAS être touché ────────────────────────────────────────
{
    const data = 'i{background:url(data:image/png;base64,AAAA)}';
    assert(rewriteCssUrls(data, distURL) === data, 'data: laissé intact');
    const blob = 'i{background:url(blob:tauri://localhost/abc)}';
    assert(rewriteCssUrls(blob, distURL) === blob, 'blob: laissé intact');
    const other = 'i{background:url(/content/img/local.png)}';
    assert(rewriteCssUrls(other, distURL) === other, 'chemin hors browser//games/ inchangé');
    const none = '.x { color: red; }';
    assert(rewriteCssUrls(none, distURL) === none, 'CSS sans url() inchangé');
}

// ── 5. Robustesse ────────────────────────────────────────────────────────────
{
    assert(rewriteCssUrls(null, distURL) === null, 'entrée non-string renvoyée telle quelle');
    assert(rewriteCssUrls('x{background:url(/games/a.png)}', null) === 'x{background:url(/games/a.png)}',
        'sans fonction de mappage : texte inchangé');
    const boom = () => { throw new Error('mapping HS'); };
    assert(rewriteCssUrls('x{background:url(/games/a.png)}', boom) === 'x{background:url(/games/a.png)}',
        'une erreur du mappage laisse l\'URL d\'origine (pas d\'exception propagée)');
    const identity = rewriteCssUrls('x{background:url(/games/a.png)}', () => null);
    assert(identity === 'x{background:url(/games/a.png)}', 'mappage renvoyant null : URL conservée');
}

// ── 6. Fragment HTML complet (ce que reçoit réellement info.js) ──────────────
{
    const html = `<style>.u-icon{background-image:url(/browser/games/chessbase/res/ultima/s.png);}</style>
<table><tr><td><span class="u-icon"></span> Pincer Pawn</td></tr></table>`;
    const out = rewriteCssUrls(html, distURL);
    assert(out.includes(PROTO + 'browser/games/chessbase/res/ultima/s.png'), 'url() réécrite dans un fragment HTML');
    assert(out.includes('<span class="u-icon"></span> Pincer Pawn'), 'le HTML autour est inchangé');
}

// ── 7. Non-divergence avec la copie d'asset-rewrite.js ──────────────────────
// asset-rewrite.js est injecté tel quel dans la webview (pas un module ES) :
// il embarque sa propre rewriteCssText(). Ce test l'EXTRAIT et vérifie
// qu'elle se comporte comme le module, pour que les deux ne divergent pas.
{
    const src = await readFile(new URL('../app/content/asset-rewrite.js', import.meta.url), 'utf8');
    const m = src.match(/function rewriteCssText\(val\) \{[\s\S]*?\n  \}/);
    assert(!!m, 'rewriteCssText() retrouvée dans asset-rewrite.js');
    // Mappage AGRESSIF (réécrit tout) : indispensable pour que la comparaison
    // teste réellement les gardes data:/blob: — avec distURL, une URL data:
    // ressort inchangée de toute façon, ce qui masquerait une divergence.
    const mapAll = (u) => 'REWRITTEN:' + u;
    // eslint-disable-next-line no-new-func
    const inlineImpl = new Function('toDist', `${m[0]}; return rewriteCssText;`)(mapAll);
    const cases = [
        '.u-icon{background-image:url(/browser/games/chessbase/res/ultima/s.png)}',
        `a{background:url("/games/x/a.png")}b{background:url('/games/x/b.png')}`,
        'i{background:url(data:image/png;base64,AAAA)}',
        'i{background:url(blob:tauri://localhost/abc)}',
        'i{background:url(/content/img/local.png)}',
        '.x{color:red}',
    ];
    for (const css of cases) {
        assert(inlineImpl(css) === rewriteCssUrls(css, mapAll),
            `même résultat que le module : ${css.slice(0, 42)}…`);
    }
}

console.log(`\ntest-css-url-rewrite: ${passed} assertions OK`);
