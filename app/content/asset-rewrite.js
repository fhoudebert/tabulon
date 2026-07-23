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
  // Idempotence : depuis le passage à initialization_script_for_all_frames
  // (lib.rs / window_manager.rs), ce script s'exécute nativement dans CHAQUE
  // frame — y compris l'iframe Jocly — à document_start. La ré-injection
  // manuelle dans l'iframe (injectIntoIframe, conservée en filet de sécurité)
  // peut donc conduire à une double exécution dans le même contexte : on
  // s'arrête si les hooks sont déjà posés, pour ne pas les ré-emballer.
  if (window.__distRewriteApplied) return;
  window.__distRewriteApplied = true;
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
  // Réécrit les url(...) d'un texte CSS. Utilisé pour le TEXTE des <style>
  // (cas non couvert par les autres hooks : le moteur CSS analyse ce texte
  // sans passer par le JS) et par le hook CSSOM plus bas.
  function rewriteCssText(val) {
    return String(val).replace(/url\((['"]?)([^'")]+)\1\)/g, function (m, q, u) {
      if (/^(data|blob):/i.test(u)) return m;
      var d = toDist(u); return d ? 'url(' + q + d + q + ')' : m;
    });
  }

  // <style> ajouté au DOM (ex. page de règles d'un jeu injectée par info.js,
  // dont les icônes de pièces sont des background-image de sprite) : on
  // réécrit son texte. Sans ça, l'URL part sur les assets embarqués — où le
  // jeu du dist externe n'existe pas — et la webview répond 500.
  function rewriteStyleEl(el) {
    try {
      var css = el.textContent;
      if (!css || css.indexOf('url(') === -1) return;
      var out = rewriteCssText(css);
      if (out !== css) el.textContent = out;
    } catch (e) { /* style non modifiable : ignore */ }
  }

  function rewriteEl(el) {
    var attr = el.tagName === 'LINK' ? 'href' : 'src';
    var v = el.getAttribute && el.getAttribute(attr);
    if (!v) return;
    if (el.tagName === 'SCRIPT' && /(^|\/)browser\/jocly\.js(\?|$)/.test(v)) return; // laisser tel quel
    var d = toDist(v);
    if (d) {
      // Images redirigées cross-origin → crossOrigin anonymous pour WebGL
      if (el.tagName === 'IMG') { try { if (!el.crossOrigin) el.crossOrigin = 'anonymous'; } catch (e) {} }
      el.setAttribute(attr, d);
    }
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
          if (n.tagName === 'STYLE') rewriteStyleEl(n);
          n.querySelectorAll && n.querySelectorAll('script[src],img[src],link[href]').forEach(rewriteEl);
          n.querySelectorAll && n.querySelectorAll('style').forEach(rewriteStyleEl);
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
  //    thumbnails, et TEXTURES 3D three.js) : ces affectations ne déclenchent
  //    pas le MutationObserver. En plus de rediriger vers le dist externe, on
  //    pose crossOrigin='anonymous' AVANT le src : sans lui, une texture
  //    servie depuis tabulon-dist:// (origine ≠ celle de l'iframe tauri://)
  //    rend le canvas WebGL "tainted" → SecurityError sur texSubImage2D. Le
  //    protocole renvoie déjà Access-Control-Allow-Origin: * (CORS OK).
  try {
    var iproto = window.HTMLImageElement && window.HTMLImageElement.prototype;
    var idesc = iproto && Object.getOwnPropertyDescriptor(iproto, 'src');
    if (idesc && idesc.set) {
      Object.defineProperty(iproto, 'src', {
        configurable: true, enumerable: idesc.enumerable,
        get: function () { return idesc.get.call(this); },
        set: function (v) {
          var d = (typeof v === 'string') && toDist(v);
          if (d) {
            // crossOrigin doit être défini avant l'assignation de src
            try { if (!this.crossOrigin) this.crossOrigin = 'anonymous'; } catch (e) {}
          }
          idesc.set.call(this, d || v);
        },
      });
    }
  } catch (e) { /* non redéfinissable : ignore */ }

  // 5. style.backgroundImage: url(...) posé en JS (vignettes du hub). Passe par
  //    le CSSOM, hors fetch/img/observer. On réécrit les url(...) au setter.
  try {
    var SP = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype;
    if (SP && SP.setProperty) {
      var _setProp = SP.setProperty;
      SP.setProperty = function (prop, val, prio) {
        if (/background/i.test(prop) && val) val = rewriteCssText(val);
        return _setProp.call(this, prop, val, prio);
      };
      ['backgroundImage', 'background'].forEach(function (name) {
        var d = Object.getOwnPropertyDescriptor(SP, name);
        if (d && d.set) {
          Object.defineProperty(SP, name, {
            configurable: true, enumerable: d.enumerable,
            get: function () { return d.get.call(this); },
            set: function (v) { d.set.call(this, rewriteCssText(v)); },
          });
        }
      });
    }
  } catch (e) { /* CSSOM non redéfinissable : ignore */ }

  // 6. Web Worker de l'IA. Après un coup, Jocly fait
  //    new Worker(config.baseURL+'jocly.aiworker.js') (StartThreadedMachine),
  //    puis DANS le worker : importScripts(baseURL+"jocly.core.js") (absolu)
  //    et des importScripts RELATIFS — "jocly-allgames.js", "jocly.game.js",
  //    "games/<module>/<jeu>-model.js" (WorkerCreateGame, jocly.core.js) —
  //    résolus contre l'URL du worker. On ne peut PAS rediriger l'URL du
  //    worker vers tabulon-dist:// : un Worker doit être SAME-ORIGIN avec sa
  //    page (SecurityError sinon → l'IA reste sur "réflexion"). On crée donc
  //    un worker "shim" same-origin (blob:) qui remappe ses importScripts
  //    vers le dist externe puis charge le vrai jocly.aiworker.js depuis
  //    celui-ci. importScripts cross-origin est permis pour les workers
  //    classiques (no-cors) ; sous COEP require-corp, le protocole doit
  //    renvoyer Cross-Origin-Resource-Policy: cross-origin (fait dans
  //    dist_override.rs).
  //    Portée volontairement limitée à jocly.aiworker.js : les workers
  //    fairy/scan chargent du WASM par fetch relatif, incompatible avec une
  //    base blob: — ils restent sur l'embarqué (comportement inchangé).
  try {
    var _Worker = window.Worker;
    if (_Worker && window.Blob && window.URL && window.URL.createObjectURL) {
      var makeAiWorkerShim = function (entry) {
        var body = '(' + function (PROTO, ENTRY) {
          var _is = self.importScripts;
          function map(u) {
            var s = String(u);
            if (/^(blob|data):/.test(s)) return s;
            // Absolu avec scheme → réduire au pathname pour traitement unifié.
            var m = s.match(/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\/]*(\/.*)$/);
            if (m) s = m[1];
            else if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(s)) return String(u); // autre scheme (file:…)
            // Racine-absolu : c'est la forme RÉELLE de config.baseURL — Jocly
            // calcule sa baseURL via new URL(scriptDir).pathname ("/browser/"),
            // donc le worker reçoit importScripts("/browser/jocly.core.js").
            if (s.charAt(0) === '/') {
              var p = s.replace(/^\/+/, '');
              return /^(browser|games)\//.test(p) ? PROTO + p : String(u);
            }
            // Relatif ("jocly-allgames.js", "games/…-model.js") : la base
            // d'origine du worker était browser/ (le worker shim étant un
            // blob:, un relatif ne se résoudrait pas du tout).
            return PROTO + 'browser/' + s.replace(/^\.\//, '');
          }
          self.importScripts = function () {
            var args = Array.prototype.map.call(arguments, map);
            return _is.apply(self, args);
          };
          _is.call(self, ENTRY);
        }.toString() + ')(' + JSON.stringify(PROTO) + ',' + JSON.stringify(entry) + ');';
        return URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
      };
      window.Worker = function (url, opts) {
        var s = (typeof url === 'string') ? url : String(url || '');
        if (/(^|\/)browser\/jocly\.aiworker\.js(\?|$)/.test(s)) {
          var d = toDist(s);
          if (d) return new _Worker(makeAiWorkerShim(d), opts);
        }
        return new _Worker(url, opts);
      };
      window.Worker.prototype = _Worker.prototype;
    }
  } catch (e) { /* Worker/Blob non disponibles : ignore */ }

  // 7. <link>.href assigné en JS AVANT insertion (CSS de module, ex.
  //    chessbase.css : Jocly crée le <link rel=stylesheet> dynamiquement).
  //    Le MutationObserver ne voit le nœud qu'À l'insertion, et son callback
  //    est asynchrone : la webview a déjà lancé la requête sur l'URL d'origine
  //    (embarqué) → 500 si le fichier n'existe que dans le dist externe. En
  //    réécrivant au setter, l'URL est déjà la bonne au moment de l'insertion.
  try {
    var lproto = window.HTMLLinkElement && window.HTMLLinkElement.prototype;
    var ldesc = lproto && Object.getOwnPropertyDescriptor(lproto, 'href');
    if (ldesc && ldesc.set) {
      Object.defineProperty(lproto, 'href', {
        configurable: true, enumerable: ldesc.enumerable,
        get: function () { return ldesc.get.call(this); },
        set: function (v) {
          var d = (typeof v === 'string') && toDist(v);
          ldesc.set.call(this, d || v);
        },
      });
    }
  } catch (e) { /* non redéfinissable : ignore */ }

  // 8. setAttribute('href'/'src', …). C'est la voie RÉELLE des CSS de module :
  //    JocGame.LoadCss (jocly.game.js) fait
  //    style.setAttribute("href", fullPath+"/"+css) — ni le setter .href ni le
  //    parse HTML ne sont impliqués, et le MutationObserver ne corrige qu'APRÈS
  //    l'insertion, alors que la webview a déjà lancé la requête sur l'embarqué
  //    (→ 500 en console sur chessbase.css avant le refetch corrigé). En
  //    réécrivant dès setAttribute, l'URL est bonne AVANT l'insertion : plus
  //    aucune requête ne part sur l'embarqué.
  try {
    var _setAttribute = window.Element.prototype.setAttribute;
    window.Element.prototype.setAttribute = function (name, value) {
      try {
        var n = String(name).toLowerCase();
        var t = this.tagName;
        if (n === 'style' && typeof value === 'string' && value.indexOf('url(') !== -1) {
          value = rewriteCssText(value);   // style inline avec une image de fond
        } else if ((n === 'href' && t === 'LINK') ||
            (n === 'src' && (t === 'IMG' ||
              (t === 'SCRIPT' && !/(^|\/)browser\/jocly\.js(\?|$)/.test(String(value)))))) {
          var d = toDist(value);
          if (d) {
            if (t === 'IMG') { try { if (!this.crossOrigin) this.crossOrigin = 'anonymous'; } catch (e2) {} }
            value = d;
          }
        }
      } catch (e3) { /* valeur non-string, etc. : laisser passer */ }
      return _setAttribute.call(this, name, value);
    };
  } catch (e) { /* non redéfinissable : ignore */ }
}
__applyDistRewrite();
