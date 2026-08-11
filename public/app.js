const state = {
  roomId: null, socket: null, playlist: [], currentTrack: 0,
  isPlaying: false, volume: .7, shuffle: false, repeat: false,
  isHost: false, rev: 0,
  transport: { position: 0, referenceTime: 0, isPlaying: false, startAt: 0 }
};

// ==================== Монотонные часы + многосэмпловая NTP-синхронизация ====================
const SYNC = {
  offset: 0, rtt: Infinity, ready: false, syncing: false,
  correcting: false, userOffsetMs: +(localStorage.getItem('userOffsetMs') || 0)
};

const monoNow = () => performance.timeOrigin + performance.now();
const serverNow = () => monoNow() + SYNC.offset;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pingOnce(timeout = 2000) {
  return new Promise(resolve => {
    const sock = state.socket;
    if (!sock?.connected) return resolve(null);            // #13
    const t0 = monoNow();
    const cleanup = () => { sock.off('clock-sync-reply', onReply); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
    const onReply = ({ t0: sent, serverTime }) => {
      if (sent !== t0) return;
      cleanup();
      const t1 = monoNow(), rtt = t1 - sent;
      resolve({ rtt, offset: serverTime - (sent + rtt / 2) });
    };
    sock.on('clock-sync-reply', onReply);
    sock.emit('clock-sync', t0);
  });
}

// Берём N замеров, оставляем лучшие по RTT (минимальная асимметрия) и усредняем
async function syncClock(rounds = 6) {
  if (SYNC.syncing) return;                                 // #13
  SYNC.syncing = true;
  try {
    const s = [];
    for (let i = 0; i < rounds; i++) {
      const r = await pingOnce();
      if (r) s.push(r);
      await sleep(40);
    }
    if (!s.length) return;
    s.sort((a, b) => a.rtt - b.rtt);
    const best = s.slice(0, Math.max(1, Math.ceil(s.length * 0.34)));
    const newOffset = best.reduce((a, x) => a + x.offset, 0) / best.length;
    SYNC.offset = SYNC.ready ? SYNC.offset * 0.7 + newOffset * 0.3 : newOffset;
    SYNC.rtt = best[0].rtt;
    SYNC.ready = true;
    updateDiagLabel();
  } finally {
    SYNC.syncing = false;
  }
}

setInterval(() => { if (state.socket?.connected) syncClock(6); }, 30000);
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden && state.socket?.connected) { await syncClock(6); hardResync(); }
});

// ==================== #3: две шкалы — общая и локальная ====================
let audioCtx = null;
function outputLatency() {
  if (!audioCtx) return 0;
  return (audioCtx.outputLatency ?? audioCtx.baseLatency ?? 0);
}
const latencyComp = () => outputLatency() + SYNC.userOffsetMs / 1000;

// Позиция в ОБЩЕЙ шкале комнаты — её и отправляем на сервер
function sharedPosition() {
  const t = state.transport;
  if (!t.isPlaying) return t.position;
  const now = serverNow();
  if (t.startAt && now < t.startAt) return t.position;
  return Math.max(0, t.position + (now - t.referenceTime) / 1000);
}
// Куда должен встать МОЙ audio.currentTime (с личной поправкой на вывод)
function expectedPosition() {
  return Math.max(0, sharedPosition() + (state.transport.isPlaying ? latencyComp() : 0));
}

const $ = id => document.getElementById(id);
const el = {
  landingScreen: $('landing-screen'), roomScreen: $('room-screen'), createRoomBtn: $('create-room-btn'),
  joinRoomBtn: $('join-room-btn'), roomCodeInput: $('room-code-input'), roomId: $('room-id'),
  usersCount: $('users-count'), copyLinkBtn: $('copy-link-btn'), syncBtn: $('sync-btn'),
  leaveRoomBtn: $('leave-room-btn'), tabs: document.querySelectorAll('.tab'),
  tabContents: document.querySelectorAll('.tab-content'), yandexLinks: $('yandex-links'),
  addTracksBtn: $('add-tracks-btn'), addDemoBtn: $('add-demo-btn'), searchInput: $('search-input'),
  searchBtn: $('search-btn'), searchResults: $('search-results'), trackCover: $('track-cover'),
  coverOverlay: $('cover-overlay'), trackTitle: $('track-title'), trackArtist: $('track-artist'),
  currentTime: $('current-time'), duration: $('duration'), progressBar: $('progress-bar'),
  progressFill: $('progress-fill'), shuffleBtn: $('shuffle-btn'), prevBtn: $('prev-btn'),
  playBtn: $('play-btn'), nextBtn: $('next-btn'), repeatBtn: $('repeat-btn'), muteBtn: $('mute-btn'),
  volumeSlider: $('volume-slider'), playlist: $('playlist'), playlistCount: $('playlist-count'),
  clearPlaylistBtn: $('clear-playlist-btn'), audio: $('audio-player'), notifications: $('notifications'),
  offsetSlider: $('offset-slider'), diagLabel: $('diag-label')
};

// ==================== #15/диагностика: панель создаётся сама, если её нет в HTML ====================
function ensureDiagUI() {
  if (el.offsetSlider && el.diagLabel) return;
  const box = document.createElement('div');
  box.id = 'sync-panel';
  box.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:900;background:#0009;color:#ddd;' +
    'font:12px/1.4 monospace;padding:8px 10px;border-radius:8px;backdrop-filter:blur(4px);user-select:none';
  box.innerHTML =
    '<div id="diag-label">offset: — | rtt: —</div>' +
    '<div style="display:flex;align-items:center;gap:6px;margin-top:4px">' +
    '<span>задержка</span><input id="offset-slider" type="range" min="-500" max="500" step="10" style="width:120px">' +
    '<span id="offset-value">0 мс</span></div>';
  document.body.appendChild(box);
  el.offsetSlider = $('offset-slider');
  el.diagLabel = $('diag-label');
  el.offsetValue = $('offset-value');
}

function init() {
  ensureDiagUI();
  const p = new URLSearchParams(location.search);
  const r = p.get('room');
  el.audio.volume = state.volume;
  el.volumeSlider.value = state.volume * 100;
  el.offsetSlider.value = SYNC.userOffsetMs;
  if (el.offsetValue) el.offsetValue.textContent = `${SYNC.userOffsetMs} мс`;
  setup();
  if (r) { el.roomCodeInput.value = r; joinRoom(r); }
}

function setup() {
  el.createRoomBtn.onclick = createRoom;
  el.joinRoomBtn.onclick = () => { const c = el.roomCodeInput.value.trim(); if (c) joinRoom(c); };
  el.roomCodeInput.onkeypress = e => { if (e.key === 'Enter') { const c = el.roomCodeInput.value.trim(); if (c) joinRoom(c); } };
  el.copyLinkBtn.onclick = copyLink;
  el.syncBtn.onclick = async () => { await syncClock(8); state.socket?.emit('request-sync'); };
  el.leaveRoomBtn.onclick = leaveRoom;
  el.tabs.forEach(t => {
    t.onclick = () => {
      el.tabs.forEach(x => x.classList.remove('active'));
      el.tabContents.forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $(`tab-${t.dataset.tab}`).classList.add('active');
    };
  });
  el.addTracksBtn.onclick = addTracks;
  el.addDemoBtn.onclick = addDemo;
  el.searchBtn.onclick = search;
  el.searchInput.onkeypress = e => { if (e.key === 'Enter') search(); };
  el.coverOverlay.onclick = togglePlay;
  el.playBtn.onclick = togglePlay;
  el.prevBtn.onclick = () => state.socket?.emit('prev-track', { from: state.currentTrack });
  el.nextBtn.onclick = () => state.socket?.emit('next-track', { from: state.currentTrack });
  el.shuffleBtn.onclick = () => state.socket?.emit('set-mode', { shuffle: !state.shuffle });
  el.repeatBtn.onclick = () => state.socket?.emit('set-mode', { repeat: !state.repeat });
  el.muteBtn.onclick = () => { el.audio.muted = !el.audio.muted; updateVolIcon(); };
  el.volumeSlider.oninput = e => { state.volume = e.target.value / 100; el.audio.volume = state.volume; updateVolIcon(); };
  el.progressBar.onclick = handleSeek;
  el.clearPlaylistBtn.onclick = () => state.socket?.emit('clear-playlist');

  el.offsetSlider.oninput = e => {
    SYNC.userOffsetMs = +e.target.value;
    localStorage.setItem('userOffsetMs', SYNC.userOffsetMs);
    if (el.offsetValue) el.offsetValue.textContent = `${SYNC.userOffsetMs} мс`;
    hardResync();
  };

  // #12: явно включаем сохранение高 тона при playbackRate != 1
  el.audio.preservesPitch = true;
  el.audio.mozPreservesPitch = true;
  el.audio.webkitPreservesPitch = true;
  el.audio.preload = 'auto';

  el.audio.ontimeupdate = handleTime;
  el.audio.onloadedmetadata = () => {
    el.duration.textContent = fmt(el.audio.duration);
    // #7: сообщаем серверу длительность, если её не было — нужен серверный автопереход
    const t = state.playlist[state.currentTrack];
    if (t && !(t.duration > 0) && isFinite(el.audio.duration)) {
      state.socket?.emit('report-duration', { index: state.currentTrack, duration: el.audio.duration });
    }
  };
  el.audio.onplay = () => updatePlayBtn(true);
  el.audio.onpause = () => updatePlayBtn(false);
  el.audio.oncanplay = () => { errorStreak = 0; };

  // #9: автопереход дублируем только с хоста (основной механизм — серверный таймер)
  el.audio.onended = () => { if (state.isHost) state.socket?.emit('next-track', { from: state.currentTrack }); };

  el.audio.onerror = () => {
    if (!hasAudio()) return;
    notify('Ошибка воспроизведения', 'error');
    errorStreak++;
    if (state.isHost && errorStreak <= state.playlist.length) {
      setTimeout(() => state.socket?.emit('next-track', { from: state.currentTrack }), 2000);
    }
  };

  // #1: 'playing' после НАШЕГО же play() не должен запускать новый ресинк
  el.audio.addEventListener('waiting', () => { wasStalled = true; el.audio.playbackRate = 1; });
  el.audio.addEventListener('stalled', () => { wasStalled = true; });
  el.audio.addEventListener('playing', () => {
    if (!wasStalled) return;
    wasStalled = false;
    setTimeout(() => {
      if (SYNC.correcting || el.audio.paused || !state.transport.isPlaying) return;
      if (Math.abs(el.audio.currentTime - expectedPosition()) > HARD_LIMIT) hardResync();
    }, 300);
  });

  setInterval(driftLoop, 250);
}

let wasStalled = false;
let errorStreak = 0;

// ==================== Работа с элементом audio ====================
function hasAudio() { return !!(el.audio.currentSrc || el.audio.getAttribute('src')); }   // #6
function clearAudio() {
  el.audio.pause();
  el.audio.removeAttribute('src');
  el.audio.dataset.src = '';
  try { el.audio.load(); } catch { }
}

async function createRoom() {
  el.createRoomBtn.disabled = true;
  el.createRoomBtn.innerHTML = '<span class="loading"></span>';
  try {
    const r = await fetch('/api/room/create', { method: 'POST' });
    const d = await r.json();
    joinRoom(d.roomId);
  } catch { notify('Ошибка', 'error'); }
  finally {
    el.createRoomBtn.disabled = false;
    el.createRoomBtn.innerHTML = '<i class="fas fa-plus"></i> Создать комнату';
  }
}

function joinRoom(id) {
  state.roomId = id.toUpperCase();
  history.pushState({}, '', `?room=${state.roomId}`);
  connectSocket();
  el.landingScreen.classList.remove('active');
  el.roomScreen.classList.add('active');
  el.roomId.textContent = state.roomId;
}

function leaveRoom() {
  state.socket?.disconnect(); state.socket = null;
  state.roomId = null; state.playlist = []; state.currentTrack = 0; state.isHost = false;
  state.transport = { position: 0, referenceTime: 0, isPlaying: false, startAt: 0 };
  state.isPlaying = false;
  clearAudio();
  history.pushState({}, '', location.pathname);
  el.roomScreen.classList.remove('active');
  el.landingScreen.classList.add('active');
  renderPlaylist();
}

function copyLink() {
  navigator.clipboard.writeText(`${location.origin}?room=${state.roomId}`)
    .then(() => notify('Ссылка скопирована!', 'success'));
}

// ==================== Единая точка применения транспорта ====================
function applyTransport(d) {
  if (typeof d.rev === 'number') state.rev = d.rev;
  state.transport = {
    position: d.position ?? 0,
    referenceTime: d.referenceTime ?? serverNow(),
    isPlaying: !!d.isPlaying,
    startAt: d.startAt || 0
  };
  state.isPlaying = state.transport.isPlaying;
  updatePlayBtn(state.isPlaying);
  hardResync();
}

function applyModes(shuffle, repeat) {
  state.shuffle = !!shuffle; state.repeat = !!repeat;
  el.shuffleBtn.classList.toggle('active', state.shuffle);
  el.repeatBtn.classList.toggle('active', state.repeat);
}

function connectSocket() {
  state.socket = io();

  state.socket.on('connect', async () => {
    await syncClock(6);                              // часы готовы ДО входа в комнату
    state.socket.emit('join-room', state.roomId);
  });

  state.socket.on('error', m => notify(m, 'error'));
  state.socket.on('user-count', c => el.usersCount.textContent = c);

  // #4: хост определяется сервером, клиент только сверяет свой id
  state.socket.on('host-changed', id => {
    const was = state.isHost;
    state.isHost = !!id && id === state.socket.id;
    if (state.isHost && !was) notify('Вы хост', 'info');
  });

  state.socket.on('sync-state', async d => {
    state.playlist = d.playlist || [];
    state.currentTrack = d.currentTrack || 0;
    applyModes(d.shuffle, d.repeat);
    state.isHost = !!d.hostId && d.hostId === state.socket.id;
    renderPlaylist();
    await loadTrack();
    applyTransport(d);
  });

  // #7: сервер шлёт и индекс — иначе подсветка и позиция разъезжаются
  state.socket.on('playlist-updated', payload => {
    const p = Array.isArray(payload) ? { playlist: payload } : (payload || {});
    state.playlist = p.playlist || [];
    if (typeof p.currentTrack === 'number') state.currentTrack = p.currentTrack;
    renderPlaylist();
    if (!hasAudio() && state.playlist.length) loadTrack();   // грузим, даже если добавили сразу пачку
  });

  state.socket.on('playlist-cleared', () => {
    state.playlist = []; state.currentTrack = 0; state.isPlaying = false;
    state.transport = { position: 0, referenceTime: serverNow(), isPlaying: false, startAt: 0 };
    clearAudio();
    renderPlaylist(); updateNowPlaying(null); updatePlayBtn(false);
    notify('Плейлист очищен', 'info');
  });

  state.socket.on('mode-changed', ({ shuffle, repeat }) => applyModes(shuffle, repeat));

  state.socket.on('play', d => applyTransport({ ...d, isPlaying: true }));
  state.socket.on('pause', d => applyTransport({ ...d, isPlaying: false }));
  state.socket.on('seek', d => applyTransport({ ...d, isPlaying: d.isPlaying ?? state.isPlaying }));

  state.socket.on('track-changed', async d => {
    state.currentTrack = d.currentTrack;
    el.audio.pause();
    renderPlaylist();
    await loadTrack();
    applyTransport(d);
  });

  state.socket.on('disconnect', () => { state.isHost = false; notify('Соединение потеряно', 'error'); });
}

async function addTracks() {
  const t = el.yandexLinks.value.trim();
  if (!t) return notify('Введите ссылку', 'error');
  el.addTracksBtn.disabled = true;
  el.addTracksBtn.innerHTML = '<span class="loading"></span>';
  let all = [];
  for (const l of t.split('\n').filter(x => x.trim())) {
    if (l.includes('music.yandex')) {
      try {
        const r = await fetch('/api/yandex/parse', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: l.trim() })
        });
        const d = await r.json();
        if (d.tracks?.length) all.push(...d.tracks);
      } catch { }
    }
  }
  el.addTracksBtn.disabled = false;
  el.addTracksBtn.innerHTML = '<i class="fas fa-plus"></i> Добавить';
  if (all.length) {
    state.socket?.emit('add-tracks', all);
    el.yandexLinks.value = '';
    notify(`Добавлено ${all.length} треков`, 'success');
  } else notify('Треки не найдены', 'error');
}

const PLACEHOLDER_COVER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Crect fill='%231e1e3a' width='200' height='200'/%3E%3Ctext x='100' y='110' text-anchor='middle' fill='%23ff5500' font-size='60' font-family='sans-serif'%3E♪%3C/text%3E%3C/svg%3E";
const DEMO_COVERS = [
"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Cdefs%3E%3ClinearGradient id='g1' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23ff7e5f'/%3E%3Cstop offset='100%25' stop-color='%23feb47b'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect fill='url(%23g1)' width='200' height='200'/%3E%3Ctext x='100' y='110' text-anchor='middle' fill='white' font-size='50' font-family='sans-serif'%3E☀%3C/text%3E%3C/svg%3E",
"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Cdefs%3E%3ClinearGradient id='g2' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%236a11cb'/%3E%3Cstop offset='100%25' stop-color='%232575fc'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect fill='url(%23g2)' width='200' height='200'/%3E%3Ctext x='100' y='110' text-anchor='middle' fill='white' font-size='50' font-family='sans-serif'%3E♫%3C/text%3E%3C/svg%3E",
"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Cdefs%3E%3ClinearGradient id='g3' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23232526'/%3E%3Cstop offset='100%25' stop-color='%23414345'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect fill='url(%23g3)' width='200' height='200'/%3E%3Ctext x='100' y='110' text-anchor='middle' fill='%23ff5500' font-size='50' font-family='sans-serif'%3E🌙%3C/text%3E%3C/svg%3E"
];

function addDemo() {
  const d = [
    { id: 'demo-1', title: 'Summer Vibes', artist: 'Demo', cover: DEMO_COVERS[0], url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', source: 'demo' },
    { id: 'demo-2', title: 'Chill Beats', artist: 'Demo', cover: DEMO_COVERS[1], url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3', source: 'demo' },
    { id: 'demo-3', title: 'Night Drive', artist: 'Demo', cover: DEMO_COVERS[2], url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3', source: 'demo' }
  ];
  state.socket?.emit('add-tracks', d);
}

async function search() {
  const q = el.searchInput.value.trim();
  if (!q) return;
  el.searchBtn.disabled = true;
  el.searchBtn.innerHTML = '<span class="loading"></span>';
  el.searchResults.innerHTML = '<p style="color:var(--text-secondary)">Поиск...</p>';
  try {
    const r = await fetch(`/api/yandex/search?q=${encodeURIComponent(q)}`);
    const d = await r.json();
    if (d.tracks?.length) {
      el.searchResults.innerHTML = d.tracks.map((t, i) =>
        `<div class="search-result-item" data-i="${i}"><img src="${t.cover}" alt=""><div class="search-result-info"><div class="search-result-title">${esc(t.title)}</div><div class="search-result-artist">${esc(t.artist)}</div></div><button class="btn btn-small btn-primary"><i class="fas fa-plus"></i></button></div>`
      ).join('');
      el.searchResults.querySelectorAll('.search-result-item').forEach((item, i) => {
        item.querySelector('button').onclick = () => {
          state.socket?.emit('add-tracks', [d.tracks[i]]);
          notify(`Добавлен: ${d.tracks[i].title}`, 'success');
        };
      });
    } else el.searchResults.innerHTML = '<p style="color:var(--text-secondary)">Не найдено</p>';
  } catch { el.searchResults.innerHTML = '<p style="color:var(--danger)">Ошибка</p>'; }
  el.searchBtn.disabled = false;
  el.searchBtn.innerHTML = '<i class="fas fa-search"></i>';
}

// ==================== #8: загрузка трека с защитой от гонок ====================
let loadGen = 0;
function loadTrack() {
  const gen = ++loadGen;
  if (!state.playlist.length) { clearAudio(); updateNowPlaying(null); return Promise.resolve(); }
  const t = state.playlist[state.currentTrack];
  if (!t) return Promise.resolve();
  updateNowPlaying(t);

  // Стабильный URL => одинаковый кэш и одинаковое время буферизации у всех
  const src = (t.source === 'yandex' && t.trackId) ? `/api/stream/${t.trackId}` : t.url;
  if (!src) return Promise.resolve();
  if (el.audio.dataset.src === src && el.audio.readyState >= 3) return Promise.resolve();

  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.audio.removeEventListener('canplay', finish);
      el.audio.removeEventListener('error', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 10000);
    el.audio.addEventListener('canplay', finish);
    el.audio.addEventListener('error', finish);

    if (gen !== loadGen) return finish();      // нас уже обогнал следующий track-changed
    el.audio.dataset.src = src;
    el.audio.preload = 'auto';
    el.audio.src = src;
    el.audio.load();
  });
}

function updateNowPlaying(t) {
  if (!t) {
    el.trackTitle.textContent = 'Выберите трек'; el.trackArtist.textContent = '—';
    el.trackCover.src = PLACEHOLDER_COVER; el.currentTime.textContent = '0:00';
    el.duration.textContent = '0:00'; el.progressFill.style.width = '0%';
    return;
  }
  el.trackTitle.textContent = t.title;
  el.trackArtist.textContent = t.artist;
  el.trackCover.src = t.cover || PLACEHOLDER_COVER;
}

// ==================== #5: разблокировка автоплея строго в жесте пользователя ====================
function unlockAudio() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => { });
  // синхронный play() внутри клика «размораживает» элемент; сразу глушим
  const p = el.audio.play();
  return (p && p.then ? p : Promise.resolve())
    .then(() => { el.audio.pause(); })
    .catch(() => { });
}

function togglePlay() {
  if (!state.playlist.length) return notify('Плейлист пуст', 'info');
  unlockAudio();                                    // ВАЖНО: без await, мы внутри жеста

  if (!state.transport.isPlaying) {
    const pos = Math.max(0, el.audio.currentTime - latencyComp());   // #3: отдаём общую шкалу
    const st = serverNow();
    state.transport = { position: pos, referenceTime: st, isPlaying: true, startAt: 0 };
    state.isPlaying = true;
    updatePlayBtn(true);
    state.socket?.emit('play', { position: pos, serverTime: st });
    hardResync();
  } else if (el.audio.paused) {
    hardResync();                                   // мы отстали локально — просто догоняем
  } else {
    const pos = sharedPosition();
    const st = serverNow();
    state.transport = { position: pos, referenceTime: st, isPlaying: false, startAt: 0 };
    state.isPlaying = false;
    el.audio.pause();
    updatePlayBtn(false);
    state.socket?.emit('pause', { position: pos, serverTime: st });
  }
}

function handleSeek(e) {
  if (!isFinite(el.audio.duration) || el.audio.duration <= 0) return;   // #10
  const r = el.progressBar.getBoundingClientRect();
  const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const pos = p * el.audio.duration;
  if (!isFinite(pos)) return;
  const st = serverNow();
  state.transport = { ...state.transport, position: pos, referenceTime: st, startAt: 0 };
  state.socket?.emit('seek', { position: pos, serverTime: st });
  hardResync();
}

function handleTime() {
  const c = el.audio.currentTime, d = el.audio.duration || 0;
  el.currentTime.textContent = fmt(c);
  if (d > 0) el.progressFill.style.width = `${(c / d) * 100}%`;
}

function updatePlayBtn(p) {
  const i = p ? 'fa-pause' : 'fa-play';
  el.playBtn.querySelector('i').className = `fas ${i}`;
  el.coverOverlay.querySelector('i').className = `fas ${i}`;
}

function updateVolIcon() {
  const v = el.audio.muted ? 0 : state.volume;
  let i = 'fa-volume-up';
  if (v === 0) i = 'fa-volume-mute'; else if (v < .5) i = 'fa-volume-down';
  el.muteBtn.querySelector('i').className = `fas ${i}`;
}

function renderPlaylist() {
  el.playlistCount.textContent = state.playlist.length;
  if (!state.playlist.length) {
    el.playlist.innerHTML = '<div class="playlist-empty"><i class="fas fa-music"></i><p>Плейлист пуст</p></div>';
    return;
  }
  el.playlist.innerHTML = state.playlist.map((t, i) =>
    `<div class="playlist-item ${i === state.currentTrack ? 'active' : ''}" data-i="${i}"><span class="playlist-item-num">${i + 1}</span><div class="playlist-item-cover"><img src="${t.cover}" alt=""></div><div class="playlist-item-info"><div class="playlist-item-title">${esc(t.title)}</div><div class="playlist-item-artist">${esc(t.artist)}</div></div><span class="playlist-item-duration">${t.duration ? fmt(t.duration) : '--:--'}</span><button class="btn btn-icon btn-delete-track" data-i="${i}"><i class="fas fa-times"></i></button></div>`
  ).join('');
  el.playlist.querySelectorAll('.playlist-item').forEach(item => {
    const del = item.querySelector('.btn-delete-track');
    if (del) del.onclick = e => { e.stopPropagation(); state.socket?.emit('remove-track', parseInt(del.dataset.i)); };
    item.onclick = () => state.socket?.emit('select-track', { index: parseInt(item.dataset.i) });
  });
}

function fmt(s) {
  if (!s || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function notify(m, type = 'info') {
  const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
  const n = document.createElement('div');
  n.className = `notification ${type}`;
  n.innerHTML = `<i class="fas ${icons[type]}"></i><span>${m}</span>`;
  el.notifications.appendChild(n);
  setTimeout(() => { n.style.animation = 'slideIn .3s ease reverse'; setTimeout(() => n.remove(), 300); }, 3000);
}

// ==================== Точный старт и удержание синхронизации ====================
const PLAY_LATENCY_MS = 60;   // задержка от вызова play() до реального звука
const LEAD = 0.35;            // запас на перемотку, сек
const SOFT_IN = 0.030;        // #12: гистерезис — включаем коррекцию скорости
const SOFT_OUT = 0.010;       //        и выключаем
const HARD_LIMIT = 0.250;     // жёсткая перемотка

function seekTo(pos) {
  return new Promise(res => {
    if (!isFinite(pos) || el.audio.readyState === 0) return res();
    if (Math.abs(el.audio.currentTime - pos) < 0.01) return res();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.audio.removeEventListener('seeked', finish);
      clearTimeout(timer);
      res();
    };
    const timer = setTimeout(finish, 1500);
    el.audio.addEventListener('seeked', finish);
    try { el.audio.currentTime = pos; } catch { finish(); }
  });
}

function waitReady(timeout = 8000) {
  return new Promise(res => {
    if (el.audio.readyState >= 3) return res(true);
    const cleanup = () => {
      el.audio.removeEventListener('canplay', done);
      el.audio.removeEventListener('error', done);
      clearTimeout(t);
    };
    const done = () => { cleanup(); res(el.audio.readyState >= 3); };
    const t = setTimeout(done, timeout);
    el.audio.addEventListener('canplay', done);
    el.audio.addEventListener('error', done);
  });
}

function showUnlockOverlay() {
  if ($('unlock')) return;
  const d = document.createElement('div');
  d.id = 'unlock';
  d.style.cssText = 'position:fixed;inset:0;background:#000c;display:grid;place-items:center;z-index:9999;cursor:pointer;font-size:20px;color:#fff';
  d.textContent = '▶ Нажмите, чтобы включить звук';
  d.onclick = () => { unlockAudio().finally(() => { d.remove(); hardResync(); }); };  // #5
  document.body.appendChild(d);
}

// ==================== #2: ресинк с отменой устаревших вызовов ====================
let resyncGen = 0;
async function hardResync() {
  if (!hasAudio()) return;
  const gen = ++resyncGen;                 // отменяем все предыдущие «спящие» ресинки
  const stale = () => gen !== resyncGen;
  SYNC.correcting = true;
  try {
    const t = state.transport;
    el.audio.playbackRate = 1;

    if (!t.isPlaying) {
      el.audio.pause();
      await seekTo(t.position);
      return;
    }

    await waitReady();                     if (stale()) return;
    el.audio.pause();                      if (stale()) return;

    let target, waitMs;
    if (t.startAt && serverNow() < t.startAt) {
      target = t.position;
      await seekTo(target);                if (stale()) return;
      waitMs = t.startAt - serverNow();
    } else {
      target = expectedPosition() + LEAD;  // прыгаем чуть вперёд...
      await seekTo(target);                if (stale()) return;
      waitMs = (target - expectedPosition()) * 1000;   // ...и ждём, пока часы догонят
    }

    if (waitMs > PLAY_LATENCY_MS) {
      await sleep(waitMs - PLAY_LATENCY_MS);
      if (stale()) return;
    }
    if (!state.transport.isPlaying) return;
    await el.audio.play();
  } catch (e) {
    if (gen === resyncGen) showUnlockOverlay();
  } finally {
    if (gen === resyncGen) SYNC.correcting = false;
  }
}

function driftLoop() {
  if (!SYNC.ready || SYNC.correcting) return;
  if (!state.transport.isPlaying || el.audio.paused) return;
  if (el.audio.readyState < 3 || el.audio.seeking) return;
  if (state.transport.startAt && serverNow() < state.transport.startAt) return;

  const drift = el.audio.currentTime - expectedPosition();   // >0 — мы впереди
  updateDiagLabel(drift);

  if (Math.abs(drift) > HARD_LIMIT) { hardResync(); return; }

  const correcting = el.audio.playbackRate !== 1;
  if (!correcting && Math.abs(drift) > SOFT_IN) {
    el.audio.playbackRate = Math.min(1.04, Math.max(0.96, 1 - drift / 5));
  } else if (correcting) {
    if (Math.abs(drift) < SOFT_OUT) el.audio.playbackRate = 1;
    else el.audio.playbackRate = Math.min(1.04, Math.max(0.96, 1 - drift / 5));
  }
}

function updateDiagLabel(drift) {
  if (!el.diagLabel) return;
  const d = typeof drift === 'number' ? drift * 1000 : null;
  el.diagLabel.textContent =
    `offset: ${SYNC.offset.toFixed(0)} мс | rtt: ${isFinite(SYNC.rtt) ? SYNC.rtt.toFixed(0) : '—'} мс` +
    (d !== null ? ` | drift: ${d >= 0 ? '+' : ''}${d.toFixed(0)} мс` : '');
}

// ==================== Тултипы (без изменений) ====================
function initTooltips() {
  let tooltip = null;
  document.querySelectorAll('[title]').forEach(node => {
    const title = node.getAttribute('title');
    if (!title) return;
    node.removeAttribute('title');
    node.dataset.tooltip = title;
    node.classList.add('has-tooltip');
    const icon = document.createElement('i');
    icon.className = 'info-icon';
    icon.textContent = 'i';
    node.appendChild(icon);
  });
  document.addEventListener('mouseenter', e => {
    const target = e.target.closest?.('[data-tooltip]');
    if (!target) return;
    if (tooltip) tooltip.remove();
    tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    tooltip.textContent = target.dataset.tooltip;
    document.body.appendChild(tooltip);
    positionTooltip(tooltip, target);
  }, true);
  document.addEventListener('mouseleave', e => {
    const target = e.target.closest?.('[data-tooltip]');
    if (!target) return;
    if (tooltip) { tooltip.remove(); tooltip = null; }
  }, true);
}

function positionTooltip(tooltip, target) {
  const rect = target.getBoundingClientRect();
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  const margin = 8, vw = window.innerWidth, vh = window.innerHeight;
  let top, left, pos = 'top';
  if (rect.top - th - margin > 0) { top = rect.top - th - margin; left = rect.left + rect.width / 2 - tw / 2; pos = 'top'; }
  else if (rect.bottom + th + margin < vh) { top = rect.bottom + margin; left = rect.left + rect.width / 2 - tw / 2; pos = 'bottom'; }
  else if (rect.left - tw - margin > 0) { top = rect.top + rect.height / 2 - th / 2; left = rect.left - tw - margin; pos = 'left'; }
  else { top = rect.top + rect.height / 2 - th / 2; left = rect.right + margin; pos = 'right'; }
  if (left < margin) left = margin;
  if (left + tw > vw - margin) left = vw - tw - margin;
  if (top < margin) top = margin;
  if (top + th > vh - margin) top = vh - th - margin;
  tooltip.style.top = top + 'px';
  tooltip.style.left = left + 'px';
  tooltip.classList.add('tooltip-' + pos);
}

init();
initTooltips();
