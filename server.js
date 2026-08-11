const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ==================== Хранилище ====================
const rooms = new Map();
const trackUrlCache = new Map();

// ==================== ТОКЕН ЯНДЕКС.МУЗЫКИ ====================
// Вставьте ваш токен сюда или используйте переменную окружения
const YM_TOKEN = process.env.YM_TOKEN || 'YOUR_TOKEN_HERE';

const YM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Authorization': `OAuth ${YM_TOKEN}`  // <-- ВАЖНО: добавлен токен
};

// Очистка каждый час
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.users.size === 0 && now - room.createdAt > 3600000) {
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
    console.log(`Getting stream URL for track ${trackId}...`);

    // Запрашиваем информацию о загрузке
    const info = await ymRequest(`/tracks/${trackId}/download-info`);

    if (!info.result?.length) {
      console.log('No download info available');
      return null;
    }

    console.log('Available formats:', info.result.map(i => `${i.codec} ${i.bitrateInKbps}kbps`));

    // Выбираем лучшее качество MP3
    const formats = info.result.filter(i => i.codec === 'mp3');
    if (!formats.length) {
      console.log('No MP3 format available');
      return null;
    }

    const best = formats.sort((a, b) => b.bitrateInKbps - a.bitrateInKbps)[0];
    console.log(`Selected: ${best.codec} ${best.bitrateInKbps}kbps`);

    // Получаем XML с информацией для скачивания
    const xml = await fetchText(best.downloadInfoUrl);

    const host = xml.match(/<host>([^<]+)/)?.[1];
    const xmlPath = xml.match(/<path>([^<]+)/)?.[1];
    const ts = xml.match(/<ts>([^<]+)/)?.[1];
    const s = xml.match(/<s>([^<]+)/)?.[1];

    if (!host || !xmlPath || !ts || !s) {
      console.log('Failed to parse download XML');
      return null;
    }

    // Формируем подпись
    const sign = crypto.createHash('md5')
      .update(`XGRlBW9FXlekgbPrRHuSiA${xmlPath.slice(1)}${s}`)
      .digest('hex');

    const streamUrl = `https://${host}/get-mp3/${sign}/${ts}${xmlPath}`;
    console.log('Stream URL generated successfully');

    return streamUrl;
  } catch (e) {
    console.error('getTrackStreamUrl error:', e.message);
    return null;
  }
}

// ==================== REST API ====================

app.post('/api/room/create', (req, res) => {
  const roomId = uuidv4().slice(0, 8).toUpperCase();
  rooms.set(roomId, {
    id: roomId, playlist: [], currentTrack: 0,
    position: 0, referenceTime: Date.now(),
    isPlaying: false, users: new Set(), hostId: null, createdAt: Date.now()
  });
  console.log(`Room created: ${roomId}`);
  res.json({ roomId });
});

app.get('/api/room/:id', (req, res) => {
  const room = rooms.get(req.params.id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Not found' });
  res.json({
    id: room.id, playlist: room.playlist, currentTrack: room.currentTrack,
    position: room.position, referenceTime: room.referenceTime,
    isPlaying: room.isPlaying, usersCount: room.users.size
  });
});

// Проверка токена
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

  console.log(`Parsing: ${url}`);
  try {
    let tracks = [];

    // Плейлист: /users/{owner}/playlists/{kind}
    const plMatch = url.match(/users\/([^\/]+)\/playlists\/(\d+)/);
    if (plMatch) {
      const data = await ymRequest(`/users/${plMatch[1]}/playlists/${plMatch[2]}`);
      if (data.result?.tracks) {
        tracks = data.result.tracks.map(t => formatTrack(t.track || t)).filter(Boolean);
      }
    }

    // Альбом: /album/{id}
    const albMatch = url.match(/album\/(\d+)(?!.*\/track)/);
    if (albMatch && !plMatch) {
      const data = await ymRequest(`/albums/${albMatch[1]}/with-tracks`);
      if (data.result?.volumes) {
        for (const vol of data.result.volumes) {
          tracks.push(...vol.map(formatTrack).filter(Boolean));
        }
      }
    }

    // Трек: /album/{id}/track/{id}
    const trkMatch = url.match(/album\/\d+\/track\/(\d+)/);
    if (trkMatch) {
      const data = await ymRequest(`/tracks/${trkMatch[1]}`);
      if (data.result?.[0]) tracks = [formatTrack(data.result[0])].filter(Boolean);
    }

    console.log(`Found ${tracks.length} tracks`);
    res.json({ tracks, count: tracks.length });
  } catch (e) {
    console.error('Parse error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/yandex/track/:id/stream', async (req, res) => {
  const { id } = req.params;

  // Проверяем кэш
  const cached = trackUrlCache.get(id);
  if (cached && cached.expires > Date.now()) {
    console.log(`Using cached URL for track ${id}`);
    return res.json({ url: cached.url, cached: true });
  }

  const url = await getTrackStreamUrl(id);
  if (!url) {
    return res.status(404).json({
      error: 'Track not available',
      hint: 'Check if YM_TOKEN is set and account has Plus subscription'
    });
  }

  // Кэшируем на 15 минут
  trackUrlCache.set(id, { url, expires: Date.now() + 900000 });
  res.json({ url, cached: false });
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

// Прокси для аудио (обход CORS)
app.get('/api/proxy', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL required');

  try {
    const proxyReq = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Range': req.headers.range || 'bytes=0-'
      },
      timeout: 30000
    }, (proxyRes) => {
      // Логируем информацию о файле
      console.log(`Proxying audio: ${proxyRes.statusCode}, Content-Length: ${proxyRes.headers['content-length']}`);

      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'audio/mpeg',
        'Content-Length': proxyRes.headers['content-length'],
        'Accept-Ranges': 'bytes',
        'Content-Range': proxyRes.headers['content-range'],
        'Access-Control-Allow-Origin': '*'
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      console.error('Proxy error:', e.message);
      if (!res.headersSent) res.status(500).send('Proxy error');
    });
  } catch (e) {
    console.error('Proxy error:', e.message);
    res.status(500).send('Error');
  }
});

// ==================== WebSocket ====================

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);
  let currentRoom = null;

  // ==================== Синхронизация часов (NTP-подобная, без периодических опросов) ====================
  // Клиент шлёт clock-sync с t0 (своё время отправки), сервер отвечает своим временем.
  // Клиент по формуле offset = serverTime - (t0 + rtt/2) вычисляет разницу часов один раз
  // и далее сам математически экстраполирует позицию воспроизведения.
  socket.on('clock-sync', (t0) => {
    socket.emit('clock-sync-reply', { t0, serverTime: Date.now() });
  });

  socket.on('join-room', (roomId) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) return socket.emit('error', 'Комната не найдена');

    currentRoom = roomId.toUpperCase();
    socket.join(currentRoom);
    room.users.add(socket.id);

    if (!room.hostId) {
      room.hostId = socket.id;
      socket.emit('you-are-host');
    }

    socket.emit('sync-state', {
      playlist: room.playlist, currentTrack: room.currentTrack,
      position: room.position, referenceTime: room.referenceTime,
      isPlaying: room.isPlaying, serverNow: Date.now()
    });
    io.to(currentRoom).emit('user-count', room.users.size);
  });

  socket.on('add-tracks', (tracks) => {
    const room = rooms.get(currentRoom);
    if (room) {
      room.playlist.push(...tracks);
      io.to(currentRoom).emit('playlist-updated', room.playlist);
    }
  });

  socket.on('clear-playlist', () => {
    const room = rooms.get(currentRoom);
    if (room) {
      room.playlist = []; room.currentTrack = 0;
      room.position = 0; room.referenceTime = Date.now(); room.isPlaying = false;
      io.to(currentRoom).emit('playlist-cleared');
    }
  });
  socket.on('remove-track', (index) => {
    const room = rooms.get(currentRoom);
    if (room && index >= 0 && index < room.playlist.length) {
      room.playlist.splice(index, 1);

      // Adjust current track index if needed
      if (room.currentTrack >= room.playlist.length && room.playlist.length > 0) {
        room.currentTrack = room.playlist.length - 1;
      } else if (room.playlist.length === 0) {
        room.currentTrack = 0;
        room.position = 0; room.referenceTime = Date.now();
        room.isPlaying = false;
      } else if (index < room.currentTrack) {
        room.currentTrack--;
      } else if (index === room.currentTrack) {
        room.position = 0; room.referenceTime = Date.now();
        io.to(currentRoom).emit('track-changed', {
          currentTrack: room.currentTrack, position: room.position,
          referenceTime: room.referenceTime, isPlaying: room.isPlaying
        });
      }

      io.to(currentRoom).emit('playlist-updated', room.playlist);
    }
  });

  // Хост присылает уже посчитанные по своим часам position и serverTime
  // (serverTime = локальное время хоста + вычисленный offset до сервера).
  // Это устраняет влияние пинга хост->сервер: сервер просто ретранслирует
  // точку отсчёта, а каждый клиент сам экстраполирует позицию по формуле
  // currentPosition = position + (localServerTime - referenceTime) / 1000.
  socket.on('play', ({ position, serverTime } = {}) => {
    const room = rooms.get(currentRoom);
    if (room) {
      room.isPlaying = true;
      room.position = typeof position === 'number' ? position : room.position;
      room.referenceTime = typeof serverTime === 'number' ? serverTime : Date.now();
      io.to(currentRoom).emit('play', { position: room.position, referenceTime: room.referenceTime });
    }
  });

  socket.on('pause', ({ position, serverTime } = {}) => {
    const room = rooms.get(currentRoom);
    if (room) {
      room.isPlaying = false;
      room.position = typeof position === 'number' ? position : room.position;
      room.referenceTime = typeof serverTime === 'number' ? serverTime : Date.now();
      io.to(currentRoom).emit('pause', { position: room.position, referenceTime: room.referenceTime });
    }
  });

  socket.on('seek', ({ position, serverTime } = {}) => {
    const room = rooms.get(currentRoom);
    if (room) {
      room.position = typeof position === 'number' ? position : room.position;
      room.referenceTime = typeof serverTime === 'number' ? serverTime : Date.now();
      socket.to(currentRoom).emit('seek', { position: room.position, referenceTime: room.referenceTime });
    }
  });

  socket.on('next-track', () => {
    const room = rooms.get(currentRoom);
    if (room?.playlist.length) {
      room.currentTrack = (room.currentTrack + 1) % room.playlist.length;
      room.position = 0; room.referenceTime = Date.now();
      io.to(currentRoom).emit('track-changed', {
        currentTrack: room.currentTrack, position: room.position,
        referenceTime: room.referenceTime, isPlaying: room.isPlaying
      });
    }
  });

  socket.on('prev-track', () => {
    const room = rooms.get(currentRoom);
    if (room?.playlist.length) {
      room.currentTrack = room.currentTrack === 0 ? room.playlist.length - 1 : room.currentTrack - 1;
      room.position = 0; room.referenceTime = Date.now();
      io.to(currentRoom).emit('track-changed', {
        currentTrack: room.currentTrack, position: room.position,
        referenceTime: room.referenceTime, isPlaying: room.isPlaying
      });
    }
  });

  socket.on('select-track', (i) => {
    const room = rooms.get(currentRoom);
    if (room && i >= 0 && i < room.playlist.length) {
      room.currentTrack = i;
      room.position = 0; room.referenceTime = Date.now();
      io.to(currentRoom).emit('track-changed', {
        currentTrack: i, position: room.position,
        referenceTime: room.referenceTime, isPlaying: room.isPlaying
      });
    }
  });

  socket.on('request-sync', () => {
    const room = rooms.get(currentRoom);
    if (room) {
      socket.emit('sync-state', {
        playlist: room.playlist, currentTrack: room.currentTrack,
        position: room.position, referenceTime: room.referenceTime,
        isPlaying: room.isPlaying, serverNow: Date.now()
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.users.delete(socket.id);
        io.to(currentRoom).emit('user-count', room.users.size);
        if (room.hostId === socket.id && room.users.size > 0) {
          room.hostId = room.users.values().next().value;
          io.to(room.hostId).emit('you-are-host');
        }
      }
    }
  });
});

// ==================== Запуск ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Server running on http://0.0.0.0:${PORT}`);
  console.log(`🔑 YM Token: ${YM_TOKEN ? 'SET' : 'NOT SET'}`);

  // Проверяем токен при старте
  if (YM_TOKEN && YM_TOKEN !== 'YOUR_TOKEN_HERE') {
    ymRequest('/account/status')
      .then(data => {
        console.log(`✅ Yandex account: ${data.result?.account?.login}`);
        console.log(`✅ Plus subscription: ${data.result?.plus?.hasPlus ? 'YES' : 'NO'}`);
      })
      .catch(e => console.log(`❌ Token validation failed: ${e.message}`));
  } else {
    console.log('⚠️  No YM_TOKEN set - only 30sec previews will be available');
  }
});
