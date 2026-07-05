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
