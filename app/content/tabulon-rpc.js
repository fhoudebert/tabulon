// app/content/tabulon-rpc.js
//
// Remplace intégralement rpc.js (Electron ipcRenderer/ipcMain).
//
// Trois patterns couverts :
//   1. renderer → Rust   : tRpc.call("commandName", arg1, arg2, ...)
//   2. Rust → renderer   : tRpc.listen({ eventName: handler })
//   3. Fenêtre → fenêtre : via relay_to_window (côté Rust)

import { invoke, listen, emit, getCurrentWindow } from './tauri-bridge.js';

// ── Niveau de debug (0=off, 1=erreurs, 2=tout) ───────────────────────────────
let debugLevel = 0;

// ── Registre des unlisten Tauri (pour cleanup) ────────────────────────────────
const _listeners = [];

const tRpc = {

  // ── renderer → Rust ──────────────────────────────────────────────────────
  //
  // Usage identique à l'ancien rpc.call("method", arg1, arg2) :
  //   tRpc.call("pause", matchId, true)
  //
  // Tauri 2 : invoke("command_name", { args: [...] })
  // La convention Rust reçoit  fn pause(args: Vec<Value>)  ou des args nommés.
  // On utilise des args nommés car les commandes Rust sont déclarées avec
  // des paramètres individuels (match_id: u32, paused: bool).
  // Pour garder la même API JS, on déstructure selon la commande connue.
  //
  call(method, ...args) {
    if (debugLevel >= 2)
      console.info(`[tRpc] call → ${method}`, args);

    // Mapping des args positionnels vers les paramètres nommés Tauri
    const payload = buildPayload(method, args);

    return invoke(method, payload)
      .then(result => {
        if (debugLevel >= 2)
          console.info(`[tRpc] call ← ${method}`, result);
        return result;
      })
      .catch(err => {
        if (debugLevel >= 1)
          console.error(`[tRpc] call ✗ ${method}`, err);
        throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
      });
  },

  // ── Rust → ce renderer ───────────────────────────────────────────────────
  //
  // Usage identique à l'ancien rpc.listen({ method: fn }) :
  //   tRpc.listen({ humanTurn: (data) => { ... } })
  //
  listen(handlers) {
    for (const [event, fn] of Object.entries(handlers)) {
      listen(event, ({ payload }) => {
        if (debugLevel >= 2)
          console.info(`[tRpc] event ← ${event}`, payload);
        // Le payload peut être un tableau (ancienne convention _args) ou un objet
        try {
          if (Array.isArray(payload))
            fn(...payload);
          else
            fn(payload);
        } catch (e) {
          console.error(`[tRpc] handler error in ${event}:`, e);
        }
      }).then(unlisten => _listeners.push(unlisten));
    }
  },

  // ── Cleanup (appeler à la fermeture de la fenêtre) ───────────────────────
  destroy() {
    _listeners.forEach(u => u());
    _listeners.length = 0;
  },

  // ── Fermer la fenêtre courante ────────────────────────────────────────────
  close() {
    return getCurrentWindow().close();
  },

  // ── Debug ─────────────────────────────────────────────────────────────────
  setDebug(level) {
    debugLevel = level;
  }
};

// ── Mapping args positionnels → paramètres nommés Tauri ──────────────────────
//
// Les commandes Rust ont des paramètres nommés (snake_case).
// Tauri 2 sérialise les noms en camelCase côté JS → snake_case côté Rust.
// On liste ici tous les mappings connus.
//
function buildPayload(method, args) {
  const map = {
    // match lifecycle
    new_match:           ([gameName, clock, forkId, inviteId]) => ({ gameName, clock: clock || null, forkId: forkId || null, inviteId: inviteId || null }),
    // history
    // players
    // clock
    open_clock:          ([matchId])               => ({ matchId }),
    // view
    // favorites
    is_favorite:         ([gameName])              => ({ gameName }),
    set_favorite:        ([gameName, value])       => ({ gameName, value }),
    // moves
    // windows
    open_history:        ([matchId])               => ({ matchId }),
    open_players:        ([matchId])               => ({ matchId }),
    open_view_options:   ([matchId])               => ({ matchId }),
    open_camera_view:    ([matchId, gameName])     => ({ matchId, gameName }),
    open_save_template:  ([matchId])               => ({ matchId }),
    open_info:           ([gameName])              => ({ gameName }),
    open_invitation:     ([gameName])              => ({ gameName }),
    open_clock_setup:    ([gameName])              => ({ gameName }),
    open_board_state:    ([gameName, matchId])     => ({ gameName, matchId }),
    open_book:           ([gameName, fn_, data])   => ({ gameName, fileName: fn_, data }),
    open_moves:          ([matchId])               => ({ matchId }),
    relay_to_window:     ([target, event, payload])=> ({ target, event, payload }),
    // fichiers
    parse_pjn:           ([data])                  => ({ data }),
    open_show_position:  ([gameName, matchId])     => ({ gameName, matchId }),
    // templates
    play_template:       ([templateName])          => ({ templateName }),
    save_template:       ([matchId, name, data])   => ({ matchId, name, data }),
    is_template_name_valid: ([name])               => ({ name }),
    // video
    start_recording:     ([matchId])               => ({ matchId }),
    record_frame:        ([matchId, snapshot])     => ({ matchId, snapshot }),
    stop_recording:      ([matchId])               => ({ matchId }),
    // hub
    get_app_info:        ()                             => ({}),
    remove_template:     ([templateName])              => ({ templateName }),
    notify_user_response:([token, result])             => ({ token, result }),
    // windows — hub actions
    open_position:       ([gameName, matchId])         => ({ gameName, matchId }),
    // extensions
    open_extensions:     ()                        => ({}),
    get_dist_info:       ()                        => ({}),
    list_extension_games:()                        => ({}),
    export_extension:    ([gameName, destPath])    => ({ gameName, destPath }),
    import_extension:    ([srcPath])               => ({ srcPath }),
    remove_extension:    ([gameName])              => ({ gameName }),
    export_module:       ([moduleName, destPath])  => ({ moduleName, destPath }),
    remove_module:       ([moduleName])            => ({ moduleName }),
    // fs
    read_text_file:      ([path])                  => ({ path }),
    save_text_file:      ([path, contents])        => ({ path, contents }),
    save_data_uri_file:  ([path, dataUri])         => ({ path, dataUri }),
    // camera
    // notify
    notify_user:         ([request])               => ({ request }),
  };

  const builder = map[method];
  if (!builder) {
    console.warn(`[tRpc] no payload map for "${method}", passing raw args`);
    return { args };
  }
  return builder(args);
}

export default tRpc;
