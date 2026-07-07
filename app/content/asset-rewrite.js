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
// Il est aussi ré-injecté à l'identique dans l'<iframe> Jocly (voir plus bas),
// d'où la forme "fonction nommée + auto-appel" : SELF_SOURCE contient sa
// propre source pour la ré-injection.
function __applyDistRewrite() {
  var SELF_SOURCE = __applyDistRewrite.toString();
  // Base absolue du protocole custom. Sur Windows, les protocoles custom sont
  // servis via https://<scheme>.localhost/ ; ailleurs via <scheme>://localhost/.
  // On laisse la webview résoudre le host : une URL relative au protocole
  // suffit si on préfixe correctement. Tauri expose le convertisseur.
  // Le format d'URL d'un protocole custom diffère selon la plateforme :
  //   Linux (WebKitGTK) : tabulon-dist://localhost/<path>
  //   Windows (WebView2) : http://tabulon-dist.localhost/<path>
  //   macOS (WKWebView)  : tabulon-dist://localhost/<path>
  // convertFileSrc() connaît le bon format : on l'utilise TOUJOURS quand il est
  // disponible (withGlobalTauri le garantit tôt). Le repli en dur ne sert que
  // si __TAURI__ n'est pas encore prêt — auquel cas on tente le format le plus
  // courant, mais ce cas ne devrait pas se produire avec l'injection au
  // initialization_script.
  var PROTO = 'tabulon-dist://localhost/';
  try {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.convertFileSrc) {
      PROTO = window.__TAURI__.core.convertFileSrc('x', 'tabulon-dist');
      // convertFileSrc('x', …) → .../x : on retire le segment factice pour
      // obtenir la base, robuste quel que soit le format de la plateforme.
      PROTO = PROTO.replace(/x$/, '');
      if (PROTO.charAt(PROTO.length - 1) !== '/') PROTO += '/';
    }
  } catch (e) { /* repli en dur conservé */ }

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

  // Exposés globalement (window.*) : distURL pour la réécriture explicite des
  // backgrounds CSS par le code de page (hub.js), et applyDistRewrite pour la
  // ré-injection dans l'iframe Jocly.
  window.__distURL = function (url) { return toDist(url) || url; };
  window.__applyDistRewrite = __applyDistRewrite;

  // 1. Réécriture des <script src>/<img src>/<link href> présents au parse.
  //    On agit très tôt (document_start) ; pour le <script src=jocly.js> qui
  //    suit dans le <head>, on réécrit à la volée via un MutationObserver.
  // Réécriture des <script src>/<img src>/<link href> ajoutés au DOM.
  // IMPORTANT : on NE réécrit PAS le <script src="../browser/jocly.js">.
  // Jocly calcule sa baseURL interne à partir du pathname de CE script
  // (BrowserScriptLoader.setBaseURL) ; s'il pointait sur tabulon-dist://,
  // la baseURL deviendrait absolue au protocole et les fetch suivants
  // seraient mal formés ("Game … not found"). En le laissant relatif à la
  // page, la baseURL reste /browser/ et TOUTES les requêtes de fichiers de
  // jeux (jocly.core.js, games/**) passent ensuite par le hook fetch/XHR
  // ci-dessous, qui les redirige correctement vers le dist externe.
  function rewriteEl(el) {
    var attr = el.tagName === 'LINK' ? 'href' : 'src';
    var v = el.getAttribute && el.getAttribute(attr);
    if (!v) return;
    if (el.tagName === 'SCRIPT' && /(^|\/)browser\/jocly\.js(\?|$)/.test(v)) return; // laisser tel quel
    var d = toDist(v);
    if (d) el.setAttribute(attr, d);
  }

  // L'<iframe> de Jocly (attachElement → jocly.embed.html) est un contexte
  // séparé où ce script n'est pas ré-injecté et où Jocly RECHARGE le jeu
  // (createMatch) — d'où "Game … not found" quand le jeu est seulement dans le
  // dist externe. On garde l'iframe sur NOTRE origine (pour préserver le
  // postMessage parent↔iframe, qui vérifie l'origine) et on injecte ce même
  // script à l'intérieur dès que son document est accessible : les fetch de
  // jeux de l'iframe passent alors aussi par le dist externe.
  function injectIntoIframe(iframe) {
    function inject() {
      try {
        var doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
        if (!doc || doc.__distRewriteInjected) return;
        doc.__distRewriteInjected = true;
        var s = doc.createElement('script');
        // Ré-injecte CE script (fonction + auto-appel) dans l'iframe.
        s.textContent = SELF_SOURCE + '\n__applyDistRewrite();';
        (doc.head || doc.documentElement).insertBefore(s, (doc.head || doc.documentElement).firstChild);
      } catch (e) { /* pas encore prêt / cross-origin : onload réessaiera */ }
    }
    inject();
    iframe.addEventListener('load', inject);
  }
  try {
    new MutationObserver(function (muts) {
      muts.forEach(function (mu) {
        mu.addedNodes && mu.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.tagName === 'IFRAME') injectIntoIframe(n);
          if (/^(SCRIPT|IMG|LINK)$/.test(n.tagName)) rewriteEl(n);
          n.querySelectorAll && n.querySelectorAll('script[src],img[src],link[href]').forEach(rewriteEl);
          n.querySelectorAll && n.querySelectorAll('iframe').forEach(injectIntoIframe);
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

  // 4. Image().src / <img>.src assignés en JS (préchargement des visuels et
  //    thumbnails) : ces affectations ne déclenchent pas le MutationObserver.
  try {
    var iproto = window.HTMLImageElement && window.HTMLImageElement.prototype;
    var idesc = iproto && Object.getOwnPropertyDescriptor(iproto, 'src');
    if (idesc && idesc.set) {
      Object.defineProperty(iproto, 'src', {
        configurable: true, enumerable: idesc.enumerable,
        get: function () { return idesc.get.call(this); },
        set: function (v) { var d = (typeof v === 'string') && toDist(v); idesc.set.call(this, d || v); },
      });
    }
  } catch (e) { /* non redéfinissable : ignore */ }

  // 5. style.backgroundImage: url(...) posé en JS (vignettes du hub). Passe par
  //    le CSSOM, hors fetch/img/observer. On réécrit les url(...) au setter.
  try {
    var SP = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype;
    if (SP && SP.setProperty) {
      var rewriteCssUrls = function (val) {
        return String(val).replace(/url\((['"]?)([^'")]+)\1\)/g, function (m, q, u) {
          var d = toDist(u); return d ? 'url(' + q + d + q + ')' : m;
        });
      };
      var _setProp = SP.setProperty;
      SP.setProperty = function (prop, val, prio) {
        if (/background/i.test(prop) && val) val = rewriteCssUrls(val);
        return _setProp.call(this, prop, val, prio);
      };
      ['backgroundImage', 'background'].forEach(function (name) {
        var d = Object.getOwnPropertyDescriptor(SP, name);
        if (d && d.set) {
          Object.defineProperty(SP, name, {
            configurable: true, enumerable: d.enumerable,
            get: function () { return d.get.call(this); },
            set: function (v) { d.set.call(this, rewriteCssUrls(v)); },
          });
        }
      });
    }
  } catch (e) { /* CSSOM non redéfinissable : ignore */ }
}
__applyDistRewrite();
