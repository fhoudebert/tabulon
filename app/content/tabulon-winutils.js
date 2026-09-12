// app/content/tabulon-winutils.js
//
// Remplace joclyboard-winutils.js.
// Supprime @electron/remote, os, ipcRenderer.
//
// jbwu.init(title, header?)  →  twu.init(title, header?)
// jbwu.ready()               →  twu.ready()

import { platform, getCurrentWindow, emit } from './tauri-bridge.js';

const twu = {

  /**
   * Initialise le titre de la fenêtre.
   * Sur macOS : injecte une titlebar HTML (comme l'original).
   * Ailleurs  : met à jour document.title.
   *
   * @param {string} title   Titre à afficher
   * @param {string} header  Sélecteur CSS optionnel d'un header déjà présent
   */
  async init(title, header) {
    let os;
    try {
      os = await platform();
    } catch {
      os = 'unknown';
    }

    if (os === 'macos') {
      if (header) {
        const el = document.querySelector(header);
        if (el) {
          el.classList.remove('hidden');
          const h1 = el.querySelector('h1');
          if (h1) h1.textContent = title;
        }
      } else {
        const header = document.createElement('header');
        header.className = 'toolbar toolbar-header';
        const h1 = document.createElement('h1');
        h1.className = 'title';
        h1.textContent = title;
        header.appendChild(h1);
        const win = document.querySelector('.window');
        if (win) win.prepend(header);
      }
    } else {
      document.title = title;
    }

    /*
     * ET LA BARRE DE TITRE DU SYSTEME, qui est une autre chose.
     *
     * Ces fenetres sont creees cote Rust (window_cmds.rs) avec un titre ecrit
     * en dur -- « Players #3 », « History #3 » -- et, contrairement a un
     * onglet de navigateur, un document.title change dans la webview ne
     * remonte pas jusqu'a la decoration de la fenetre. Le titre traduit
     * s'affichait donc a l'interieur et l'anglais restait autour : la barre
     * des taches et le gestionnaire de fenetres ne connaissaient que celui-la.
     *
     * Rust ne peut pas ecrire le bon : il faudrait y dupliquer le
     * dictionnaire. C'est donc la fenetre elle-meme qui se renomme, une fois,
     * au moment ou elle sait ce qu'elle affiche.
     *
     * Silencieux en cas d'echec : un titre en anglais est un defaut
     * d'affichage, pas une raison d'empecher une fenetre de s'ouvrir.
     */
    try {
      const win = getCurrentWindow();
      if (win && typeof win.setTitle === 'function') await win.setTitle(title);
    } catch (e) {
      console.warn('[winutils] setTitle:', e);
    }
  },

  /**
   * Signale au processus principal que cette fenêtre est prête.
   * Remplace : remote.getCurrentWebContents().emit("joclyboard-window-ready")
   *
   * Le Rust écoute l'événement "window-ready" et résout la promesse
   * équivalente de createWindowPromise().
   */
  async ready() {
    const win = getCurrentWindow();
    await emit('window-ready', { label: win.label });
  }
};

export default twu;
