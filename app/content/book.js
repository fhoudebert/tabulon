// app/content/book.js
import tRpc from './tabulon-rpc.js';
import twu  from './tabulon-winutils.js';

const gameName = (function () {
    const m = /\?.*\bgame=([^&]+)/.exec(window.location.href);
    return m && m[1] || 'classic-chess';
})();
const fileName = (function () {
    const m = /\?.*\bfile=([^&]+)/.exec(window.location.href);
    if (m && m[1]) {
        const f = decodeURIComponent(m[1]);
        return /([^/\\]*)$/.exec(f)[1];
    }
    return 'PJN';
})();

function SetBookMatches(matches) {
    const list = document.querySelector('.book-content ul');
    matches.forEach((match) => {
        const li = document.createElement('li');
        li.className = 'list-group-item object-list-item';
        li.innerHTML = `<div class="media-body"><strong>${match.label}</strong></div>`;
        li.addEventListener('click', () => tRpc.call('open_book_match', gameName, match));
        list.appendChild(li);
    });
    document.querySelector('.book-content .message').style.display = 'none';
    list.style.display = '';
}

tRpc.listen({
    setBookMatches: SetBookMatches,
    error: (error) => {
        document.querySelector('.book-content ul').style.display = 'none';
        const msg = document.querySelector('.book-content .message > div > div');
        msg.textContent = error;
        msg.style.display = '';
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    const config = await Jocly.getGameConfig(gameName);
    await twu.init(config.model['title-en'] + ' Book - ' + fileName);
    setTimeout(() => twu.ready(), 0);
});
