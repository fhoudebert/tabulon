// tests/test-thinking-clock.mjs — le chronomètre de réflexion du pied de plateau.
//
// POURQUOI IL EXISTE. Une recherche KataGo dure des secondes et rien ne bouge
// pendant ce temps : ni le plateau, ni le pied de page. Un texte fixe ne
// distingue pas « cela réfléchit » de « cela a planté », et c'est exactement
// le symptôme qu'avait le moteur de go avant que sa sonde soit réparée. Un
// compteur qui avance répond à la question sans ouvrir la console.
//
// DEUX CHOSES SE VÉRIFIENT ICI, et la seconde est la plus importante :
//
//   1. le format, parce qu'un dixième qui ne bouge pas ou un « 1:5 » au lieu
//      de « 1:05 » se lisent mal ;
//   2. l'ARRÊT du chronomètre. Un setInterval oublié survit à la recherche et
//      continue d'écrire dans le pied par-dessus le message suivant — une
//      fuite qui ne se voit qu'à l'usage, longtemps après. D'où le `finally`
//      dans play.js, contrôlé ici plutôt que laissé à la relecture.
//
// La fonction est PRISE dans play.js (extraction par équilibrage d'accolades)
// et non recopiée : une copie ne serait d'accord qu'avec elle-même.
//
// Usage : node tests/test-thinking-clock.mjs
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const play = readFileSync(path.join(root, 'app', 'content', 'play.js'), 'utf-8');

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

function lift(name) {
    const at = play.indexOf('function ' + name);
    if (at < 0) throw new Error('introuvable : ' + name);
    let depth = 0;
    for (let j = play.indexOf('{', at); j < play.length; j++) {
        if (play[j] === '{') depth++;
        else if (play[j] === '}' && --depth === 0)
            return (0, eval)('(' + play.slice(at, j + 1) + ')');
    }
    throw new Error('accolades déséquilibrées : ' + name);
}

console.log('Le format du temps écoulé');
{
    const FormatElapsed = lift('FormatElapsed');
    ok(FormatElapsed(0) === '0.0 s', 'un chronomètre neuf affiche déjà un dixième');
    ok(FormatElapsed(3400) === '3.4 s', 'des secondes sous la minute');
    ok(FormatElapsed(59900) === '59.9 s', 'et jusqu\'à la minute');
    // Au-delà, le dixième est du bruit et le nombre devient long ; les minutes
    // se lisent plus vite, et le zéro doit rester ou 1:05 et 1:50 se ressemblent.
    ok(FormatElapsed(60000) === '1:00', 'des minutes au-delà');
    ok(FormatElapsed(65000) === '1:05', 'secondes complétées par un zéro');
    ok(FormatElapsed(605000) === '10:05', 'et pas de plafond sur les minutes');
}

console.log('');
console.log('Le chronomètre est arrêté quoi qu\'il arrive');
// La recherche peut aussi bien rendre un coup qu'échouer (moteur absent,
// niveau non résolu) ou être interrompue par un recul dans l'historique --
// gameLoop attrape et reboucle. Seul un `finally` couvre les trois.
ok(/finally\s*\{\s*stopClock\(\);\s*\}/.test(play),
   'l\'arrêt est dans un finally, pas seulement sur le chemin nominal');
ok(/const stopClock = StartThinkingClock\(/.test(play),
   'et il est bien celui que StartThinkingClock a rendu');
ok(/clearInterval\(timer\)/.test(play),
   'l\'intervalle est supprimé, pas seulement oublié');

// Le tour humain n'a rien à chronométrer : personne n'attend une machine.
ok(!/turnA' : 'play\.turnB'\)\);\s*const stopClock/.test(play),
   'le tour humain ne démarre pas de chronomètre');

console.log('');
console.log('L\'unité ne passe pas par le dictionnaire');
// « s » s'écrit pareil en français et en anglais, et un affichage rafraîchi
// dix fois par seconde n'est pas l'endroit où faire travailler l'i18n.
{
    const i18n = readFileSync(path.join(root, 'app', 'content', 'tabulon-i18n.js'), 'utf-8');
    ok(!/'play\.seconds'|'common\.seconds'/.test(i18n),
       'aucune clé inventée pour une unité qui ne change pas');
}

console.log('');
console.log(`RESULTAT thinking-clock: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
