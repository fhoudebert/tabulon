// scripts/export-all.mjs — export général PONCTUEL : empaquette TOUT un dist
// en extensions publiables sur le catalogue GitHub Pages.
//
// Produit, dans le dossier de sortie :
//   modules/<module>.tabulon-ext  + modules/index.html   (modules, ordre alpha)
//   games/<jeu>.tabulon-ext       + games/index.html     (jeux groupés par
//                                   module, puis ordre alphabétique de titre)
//   index.html                    (accueil minimal liant les deux pages)
// Le dossier de sortie se publie tel quel sous ext/ :
//   https://fhoudebert.github.io/tabulon/ext/modules
//   https://fhoudebert.github.io/tabulon/ext/games
//
// Toute la logique d'empaquetage vit dans make-extension.mjs (miroir du Rust) ;
// ici on ne fait qu'orchestrer et générer les pages statiques. Les pages sont
// autonomes (css inline, aucun script) pour rester servables par GitHub Pages
// sans dépendance.
//
// Usage : node scripts/export-all.mjs [dossier-sortie=ext] [--dist chemin]
//   ex.  node scripts/export-all.mjs /tmp/ext --dist dist
// Un jeu ou module qui échoue n'interrompt pas l'export : il est listé en fin
// de course et le script sort en code 1.
import { writeFileSync, mkdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { readIndex, buildExtension, buildModuleExtension } from './make-extension.mjs';

// ── Plan d'export : modules triés, jeux groupés par module puis par titre ────
import { pickLocalized } from '../app/content/localized-field.js';

export function planExport(index) {
  const byModule = new Map();
  for (const [name, decl] of Object.entries(index)) {
    if (!byModule.has(decl.module)) byModule.set(decl.module, []);
    byModule.get(decl.module).push({
      name,
      title: decl.title || name,
      // Le resume peut etre une chaine ou un objet {locale: texte} : le
      // catalogue est un artefact statique publie tel quel -> anglais.
      summary: pickLocalized(decl.summary, 'en'),
    });
  }
  const modules = [...byModule.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  const groups = modules.map(module => ({
    module,
    games: byModule.get(module)
      .sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' })
                   || a.name.localeCompare(b.name, 'en')),
  }));
  return { modules, groups };
}

// ── Petites briques HTML (pures, testables) ──────────────────────────────────
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' Ko';
  return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
}

// Gabarit commun : page statique autonome (aucun script, css inline).
function page(title, intro, body, generatedAt) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 56rem;
         padding: 1.5rem 1rem 3rem; line-height: 1.5; color: #222; background: #fafafa; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.15rem; margin-top: 2rem;
       border-bottom: 1px solid #ddd; padding-bottom: .25rem; }
  p.intro { color: #555; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: .35rem .6rem; vertical-align: top; }
  tbody tr:nth-child(odd) { background: #f0f0f0; }
  td.size { white-space: nowrap; text-align: right; color: #555; }
  td.dl { white-space: nowrap; text-align: right; }
  a.get { text-decoration: none; background: #2f6f4f; color: #fff;
          padding: .15rem .6rem; border-radius: .35rem; }
  a.get:hover { background: #245a3f; }
  .summary { color: #555; font-size: .9rem; }
  footer { margin-top: 3rem; color: #888; font-size: .8rem; }
  nav { margin-bottom: 1rem; font-size: .9rem; }
</style>
</head>
<body>
<nav><a href="../">← Catalogue</a></nav>
<h1>${escapeHtml(title)}</h1>
<p class="intro">${intro}</p>
${body}
<footer>Généré le ${escapeHtml(generatedAt)} par scripts/export-all.mjs —
<a href="https://github.com/fhoudebert/tabulon">Tabulon</a>.</footer>
</body>
</html>
`;
}

// rows = [{ module, gamesCount, size, file }] déjà triés.
export function buildModulesIndexHtml(rows, generatedAt = new Date().toISOString().slice(0, 10)) {
  const tr = rows.map(r => `<tr>
<td><strong>${escapeHtml(r.module)}</strong></td>
<td>${r.gamesCount} jeu${r.gamesCount > 1 ? 'x' : ''}</td>
<td class="size">${formatSize(r.size)}</td>
<td class="dl"><a class="get" href="${escapeHtml(r.file)}" download>Télécharger</a></td>
</tr>`).join('\n');
  const body = `<table>
<thead><tr><th>Module</th><th>Contenu</th><th>Taille</th><th></th></tr></thead>
<tbody>
${tr}
</tbody>
</table>`;
  const intro = 'Chaque extension de module (<code>.tabulon-ext</code>) contient '
    + 'l\u2019intégralité du module — tous ses jeux et leurs ressources partagées. '
    + 'À importer depuis l\u2019écran <em>Extensions</em> de Tabulon (onglet Modules).';
  return page('Tabulon — extensions de modules', intro, body, generatedAt);
}

// groups = [{ module, games: [{ name, title, summary, size, file }] }] triés.
export function buildGamesIndexHtml(groups, generatedAt = new Date().toISOString().slice(0, 10)) {
  const sections = groups.map(g => {
    const tr = g.games.map(x => `<tr>
<td><strong>${escapeHtml(x.title)}</strong><br><span class="summary">${escapeHtml(x.summary)}</span></td>
<td class="size">${formatSize(x.size)}</td>
<td class="dl"><a class="get" href="${escapeHtml(x.file)}" download>Télécharger</a></td>
</tr>`).join('\n');
    return `<h2 id="${escapeHtml(g.module)}">${escapeHtml(g.module)}</h2>
<table>
<tbody>
${tr}
</tbody>
</table>`;
  }).join('\n');
  const toc = '<p>' + groups.map(g =>
    `<a href="#${escapeHtml(g.module)}">${escapeHtml(g.module)}</a>`).join(' · ') + '</p>';
  const intro = 'Extensions de jeux individuels (<code>.tabulon-ext</code>), groupées par module. '
    + 'L\u2019import d\u2019un jeu exige que son <a href="../modules/">module</a> soit déjà présent '
    + 'dans le dist externe (les ressources partagées restent liées au module).';
  return page('Tabulon — extensions de jeux', intro, toc + '\n' + sections, generatedAt);
}

export function buildRootIndexHtml(moduleCount, gameCount, generatedAt = new Date().toISOString().slice(0, 10)) {
  const body = `<ul>
<li><a href="modules/">Modules</a> — ${moduleCount} extensions de modules complets</li>
<li><a href="games/">Jeux</a> — ${gameCount} extensions de jeux individuels</li>
</ul>`;
  return page('Tabulon — catalogue d\u2019extensions', 'Extensions installables depuis l\u2019écran '
    + '<em>Extensions</em> de Tabulon (import d\u2019un fichier <code>.tabulon-ext</code>).', body, generatedAt)
    .replace('<nav><a href="../">← Catalogue</a></nav>\n', '');
}

// ── Orchestration ─────────────────────────────────────────────────────────────
export function exportAll(distDir, outDir, { log = () => {} } = {}) {
  const index = readIndex(path.join(distDir, 'browser', 'jocly-allgames.js'));
  const plan = planExport(index);
  const modulesDir = path.join(outDir, 'modules');
  const gamesDir = path.join(outDir, 'games');
  mkdirSync(modulesDir, { recursive: true });
  mkdirSync(gamesDir, { recursive: true });

  const failures = [];
  const moduleRows = [];
  for (const m of plan.modules) {
    try {
      const r = buildModuleExtension(distDir, m, modulesDir);
      moduleRows.push({
        module: m,
        gamesCount: Object.keys(r.games).length,
        size: statSync(r.out).size,
        file: path.basename(r.out),
      });
      log(`✓ module ${m} (${Object.keys(r.games).length} jeux)`);
    } catch (e) {
      failures.push(`module ${m} : ${e.message}`);
      log(`✗ module ${m} : ${e.message}`);
    }
  }

  const groups = [];
  for (const g of plan.groups) {
    const games = [];
    for (const game of g.games) {
      try {
        const r = buildExtension(distDir, game.name, gamesDir);
        games.push({ ...game, size: statSync(r.out).size, file: path.basename(r.out) });
        log(`✓ jeu ${game.name}${r.missing.length ? ` (⚠ absents : ${r.missing.join(', ')})` : ''}`);
      } catch (e) {
        failures.push(`jeu ${game.name} : ${e.message}`);
        log(`✗ jeu ${game.name} : ${e.message}`);
      }
    }
    if (games.length) groups.push({ module: g.module, games });
  }

  const generatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(modulesDir, 'index.html'), buildModulesIndexHtml(moduleRows, generatedAt));
  writeFileSync(path.join(gamesDir, 'index.html'), buildGamesIndexHtml(groups, generatedAt));
  const gameCount = groups.reduce((n, g) => n + g.games.length, 0);
  writeFileSync(path.join(outDir, 'index.html'), buildRootIndexHtml(moduleRows.length, gameCount, generatedAt));
  return { moduleRows, groups, gameCount, failures };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const di = args.indexOf('--dist');
  const distDir = di >= 0 ? args.splice(di, 2)[1]
    : path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist');
  const outDir = args[0] || 'ext';
  const r = exportAll(distDir, outDir, { log: m => console.log('  ' + m) });
  console.log(`\n${r.moduleRows.length} modules et ${r.gameCount} jeux exportés dans ${outDir}/`);
  console.log(`→ publier le contenu de ${outDir}/ sous ext/ (GitHub Pages)`);
  if (r.failures.length) {
    console.error(`\n✗ ${r.failures.length} échec(s) :`);
    for (const f of r.failures) console.error('  - ' + f);
    process.exit(1);
  }
}
