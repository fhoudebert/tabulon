// app/content/book-history.js
//
// PJNParser.js est chargé via <script src="../PJNParser.js"> AVANT ce module ES.
// Ce fichier CommonJS expose module.exports.parser — le HTML contient un shim
// minimaliste pour le rendre accessible comme window.PJNParser.
// jocly-pjn (jQuery plugin) est chargé via <script> tag et utilise window.PJNParser.
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';

const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || 0;
})();

tRpc.listen({
    setMatchData: (data) => {
        try {
            // jocly-pjn expose un plugin jQuery chargé via <script> tag
            if (typeof $ === 'undefined' || typeof $.fn.joclyPJN === 'undefined') {
                console.error('joclyPJN plugin not loaded');
                return;
            }
            $('#pjn').joclyPJN({
                data: data.text,
                simpleHighlight: true,
                appletAction: function (command) {
                    if (command === 'view') {
                        const spec = arguments[2];
                        tRpc.call('book_history_view', matchId, spec);
                    }
                }
            });
        } catch (e) {
            console.error('setMatchData error:', e.message);
        }
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    await twu.init('Book #' + matchId);
    twu.ready();
});
