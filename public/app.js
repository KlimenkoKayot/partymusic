const state={roomId:null,socket:null,playlist:[],currentTrack:0,isPlaying:false,volume:.7,shuffle:false,repeat:false};
const $=id=>document.getElementById(id);
const el={landingScreen:$('landing-screen'),roomScreen:$('room-screen'),createRoomBtn:$('create-room-btn'),joinRoomBtn:$('join-room-btn'),roomCodeInput:$('room-code-input'),roomId:$('room-id'),usersCount:$('users-count'),copyLinkBtn:$('copy-link-btn'),syncBtn:$('sync-btn'),leaveRoomBtn:$('leave-room-btn'),tabs:document.querySelectorAll('.tab'),tabContents:document.querySelectorAll('.tab-content'),yandexLinks:$('yandex-links'),addTracksBtn:$('add-tracks-btn'),addDemoBtn:$('add-demo-btn'),searchInput:$('search-input'),searchBtn:$('search-btn'),searchResults:$('search-results'),trackCover:$('track-cover'),coverOverlay:$('cover-overlay'),trackTitle:$('track-title'),trackArtist:$('track-artist'),currentTime:$('current-time'),duration:$('duration'),progressBar:$('progress-bar'),progressFill:$('progress-fill'),shuffleBtn:$('shuffle-btn'),prevBtn:$('prev-btn'),playBtn:$('play-btn'),nextBtn:$('next-btn'),repeatBtn:$('repeat-btn'),muteBtn:$('mute-btn'),volumeSlider:$('volume-slider'),playlist:$('playlist'),playlistCount:$('playlist-count'),clearPlaylistBtn:$('clear-playlist-btn'),audio:$('audio-player'),notifications:$('notifications')};

function init(){const p=new URLSearchParams(location.search);const r=p.get('room');if(r){el.roomCodeInput.value=r;joinRoom(r)}el.audio.volume=state.volume;el.volumeSlider.value=state.volume*100;setup()}

function setup(){el.createRoomBtn.onclick=createRoom;el.joinRoomBtn.onclick=()=>{const c=el.roomCodeInput.value.trim();if(c)joinRoom(c)};el.roomCodeInput.onkeypress=e=>{if(e.key==='Enter'){const c=el.roomCodeInput.value.trim();if(c)joinRoom(c)}};el.copyLinkBtn.onclick=copyLink;el.syncBtn.onclick=()=>state.socket?.emit('request-sync');el.leaveRoomBtn.onclick=leaveRoom;el.tabs.forEach(t=>{t.onclick=()=>{el.tabs.forEach(x=>x.classList.remove('active'));el.tabContents.forEach(x=>x.classList.remove('active'));t.classList.add('active');$(`tab-${t.dataset.tab}`).classList.add('active')}});el.addTracksBtn.onclick=addTracks;el.addDemoBtn.onclick=addDemo;el.searchBtn.onclick=search;el.searchInput.onkeypress=e=>{if(e.key==='Enter')search()};el.coverOverlay.onclick=togglePlay;el.playBtn.onclick=togglePlay;el.prevBtn.onclick=()=>state.socket?.emit('prev-track');el.nextBtn.onclick=()=>state.socket?.emit('next-track');el.shuffleBtn.onclick=()=>{state.shuffle=!state.shuffle;el.shuffleBtn.classList.toggle('active',state.shuffle)};el.repeatBtn.onclick=()=>{state.repeat=!state.repeat;el.repeatBtn.classList.toggle('active',state.repeat);el.audio.loop=state.repeat};el.muteBtn.onclick=()=>{el.audio.muted=!el.audio.muted;updateVolIcon()};el.volumeSlider.oninput=e=>{state.volume=e.target.value/100;el.audio.volume=state.volume;updateVolIcon()};el.progressBar.onclick=handleSeek;el.clearPlaylistBtn.onclick=()=>state.socket?.emit('clear-playlist');el.audio.ontimeupdate=handleTime;el.audio.onloadedmetadata=()=>{el.duration.textContent=fmt(el.audio.duration)};el.audio.onended=()=>{if(!state.repeat){state.shuffle?state.socket?.emit('select-track',Math.floor(Math.random()*state.playlist.length)):state.socket?.emit('next-track')}};el.audio.onplay=()=>updatePlayBtn(true);el.audio.onpause=()=>updatePlayBtn(false);el.audio.onerror=()=>notify('Ошибка воспроизведения','error')}

async function createRoom(){el.createRoomBtn.disabled=true;el.createRoomBtn.innerHTML='<span class="loading"></span>';try{const r=await fetch('/api/room/create',{method:'POST'});const d=await r.json();joinRoom(d.roomId)}catch{notify('Ошибка','error')}finally{el.createRoomBtn.disabled=false;el.createRoomBtn.innerHTML='<i class="fas fa-plus"></i> Создать комнату'}}

function joinRoom(id){state.roomId=id.toUpperCase();history.pushState({},'',`?room=${state.roomId}`);connectSocket();el.landingScreen.classList.remove('active');el.roomScreen.classList.add('active');el.roomId.textContent=state.roomId}

function leaveRoom(){state.socket?.disconnect();state.socket=null;state.roomId=null;state.playlist=[];state.currentTrack=0;el.audio.pause();el.audio.src='';history.pushState({},'',location.pathname);el.roomScreen.classList.remove('active');el.landingScreen.classList.add('active');renderPlaylist()}

function copyLink(){navigator.clipboard.writeText(`${location.origin}?room=${state.roomId}`).then(()=>notify('Ссылка скопирована!','success'))}

function connectSocket(){state.socket=io();state.socket.on('connect',()=>state.socket.emit('join-room',state.roomId));state.socket.on('error',m=>notify(m,'error'));state.socket.on('you-are-host',()=>notify('Вы хост','info'));state.socket.on('user-count',c=>el.usersCount.textContent=c);state.socket.on('sync-state',async d=>{state.playlist=d.playlist;state.currentTrack=d.currentTrack;state.isPlaying=d.isPlaying;renderPlaylist();await loadTrack();if(el.audio.src){el.audio.currentTime=d.currentTime;updatePlayBtn(d.isPlaying);if(d.isPlaying){el.audio.play().catch(()=>{})}}});state.socket.on('playlist-updated',p=>{state.playlist=p;renderPlaylist();if(state.playlist.length===1)loadTrack();notify('Плейлист обновлён','info')});state.socket.on('playlist-cleared',()=>{state.playlist=[];state.currentTrack=0;state.isPlaying=false;el.audio.pause();el.audio.src='';renderPlaylist();updateNowPlaying(null);notify('Плейлист очищен','info')});state.socket.on('play',({time})=>{state.isPlaying=true;el.audio.currentTime=time;el.audio.play().catch(()=>{})});state.socket.on('pause',({time})=>{state.isPlaying=false;el.audio.currentTime=time;el.audio.pause()});state.socket.on('seek',({time})=>{el.audio.currentTime=time});state.socket.on('track-changed',async({currentTrack:t})=>{state.currentTrack=t;await loadTrack();renderPlaylist();if(state.isPlaying&&el.audio.src){el.audio.play().catch(()=>{})}});state.socket.on('disconnect',()=>notify('Соединение потеряно','error'))}

async function addTracks(){const t=el.yandexLinks.value.trim();if(!t)return notify('Введите ссылку','error');el.addTracksBtn.disabled=true;el.addTracksBtn.innerHTML='<span class="loading"></span>';let all=[];for(const l of t.split('\n').filter(x=>x.trim())){if(l.includes('music.yandex')){try{const r=await fetch('/api/yandex/parse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:l.trim()})});const d=await r.json();if(d.tracks?.length)all.push(...d.tracks)}catch{}}}el.addTracksBtn.disabled=false;el.addTracksBtn.innerHTML='<i class="fas fa-plus"></i> Добавить';if(all.length){state.socket?.emit('add-tracks',all);el.yandexLinks.value='';notify(`Добавлено ${all.length} треков`,'success')}else notify('Треки не найдены','error')}

const PLACEHOLDER_COVER="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Crect fill='%231e1e3a' width='200' height='200'/%3E%3Ctext x='100' y='110' text-anchor='middle' fill='%23ff5500' font-size='60' font-family='sans-serif'%3E♪%3C/text%3E%3C/svg%3E";
const DEMO_COVERS=[
"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Cdefs%3E%3ClinearGradient id='g1' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23ff7e5f'/%3E%3Cstop offset='100%25' stop-color='%23feb47b'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect fill='url(%23g1)' width='200' height='200'/%3E%3Ctext x='100' y='110' text-anchor='middle' fill='white' font-size='50' font-family='sans-serif'%3E☀%3C/text%3E%3C/svg%3E",
"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Cdefs%3E%3ClinearGradient id='g2' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%236a11cb'/%3E%3Cstop offset='100%25' stop-color='%232575fc'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect fill='url(%23g2)' width='200' height='200'/%3E%3Ctext x='100' y='110' text-anchor='middle' fill='white' font-size='50' font-family='sans-serif'%3E♫%3C/text%3E%3C/svg%3E",
"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Cdefs%3E%3ClinearGradient id='g3' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%23232526'/%3E%3Cstop offset='100%25' stop-color='%23414345'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect fill='url(%23g3)' width='200' height='200'/%3E%3Ctext x='100' y='110' text-anchor='middle' fill='%23ff5500' font-size='50' font-family='sans-serif'%3E🌙%3C/text%3E%3C/svg%3E"
];
function addDemo(){const d=[{id:'demo-1',title:'Summer Vibes',artist:'Demo',cover:DEMO_COVERS[0],url:'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',source:'demo'},{id:'demo-2',title:'Chill Beats',artist:'Demo',cover:DEMO_COVERS[1],url:'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',source:'demo'},{id:'demo-3',title:'Night Drive',artist:'Demo',cover:DEMO_COVERS[2],url:'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',source:'demo'}];state.socket?.emit('add-tracks',d)}

async function search(){const q=el.searchInput.value.trim();if(!q)return;el.searchBtn.disabled=true;el.searchBtn.innerHTML='<span class="loading"></span>';el.searchResults.innerHTML='<p style="color:var(--text-secondary)">Поиск...</p>';try{const r=await fetch(`/api/yandex/search?q=${encodeURIComponent(q)}`);const d=await r.json();if(d.tracks?.length){el.searchResults.innerHTML=d.tracks.map((t,i)=>`<div class="search-result-item" data-i="${i}"><img src="${t.cover}" alt=""><div class="search-result-info"><div class="search-result-title">${esc(t.title)}</div><div class="search-result-artist">${esc(t.artist)}</div></div><button class="btn btn-small btn-primary"><i class="fas fa-plus"></i></button></div>`).join('');el.searchResults.querySelectorAll('.search-result-item').forEach((item,i)=>{item.querySelector('button').onclick=()=>{state.socket?.emit('add-tracks',[d.tracks[i]]);notify(`Добавлен: ${d.tracks[i].title}`,'success')}})}else el.searchResults.innerHTML='<p style="color:var(--text-secondary)">Не найдено</p>'}catch{el.searchResults.innerHTML='<p style="color:var(--danger)">Ошибка</p>'}el.searchBtn.disabled=false;el.searchBtn.innerHTML='<i class="fas fa-search"></i>'}

async function loadTrack(){if(!state.playlist.length){updateNowPlaying(null);return}const t=state.playlist[state.currentTrack];if(!t)return;updateNowPlaying(t);return new Promise((resolve)=>{const onLoaded=()=>{el.audio.removeEventListener('loadedmetadata',onLoaded);el.audio.removeEventListener('error',onError);resolve()};const onError=()=>{el.audio.removeEventListener('loadedmetadata',onLoaded);el.audio.removeEventListener('error',onError);resolve()};el.audio.addEventListener('loadedmetadata',onLoaded);el.audio.addEventListener('error',onError);if(t.source==='yandex'&&t.trackId){fetch(`/api/yandex/track/${t.trackId}/stream`).then(r=>r.json()).then(d=>{if(d.url){el.audio.src=`/api/proxy?url=${encodeURIComponent(d.url)}`;el.audio.load()}else{notify('Трек недоступен','error');setTimeout(()=>state.socket?.emit('next-track'),2000);resolve()}}).catch(()=>{notify('Ошибка загрузки','error');resolve()})}else if(t.url){el.audio.src=t.url;el.audio.load()}else{resolve()}})}

function updateNowPlaying(t){if(!t){el.trackTitle.textContent='Выберите трек';el.trackArtist.textContent='—';el.trackCover.src=PLACEHOLDER_COVER;el.currentTime.textContent='0:00';el.duration.textContent='0:00';el.progressFill.style.width='0%';return}el.trackTitle.textContent=t.title;el.trackArtist.textContent=t.artist;el.trackCover.src=t.cover||PLACEHOLDER_COVER}

function togglePlay(){if(!state.playlist.length)return notify('Плейлист пуст','info');if(el.audio.paused){el.audio.play().then(()=>state.socket?.emit('play',el.audio.currentTime)).catch(()=>notify('Не удалось воспроизвести','error'))}else{el.audio.pause();state.socket?.emit('pause',el.audio.currentTime)}}

function handleSeek(e){const r=el.progressBar.getBoundingClientRect();const p=(e.clientX-r.left)/r.width;const t=p*el.audio.duration;el.audio.currentTime=t;state.socket?.emit('seek',t)}

function handleTime(){const c=el.audio.currentTime;const d=el.audio.duration||0;el.currentTime.textContent=fmt(c);if(d>0)el.progressFill.style.width=`${(c/d)*100}%`;if(Math.floor(c)%5===0)state.socket?.emit('time-update',c)}

function updatePlayBtn(p){const i=p?'fa-pause':'fa-play';el.playBtn.querySelector('i').className=`fas ${i}`;el.coverOverlay.querySelector('i').className=`fas ${i}`}

function updateVolIcon(){const v=el.audio.muted?0:state.volume;let i='fa-volume-up';if(v===0)i='fa-volume-mute';else if(v<.5)i='fa-volume-down';el.muteBtn.querySelector('i').className=`fas ${i}`}

function renderPlaylist(){el.playlistCount.textContent=state.playlist.length;if(!state.playlist.length){el.playlist.innerHTML='<div class="playlist-empty"><i class="fas fa-music"></i><p>Плейлист пуст</p></div>';return}el.playlist.innerHTML=state.playlist.map((t,i)=>`<div class="playlist-item ${i===state.currentTrack?'active':''}" data-i="${i}"><span class="playlist-item-num">${i+1}</span><div class="playlist-item-cover"><img src="${t.cover}" alt=""></div><div class="playlist-item-info"><div class="playlist-item-title">${esc(t.title)}</div><div class="playlist-item-artist">${esc(t.artist)}</div></div><span class="playlist-item-duration">${t.duration?fmt(t.duration):'--:--'}</span><button class="btn btn-icon btn-delete-track" title="Удалить трек из плейлиста" data-i="${i}"><i class="fas fa-times"></i></button></div>`).join('');el.playlist.querySelectorAll('.playlist-item').forEach(item=>{const deleteBtn=item.querySelector('.btn-delete-track');if(deleteBtn){deleteBtn.onclick=(e)=>{e.stopPropagation();state.socket?.emit('remove-track',parseInt(deleteBtn.dataset.i))}}item.onclick=()=>state.socket?.emit('select-track',parseInt(item.dataset.i))})}

function fmt(s){if(!s||!isFinite(s))return'0:00';const m=Math.floor(s/60);const sec=Math.floor(s%60);return`${m}:${sec.toString().padStart(2,'0')}`}

function esc(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML}

function notify(m,type='info'){const icons={success:'fa-check-circle',error:'fa-exclamation-circle',info:'fa-info-circle'};const n=document.createElement('div');n.className=`notification ${type}`;n.innerHTML=`<i class="fas ${icons[type]}"></i><span>${m}</span>`;el.notifications.appendChild(n);setTimeout(()=>{n.style.animation='slideIn .3s ease reverse';setTimeout(()=>n.remove(),300)},3000)}

function initTooltips(){
  let tooltip=null;
  document.querySelectorAll('[title]').forEach(el=>{
    const title=el.getAttribute('title');
    if(!title)return;
    el.removeAttribute('title');
    el.dataset.tooltip=title;
    el.classList.add('has-tooltip');
    const icon=document.createElement('i');
    icon.className='info-icon';
    icon.textContent='i';
    el.appendChild(icon);
  });
  document.addEventListener('mouseenter',e=>{
    const target=e.target.closest('[data-tooltip]');
    if(!target)return;
    if(tooltip)tooltip.remove();
    tooltip=document.createElement('div');
    tooltip.className='tooltip';
    tooltip.textContent=target.dataset.tooltip;
    document.body.appendChild(tooltip);
    positionTooltip(tooltip,target);
  },true);
  document.addEventListener('mouseleave',e=>{
    const target=e.target.closest('[data-tooltip]');
    if(!target)return;
    if(tooltip){tooltip.remove();tooltip=null}
  },true);
}

function positionTooltip(tooltip,target){
  const rect=target.getBoundingClientRect();
  const tw=tooltip.offsetWidth;
  const th=tooltip.offsetHeight;
  const margin=8;
  const vw=window.innerWidth;
  const vh=window.innerHeight;
  let top,left,pos='top';
  if(rect.top-th-margin>0){
    top=rect.top-th-margin;
    left=rect.left+rect.width/2-tw/2;
    pos='top';
  }else if(rect.bottom+th+margin<vh){
    top=rect.bottom+margin;
    left=rect.left+rect.width/2-tw/2;
    pos='bottom';
  }else if(rect.left-tw-margin>0){
    top=rect.top+rect.height/2-th/2;
    left=rect.left-tw-margin;
    pos='left';
  }else{
    top=rect.top+rect.height/2-th/2;
    left=rect.right+margin;
    pos='right';
  }
  if(left<margin)left=margin;
  if(left+tw>vw-margin)left=vw-tw-margin;
  if(top<margin)top=margin;
  if(top+th>vh-margin)top=vh-th-margin;
  tooltip.style.top=top+'px';
  tooltip.style.left=left+'px';
  tooltip.classList.add('tooltip-'+pos);
}

init();
initTooltips();
