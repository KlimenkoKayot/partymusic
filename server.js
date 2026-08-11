const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { performance } = require('perf_hooks');

// Монотонные «серверные часы»: не прыгают от NTP-коррекции и перевода времени
const nowMs = () => performance.timeOrigin + performance.now();

const TRACK_CHANGE_LEAD_MS = 1200;   // старт нового трека в будущем — все успевают догрузить буфер
const TRACK_CHANGE_MIN_GAP_MS = 300; // микро-антидребезг (двойной клик по одной кнопке)
const STALE_CMD_WINDOW_MS = 1000;    // окно, в котором отбрасываем команды с устаревшим `from`
const AUTO_ADVANCE_GRACE_MS = 250;   // запас перед автопереходом на следующий трек

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ==================== Хранилище ====================
const rooms = new Map();
const trackUrlCache = new Map();

// ==================== ТОКЕН ЯНДЕКС.МУЗЫКИ ====================
const YM_TOKEN = process.env.YM_TOKEN || 'YOUR_TOKEN_HERE';

const YM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Authorization': `OAuth ${YM_TOKEN}`
};

// Очистка каждый час
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.users.size === 0 && now - room.createdAt > 3600000) {
      clearAutoAdvance(room);
      rooms.delete(id);
    }
  }
  for (const [id, data] of trackUrlCache) {
    if (data.expires < now) trackUrlCache.delete(id);
  }
}, 3600000);

// ==================== Яндекс.Музыка API ====================

function ymRequest(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, 'https://api.music.yandex.net');
    const req = https.get(url, { headers: YM_HEADERS, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            console.error('YM API Error:', parsed.error);
            reject(new Error(parsed.error.message || 'API Error'));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: YM_HEADERS, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const PLACEHOLDER_COVER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Crect fill='%231e1e3a' width='200' height='200'/%3E%3Ctext x='100' y='110' text-anchor='middle' fill='%23ff5500' font-size='60' font-family='sans-serif'%3E♪%3C/text%3E%3C/svg%3E";

function formatTrack(track) {
  if (!track) return null;
  const artists = track.artists?.map(a => a.name).join(', ') || 'Unknown';
  const album = track.albums?.[0];
  let cover = PLACEHOLDER_COVER;
  if (album?.coverUri) cover = 'https://' + album.coverUri.replace('%%', '200x200');

  return {
    id: `ym-${track.id}`,
    trackId: String(track.id),
    title: track.title || 'Unknown',
    artist: artists,
    album: album?.title || '',
    duration: track.durationMs ? Math.floor(track.durationMs / 1000) : 0,
    cover,
    available: track.available !== false,
    source: 'yandex'
  };
}

async function getTrackStreamUrl(trackId) {
  try {
    const info = await ymRequest(`/tracks/${trackId}/download-info`);
    if (!info.result?.length) return null;

    const formats = info.result.filter(i => i.codec === 'mp3');
    if (!formats.length) return null;

    const best = formats.sort((a, b) => b.bitrateInKbps - a.bitrateInKbps)[0];
    const xml = await fetchText(best.downloadInfoUrl);

    const host = xml.match(/<host>([^<]+)/)?.[1];
    const xmlPath = xml.match(/<path>([^<]+)/)?.[1];
    const ts = xml.match(/<ts>([^<]+)/)?.[1];
    const s = xml.match(/<s>([^<]+)/)?.[1];
    if (!host || !xmlPath || !ts || !s) return null;

    const sign = crypto.createHash('md5')
      .update(`XGRlBW9FXlekgbPrRHuSiA${xmlPath.slice(1)}${s}`)
      .digest('hex');

    return `https://${host}/get-mp3/${sign}/${ts}${xmlPath}`;
  } catch (e) {
    console.error('getTrackStreamUrl error:', e.message);
    return null;
  }
}

// Кэш подписанных ссылок: 13 минут (Яндекс отдаёт ~15)
async function resolveStreamUrl(trackId, force = false) {
  const cached = trackUrlCache.get(trackId);
  if (!force && cached && cached.expires > Date.now()) return cached.url;
  const url = await getTrackStreamUrl(trackId);
  if (url) trackUrlCache.set(trackId, { url, expires: Date.now() + 780000 });
  return url;
}

// ==================== Логика комнаты ====================

function roomPosition(room) {
  if (!room.isPlaying) return room.position;
  const now = nowMs();
  if (room.startAt && now < room.startAt) return room.position;
  return Math.max(0, room.position + (now - room.referenceTime) / 1000);
}

function currentDuration(room) {
  const t = room.playlist[room.currentTrack];
  return t && t.duration > 0 ? t.duration : 0;
}

function clearAutoAdvance(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

// #4 / #9: автопереход рулит СЕРВЕР. Хост нужен только как fallback,
// когда длительность трека неизвестна (демо-ссылки без duration).
function scheduleAutoAdvance(room) {
  clearAutoAdvance(room);
  if (!room.isPlaying || !room.playlist.length || room.users.size === 0) return;
  const dur = currentDuration(room);
  if (!dur) return;
  const leftMs = (dur - roomPosition(room)) * 1000 + AUTO_ADVANCE_GRACE_MS;
  room.timer = setTimeout(() => {
    room.timer = null;
    autoAdvance(room);
  }, Math.max(0, Math.min(leftMs, 2147483000)));
}

function pickNext(room) {
  if (room.playlist.length < 2) return 0;
  if (room.shuffle) {
    let r;
    do { r = Math.floor(Math.random() * room.playlist.length); } while (r === room.currentTrack);
    return r;
  }
  return (room.currentTrack + 1) % room.playlist.length;
}

function autoAdvance(room) {
  if (!room.isPlaying || !room.playlist.length) return;
  // #9: repeat — повтор текущего трека, форсируем мимо антидребезга
  if (room.repeat) return changeTrack(room, room.currentTrack, true);
  changeTrack(room, pickNext(room), true);
}

function changeTrack(room, index, force = false) {
  if (index < 0 || index >= room.playlist.length) return false;
  const now = nowMs();
  if (!force && now - room.lastChange < TRACK_CHANGE_MIN_GAP_MS) return false;

  room.lastChange = now;
  room.currentTrack = index;
  room.position = 0;
  room.referenceTime = now + TRACK_CHANGE_LEAD_MS;
  room.startAt = room.referenceTime;
  room.rev++;

  io.to(room.id).emit('track-changed', {
    currentTrack: room.currentTrack,
    position: room.position,
    referenceTime: room.referenceTime,
    startAt: room.startAt,
    isPlaying: room.isPlaying,
    rev: room.rev
  });
  scheduleAutoAdvance(room);
  return true;
}

function emitPlaylist(room) {
  io.to(room.id).emit('playlist-updated', {
    playlist: room.playlist,
    currentTrack: room.currentTrack
  });
}

function snapshot(room) {
  return {
    playlist: room.playlist,
    currentTrack: room.currentTrack,
    position: room.position,
    referenceTime: room.referenceTime,
    startAt: room.startAt || 0,
    isPlaying: room.isPlaying,
    shuffle: room.shuffle,
    repeat: room.repeat,
    rev: room.rev,
    hostId: room.hostId,
    serverNow: nowMs()
  };
}

// #4: хост переизбирается и когда протух, и когда комната опустела
function ensureHost(room) {
  if (!room.hostId || !room.users.has(room.hostId)) {
    room.hostId = room.users.size ? room.users.values().next().value : null;
    io.to(room.id).emit('host-changed', room.hostId);
  }
}

// ==================== REST API ====================

app.post('/api/room/create', (req, res) => {
  const roomId = uuidv4().slice(0, 8).toUpperCase();
  rooms.set(roomId, {
    id: roomId, playlist: [], currentTrack: 0,
    position: 0, referenceTime: nowMs(), startAt: 0,
    isPlaying: false, shuffle: false, repeat: false,
    users: new Set(), hostId: null, createdAt: Date.now(),
    lastChange: 0, rev: 0, timer: null
  });
  console.log(`Room created: ${roomId}`);
  res.json({ roomId });
});

app.get('/api/room/:id', (req, res) => {
  const room = rooms.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });
  res.json({ ...snapshot(room), usersCount: room.users.size });
});

app.get('/api/yandex/status', async (req, res) => {
  try {
    const data = await ymRequest('/account/status');
    res.json({
      authorized: true,
      account: data.result?.account?.login || 'unknown',
      plus: data.result?.plus?.hasPlus || false
    });
  } catch (e) {
    res.json({ authorized: false, error: e.message });
  }
});

app.post('/api/yandex/parse', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    let tracks = [];

    const plMatch = url.match(/users\/([^\/]+)\/playlists\/(\d+)/);
    if (plMatch) {
      const data = await ymRequest(`/users/${plMatch[1]}/playlists/${plMatch[2]}`);
      if (data.result?.tracks) {
        tracks = data.result.tracks.map(t => formatTrack(t.track || t)).filter(Boolean);
      }
    }

    const albMatch = url.match(/album\/(\d+)(?!.*\/track)/);
    if (albMatch && !plMatch) {
      const data = await ymRequest(`/albums/${albMatch[1]}/with-tracks`);
      if (data.result?.volumes) {
        for (const vol of data.result.volumes) tracks.push(...vol.map(formatTrack).filter(Boolean));
      }
    }

    const trkMatch = url.match(/album\/\d+\/track\/(\d+)/);
    if (trkMatch) {
      const data = await ymRequest(`/tracks/${trkMatch[1]}`);
      if (data.result?.[0]) tracks = [formatTrack(data.result[0])].filter(Boolean);
    }

    res.json({ tracks, count: tracks.length });
  } catch (e) {
    console.error('Parse error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/yandex/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query required' });
  try {
    const data = await ymRequest(`/search?type=track&text=${encodeURIComponent(q)}&page=0&pageSize=20`);
    const tracks = data.result?.tracks?.results?.map(formatTrack).filter(Boolean) || [];
    res.json({ tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Оставлено для совместимости (сообщает клиенту стабильный URL)
app.get('/api/yandex/track/:id/stream', (req, res) => {
  res.json({ url: `/api/stream/${encodeURIComponent(req.params.id)}` });
});

// ==================== #15: стабильный кэшируемый стрим ====================
// Один и тот же URL для всех клиентов => одинаковое поведение кэша браузера/CDN
// => одинаковое время буферизации => меньше разброса на старте.
const ALLOWED_STREAM_HOST = /(^|\.)(yandex\.net|yandex\.ru|yandexcloud\.net)$/i;

function pipeUpstream(streamUrl, req, res, onExpired) {
  let target;
  try { target = new URL(streamUrl); } catch { return res.status(400).end(); }
  if (target.protocol !== 'https:' || !ALLOWED_STREAM_HOST.test(target.hostname)) {
    return res.status(403).send('Host not allowed');
  }

  const upstream = https.get(target, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      ...(req.headers.range ? { Range: req.headers.range } : {})
    },
    timeout: 30000
  }, (up) => {
    // Подпись протухла — один раз пробуем перевыпустить
    if ((up.statusCode === 403 || up.statusCode === 410) && onExpired) {
      up.resume();
      return onExpired();
    }
    if (res.headersSent) { up.resume(); return; }
    res.writeHead(up.statusCode, {
      'Content-Type': up.headers['content-type'] || 'audio/mpeg',
      ...(up.headers['content-length'] && { 'Content-Length': up.headers['content-length'] }),
      ...(up.headers['content-range'] && { 'Content-Range': up.headers['content-range'] }),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    });
    up.pipe(res);
    res.on('close', () => up.destroy());
  });

  upstream.on('error', (e) => {
    console.error('Stream error:', e.message);
    if (!res.headersSent) res.status(502).send('Upstream error');
    else res.end();
  });
  upstream.on('timeout', () => upstream.destroy());
}

app.get('/api/stream/:id', async (req, res) => {
  const id = String(req.params.id).replace(/[^\w-]/g, '');
  if (!id) return res.status(400).send('Bad id');

  const url = await resolveStreamUrl(id);
  if (!url) return res.status(404).json({ error: 'Track not available' });

  pipeUpstream(url, req, res, async () => {
    const fresh = await resolveStreamUrl(id, true);
    if (!fresh) { if (!res.headersSent) res.status(404).end(); return; }
    pipeUpstream(fresh, req, res, null);
  });
});

// #15: старый прокси закрыт whitelist-ом (был открытый SSRF)
app.get('/api/proxy', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL required');
  pipeUpstream(url, req, res, null);
});

// ==================== WebSocket ====================

io.on('connection', (socket) => {
  let currentRoom = null;
  const getRoom = () => (currentRoom ? rooms.get(currentRoom) : null);

  // Сервер только отвечает монотонным временем; усреднение — на клиенте
  socket.on('clock-sync', (t0) => {
    socket.emit('clock-sync-reply', { t0, serverTime: nowMs() });
  });

  socket.on('join-room', (roomId) => {
    const room = rooms.get(String(roomId || '').toUpperCase());
    if (!room) return socket.emit('error', 'Комната не найдена');

    currentRoom = room.id;
    socket.join(currentRoom);
    room.users.add(socket.id);
    ensureHost(room);

    socket.emit('sync-state', snapshot(room));
    io.to(currentRoom).emit('user-count', room.users.size);
    io.to(currentRoom).emit('host-changed', room.hostId);
    scheduleAutoAdvance(room);
  });

  socket.on('add-tracks', (tracks) => {
    const room = getRoom();
    if (!room || !Array.isArray(tracks)) return;
    room.playlist.push(...tracks);
    emitPlaylist(room);
    scheduleAutoAdvance(room);
  });

  // #7: клиент сообщает реальную длительность (для треков без duration)
  socket.on('report-duration', ({ index, duration } = {}) => {
    const room = getRoom();
    if (!room || typeof index !== 'number' || !(duration > 0)) return;
    const t = room.playlist[index];
    if (!t || t.duration > 0) return;
    t.duration = Math.floor(duration);
    emitPlaylist(room);
    if (index === room.currentTrack) scheduleAutoAdvance(room);
  });

  socket.on('clear-playlist', () => {
    const room = getRoom();
    if (!room) return;
    clearAutoAdvance(room);
    room.playlist = []; room.currentTrack = 0;
    room.position = 0; room.referenceTime = nowMs(); room.startAt = 0;
    room.isPlaying = false; room.rev++;
    io.to(currentRoom).emit('playlist-cleared');
  });

  socket.on('remove-track', (index) => {
    const room = getRoom();
    if (!room || !(index >= 0 && index < room.playlist.length)) return;

    room.playlist.splice(index, 1);

    if (!room.playlist.length) {
      clearAutoAdvance(room);
      room.currentTrack = 0; room.position = 0;
      room.referenceTime = nowMs(); room.startAt = 0; room.isPlaying = false;
      emitPlaylist(room);
      io.to(currentRoom).emit('track-changed', {
        currentTrack: 0, position: 0, referenceTime: room.referenceTime,
        startAt: 0, isPlaying: false, rev: ++room.rev
      });
      return;
    }

    if (index < room.currentTrack) {
      room.currentTrack--;
      emitPlaylist(room);           // #7: индекс уехал — сообщаем клиентам
      scheduleAutoAdvance(room);
    } else if (index === room.currentTrack) {
      if (room.currentTrack >= room.playlist.length) room.currentTrack = 0;
      emitPlaylist(room);
      changeTrack(room, room.currentTrack, true);   // #14: через changeTrack => есть startAt
    } else {
      emitPlaylist(room);
    }
  });

  // Инициатор применяет действие локально сам, поэтому обратно ему не шлём (эхо)
  socket.on('play', ({ position, serverTime } = {}) => {
    const room = getRoom();
    if (!room) return;
    room.isPlaying = true;
    if (typeof position === 'number' && isFinite(position)) room.position = Math.max(0, position);
    room.referenceTime = (typeof serverTime === 'number' && isFinite(serverTime)) ? serverTime : nowMs();
    room.startAt = 0; room.rev++;
    socket.to(currentRoom).emit('play', {
      position: room.position, referenceTime: room.referenceTime, startAt: 0, rev: room.rev
    });
    scheduleAutoAdvance(room);
  });

  socket.on('pause', ({ position, serverTime } = {}) => {
    const room = getRoom();
    if (!room) return;
    clearAutoAdvance(room);
    room.isPlaying = false;
    if (typeof position === 'number' && isFinite(position)) room.position = Math.max(0, position);
    room.referenceTime = (typeof serverTime === 'number' && isFinite(serverTime)) ? serverTime : nowMs();
    room.startAt = 0; room.rev++;
    socket.to(currentRoom).emit('pause', {
      position: room.position, referenceTime: room.referenceTime, startAt: 0, rev: room.rev
    });
  });

  socket.on('seek', ({ position, serverTime } = {}) => {
    const room = getRoom();
    if (!room) return;
    if (typeof position === 'number' && isFinite(position)) room.position = Math.max(0, position);
    room.referenceTime = (typeof serverTime === 'number' && isFinite(serverTime)) ? serverTime : nowMs();
    room.startAt = 0; room.rev++;
    socket.to(currentRoom).emit('seek', {
      position: room.position, referenceTime: room.referenceTime,
      startAt: 0, isPlaying: room.isPlaying, rev: room.rev
    });
    scheduleAutoAdvance(room);
  });

  // #11: вместо «глухого» дебаунса — идемпотентность по `from`.
  // Дубликаты-гонки (одновременные onended) отсекаются, осознанный повтор — нет.
  function isStale(room, from) {
    return typeof from === 'number'
      && from !== room.currentTrack
      && nowMs() - room.lastChange < STALE_CMD_WINDOW_MS;
  }

  socket.on('next-track', ({ from } = {}) => {
    const room = getRoom();
    if (!room?.playlist.length || isStale(room, from)) return;
    if (room.repeat) return changeTrack(room, room.currentTrack, true);
    changeTrack(room, pickNext(room));
  });

  socket.on('prev-track', ({ from } = {}) => {
    const room = getRoom();
    if (!room?.playlist.length || isStale(room, from)) return;
    changeTrack(room, room.currentTrack === 0 ? room.playlist.length - 1 : room.currentTrack - 1);
  });

  socket.on('select-track', (payload) => {
    const room = getRoom();
    if (!room) return;
    const i = typeof payload === 'object' && payload ? payload.index : payload;
    if (!(i >= 0 && i < room.playlist.length)) return;
    changeTrack(room, i, true);
  });

  socket.on('set-mode', ({ shuffle, repeat } = {}) => {
    const room = getRoom();
    if (!room) return;
    if (typeof shuffle === 'boolean') room.shuffle = shuffle;
    if (typeof repeat === 'boolean') room.repeat = repeat;
    io.to(currentRoom).emit('mode-changed', { shuffle: room.shuffle, repeat: room.repeat });
  });

  socket.on('request-sync', () => {
    const room = getRoom();
    if (room) socket.emit('sync-state', snapshot(room));
  });

  socket.on('disconnect', () => {
    const room = getRoom();
    if (!room) return;
    room.users.delete(socket.id);

    if (room.users.size === 0) {
      // Замораживаем позицию: иначе через час «воспроизведение» уедет далеко за конец трека
      room.position = roomPosition(room);
      room.referenceTime = nowMs();
      room.startAt = 0;
      room.isPlaying = false;
      room.hostId = null;
      clearAutoAdvance(room);
      return;
    }

    io.to(room.id).emit('user-count', room.users.size);
    ensureHost(room);   // #4: переизбираем, даже если ушёл не хост
  });
});

// ==================== Запуск ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Server running on http://0.0.0.0:${PORT}`);
  if (YM_TOKEN && YM_TOKEN !== 'YOUR_TOKEN_HERE') {
    ymRequest('/account/status')
      .then(data => {
        console.log(`✅ Yandex account: ${data.result?.account?.login}`);
        console.log(`✅ Plus subscription: ${data.result?.plus?.hasPlus ? 'YES' : 'NO'}`);
      })
      .catch(e => console.log(`❌ Token validation failed: ${e.message}`));
  } else {
    console.log('⚠️  No YM_TOKEN set');
  }
});
