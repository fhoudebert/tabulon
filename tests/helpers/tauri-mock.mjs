// tests/helpers/tauri-mock.mjs — complete un faux window.__TAURI__ pour les
// suites jsdom.
//
// POURQUOI. Les pages de test sont servies sous une URL Tauri
// (https://tauri.localhost/...), donc tauri-bridge.js ATTEND l'injection
// complete (isTauriInjected : core, event, window, webviewWindow, shell,
// dialog, store, os) avant d'evaluer la page. Un mock qui n'en simule qu'une
// partie faisait attendre chaque suite jusqu'au delai de garde de 8 s, puis
// ecrire une erreur en console : ~8,5 s perdues par suite, 24 suites.
//
// Les espaces que le mock ne simule pas sont remplaces par un objet dont
// chaque methode LEVE une erreur explicite a l'appel -- exactement ce qui se
// passait apres le delai (TypeError sur undefined), mais sans l'attente et
// avec un message qui nomme ce qui manque. Rien de ce que le mock fournit
// n'est modifie.
const NAMESPACES = ['core', 'event', 'window', 'webviewWindow', 'shell', 'dialog', 'store', 'os'];

function unsimulated(ns) {
    return new Proxy({}, {
        get(_t, prop) {
            // Ni thenable (un `await` dessus doit rendre l'objet), ni symbole.
            if (prop === 'then' || typeof prop === 'symbol') return undefined;
            return () => { throw new Error(`mock Tauri : ${ns}.${String(prop)} non simulé`); };
        },
    });
}

export function completeTauriInjection(mock) {
    for (const ns of NAMESPACES) {
        if (!mock[ns]) mock[ns] = unsimulated(ns);
    }
    return mock;
}
