// app/content/chat.js
//
// Fenêtre satellite : la conversation d'une partie à distance.
//
// LE FIL VIT DANS play.js, comme l'horloge : c'est lui qui tient le canal
// (RelayChatChannel ou PeerChatChannel), lui qui a la clé, lui qui sait si
// l'adversaire est distant. Cette fenêtre n'affiche et ne demande — même
// partage que clock.js, et pour la même raison : elle peut être fermée et
// rouverte sans que la partie s'en aperçoive.
//
//   requête : emit('play-req:{matchId}:get-chat')
//   réponse : listen('play-rep:{matchId}:get-chat', {conversation, canWrite, sides, chatKey})
//   poussée : listen('play-event:{matchId}:chat', {conversation, canWrite, sides, chatKey})
//   envoi   : emit('play-req:{matchId}:send-chat', {kind, body, quick})
//   lu      : emit('play-req:{matchId}:chat-seen', {id})
//
// C'est cette derniere qui eteint la pastille de la barre de jeu. Elle part
// d'ICI plutot que d'etre deduite la-bas, parce que play.js n'a aucun moyen de
// savoir si cette fenetre est ouverte : Tauri ne previent pas de sa fermeture,
// et une fenetre fermee ne dit rien. Tant qu'elle se tait, les messages sont
// non lus -- ce qui est exactement vrai.
//
// UNE FENÊTRE PLUTÔT QU'UN PANNEAU. Un panneau à gauche du plateau prendrait
// de la place à la seule chose qu'on regarde, et sur un goban 19x19 ou un
// 12x12 c'est cher. Une fenêtre se place où le joueur veut, se redimensionne,
// et se ferme quand la conversation ne sert plus.
import twu from './tabulon-winutils.js';
import { initI18n, t } from './tabulon-i18n.js';
import { listen, emit } from './tauri-bridge.js';

const matchId = (function () {
    const m = /\?.*\bid=([0-9]+)/.exec(window.location.href);
    return m && m[1] || 0;
})();

let sides = { 1: 'A', '-1': 'B' };
let lastRendered = '';

const $ = (id) => document.getElementById(id);

/**
 * Le texte d'un message.
 *
 * Un message rapide voyage comme IDENTIFIANT (`quick`) et se traduit ici :
 * c'est ce qui permet à deux joueurs sans langue commune de se comprendre. Un
 * message libre, lui, est du texte tel quel — c'est le seul qui ait besoin
 * d'être scellé, et le seul que l'autre lira dans la langue où il a été écrit.
 */
function MessageText(m) {
    if (m.locked) {
        // Un message qu'on ne peut pas ouvrir reste VISIBLE : un trou
        // silencieux dans une conversation est pire qu'un cadenas, et la
        // raison distingue « je n'ai pas la clé » de « ce n'est pas la bonne ».
        return t(m.reason === 'unsealed' ? 'chat.lockedUnsealed' : 'chat.locked');
    }
    if (m.quick) return t('chat.' + m.quick);
    return m.body ?? '';
}

function Render(conversation) {
    const thread = $('chat-thread');
    if (!thread) return;
    // Recalculé en entier, mais seulement si quelque chose a changé : le fil
    // d'en face est relu à chaque sondage, et redessiner à chaque tour ferait
    // sauter le défilement sous le curseur du lecteur.
    const stamp = conversation.map(m => m.id).join(',');
    if (stamp === lastRendered) return;
    lastRendered = stamp;

    // Le défilement ne suit que si le lecteur était déjà en bas : le remonter
    // de force pendant qu'il relit un message plus haut est le défaut le plus
    // sûr de toute fenêtre de discussion.
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;

    thread.innerHTML = '';
    for (const m of conversation) {
        const line = document.createElement('div');
        line.className = 'chat-line' + (m.locked ? ' locked' : '');
        const who = document.createElement('span');
        who.className = 'chat-who';
        who.textContent = sides[m.side] ?? '?';
        const text = document.createElement('span');
        text.className = 'chat-text';
        // textContent et non innerHTML : le texte vient d'en face, et un
        // message n'a pas à pouvoir écrire dans cette page.
        text.textContent = MessageText(m);
        const when = document.createElement('span');
        when.className = 'chat-when';
        when.textContent = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        line.append(who, text, when);
        thread.appendChild(line);
    }
    if (atBottom) thread.scrollTop = thread.scrollHeight;
}

/**
 * Ouvre ou ferme la saisie libre.
 *
 * Fermée quand la partie n'a pas de clé : le canal refuserait le message, et
 * laisser taper pour échouer ensuite serait pire. Les messages rapides, eux,
 * restent disponibles — ils ne transportent aucun texte, donc rien à sceller.
 */
/**
 * Ouvre ou ferme la saisie libre, et montre la cle de la partie.
 *
 * LA LIGNE DE CLE EST TOUJOURS LA, et c'est un changement : elle
 * n'apparaissait qu'a celui qui n'avait PAS de cle. Celui qui cree la partie
 * en a une -- tiree au tirage de l'invitation, vivant seulement dans le
 * fragment du lien -- et n'avait donc aucun moyen de la relire ni de la
 * redonner si l'autre ne l'avait pas recue. Les deux joueurs voient desormais
 * la meme chose : la cle si elle existe, de quoi en poser une sinon.
 *
 * L'afficher ne coute rien : elle est deja sur cette machine. Ce qui compte
 * est qu'elle ne parte jamais vers le relai.
 */
/**
 * La liste des cles de communaute, et celle qui sert a cette partie.
 *
 * Elle repond a la question qu'on se pose vraiment quand on ne lit pas son
 * adversaire : « laquelle de mes cles emploie-t-il ? ». La reponse est presque
 * toujours « une que j'ai deja », sous un autre nom -- d'ou une liste plutot
 * qu'un champ a coller.
 *
 * Seuls les noms et les empreintes arrivent ici : les cles restent dans les
 * preferences, la fenetre n'en a pas besoin pour en designer une.
 */
function SetKeyring(keyring, current) {
    const row = $('chat-keyring-row');
    const select = $('chat-keyring');
    if (!row || !select) return;
    row.style.display = keyring.length ? '' : 'none';
    // Pas reconstruite pendant qu'on la deroule : la liste se refermerait
    // sous le curseur a chaque rafraichissement du fil.
    if (document.activeElement === select) return;
    const stamp = keyring.map(k => k.id).join(',') + '|' + (current || '');
    if (stamp === select.dataset.stamp) return;
    select.dataset.stamp = stamp;
    select.innerHTML = '';
    if (!current) {
        // Aucune reconnue : on le dit dans la liste elle-meme, sinon la
        // premiere ligne aurait l'air d'etre celle qui sert.
        const none = document.createElement('option');
        none.value = '';
        none.textContent = t('chat.keyringNone');
        select.appendChild(none);
    }
    for (const entry of keyring) {
        const opt = document.createElement('option');
        opt.value = entry.id;
        // Une cle sans nom reste designable : son empreinte en tient lieu.
        opt.textContent = entry.name || entry.id;
        if (entry.id === current) opt.selected = true;
        select.appendChild(opt);
    }
}

function SetCanWrite(canWrite, chatKey) {
    const input = $('chat-input'), send = $('chat-send'), status = $('chat-status');
    if (input) input.disabled = !canWrite;
    if (send) send.disabled = !canWrite;
    if (status) status.textContent = canWrite ? '' : t('chat.noKey');

    // Les deux boutons ne servent que faute de mieux : quand aucune cle de
    // communaute n'est enregistree, il ne reste qu'a en fabriquer une et a la
    // transmettre a la main. Des qu'un trousseau existe, la liste au-dessus
    // fait le travail, et deux boutons de plus ne feraient qu'inviter a
    // casser ce qui marche.
    const manual = $('chat-key-row');
    if (manual) manual.style.display = ($('chat-keyring')?.options.length ? 'none' : '');

    const field = $('chat-key-input');
    // Pas pendant qu'on la modifie : ecraser une cle a moitie collee serait
    // le plus sur moyen de rendre le champ inutilisable.
    if (field && chatKey && document.activeElement !== field && field.value !== chatKey)
        field.value = chatKey;
    const hint = $('chat-key-hint');
    if (hint) hint.textContent = $('chat-keyring')?.options.length ? t('chat.keyringHint')
        : chatKey ? t('chat.keyMine') : t('chat.keyNone');
}

let conversation = [];

/**
 * Signale que tout ce qui est affiche a ete vu.
 *
 * SEULEMENT SI LA FENETRE EST VISIBLE : reduite ou cachee derriere le plateau,
 * elle affiche bien mais personne ne lit, et eteindre la pastille ferait
 * manquer le message. document.hidden couvre les deux cas.
 */
function MarkSeen() {
    if (document.hidden || !conversation.length) return;
    emit(`play-req:${matchId}:chat-seen`,
        { id: conversation[conversation.length - 1].id }).catch(() => {});
}

function Apply(payload) {
    if (!payload) return;
    if (payload.sides) sides = payload.sides;
    SetKeyring(payload.keyring || [], payload.keyringId || null);
    SetCanWrite(!!payload.canWrite, payload.chatKey || null);
    conversation = payload.conversation || [];
    Render(conversation);
    MarkSeen();
}

document.addEventListener('DOMContentLoaded', async () => {
    await initI18n();
    await twu.init(t('chat.title', { id: matchId }));

    await listen(`play-rep:${matchId}:get-chat`, ({ payload }) => Apply(payload));
    await listen(`play-event:${matchId}:chat`, ({ payload }) => Apply(payload));

    const Send = (msg) => emit(`play-req:${matchId}:send-chat`, msg).catch(
        e => console.warn('[chat] envoi impossible :', e.message || e));

    document.querySelectorAll('[data-quick]').forEach(btn => {
        btn.addEventListener('click', () => Send({ quick: btn.dataset.quick }));
    });

    const input = $('chat-input');
    const SendTyped = () => {
        const body = (input?.value || '').trim();
        if (!body) return;
        input.value = '';
        Send({ body });
    };
    $('chat-send')?.addEventListener('click', SendTyped);
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') SendTyped(); });

    /*
     * Ajouter une cle a une partie qui n'en a pas.
     *
     * « Generer » l'affiche pour qu'on la COPIE et qu'on l'envoie a l'autre
     * joueur par le canal de son choix -- message, courriel, telephone. Elle
     * ne doit surtout pas passer par le relai : il l'aurait, et le
     * chiffrement ne servirait plus a rien. C'est le meme raisonnement que le
     * fragment du lien d'invitation, en manuel.
     *
     * L'autre joueur colle la meme et clique « Utiliser ». Les deux cotes ont
     * alors la meme cle, sans que le serveur l'ait vue passer.
     */
    $('chat-key-new')?.addEventListener('click', async () => {
        const { generateChatKey } = await import('./remote-secret.js');
        const field = $('chat-key-input');
        if (!field) return;
        try { field.value = generateChatKey(); } catch (e) {
            console.warn('[chat] pas de cle :', e.message || e);
            return;
        }
        field.select();
        // Pas appliquee tout de suite : tant que l'autre ne l'a pas, l'appliquer
        // rendrait nos messages illisibles pour lui sans rien dire.
        const status = $('chat-status');
        if (status) status.textContent = t('chat.keyShare');
    });

    $('chat-keyring')?.addEventListener('change', (e) => {
        if (!e.target.value) return;
        emit(`play-req:${matchId}:set-chat-keyring`, { id: e.target.value }).catch(() => {});
    });

    $('chat-key-apply')?.addEventListener('click', () => {
        const key = ($('chat-key-input')?.value || '').trim().toLowerCase();
        emit(`play-req:${matchId}:set-chat-key`, { key }).catch(() => {});
    });

    // Revenir sur la fenetre vaut lecture : un message arrive pendant qu'elle
    // etait cachee doit eteindre la pastille des qu'on la regarde, sans avoir
    // a cliquer dedans.
    document.addEventListener('visibilitychange', MarkSeen);
    window.addEventListener('focus', MarkSeen);

    await emit(`play-req:${matchId}:get-chat`, {});
    await twu.ready();
});
