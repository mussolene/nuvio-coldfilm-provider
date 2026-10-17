const test = require('node:test');
const assert = require('node:assert/strict');
const { getStreams, __test } = require('./index');

test('выбирает запрошенную серию из результатов поиска', () => {
    const html = `
      <a class="sres-wrap clearfix" href="/news/old"><h2>Ковчег 2 сезон 1 серия [Смотреть Онлайн]</h2></a>
      <a class="sres-wrap clearfix" href="/news/new"><h2><b>Ковчег</b> 3 сезон 11 серия [Смотреть Онлайн]</h2></a>`;
    const results = __test.parseSearchResults(html);
    const selected = __test.chooseSearchResult(results, 'Ковчег', 'tv', 3, 11);
    assert.equal(selected.url, 'https://coldfilm.press/news/new');
});

test('извлекает нужный эпизод и варианты качества', () => {
    const playlist = [
      { comment: 'The.Ark.S03E11.720p.ColdFilm', file: '[720p]https://video.test/720.mp4,[360p]https://video.test/360.mp4' },
      { comment: 'The.Ark.S03E10.720p.ColdFilm', file: '[720p]https://video.test/other.mp4' }
    ];
    const html = '<script>new Playerjs({file:' + JSON.stringify(playlist) + ',embed:"x"})</script>';
    const parsed = __test.parsePlayerPlaylist(html);
    const item = parsed.find((entry) => __test.episodeMatches(entry.comment, 3, 11));
    const streams = __test.qualityStreams(item, 'https://secvideo.test/embed');
    assert.deepEqual(streams.map((stream) => stream.quality), ['720p', '360p']);
    assert.equal(streams.every((stream) => stream.headers.Referer.includes('secvideo')), true);
});

test('извлекает 1080p torrent и вычисляет его info hash', () => {
    const pageUrl = 'https://coldfilm.press/news/example';
    const html = '<a href="/t13/Example.S01E01.1080p.mkv.torrent">Скачать Torrent [1080p]</a>';
    assert.deepEqual(__test.parseTorrentLinks(html, pageUrl), [{
        url: 'https://coldfilm.press/t13/Example.S01E01.1080p.mkv.torrent',
        quality: '1080p'
    }]);

    const torrent = Buffer.from('d4:infod4:name4:testee');
    const info = __test.torrentInfoBytes(torrent);
    assert.equal(Buffer.from(info).toString(), 'd4:name4:teste');
    assert.equal(__test.sha1Hex(info), '1ade8a1a581f338e4fce4ce784da3f7d03f81f3a');
});

test('собирает 1080p P2P и прямые варианты одной серии', async (context) => {
    const originalFetch = global.fetch;
    global.TMDB_API_KEY = 'test-key';
    const torrent = Buffer.from('d4:infod4:name4:testee');
    global.fetch = async (url) => {
        if (url.includes('api.themoviedb.org')) {
            return { ok: true, status: 200, json: async () => ({ name: 'Ковчег' }) };
        }
        if (url.includes('/search/')) {
            return {
                ok: true,
                status: 200,
                text: async () => '<a class="sres-wrap" href="/news/ark"><h2>Ковчег 3 сезон 11 серия</h2></a>'
            };
        }
        if (url.endsWith('/news/ark')) {
            return {
                ok: true,
                status: 200,
                text: async () => '<a href="/t13/ark.1080p.torrent">Torrent [1080p]</a>' +
                    '<iframe src="https://secvideo1.online/playlist_iframe/1/"></iframe>'
            };
        }
        if (url.endsWith('.torrent')) {
            return { ok: true, status: 200, arrayBuffer: async () => torrent };
        }
        if (url.includes('secvideo1.online')) {
            return {
                ok: true,
                status: 200,
                text: async () => '<script>new Playerjs({file:[{"comment":"The.Ark.S03E11.720p.ColdFilm",' +
                    '"file":"[720p]https://video.test/720.mp4,[360p]https://video.test/360.mp4"}],embed:"x"})</script>'
            };
        }
        throw new Error('Неожиданный URL: ' + url);
    };
    context.after(() => {
        global.fetch = originalFetch;
        delete global.TMDB_API_KEY;
    });

    const streams = await getStreams('123', 'tv', 3, 11);
    assert.deepEqual(streams.map((stream) => stream.quality), ['1080p', '720p', '360p']);
    assert.equal(streams[0].url, 'torrent:1ade8a1a581f338e4fce4ce784da3f7d03f81f3a');
});


test('различает одноименные сериалы по году премьеры и букве ё', () => {
    const results = [
        { title: 'Темная материя 2 сезон 3 серия', url: 'https://coldfilm.press/news/old/2016-07-15-4981' },
        { title: 'Тёмная материя 2 сезон 3 серия', url: 'https://coldfilm.press/news/new/2026-09-11-41815' }
    ];
    assert.equal(__test.chooseSearchResult(results, 'Темная материя', 'tv', 2, 3, 2024).url, results[1].url);
    assert.equal(__test.chooseSearchResult(results, 'Темная материя', 'tv', 2, 3, 2015).url, results[0].url);
    assert.equal(__test.chooseSearchResult(results, 'Другой сериал', 'tv', 2, 3, 2024), null);
});
