// asset-rewrite.js — injecté dans chaque webview AVANT le code de page,
// uniquement quand un dist/ externe existe (voir dist_override.rs).
//
// But : faire pointer les assets Jocly (moteur + jeux) vers le protocole
// `tabulon-dist://`, qui sert le dist externe posé à côté de l'exécutable
// (avec repli sur l'embarqué). Les pages gardent leurs `../browser/…` et
// `../games/…` relatifs habituels : on intercepte à trois niveaux.
//
// Ce fichier n'est PAS un module ES : il est injecté tel quel via
// initialization_script et doit s'exécuter en contexte global, sans import.
(function () {
  // Base absolue du protocole custom. Sur Windows, les protocoles custom sont
  // servis via https://<scheme>.localhost/ ; ailleurs via <scheme>://localhost/.
  // On laisse la webview résoudre le host : une URL relative au protocole
  // suffit si on préfixe correctement. Tauri expose le convertisseur.
  var PROTO = 'tabulon-dist://localhost/';
  if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.convertFileSrc) {
    // convertFileSrc(path, protocol) → URL correcte pour la plateforme.
    PROTO = window.__TAURI__.core.convertFileSrc('', 'tabulon-dist');
    if (PROTO.charAt(PROTO.length - 1) !== '/') PROTO += '/';
  }

  // Transforme une URL de page (relative ou absolue) contenant /browser/ ou
  // /games/ en URL du protocole custom. Retourne null si non concernée.
  function toDist(url) {
    try {
      var abs = new URL(url, document.baseURI);
      var m = abs.pathname.match(/\/((?:browser|games)\/.*)$/);
      if (!m) return null;
      return PROTO + m[1] + abs.search;
    } catch (e) { return null; }
  }

  // 1. Réécriture des <script src>/<img src>/<link href> présents au parse.
  //    On agit très tôt (document_start) ; pour le <script src=jocly.js> qui
  //    suit dans le <head>, on réécrit à la volée via un MutationObserver.
  function rewriteEl(el) {
    var attr = el.tagName === 'LINK' ? 'href' : 'src';
    var v = el.getAttribute && el.getAttribute(attr);
    if (!v) return;
    var d = toDist(v);
    if (d) el.setAttribute(attr, d);
  }
  try {
    new MutationObserver(function (muts) {
      muts.forEach(function (mu) {
        mu.addedNodes && mu.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (/^(SCRIPT|IMG|LINK)$/.test(n.tagName)) rewriteEl(n);
          n.querySelectorAll && n.querySelectorAll('script[src],img[src],link[href]').forEach(rewriteEl);
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* pas de DOM encore : les autres hooks couvrent */ }

  // 2. fetch() — les règles/descriptions/crédits et data des jeux.
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url);
      var d = url && toDist(url);
      if (d) input = (typeof input === 'string') ? d : new Request(d, input);
      return _fetch.call(this, input, init);
    };
  }

  // 3. XMLHttpRequest — au cas où Jocly l'utilise pour certaines ressources.
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var d = (typeof url === 'string') && toDist(url);
    if (d) arguments[1] = d;
    return _open.apply(this, arguments);
  };
})();
