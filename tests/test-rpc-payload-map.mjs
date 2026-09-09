// tests/test-rpc-payload-map.mjs — la table de tabulon-rpc.js dit la vérité.
//
// Régression : les niveaux KataGo se rabattaient silencieusement sur l'IA
// native avec « aucun reseau declare par le niveau ». Cause : `buildPayload`
// (app/content/tabulon-rpc.js) n'avait pas d'entrée pour `katago_probe`,
// `katago_search` ni `katago_stop`. Le repli `return { args }` envoie alors à
// Tauri un objet `{ args: [...] }` dont AUCUNE clé ne porte le nom d'un
// paramètre Rust — et comme `net: Option<String>` est optionnel, la commande
// ne PROTESTE PAS : elle s'exécute avec `None`, et l'échec ressort trois
// couches plus loin sous la forme d'un diagnostic faux (« le niveau ne
// déclare pas de réseau », alors que le niveau le déclarait bien).
//
// Ce que ce fichier vérifie, et pourquoi ça ne se vérifie pas ailleurs :
// `map` est un DOUBLON À LA MAIN des signatures Rust, et rien ne les relie.
// Les suites existantes (test-engine-native.mjs) simulent `rpc`, donc ne
// traversent jamais `buildPayload` ; les tests Rust ne voient pas le JS.
// Seule une comparaison des deux fichiers ferme l'angle mort.
//
//   1. tout `.call('x')` du front a une entrée dans `map` ;
//   2. toute entrée de `map` désigne une commande Tauri réellement déclarée ;
//   3. les clés produites par le builder portent le nom des paramètres Rust
//      (camelCase côté JS -> snake_case côté Rust, conversion faite par Tauri),
//      les paramètres injectés (AppHandle, State) mis à part, et un
//      `Option<...>` pouvant être omis.
//
// Usage : npm test  (ou node tests/test-rpc-payload-map.mjs)
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root    = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const content = path.join(root, 'app', 'content');
const cmdsDir = path.join(root, 'src-tauri', 'src', 'commands');

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  \u2713', m); } else { FAIL++; console.log('  \u2717 ECHEC:', m); } };

// Commentaires retirés avant toute analyse : `new_match` porte un commentaire
// contenant une parenthèse, qui couperait la liste de paramètres en deux.
function Strip(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Tauri convertit le nom du paramètre Rust en lowerCamelCase (heck) pour en
// faire la clé attendue dans le payload : `game_name` -> `gameName`, et
// `_data` -> `data`, le souligné d'un paramètre inutilisé disparaissant. On
// compare donc les deux côtés sur une forme neutre.
const Key = (s) => s.replace(/_/g, '').toLowerCase();

// Découpe sur les virgules DE PREMIER NIVEAU. `State<'_, EngineState>` en
// contient une qui n'est pas une séparation de paramètres, et un `split(',')`
// naïf y invente un paramètre nommé « EngineState ».
function SplitTop(src) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if ('<([{'.includes(c)) depth++;
        else if ('>)]}'.includes(c)) depth--;
        else if (c === ',' && depth === 0) { out.push(src.slice(start, i)); start = i + 1; }
    }
    out.push(src.slice(start));
    return out.map((s) => s.trim()).filter(Boolean);
}

// ── Côté Rust : les commandes, leurs paramètres, et lesquels sont optionnels ──
//
// Un paramètre dont le TYPE est AppHandle ou State<…> est fourni par Tauri,
// jamais par le front : il ne doit pas apparaître dans le payload.
const INJECTED = /AppHandle|State\s*<|Window\b|Channel\s*</;

const rust = new Map();
for (const f of readdirSync(cmdsDir).filter((n) => n.endsWith('.rs'))) {
    const src = Strip(readFileSync(path.join(cmdsDir, f), 'utf-8'));
    for (const m of src.matchAll(/#\[tauri::command\][\s\S]{0,120}?\bfn\s+([a-z_0-9]+)\s*\(([^)]*)\)/g)) {
        const params = SplitTop(m[2]).map((p) => {
            const i = p.indexOf(':');
            return { name: p.slice(0, i).trim(), type: p.slice(i + 1).trim() };
        }).filter((p) => p.name && !INJECTED.test(p.type));
        rust.set(m[1], { file: f, params });
    }
}

// Déclarées ≠ exposées : une commande absente de invoke_handler n'existe pas
// pour le front, quoi qu'en dise son attribut.
const lib = Strip(readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf-8'));
const handler = lib.slice(lib.indexOf('generate_handler!'), lib.indexOf('generate_handler!') + 4000);
const exposed = new Set([...handler.matchAll(/[a-z_0-9]+::([a-z_0-9]+)/g)].map((m) => m[1]));

// ── Côté JS : la table, et les clés que chaque builder produit ────────────────
const rpcSrc = readFileSync(path.join(content, 'tabulon-rpc.js'), 'utf-8');
const mapSrc = rpcSrc.slice(rpcSrc.indexOf('const map = {'), rpcSrc.indexOf('const builder = map[method]'));
const map = new Map();
for (const m of Strip(mapSrc).matchAll(/^\s{4}([a-z_0-9]+):\s*\(([^)]*)\)\s*=>\s*\(\{([^}]*)\}\)/gm)) {
    // `{ gameName, clock: clock || null }` : clé explicite ou raccourci.
    const keys = SplitTop(m[3]).map((f) => (f.match(/^([A-Za-z_0-9]+)/) || [])[1]).filter(Boolean);
    map.set(m[1], keys);
}

console.log(`Table de payload : ${map.size} entrées, ${rust.size} commandes Rust déclarées`);
ok(map.size > 40, `${map.size} entrées lues dans buildPayload — l'extraction porte bien`);
ok(rust.size > 40, `${rust.size} commandes Rust lues — l'extraction porte bien`);

console.log('');
console.log('Tout appel du front a une entrée dans la table');
{
    const used = new Map();
    for (const f of readdirSync(content).filter((n) => n.endsWith('.js') && n !== 'tabulon-rpc.js')) {
        const src = Strip(readFileSync(path.join(content, f), 'utf-8'));
        for (const m of src.matchAll(/\.call\(\s*['"]([a-z_0-9]+)['"]/g))
            if (!used.has(m[1])) used.set(m[1], f);
    }
    for (const [method, file] of [...used].sort())
        ok(map.has(method), `${method} (${file}) est dans buildPayload`);
}

console.log('');
console.log('Toute entrée de la table désigne une commande exposée');
for (const method of [...map.keys()].sort())
    ok(exposed.has(method) && rust.has(method),
       `${method} est déclarée et passée à generate_handler!`);

console.log('');
console.log('Les clés du payload portent le nom des paramètres Rust');
for (const [method, keys] of [...map].sort()) {
    const sig = rust.get(method);
    if (!sig) continue;                      // déjà signalé au bloc précédent
    const sent = new Set(keys.map(Key));
    const missing = sig.params
        .filter((p) => !p.type.startsWith('Option<') && !sent.has(Key(p.name)))
        .map((p) => p.name);
    const extra = keys.filter((k) => !sig.params.some((p) => Key(p.name) === Key(k)));
    ok(missing.length === 0 && extra.length === 0,
       `${method} : ${sig.params.map((p) => p.name).join(', ') || '(aucun)'}`
       + (missing.length ? ` — MANQUE ${missing.join(', ')}` : '')
       + (extra.length ? ` — EN TROP ${extra.join(', ')}` : ''));
}

console.log('');
console.log(`RESULTAT rpc-payload-map: ${PASS} OK / ${FAIL} ECHEC`);
process.exit(FAIL ? 1 : 0);
