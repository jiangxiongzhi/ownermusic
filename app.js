const audio = document.getElementById('audio');
const statusEl = document.getElementById('status');
const gateEl = document.getElementById('gate');
const nowEl = document.getElementById('now');
const titleEl = document.getElementById('title');
const artistEl = document.getElementById('artist');
const lyricEl = document.getElementById('lyric');
const seekEl = document.getElementById('seek');
const timeEl = document.getElementById('time');
const listEl = document.getElementById('list');
const filtersEl = document.getElementById('filters');

let songs = [];
let playlists = [];
let lyrics = new Map();
let queue = [];
let index = -1;
let objectUrl = '';
let lyricLines = [];
let seeking = false;
let view = 'all';
let activePlaylist = '';

if (navigator.audioSession) navigator.audioSession.type = 'playback';
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

document.getElementById('prev').addEventListener('click', () => step(-1));
document.getElementById('next').addEventListener('click', () => step(1));
document.getElementById('toggle').addEventListener('click', toggle);
seekEl.addEventListener('pointerdown', () => { seeking = true; });
seekEl.addEventListener('change', () => {
  seeking = false;
  if (audio.duration) audio.currentTime = (seekEl.value / 1000) * audio.duration;
});
audio.addEventListener('timeupdate', onTime);
audio.addEventListener('ended', () => step(1));
audio.addEventListener('play', () => { document.getElementById('toggle').textContent = '暂停'; });
audio.addEventListener('pause', () => { document.getElementById('toggle').textContent = '播放'; });
audio.addEventListener('error', () => markUnsupported());

const params = new URLSearchParams(location.search);
const syncApi = (params.get('api') || '').replace(/\/$/, '');
const syncCode = params.get('c') || '';

boot();

async function boot() {
  const db = await openDb();
  songs = await all(db, 'songs');
  const storedLists = await get(db, 'playlists', 'list');
  playlists = Array.isArray(storedLists) ? storedLists : [];
  db.close();
  render();
  if (!syncApi || !/^\d{6}$/.test(syncCode)) {
    statusEl.textContent = songs.length
      ? '歌在这台手机的浏览器里，可以离线听。'
      : '还没有歌。在电脑上开始同步，用系统相机扫浏览器收歌的码。';
    return;
  }
  if (needHomeScreen()) {
    statusEl.textContent = '先添加到主屏幕，再在那个图标里收歌。';
    gateEl.hidden = false;
    gateEl.innerHTML = '';
    const note = document.createElement('p');
    note.textContent = 'Safari 标签和主屏幕是两套存储。在标签里收的歌，主屏幕图标里看不到。普通标签大约 7 天不打开会被清掉。';
    const row = document.createElement('div');
    row.className = 'row';
    const stay = document.createElement('button');
    stay.type = 'button';
    stay.textContent = '仍在这个标签里收歌';
    stay.addEventListener('click', () => { gateEl.hidden = true; startSync(); });
    row.append(stay);
    gateEl.append(note, row);
    return;
  }
  startSync();
}

function needHomeScreen() {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches ||
    navigator.standalone === true;
  return ios && !standalone;
}

async function startSync() {
  statusEl.textContent = '正在读取电脑上的歌单…';
  let manifest;
  try {
    manifest = await pullJson('/v1/manifest');
  } catch (error) {
    statusEl.textContent = '连不上电脑。请确认同步还开着，并且手机能打开这条网页地址。';
    return;
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  playlists = Array.isArray(manifest.playlists) ? manifest.playlists : [];
  const db = await openDb();
  await put(db, 'playlists', 'list', playlists);
  let done = 0;
  for (const file of files) {
    done += 1;
    const name = file.title || file.fileName || '未命名';
    statusEl.textContent = '正在接收 ' + done + '/' + files.length + ' ' + name;
    const existing = songs.find((song) => song.fileKey === file.fileKey);
    if (existing && existing.blob && existing.sizeBytes === file.sizeBytes) continue;
    try {
      const response = await pull('/v1/audio/' + file.fileKey);
      const bytes = await response.arrayBuffer();
      const record = {
        fileKey: file.fileKey,
        fileName: file.fileName || '',
        sizeBytes: file.sizeBytes || bytes.byteLength,
        title: file.title || '',
        artist: file.artist || '',
        album: file.album || '',
        durationMs: file.durationMs || 0,
        favorite: file.favorite === true,
        blob: new Blob([bytes], { type: blobType(file.fileName) }),
        failed: false,
      };
      await put(db, 'songs', file.fileKey, record);
      if (file.hasLrc) {
        try {
          const lrcResponse = await pull('/v1/lrc/' + file.fileKey);
          const text = decodeLyric(await lrcResponse.arrayBuffer());
          await put(db, 'lyrics', file.fileKey, text);
        } catch (_) {}
      }
    } catch (error) {
      if (isQuota(error)) {
        statusEl.textContent = '手机浏览器空间不够，已停下。已经收下的歌还在。';
        db.close();
        songs = await reloadSongs();
        render();
        return;
      }
      try {
        await put(db, 'songs', file.fileKey, {
          fileKey: file.fileKey,
          fileName: file.fileName || '',
          sizeBytes: file.sizeBytes || 0,
          title: file.title || '',
          artist: file.artist || '',
          album: file.album || '',
          durationMs: file.durationMs || 0,
          favorite: file.favorite === true,
          failed: true,
        });
      } catch (again) {
        if (!isQuota(again)) continue;
        statusEl.textContent = '手机浏览器空间不够，已停下。已经收下的歌还在。';
        db.close();
        songs = await reloadSongs();
        render();
        return;
      }
    }
  }
  db.close();
  songs = await reloadSongs();
  statusEl.textContent = '接收完成。之后没网也可以从主屏幕打开来听。';
  render();
}

function pull(path) {
  return fetch(syncApi + path, {
    headers: { 'x-owner-token': syncCode },
    referrerPolicy: 'no-referrer',
  }).then((response) => {
    if (!response.ok) throw new Error(String(response.status));
    return response;
  });
}

function pullJson(path) {
  return pull(path).then((response) => response.json());
}

function isQuota(error) {
  return error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

async function reloadSongs() {
  const db = await openDb();
  const rows = await all(db, 'songs');
  db.close();
  return rows;
}

function render() {
  const playable = songs.filter((song) => song.blob);
  queue = playable.filter((song) => {
    if (view === 'fav') return song.favorite;
    if (activePlaylist) {
      const list = playlists.find((item) => item.name === activePlaylist);
      return list && list.fileKeys && list.fileKeys.indexOf(song.fileKey) >= 0;
    }
    return true;
  });
  filtersEl.innerHTML = '';
  addChip('全部', view === 'all' && !activePlaylist, () => { view = 'all'; activePlaylist = ''; render(); });
  addChip('喜欢', view === 'fav', () => { view = 'fav'; activePlaylist = ''; render(); });
  playlists.forEach((list) => {
    addChip(list.name, activePlaylist === list.name, () => {
      view = 'playlist';
      activePlaylist = list.name;
      render();
    });
  });
  listEl.innerHTML = '';
  queue.forEach((song, at) => {
    const li = document.createElement('li');
    if (at === index) li.className = 'playing';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = song.title || song.fileName || '未命名';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = song.failed
      ? '这首先前没收完，下次同步会再试'
      : (song.unsupported ? '这个浏览器播不了' : (song.artist || ''));
    meta.append(name, sub);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '移除';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeSong(song.fileKey);
    });
    li.addEventListener('click', () => playAt(at));
    li.append(meta, remove);
    listEl.append(li);
  });
  const failed = songs.filter((song) => song.failed);
  if (failed.length && !statusEl.textContent.includes('空间不够')) {
    const note = document.createElement('p');
    note.className = 'warn';
    note.textContent = failed.length + ' 首先前没收完，下次同步会再试。';
    listEl.prepend(note);
  }
}

function addChip(label, on, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip';
  button.textContent = label;
  if (on) button.classList.add('primary');
  button.addEventListener('click', action);
  filtersEl.append(button);
}

async function playAt(at) {
  const song = queue[at];
  if (!song || !song.blob) return;
  index = at;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(song.blob);
  audio.src = objectUrl;
  nowEl.hidden = false;
  titleEl.textContent = song.title || song.fileName || '未命名';
  artistEl.textContent = [song.artist, song.album].filter(Boolean).join(' · ');
  lyricLines = parseLrc(lyrics.get(song.fileKey) || await loadLyric(song.fileKey));
  lyricEl.textContent = lyricLines.length ? lyricLines[0].text : '';
  setSession(song);
  try {
    await audio.play();
  } catch (_) {
    statusEl.textContent = '点一下播放。';
  }
  render();
}

async function loadLyric(fileKey) {
  const db = await openDb();
  const text = await get(db, 'lyrics', fileKey);
  db.close();
  if (typeof text === 'string') lyrics.set(fileKey, text);
  return typeof text === 'string' ? text : '';
}

function toggle() {
  if (!audio.src) {
    if (queue.length) playAt(Math.max(index, 0));
    return;
  }
  if (audio.paused) audio.play();
  else audio.pause();
}

function step(delta) {
  if (!queue.length) return;
  const next = index < 0 ? 0 : (index + delta + queue.length) % queue.length;
  playAt(next);
}

function onTime() {
  if (!seeking && audio.duration) seekEl.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  timeEl.textContent = formatTime(audio.currentTime) + ' / ' + formatTime(audio.duration || 0);
  if (!lyricLines.length) return;
  let text = lyricLines[0].text;
  for (const line of lyricLines) {
    if (line.time <= audio.currentTime + 0.05) text = line.text;
  }
  lyricEl.textContent = text;
}

function markUnsupported() {
  const song = queue[index];
  if (!song) return;
  song.unsupported = true;
  openDb().then((db) => put(db, 'songs', song.fileKey, song).then(() => db.close()));
  lyricEl.textContent = '这个浏览器播不了';
  render();
}

async function removeSong(fileKey) {
  const db = await openDb();
  await del(db, 'songs', fileKey);
  await del(db, 'lyrics', fileKey);
  db.close();
  songs = songs.filter((song) => song.fileKey !== fileKey);
  lyrics.delete(fileKey);
  if (queue[index] && queue[index].fileKey === fileKey) {
    audio.pause();
    audio.removeAttribute('src');
    nowEl.hidden = true;
    index = -1;
  }
  render();
}

function setSession(song) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || song.fileName || '未命名',
      artist: song.artist || '',
      album: song.album || '',
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
  } catch (_) {}
}

function blobType(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const types = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    webm: 'audio/webm',
  };
  return types[ext] || 'application/octet-stream';
}

function decodeLyric(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch (_) {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }
}

function parseLrc(text) {
  const lines = [];
  String(text || '').split(/\r?\n/).forEach((row) => {
    const stamps = [];
    const rest = row.replace(/\[(\d+):(\d+(?:\.\d+)?)\]/g, (_, min, sec) => {
      stamps.push(Number(min) * 60 + Number(sec));
      return '';
    }).trim();
    stamps.forEach((time) => lines.push({ time, text: rest }));
  });
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const min = Math.floor(whole / 60);
  const sec = whole % 60;
  return min + ':' + String(sec).padStart(2, '0');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('owner-music-web', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'fileKey' });
      if (!db.objectStoreNames.contains('lyrics')) db.createObjectStore('lyrics');
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function all(db, store) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function get(db, store, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function put(db, store, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const objectStore = tx.objectStore(store);
    if (store === 'songs') objectStore.put(value);
    else objectStore.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function del(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
