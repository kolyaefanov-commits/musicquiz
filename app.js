// ==================== SUPABASE КЛИЕНТ ====================
const SUPABASE_URL = 'https://ajipmwgodfgnjiswhgbq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqaXBtd2dvZGZnbmppc3doZ2JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5Mjg3OTQsImV4cCI6MjExMDUwNDc5NH0.RgIG2msQVR-w5LGQFZ4BxDOuzjJoaQ3VHwF2JmEFAZQ';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==================== ЛОКАЛЬНЫЕ ПЕРЕМЕННЫЕ ====================
const DB_NAME = 'music_quiz_idb';
const DB_VERSION = 1;
const STORE_META = 'meta'; // Храним только сессию, команды и игру

let idb = null;
let db = { songs: [], session: null, teams: {}, game: null };
let currentUser = null;

// ==================== INDEXEDDB (ТОЛЬКО ДЛЯ МЕТАДАННЫХ) ====================
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      // Оставляем только метаданные, песни теперь в Supabase
      if (!d.objectStoreNames.contains(STORE_META)) d.createObjectStore(STORE_META, { keyPath: 'key' });
    };
    req.onsuccess = () => { idb = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function idbGetMeta(key) { return new Promise((res, rej) => { const r = idb.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(key); r.onsuccess = () => res(r.result ? r.result.value : null); r.onerror = () => rej(r.error); }); }
function idbSetMeta(key, value) { return new Promise((res, rej) => { const r = idb.transaction(STORE_META, 'readwrite').objectStore(STORE_META).put({ key, value }); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
async function initApp() {
  await openIDB();
  db.session = await idbGetMeta('session');
  db.teams = (await idbGetMeta('teams')) || {};
  db.game = await idbGetMeta('game');
  
  // Загружаем песни из Supabase
  await loadSongsFromSupabase();
  
  currentUser = db.session;
  route();
}

async function loadSongsFromSupabase() {
  const { data, error } = await supabaseClient.from('songs').select('*').order('created_at', { ascending: true });
  if (error) { 
    console.error('Ошибка загрузки песен:', error); 
    return; 
  }
  // Песни теперь хранят file_url, а не blob
  db.songs = data;
}

async function saveSession() { await idbSetMeta('session', currentUser); }
async function saveTeams() { await idbSetMeta('teams', db.teams); }
async function saveGame() { await idbSetMeta('game', db.game); }

// ==================== УПРАВЛЕНИЕ АУДИО ====================
let currentAudio = null;

function stopCurrentAudio() {
  if (currentAudio) { 
    currentAudio.pause(); 
    currentAudio.currentTime = 0; 
    currentAudio = null; 
  }
  const ind = document.getElementById('game-audio-indicator');
  if (ind) ind.classList.remove('playing');
}

function playAudioUrl(url, onEnded) {
  stopCurrentAudio();
  currentAudio = new Audio(url);
  const ind = document.getElementById('game-audio-indicator');
  if (ind) ind.classList.add('playing');
  if (onEnded) currentAudio.onended = onEnded;
  currentAudio.play();
}

// ==================== НАВИГАЦИЯ И ВХОД ====================
function showScreen(id) { 
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active')); 
  document.getElementById(id).classList.add('active'); 
}

function route() {
  if (!currentUser) return showScreen('screen-login');
  if (currentUser.role === 'admin') { showScreen('screen-admin'); renderAdmin(); }
  else { showScreen('screen-user'); renderUser(); }
}

async function login() {
  const loginValue = document.getElementById('login-name').value.trim();
  const pass = document.getElementById('login-pass').value;

  if (!loginValue || !pass) return alert('Введите логин и пароль');

  document.getElementById('global-loader').classList.remove('hidden');

  try {
    const { data, error } = await supabaseClient.rpc('login_user', {
      p_login: loginValue,
      p_password: pass
    });

    if (error) throw error;

    if (!data || data.length === 0) {
      alert('Неверный логин или пароль');
      return;
    }

    currentUser = { name: data[0].login, role: data[0].role };
    await saveSession();
    route();
  } catch (err) {
    console.error(err);
    alert('Ошибка входа: ' + err.message);
  } finally {
    document.getElementById('global-loader').classList.add('hidden');
  }
}

async function register() {
  const loginValue = document.getElementById('reg-name').value.trim();
  const pass = document.getElementById('reg-pass').value;

  if (!loginValue || !pass) return alert('Заполните оба поля');
  if (pass.length < 3) return alert('Пароль должен быть не менее 3 символов');

  document.getElementById('global-loader').classList.remove('hidden');

  try {
    const { error } = await supabaseClient.rpc('register_user', {
      p_login: loginValue,
      p_password: pass
    });

    if (error) throw error;

    alert('Регистрация успешна! Теперь войдите.');
    document.getElementById('reg-name').value = '';
    document.getElementById('reg-pass').value = '';
  } catch (err) {
    console.error(err);
    alert('Ошибка регистрации: ' + err.message);
  } finally {
    document.getElementById('global-loader').classList.add('hidden');
  }
}

async function logout() {
  currentUser = null;
  await saveSession();
  route();
}

// ==================== ОБРЕЗКА И СОХРАНЕНИЕ ====================
let audioBuffer = null;
let audioCtx = null;

document.getElementById('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arr = await file.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(arr);
    const range = document.getElementById('start-range');
    range.max = Math.max(0, audioBuffer.duration - 10);
    range.value = 0;
    updateStartLabel();
    document.getElementById('editor').classList.remove('hidden');
    document.getElementById('preview-audio').classList.add('hidden');
  } catch (err) {
    console.error(err);
    alert('Не удалось декодировать аудио. Проверьте формат.');
  }
});

document.getElementById('start-range').addEventListener('input', updateStartLabel);
function updateStartLabel() {
  document.getElementById('start-label').textContent = parseFloat(document.getElementById('start-range').value).toFixed(1);
}

function getClipBuffer(start) {
  const sr = audioBuffer.sampleRate;
  const len = Math.floor(10 * sr);
  const startSample = Math.floor(start * sr);
  const out = audioCtx.createBuffer(1, len, sr);
  const src = audioBuffer.getChannelData(0);
  const dst = out.getChannelData(0);
  for (let i = 0; i < len; i++) dst[i] = src[startSample + i] || 0;
  return out;
}

async function encodeToCompressed(buffer) {
  if (typeof MediaRecorder === 'undefined') return bufferToWav(buffer);
  const offlineCtx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const src = offlineCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(offlineCtx.destination);
  src.start();
  const rendered = await offlineCtx.startRendering();

  const rtCtx = new AudioContext();
  const dest = rtCtx.createMediaStreamDestination();
  const source = rtCtx.createBufferSource();
  source.buffer = rendered;
  source.connect(dest);

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const recorder = new MediaRecorder(dest.stream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  return new Promise((resolve) => {
    recorder.onstop = () => { rtCtx.close(); resolve(new Blob(chunks, { type: mimeType })); };
    recorder.start();
    source.start();
    setTimeout(() => { try { source.stop(); } catch (e) {} recorder.stop(); }, 10200);
  });
}

async function previewClip() {
  if (!audioBuffer) return;
  document.getElementById('global-loader').classList.remove('hidden');
  try {
    const start = parseFloat(document.getElementById('start-range').value);
    const clipBuf = getClipBuffer(start);
    const blob = await encodeToCompressed(clipBuf);
    const url = URL.createObjectURL(blob);
    const audioEl = document.getElementById('preview-audio');
    audioEl.src = url;
    audioEl.classList.remove('hidden');
    audioEl.play();
  } finally {
    document.getElementById('global-loader').classList.add('hidden');
  }
}

function bufferToWav(buffer) {
  const numCh = buffer.numberOfChannels, len = buffer.length, sr = buffer.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + len * 2)); let offset = 0;
  const writeStr = (s) => { for (let i = 0; i < s.length; i++) data.setUint8(offset++, s.charCodeAt(i)); };
  writeStr('RIFF'); data.setUint32(offset, 36 + len * 2, true); offset += 4;
  writeStr('WAVEfmt '); data.setUint32(offset, 16, true); offset += 4;
  data.setUint16(offset, 1, true); offset += 2; data.setUint16(offset, numCh, true); offset += 2;
  data.setUint32(offset, sr, true); offset += 4; data.setUint32(offset, sr * numCh * 2, true); offset += 4;
  data.setUint16(offset, numCh * 2, true); offset += 2; data.setUint16(offset, 16, true); offset += 2;
  writeStr('data'); data.setUint32(offset, len * 2, true); offset += 4;
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) { let s = Math.max(-1, Math.min(1, ch[i])); data.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true); offset += 2; }
  return new Blob([data], { type: 'audio/wav' });
}

async function saveClip() {
  if (!audioBuffer) return alert('Сначала выберите файл');
  const title = document.getElementById('song-title').value.trim();
  const artist = document.getElementById('song-artist').value.trim();
  if (!title || !artist) return alert('Введите название и исполнителя');
  
  // Проверка лимита (по локальному массиву)
  if (db.songs.filter(s => s.owner === currentUser.name).length >= 5) return alert('Максимум 5 песен');

  const btn = document.getElementById('btn-save-song');
  btn.disabled = true;
  document.getElementById('global-loader').classList.remove('hidden');

  try {
    const start = parseFloat(document.getElementById('start-range').value);
    const clipBuf = getClipBuffer(start);
    const blob = await encodeToCompressed(clipBuf);

    // 1. Загрузка в Supabase Storage
    const fileName = `${currentUser.name.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.webm`;
    const { error: upErr } = await supabaseClient.storage
      .from('songs')
      .upload(fileName, blob, { contentType: blob.type });

    if (upErr) throw upErr;

    // 2. Получение публичной ссылки
    const { data: urlData } = supabaseClient.storage.from('songs').getPublicUrl(fileName);
    const publicUrl = urlData.publicUrl;

    // 3. Сохранение в БД
    const { error: dbErr } = await supabaseClient.rpc('add_song', {
      p_owner: currentUser.name,
      p_title: title,
      p_artist: artist,
      p_file_url: publicUrl
    });

    if (dbErr) throw dbErr;

    // 4. Обновление списка
    await loadSongsFromSupabase();
    
    audioBuffer = null;
    document.getElementById('file-input').value = '';
    document.getElementById('song-title').value = '';
    document.getElementById('song-artist').value = '';
    document.getElementById('editor').classList.add('hidden');
    renderUser();
    alert('Песня сохранена!');
  } catch (err) {
    console.error(err);
    alert('Ошибка сохранения: ' + err.message);
  } finally {
    btn.disabled = false;
    document.getElementById('global-loader').classList.add('hidden');
  }
}

// ==================== ПЛЕЙЛИСТ УЧАСТНИКА ====================
let inlineAudio = null;
let inlinePlayingId = null;

async function togglePlay(id) {
  // Если нажали на уже играющую песню — ставим на паузу
  if (inlinePlayingId === id) {
    if (inlineAudio) inlineAudio.pause();
    inlinePlayingId = null;
    renderUser();
    return;
  }
  
  // Останавливаем предыдущую, если играла
  if (inlineAudio) inlineAudio.pause();

  const song = db.songs.find(s => s.id === id);
  if (!song) return;

  // ВАЖНО: используем file_url вместо blob
  inlineAudio = new Audio(song.file_url);
  
  inlineAudio.play().then(() => {
    inlinePlayingId = id;
    renderUser();
  }).catch(err => {
    console.error("Ошибка воспроизведения:", err);
    alert("Не удалось включить песню");
  });

  inlineAudio.onended = () => {
    inlinePlayingId = null;
    renderUser();
  };
}

async function deleteSong(id) {
  if (!confirm('Удалить эту песню?')) return;
  const song = db.songs.find(s => s.id === id);
  if (!song) return;

  try {
    // Извлекаем путь из URL
    const url = new URL(song.file_url);
    const pathStart = url.pathname.indexOf('/songs/') + '/songs/'.length;
    const filePath = decodeURIComponent(url.pathname.slice(pathStart));

    await supabaseClient.storage.from('songs').remove([filePath]);
    await supabaseClient.rpc('delete_song', { p_id: song.id });

    if (inlinePlayingId === id) {
      if (inlineAudio) inlineAudio.pause();
      inlinePlayingId = null;
    }

    await loadSongsFromSupabase();
    renderUser();
  } catch (err) {
    console.error(err);
    alert('Ошибка удаления: ' + err.message);
  }
}

function renderUser() {
  document.getElementById('user-label').textContent = currentUser.name;
  const mySongs = db.songs.filter(s => s.owner === currentUser.name);
  document.getElementById('my-count').textContent = mySongs.length;

  document.getElementById('my-songs').innerHTML = mySongs.map(s => `
    <li style="opacity:1; transform:none;">
      <span><b>${s.title}</b> — ${s.artist}</span>
      <div style="display:flex; gap:5px;">
        <button class="btn-outline" onclick="togglePlay('${s.id}')">${inlinePlayingId === s.id ? '⏸' : '▶'}</button>
        <button class="btn-outline" style="color:red;" onclick="deleteSong('${s.id}')">✕</button>
      </div>
    </li>
  `).join('') || '<li style="opacity:1;" class="hint">У вас пока нет песен</li>';
}

// ==================== АДМИН: ФОРМИРОВАНИЕ КОМАНД ====================
function renderAdmin() {
  const users = {};
  db.songs.forEach(s => { if (!users[s.owner]) users[s.owner] = 0; users[s.owner]++; });
  document.getElementById('admin-users').innerHTML = Object.keys(users).length
    ? Object.entries(users).map(([owner, count]) => `<div class="player-card"><span>${owner}</span><span class="count">${count}/5</span></div>`).join('')
    : '<p class="hint">Пока никто не загрузил песни.</p>';

  document.getElementById('admin-main').classList.remove('hidden');
  document.getElementById('admin-teams').classList.add('hidden');
  document.getElementById('admin-game').classList.add('hidden');
}

let tempTeams = {};

function openTeamBuilder() {
  document.getElementById('admin-main').classList.add('hidden');
  document.getElementById('admin-teams').classList.remove('hidden');
  
  tempTeams = {};
  Object.entries(db.teams).forEach(([p, teamName]) => {
    if (!tempTeams[teamName]) tempTeams[teamName] = [];
    tempTeams[teamName].push(p);
  });
  renderTeamBuilder();
}

function renderTeamBuilder() {
  const allPlayers = [...new Set(db.songs.map(s => s.owner))];
  const assigned = Object.values(tempTeams).flat();
  const freePlayers = allPlayers.filter(p => !assigned.includes(p));

  let html = '';
  for (const [teamName, players] of Object.entries(tempTeams)) {
    html += `
      <div class="team-block">
        <div class="team-block-header">
          <h3>${teamName}</h3>
          <div class="team-block-actions">
            <button onclick="renameTeam('${teamName}')" title="Переименовать">✏️</button>
            <button onclick="deleteTeam('${teamName}')" title="Удалить" style="color:red;">✕</button>
          </div>
        </div>
        <ul style="padding-left:20px; margin-bottom:10px;">
          ${players.map(p => `<li>${p} <button onclick="removePlayerFromTeam('${teamName}', '${p}')" style="width:auto; padding:2px 8px; font-size:12px; margin-left:10px;">✕</button></li>`).join('') || '<li class="hint">Пусто</li>'}
        </ul>
        ${freePlayers.length ? `
          <div style="display:flex; gap:10px;">
            <select id="sel-${teamName}" style="margin:0;">
              ${freePlayers.map(p => `<option value="${p}">${p}</option>`).join('')}
            </select>
            <button onclick="addPlayerToTeam('${teamName}')" style="width:auto; white-space:nowrap;">+</button>
          </div>
        ` : '<p class="hint">Все игроки распределены</p>'}
      </div>
    `;
  }
  document.getElementById('teams-list').innerHTML = html || '<p class="hint">Нет команд</p>';
}

function addNewTeam() {
  const name = prompt('Название команды:');
  if (!name || !name.trim()) return;
  if (tempTeams[name.trim()]) return alert('Такая команда уже есть');
  tempTeams[name.trim()] = [];
  renderTeamBuilder();
}

function renameTeam(oldName) {
  const newName = prompt('Новое название команды:', oldName);
  if (!newName || !newName.trim() || newName.trim() === oldName) return;
  if (tempTeams[newName.trim()]) return alert('Такая команда уже есть');
  tempTeams[newName.trim()] = tempTeams[oldName];
  delete tempTeams[oldName];
  renderTeamBuilder();
}

function deleteTeam(teamName) {
  if (!confirm(`Удалить команду "${teamName}"? Игроки станут свободными.`)) return;
  delete tempTeams[teamName];
  renderTeamBuilder();
}

function addPlayerToTeam(teamName) {
  const sel = document.getElementById('sel-' + teamName);
  if (!sel) return;
  const player = sel.value;
  tempTeams[teamName].push(player);
  renderTeamBuilder();
}

function removePlayerFromTeam(teamName, player) {
  tempTeams[teamName] = tempTeams[teamName].filter(p => p !== player);
  renderTeamBuilder();
}

async function saveTeamsAdmin() {
  db.teams = {};
  Object.entries(tempTeams).forEach(([teamName, players]) => {
    players.forEach(p => db.teams[p] = teamName);
  });
  await saveTeams();
  closeTeamBuilder();
}

function closeTeamBuilder() {
  document.getElementById('admin-teams').classList.add('hidden');
  renderAdmin();
}

// ==================== ЛОГИКА ИГРЫ ====================
let timerInterval = null;
let answerTimeouts = [];

function buildRounds() {
  const byOwner = {};
  db.songs.forEach(s => { if (!byOwner[s.owner]) byOwner[s.owner] = []; byOwner[s.owner].push(s); });
  const owners = shuffle(Object.keys(byOwner));
  return owners.map(owner => ({ owner, songs: shuffle(byOwner[owner]).slice(0, 5) }));
}

function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function startGame() {
  const rounds = buildRounds();
  if (!rounds.length) return alert('Нет песен');
  db.game = { rounds, roundIndex: 0, songIndex: 0, phase: 'idle', teams: [], scores: {} };
  await saveGame();
  document.getElementById('admin-main').classList.add('hidden');
  document.getElementById('admin-game').classList.remove('hidden');
  
  showRoundStart();
}

function showGameBlock(id) {
  ['game-round-start', 'game-play-area', 'game-finished'].forEach(b => {
    document.getElementById(b).classList.add('hidden');
  });
  if (id) document.getElementById(id).classList.remove('hidden');
}

function showRoundStart() {
  stopCurrentAudio();
  clearInterval(timerInterval);
  clearTimeouts();
  showGameBlock('game-round-start');
  
  const round = db.game.rounds[db.game.roundIndex];
  const nameEl = document.getElementById('round-start-name');
  nameEl.textContent = round.owner;
  
  nameEl.style.fontSize = '80px';
  let currentSize = 80;
  
  while ((nameEl.scrollHeight > window.innerHeight * 0.5 || nameEl.scrollWidth > window.innerWidth * 0.9) && currentSize > 16) {
    currentSize -= 2;
    nameEl.style.fontSize = currentSize + 'px';
  }
}

function startRoundPlay() {
  showGameBlock('game-play-area');
  const g = db.game;
  g.songIndex = 0;
  g.phase = 'playing';
  saveGame();

  const round = g.rounds[g.roundIndex];
  document.getElementById('game-round-title').textContent = `Раунд ${g.roundIndex + 1}`;
  
  const team = db.teams[round.owner] || 'Без команды';
  document.getElementById('game-teams-wrap').innerHTML = `<div class="sticker-team">${team}</div>`;

  playSong();
}

function playSong() {
  stopCurrentAudio();
  clearInterval(timerInterval);
  const g = db.game;
  const round = g.rounds[g.roundIndex];
  const song = round.songs[g.songIndex];
  if (!song) return roundEnd();

  document.getElementById('game-song-block').classList.remove('hidden');
  document.getElementById('game-answers-block').classList.add('hidden');
  document.getElementById('game-results-block').classList.add('hidden');
  
  document.getElementById('game-status').textContent = `Песня ${g.songIndex + 1} из ${round.songs.length}`;
  document.getElementById('game-audio-indicator').innerHTML = '<span>🎵 Играет трек...</span>';

  // ВОСПРОИЗВОДИМ ИЗ SUPABASE URL
  playAudioUrl(song.file_url);

  let sec = 10;
  const timerEl = document.getElementById('game-timer');
  const fill = document.getElementById('timer-fill-1');
  timerEl.textContent = `Слушаем: ${sec} сек`;
  fill.style.width = '100%';

  timerInterval = setInterval(() => {
    sec--;
    fill.style.width = `${(sec / 10) * 100}%`;
    if (sec <= 0) {
      clearInterval(timerInterval);
      stopCurrentAudio();
      startAnswerPhase(song);
    } else {
      timerEl.textContent = `Слушаем: ${sec} сек`;
    }
  }, 1000);
}

function startAnswerPhase(song) {
  db.game.phase = 'answering';
  db.game.currentSong = { title: song.title, artist: song.artist };
  saveGame();

  document.getElementById('game-audio-indicator').innerHTML = '<span>✍️ Время на ответ</span>';
  
  let sec = 20;
  const timerEl = document.getElementById('game-timer');
  const fill = document.getElementById('timer-fill-1');
  timerEl.textContent = `Ответ: ${sec} сек`;
  fill.style.width = '100%';

  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    sec--;
    fill.style.width = `${(sec / 20) * 100}%`;
    if (sec <= 0) {
      clearInterval(timerInterval);
      timerEl.textContent = 'Время вышло!';
      nextSongOrRound(); 
    } else {
      timerEl.textContent = `Ответ: ${sec} сек`;
    }
  }, 1000);
}

function nextSongOrRound() {
  clearInterval(timerInterval);
  const g = db.game;
  g.songIndex++;
  if (g.songIndex >= g.rounds[g.roundIndex].songs.length) {
    roundEnd();
  } else {
    saveGame();
    playSong();
  }
}

function roundEnd() {
  stopCurrentAudio();
  db.game.phase = 'submit';
  saveGame();
  
  document.getElementById('game-song-block').classList.add('hidden');
  document.getElementById('game-answers-block').classList.remove('hidden');
  document.getElementById('game-results-block').classList.add('hidden');
  
  document.getElementById('game-status').textContent = 'Раунд завершён!';
}

let answerQueueIndex = 0;
let answerRoundSongs = [];

function showAnswers() {
  stopCurrentAudio();
  clearTimeouts();
  const g = db.game;
  const round = g.rounds[g.roundIndex];
  
  document.getElementById('game-answers-block').classList.add('hidden');
  document.getElementById('game-results-block').classList.remove('hidden');
  document.getElementById('game-status').textContent = 'Ответы раунда:';
  
  const listEl = document.getElementById('answers-list');
  listEl.innerHTML = '';

  answerRoundSongs = round.songs;
  answerQueueIndex = 0;
  
  round.songs.forEach((s, i) => {
    const li = document.createElement('li');
    li.id = `answer-item-${i}`;
    li.style.opacity = '0';
    li.style.transform = 'translateY(10px)';
    li.style.transition = 'all 0.3s ease-out';
    li.innerHTML = `<span><b>${i+1}. ${s.title}</b> — ${s.artist}</span> 
      <button class="btn-outline" onclick="playAnswersAudio('${s.id}')">▶</button>`;
    listEl.appendChild(li);
  });

  playNextAnswer();
}

function playNextAnswer() {
  if (answerQueueIndex >= answerRoundSongs.length) {
    return; 
  }

  const song = answerRoundSongs[answerQueueIndex];
  const li = document.getElementById(`answer-item-${answerQueueIndex}`);
  
  playAudioUrl(song.file_url);

  const t = setTimeout(() => {
    if (li) {
      li.style.opacity = '1';
      li.style.transform = 'translateY(0)';
    }
  }, 3000);
  answerTimeouts.push(t);

  const waitTime = 10000 + 1000; 
  const t2 = setTimeout(() => {
    answerQueueIndex++;
    playNextAnswer();
  }, waitTime);
  answerTimeouts.push(t2);
}

function playAnswersAudio(id) {
  clearTimeouts();
  const song = db.songs.find(s => s.id === id);
  if (song) {
    playAudioUrl(song.file_url);
    const ind = document.getElementById('game-audio-indicator');
    if (ind) ind.classList.add('playing');
    
    answerRoundSongs.forEach((_, i) => {
      const li = document.getElementById(`answer-item-${i}`);
      if (li) { li.style.opacity = '1'; li.style.transform = 'translateY(0)'; }
    });
  }
}

function clearTimeouts() {
  answerTimeouts.forEach(t => clearTimeout(t));
  answerTimeouts = [];
}

function nextRoundOrFinish() {
  stopCurrentAudio();
  clearTimeouts();
  const g = db.game;
  g.roundIndex++;
  
  if (g.roundIndex >= g.rounds.length) {
    finishGame();
  } else {
    saveGame();
    showRoundStart();
  }
}

function startNextRound() {
  stopCurrentAudio();
  startRoundPlay();
}

function finishGame() {
  db.game.phase = 'finished';
  showGameBlock('game-finished');

  const teams = [...new Set(Object.values(db.teams))];
  if (teams.length === 0) teams.push('Без команды');

  db.game.teams = teams;
  db.game.scores = {};
  teams.forEach(t => db.game.scores[t] = 0);
  saveGame();

  document.getElementById('score-inputs').innerHTML = teams.map(t => `
    <label style="display:block; margin-bottom:10px; font-weight:600; text-align:left;">
      ${t}:
      <input type="number" id="score-${t}" value="0" min="0" />
    </label>
  `).join('');
}

function showScoreboard() {
  const teams = db.game.teams;
  teams.forEach(t => {
    const val = document.getElementById('score-' + t).value;
    db.game.scores[t] = parseInt(val) || 0;
  });
  saveGame();

  const sorted = teams.slice().sort((a, b) => db.game.scores[b] - db.game.scores[a]);
  document.getElementById('scoreboard').innerHTML = `
    <table>
      <tr><th>Место</th><th>Команда</th><th>Баллы</th></tr>
      ${sorted.map((t, i) => `<tr><td>${i + 1}</td><td>${t}</td><td>${db.game.scores[t]}</td></tr>`).join('')}
    </table>
  `;
  
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('slide-results').classList.remove('hidden');
}

function closeResults() {
  document.getElementById('slide-results').classList.add('hidden');
  route();
}

// ==================== СТАРТ ====================
initApp().catch(err => { 
  console.error(err); 
  alert('Ошибка инициализации. Проверьте консоль.'); 
});
