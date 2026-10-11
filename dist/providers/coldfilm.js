const BASE_URL = 'https://coldfilm.press';
const TMDB_API_URL = 'https://api.themoviedb.org/3';
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 10; Android TV) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const COMMON_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7'
};

function decodeHtml(value) {
  const entities = {
    amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' '
  };
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => entities[name.toLowerCase()] || match)
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(value) {
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' '));
}

function normalizeTitle(value) {
  return stripTags(value)
    .toLowerCase()
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSearchResults(html) {
  const results = [];
  const pattern = /<a[^>]+class=["'][^"']*sres-wrap[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(String(html || ''))) !== null) {
    const heading = match[2].match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = stripTags(heading ? heading[1] : match[2]);
    if (!title || !match[1].includes('/news/')) continue;
    results.push({
      title,
      url: match[1].startsWith('http') ? match[1] : BASE_URL + match[1]
    });
  }
  return results;
}

function chooseSearchResult(results, title, mediaType, season, episode) {
  const wantedTitle = normalizeTitle(title);
  const wantedSeason = Number(season || 0);
  const wantedEpisode = Number(episode || 0);
  const ranked = results.map((item) => {
    const normalized = normalizeTitle(item.title);
    let score = normalized.startsWith(wantedTitle) ? 100 : 0;
    if (normalized.includes(wantedTitle)) score += 40;
    if (mediaType === 'tv') {
      if (new RegExp('(?:^| )' + wantedSeason + ' сезон(?: |$)', 'i').test(normalized)) score += 30;
      if (new RegExp('(?:^| )' + wantedEpisode + '(?: серия| серии| эпизод)(?: |$)', 'i').test(normalized)) score += 20;
    }
    return { item, score };
  }).filter((entry) => entry.score > 0);

  ranked.sort((a, b) => b.score - a.score);
  return ranked.length ? ranked[0].item : null;
}

function parseIframeUrls(html, pageUrl) {
  const urls = [];
  const pattern = /<iframe[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(String(html || ''))) !== null) {
    let value = decodeHtml(match[1]);
    if (value.startsWith('//')) value = 'https:' + value;
    else if (value.startsWith('/')) value = BASE_URL + value;
    if (/^https?:\/\//i.test(value)) urls.push({ url: value, pageUrl });
  }
  return urls;
}

function parsePlayerPlaylist(html) {
  const match = String(html || '').match(/\bfile\s*:\s*(\[\{[\s\S]*?\}\])\s*,\s*embed\s*:/i);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function episodeMatches(comment, season, episode) {
  const value = String(comment || '');
  const s = String(Number(season || 0)).padStart(2, '0');
  const e = String(Number(episode || 0)).padStart(2, '0');
  return new RegExp('S0*' + Number(s) + 'E0*' + Number(e) + '(?:\\D|$)', 'i').test(value) ||
    new RegExp('(?:^|\\D)' + Number(season) + 'x0*' + Number(episode) + '(?:\\D|$)', 'i').test(value);
}

function qualityStreams(item, iframeUrl) {
  const streams = [];
  const pattern = /\[([^\]]+)](https?:\/\/[^,\s]+)/gi;
  let match;
  while ((match = pattern.exec(String(item.file || ''))) !== null) {
    const quality = match[1].trim();
    const url = match[2].trim();
    streams.push({
      name: 'ColdFilm',
      title: String(item.comment || 'ColdFilm'),
      url,
      quality,
      language: 'ru',
      headers: {
        'User-Agent': USER_AGENT,
        Referer: iframeUrl
      }
    });
  }
  return streams;
}

function parseTorrentLinks(html, pageUrl) {
  const streams = [];
  const pattern = /<a[^>]+href=["']([^"']+\.torrent(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(String(html || ''))) !== null) {
    const label = stripTags(match[2]);
    const qualityMatch = label.match(/\b(\d{3,4}p)\b/i) || match[1].match(/\b(\d{3,4}p)\b/i);
    if (!qualityMatch) continue;
    streams.push({
      url: match[1].startsWith('http') ? match[1] : new URL(match[1], pageUrl).href,
      quality: qualityMatch[1].toLowerCase()
    });
  }
  return streams;
}

function skipBencode(bytes, start) {
  const marker = bytes[start];
  if (marker === 0x69) {
    const end = bytes.indexOf(0x65, start + 1);
    if (end < 0) throw new Error('Некорректное целое число в torrent');
    return end + 1;
  }
  if (marker === 0x6c || marker === 0x64) {
    let offset = start + 1;
    while (bytes[offset] !== 0x65) {
      if (offset >= bytes.length) throw new Error('Незавершенный список или словарь в torrent');
      if (marker === 0x64) offset = skipBencode(bytes, offset);
      offset = skipBencode(bytes, offset);
    }
    return offset + 1;
  }
  if (marker >= 0x30 && marker <= 0x39) {
    let colon = start;
    while (bytes[colon] !== 0x3a) {
      if (colon >= bytes.length) throw new Error('Некорректная строка в torrent');
      colon += 1;
    }
    let length = 0;
    for (let index = start; index < colon; index += 1) length = length * 10 + bytes[index] - 0x30;
    const end = colon + 1 + length;
    if (end > bytes.length) throw new Error('Строка выходит за границы torrent');
    return end;
  }
  throw new Error('Неизвестный тип bencode');
}

function readBencodeString(bytes, start) {
  let colon = start;
  while (bytes[colon] !== 0x3a) {
    if (colon >= bytes.length) throw new Error('Некорректный ключ torrent');
    colon += 1;
  }
  let length = 0;
  for (let index = start; index < colon; index += 1) length = length * 10 + bytes[index] - 0x30;
  const valueStart = colon + 1;
  const valueEnd = valueStart + length;
  let value = '';
  for (let index = valueStart; index < valueEnd; index += 1) value += String.fromCharCode(bytes[index]);
  return { value, end: valueEnd };
}

function torrentInfoBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x64) throw new Error('Torrent не является bencode-словарем');
  let offset = 1;
  while (bytes[offset] !== 0x65) {
    const key = readBencodeString(bytes, offset);
    const valueStart = key.end;
    const valueEnd = skipBencode(bytes, valueStart);
    if (key.value === 'info') return bytes.slice(valueStart, valueEnd);
    offset = valueEnd;
  }
  throw new Error('В torrent отсутствует словарь info');
}

function sha1Hex(bytes) {
  const inputLength = bytes.length;
  const paddedLength = Math.ceil((inputLength + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[inputLength] = 0x80;
  const bitLength = inputLength * 8;
  for (let index = 0; index < 8; index += 1) {
    data[paddedLength - 1 - index] = Math.floor(bitLength / Math.pow(256, index)) & 0xff;
  }
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);
  const rotateLeft = (value, shift) => (value << shift) | (value >>> (32 - shift));
  for (let block = 0; block < data.length; block += 64) {
    for (let index = 0; index < 16; index += 1) {
      const position = block + index * 4;
      words[index] = ((data[position] << 24) | (data[position + 1] << 16) |
        (data[position + 2] << 8) | data[position + 3]) >>> 0;
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index += 1) {
      let f;
      let k;
      if (index < 20) {
        f = (b & c) | ((~b) & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temporary = (rotateLeft(a, 5) + f + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30) >>> 0;
      b = a;
      a = temporary;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((value) => value.toString(16).padStart(8, '0')).join('');
}

async function torrentStreams(html, pageUrl) {
  const links = parseTorrentLinks(html, pageUrl).sort((left, right) =>
    Number.parseInt(right.quality, 10) - Number.parseInt(left.quality, 10));
  const streams = [];
  for (const link of links) {
    try {
      const response = await fetch(link.url, { headers: { ...COMMON_HEADERS, Referer: pageUrl } });
      if (!response.ok) continue;
      const hash = sha1Hex(torrentInfoBytes(await response.arrayBuffer()));
      streams.push({
        name: 'ColdFilm P2P',
        title: 'ColdFilm ' + link.quality,
        url: 'torrent:' + hash,
        infoHash: hash,
        quality: link.quality,
        language: 'ru'
      });
    } catch (error) {
      console.warn('[ColdFilm] Не удалось обработать ' + link.quality + ' torrent: ' +
        (error && error.message ? error.message : String(error)));
    }
  }
  return streams;
}

async function fetchText(url, headers) {
  const response = await fetch(url, { headers: { ...COMMON_HEADERS, ...(headers || {}) } });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.text();
}

async function resolveTitle(tmdbId, mediaType) {
  const type = mediaType === 'movie' ? 'movie' : 'tv';
  if (typeof TMDB_API_KEY === 'undefined' || !TMDB_API_KEY) throw new Error('Ключ TMDB недоступен');
  const url = TMDB_API_URL + '/' + type + '/' + encodeURIComponent(tmdbId) +
    '?api_key=' + encodeURIComponent(TMDB_API_KEY) + '&language=ru-RU';
  const response = await fetch(url, { headers: COMMON_HEADERS });
  if (!response.ok) throw new Error('TMDB HTTP ' + response.status);
  const data = await response.json();
  return String(type === 'movie' ? data.title || '' : data.name || '').trim();
}

async function searchColdFilm(query) {
  const url = BASE_URL + '/search/?q=' + encodeURIComponent(query);
  try {
    return parseSearchResults(await fetchText(url, { Referer: BASE_URL + '/' }));
  } catch (error) {
    await fetchText(BASE_URL + '/');
    return parseSearchResults(await fetchText(url, { Referer: BASE_URL + '/' }));
  }
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const title = await resolveTitle(tmdbId, mediaType);
    if (!title) return [];

    const query = mediaType === 'tv'
      ? title + ' ' + Number(season) + ' сезон ' + Number(episode) + ' серия'
      : title;
    const results = await searchColdFilm(query);
    const selected = chooseSearchResult(results, title, mediaType, season, episode);
    if (!selected) return [];

    const pageHtml = await fetchText(selected.url, { Referer: BASE_URL + '/' });
    const p2pStreams = await torrentStreams(pageHtml, selected.url);
    const iframes = parseIframeUrls(pageHtml, selected.url)
      .filter((entry) => /secvideo/i.test(entry.url));

    for (const iframe of iframes) {
      const iframeHtml = await fetchText(iframe.url, { Referer: selected.url });
      const playlist = parsePlayerPlaylist(iframeHtml);
      const matching = mediaType === 'tv'
        ? playlist.filter((item) => episodeMatches(item.comment, season, episode))
        : playlist.slice(0, 1);
      const streams = matching.flatMap((item) => qualityStreams(item, iframe.url));
      if (streams.length) return p2pStreams.concat(streams);
    }
    return p2pStreams;
  } catch (error) {
    console.error('[ColdFilm] ' + (error && error.message ? error.message : String(error)));
    return [];
  }
}

module.exports = {
  getStreams,
  __test: {
    parseSearchResults,
    chooseSearchResult,
    parseIframeUrls,
    parsePlayerPlaylist,
    episodeMatches,
    qualityStreams,
    parseTorrentLinks,
    torrentInfoBytes,
    sha1Hex,
    normalizeTitle
  }
};
