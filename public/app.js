
let currentCategory = null;
let audioPlayer = null;
let playingCard = null;
let playbackMode = localStorage.getItem('playbackMode') || 'local';
let discordStatus = { online: false, username: null, guilds: [] };
let guildPickedManually = false; // user changed the server in the Discord modal
let channelPickedManually = false; // user changed the voice channel in the Discord modal
let discordProgressTimer = null;
let discordStartTime = 0;
let discordMetaListener = null; // pending 'loadedmetadata' listener of discord mode
let isAuthed = false;
let playlistInfo = null;        
let playlistPollTimer = null;
let playlistOrder = 'order';    


const $grid = document.getElementById('audioGrid');
const $empty = document.getElementById('emptyState');
const $catNav = document.getElementById('categoriesNav');
const $player = document.getElementById('audioPlayer');


const $toast = document.getElementById('toastPlayer');
const $toastName = document.getElementById('toastName');
const $toastTime = document.getElementById('toastTime');
const $toastBar = document.getElementById('toastProgressBar');
const $toastTrack = document.getElementById('toastProgressTrack');


async function checkAuth() {
  const userInfo = document.getElementById('userInfo');
  const btnLogin = document.getElementById('btnLogin');

  try {
    const res = await fetch('/auth/me');
    if (res.status === 401) {
      isAuthed = false;
      userInfo.style.display = 'none';
      btnLogin.style.display = '';
      return false;
    }
    const data = await res.json();
    window.currentUser = data.user;
    isAuthed = true;

    const avatar = document.getElementById('userAvatar');
    const userName = document.getElementById('userName');
    if (data.user.avatar) {
      avatar.src = `https://cdn.discordapp.com/avatars/${data.user.id}/${data.user.avatar}.png?size=32`;
    } else {
      avatar.src = `https://cdn.discordapp.com/embed/avatars/${(BigInt(data.user.id) >> 22n) % 6n}.png`;
    }
    userName.textContent = data.user.username;
    userInfo.style.display = 'flex';
    btnLogin.style.display = 'none';

    return true;
  } catch {
    isAuthed = false;
    userInfo.style.display = 'none';
    btnLogin.style.display = '';
    return false;
  }
}

function requiresDiscordAuth(mode) {
  return mode === 'discord' || mode === 'both';
}

const $notice = document.getElementById('notice');
let noticeTimer = null;

function showNotice(message) {
  $notice.textContent = message;
  $notice.classList.add('visible');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => $notice.classList.remove('visible'), 4000);
}

// Only the "Login Discord" button starts the OAuth flow. Other actions that
// need a session just explain how to get one.
function notifyLoginRequired(action = 'usar esta função') {
  showNotice(`Entre com o botão "Login Discord" para ${action}.`);
}

// Managing the library requires login; listening in the browser does not.
function withLogin(fn, action = 'gerenciar a biblioteca') {
  return (...args) => {
    if (!isAuthed) {
      notifyLoginRequired(action);
      return;
    }
    return fn(...args);
  };
}

// Show the server's { error } message for a failed request.
async function reportError(res, fallback) {
  let message = fallback;
  try { message = (await res.json()).error || fallback; } catch {}
  if (res.status === 401) {
    // Session expired (e.g. server restarted) — reflect it in the UI
    await checkAuth();
    notifyLoginRequired('continuar');
    return;
  }
  alert(message);
}


document.addEventListener('DOMContentLoaded', async () => {
  // OAuth callback rejected the account (not in allowedUserIds)
  const params = new URLSearchParams(window.location.search);
  const loginErrors = {
    'sem-permissao': 'Sua conta do Discord não tem permissão para usar este SoundBot.',
    'login-falhou': 'Não foi possível concluir o login com o Discord. Veja o motivo no console do servidor.'
  };
  const loginError = loginErrors[params.get('erro')];
  if (loginError) {
    history.replaceState(null, '', window.location.pathname);
    showNotice(loginError);
  }

  await checkAuth();

  document.getElementById('btnLogout').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.reload();
  });

  audioPlayer = $player;
  audioPlayer.addEventListener('ended', () => stopPlaying());
  // A file/stream that can't be played (e.g. YouTube unavailable) used to leave
  // the card "playing" forever with no feedback. In discord mode the element
  // only reads metadata, so a failure there must not stop the bot.
  audioPlayer.addEventListener('error', () => {
    if (!playingCard || playbackMode === 'discord') return;
    stopPlaying({ keepDiscord: true });
    showNotice('Não foi possível tocar este áudio no navegador.');
  });
  audioPlayer.addEventListener('timeupdate', updateToastProgress);

  
  $toastTrack.addEventListener('click', e => {
    if (!audioPlayer.duration) return;
    const rect = $toastTrack.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audioPlayer.currentTime = ratio * audioPlayer.duration;
  });

  document.getElementById('toastClose').addEventListener('click', () => {
    
    if (playingCard) stopPlaying();
    else if (playlistInfo) stopPlaylist();
    else stopPlaying();
  });

  document.getElementById('toastPrev').addEventListener('click', () => changePlaylistTrack('prev'));
  document.getElementById('toastNext').addEventListener('click', () => changePlaylistTrack('next'));

  loadConfig();
  loadCategories();
  loadDiscordStatus();
  setInterval(loadDiscordStatus, 30000);
  initPlaybackToggle();
  initDiscordModal();

  
  document.getElementById('btnDirectory').addEventListener('click', withLogin(openDirectoryModal));
  document.getElementById('btnAddAudio').addEventListener('click', withLogin(openAddAudioModal));
  document.getElementById('btnSaveDirectory').addEventListener('click', saveDirectory);
  initDirectoryPicker();
  document.getElementById('btnUpload').addEventListener('click', uploadAudio);
  document.getElementById('btnNewCategory').addEventListener('click', promptNewCategory);
  document.getElementById('btnConfirmNewCategory').addEventListener('click', confirmNewCategory);
  document.getElementById('inputNewCategory').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmNewCategory();
  });
  document.getElementById('btnDiscord').addEventListener('click',
    withLogin(() => {
      // Fresh open: forget any manual pick so the server the user is in
      // right now gets preselected, and refresh voice state before showing
      guildPickedManually = false;
      channelPickedManually = false;
      openModal('modalDiscord');
      loadDiscordStatus();
    }, 'escolher a sala do Discord'));
  document.getElementById('btnPlaylist').addEventListener('click',
    withLogin(openPlaylistModal, 'tocar playlists no Discord'));
  initPlaylistModal();
  initEditModal();
  initSearch();
  initSourceToggle();

  
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('inputAudioFile');

  uploadArea.addEventListener('click', () => fileInput.click());
  document.querySelectorAll('[role="button"][tabindex="0"]:not(.audio-card)').forEach(el => {
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  });
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      fileInput.files = e.dataTransfer.files;
      onFileSelected();
    }
  });
  fileInput.addEventListener('change', onFileSelected);

  
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  
  document.getElementById('btnAddFirstAudio').addEventListener('click', () => {
    document.getElementById('btnAddAudio').click();
  });

  
  document.getElementById('btnClearFile').addEventListener('click', clearFile);
});


async function loadConfig() {
  const res = await fetch('/api/config');
  const config = await res.json();
  document.getElementById('currentDir').textContent = config.audioDir;
  document.getElementById('inputDirectory').value = config.audioDir;
}

async function loadCategories() {
  const res = await fetch('/api/categories');
  const categories = await res.json();
  renderCategories(categories);

  if (!currentCategory || !categories.includes(currentCategory)) {
    currentCategory = categories[0] || 'Geral';
  }
  setActiveCategory(currentCategory);
  loadAudios(currentCategory);
}

// Bumped by every grid load (category or search): a slow response that
// arrives after a newer request must not overwrite the grid.
let gridRequestSeq = 0;

async function loadAudios(category) {
  const seq = ++gridRequestSeq;
  const res = await fetch(`/api/audios?category=${encodeURIComponent(category)}`);
  const audios = await res.json();
  if (seq !== gridRequestSeq) return;
  renderAudioGrid(audios);
}


// Each real category gets a stable pad color by its position in the list
let categoryPads = {};
const PAD_COUNT = 6;

function padColorFor(category) {
  const n = categoryPads[category];
  return n ? `var(--pad-${n})` : '';
}

function renderCategories(categories) {
  $catNav.innerHTML = '';
  categoryPads = {};
  categories.filter(c => c !== 'Geral').forEach((cat, i) => {
    categoryPads[cat] = (i % PAD_COUNT) + 1;
  });
  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'category-tab';
    btn.textContent = cat;
    if (categoryPads[cat]) {
      const dot = document.createElement('span');
      dot.className = 'cat-dot';
      dot.setAttribute('aria-hidden', 'true');
      dot.style.setProperty('--pad', padColorFor(cat));
      btn.prepend(dot);
    }
    btn.addEventListener('click', () => {
      
      const searchInput = document.getElementById('inputSearch');
      if (searchInput) searchInput.value = '';
      document.querySelectorAll('.category-tab').forEach(t => t.disabled = false);

      currentCategory = cat;
      setActiveCategory(cat);
      loadAudios(cat);
    });
    $catNav.appendChild(btn);
  });

  
  const addBtn = document.createElement('button');
  addBtn.className = 'category-tab category-add-btn';
  addBtn.title = 'Nova categoria';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', withLogin(addCategoryFromNav));
  $catNav.appendChild(addBtn);
}


let newCategoryCallback = null;

function openNewCategoryModal(callback) {
  newCategoryCallback = callback;
  document.getElementById('inputNewCategory').value = '';
  openModal('modalNewCategory');
  setTimeout(() => document.getElementById('inputNewCategory').focus(), 100);
}

function confirmNewCategory() {
  const name = document.getElementById('inputNewCategory').value.trim();
  if (!name) return;
  closeModal('modalNewCategory');
  if (newCategoryCallback) newCategoryCallback(name);
  newCategoryCallback = null;
}

async function addCategoryFromNav() {
  openNewCategoryModal(async (name) => {
    const res = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) return reportError(res, 'Não foi possível criar a categoria');
    loadCategories();
  });
}

function setActiveCategory(name) {
  document.querySelectorAll('.category-tab').forEach(tab => {
    tab.classList.toggle('active', tab.textContent === name);
  });
}

function renderAudioGrid(audios, searchQuery = '') {
  $grid.innerHTML = '';

  if (audios.length === 0) {
    $grid.style.display = 'none';
    $empty.style.display = 'flex';
    document.getElementById('emptyText').textContent = searchQuery
      ? `Nenhum áudio encontrado para "${searchQuery}"`
      : 'Nenhum áudio nesta categoria';
    document.getElementById('btnAddFirstAudio').style.display = searchQuery ? 'none' : '';
    return;
  }

  $grid.style.display = 'grid';
  $empty.style.display = 'none';

  audios.forEach(audio => {
    const card = document.createElement('div');
    card.className = 'audio-card';
    card.tabIndex = 0;
    if (categoryPads[audio.category]) card.style.setProperty('--pad', padColorFor(audio.category));
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Tocar ${audio.display || audio.name}`);
    card.dataset.url = audio.url || '';
    card.dataset.filename = audio.filename;
    card.dataset.category = audio.category;
    if (audio.type === 'youtube') {
      card.dataset.type = 'youtube';
      card.dataset.youtubeUrl = audio.youtubeUrl;
    }

    let iconHtml;
    if (audio.thumbnail) {
      iconHtml = `<img class="card-thumb" src="${audio.thumbnail}" alt="">`;
    } else if (audio.type === 'youtube') {
      iconHtml = `<div class="card-icon card-icon-yt"><svg width="24" height="24" viewBox="0 0 24 24" fill="#FF0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></div>`;
    } else {
      iconHtml = `<div class="card-icon">&#9835;</div>`;
    }

    card.innerHTML = `
      <div class="card-actions">
        <button class="card-action-btn edit" title="Editar" aria-label="Editar ${escapeHtml(audio.display || audio.name)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
            <path d="m15 5 4 4"/>
          </svg>
        </button>
        <button class="card-action-btn delete" title="Remover" aria-label="Remover ${escapeHtml(audio.display || audio.name)}">&times;</button>
      </div>
      ${iconHtml}
      <div class="card-name">${escapeHtml(audio.display || audio.name)}</div>
      <div class="card-progress" aria-hidden="true"><span></span></div>
    `;

    card.addEventListener('keydown', e => {
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        card.click();
      }
    });

    card.addEventListener('click', e => {
      if (e.target.closest('.card-action-btn')) return;
      if (audio.type === 'youtube') {
        // Streaming YouTube runs yt-dlp on the server, so it needs login
        if (!isAuthed) return notifyLoginRequired('tocar links do YouTube');
        togglePlayYouTube(card, audio.youtubeUrl, audio.display || audio.name);
      } else {
        togglePlay(card, audio.url);
      }
    });

    card.querySelector('.card-action-btn.edit').addEventListener('click', e => {
      e.stopPropagation();
      withLogin(openEditModal)(audio);
    });

    card.querySelector('.card-action-btn.delete').addEventListener('click', e => {
      e.stopPropagation();
      withLogin(deleteAudio)(audio);
    });

    $grid.appendChild(card);
  });
}


function togglePlay(card, url) {
  if (playingCard === card) {
    stopPlaying();
    return;
  }

  // The new play already interrupts the bot server-side; a separate stop request
  // could arrive after it and silence the new audio.
  stopPlaying({ keepDiscord: requiresDiscordAuth(playbackMode) });
  playingCard = card;
  card.classList.add('playing');

  const name = card.querySelector('.card-name').textContent;
  const category = card.dataset.category;
  const filename = card.dataset.filename;

  if (playbackMode === 'local' || playbackMode === 'both') {
    audioPlayer.src = url;
    audioPlayer.play();
  }

  if (playbackMode === 'discord' || playbackMode === 'both') {
    playInDiscord(category, filename);
  }

  
  if (playbackMode === 'discord') {
    audioPlayer.src = url;
    discordMetaListener = function onMeta() {
      audioPlayer.removeEventListener('loadedmetadata', onMeta);
      discordMetaListener = null;
      if (playingCard !== card) return;
      discordStartTime = Date.now();
      const duration = audioPlayer.duration;
      discordProgressTimer = setInterval(() => {
        const elapsed = (Date.now() - discordStartTime) / 1000;
        if (elapsed >= duration) {
          stopPlaying();
          return;
        }
        const pct = (elapsed / duration) * 100;
        setProgress(pct);
        $toastTime.textContent = `${formatTime(elapsed)} / ${formatTime(duration)}`;
      }, 250);
    };
    audioPlayer.addEventListener('loadedmetadata', discordMetaListener);
  }

  showToast(name);
}

function togglePlayYouTube(card, youtubeUrl, name) {
  if (playingCard === card) {
    stopPlaying();
    return;
  }

  stopPlaying({ keepDiscord: requiresDiscordAuth(playbackMode) });
  playingCard = card;
  card.classList.add('playing');


  if (playbackMode === 'local' || playbackMode === 'both') {
    const streamUrl = '/api/youtube/stream?url=' + encodeURIComponent(youtubeUrl);
    audioPlayer.src = streamUrl;
    audioPlayer.play();
  }

  
  if (playbackMode === 'discord' || playbackMode === 'both') {
    fetch('/api/discord/play-youtube', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: youtubeUrl })
    }).catch(err => console.error('Discord YouTube play error:', err));
  }

  showToast(name);
}

// Drop the discord-mode progress timer and any listener still waiting to start one
function clearDiscordProgress() {
  if (discordMetaListener) {
    audioPlayer.removeEventListener('loadedmetadata', discordMetaListener);
    discordMetaListener = null;
  }
  if (discordProgressTimer) {
    clearInterval(discordProgressTimer);
    discordProgressTimer = null;
  }
}

// keepDiscord: skip the stop request when a new play is about to replace it
function stopPlaying({ keepDiscord = false } = {}) {
  if (playingCard) {
    const cardBar = playingCard.querySelector('.card-progress span');
    if (cardBar) cardBar.style.width = '0%';
    playingCard.classList.remove('playing');
    playingCard = null;
  }
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  clearDiscordProgress();

  if (!keepDiscord && requiresDiscordAuth(playbackMode)) {
    stopDiscord();
  }

  hideToast();
}

function showToast(name) {
  $toast.classList.remove('playlist-mode');
  const pad = playingCard && playingCard.style.getPropertyValue('--pad');
  if (pad) $toast.style.setProperty('--pad', pad);
  else $toast.style.removeProperty('--pad');
  $toastName.textContent = name;
  $toastTime.textContent = '0:00 / 0:00';
  setProgress(0);
  $toast.classList.add('visible');
}

function hideToast() {
  $toast.classList.remove('visible');
}

function setProgress(pct) {
  $toastBar.style.width = pct + '%';
  const cardBar = playingCard && playingCard.querySelector('.card-progress span');
  if (cardBar) cardBar.style.width = pct + '%';
}

function updateToastProgress() {
  if (!audioPlayer.duration) return;
  const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100;
  setProgress(pct);
  $toastTime.textContent = `${formatTime(audioPlayer.currentTime)} / ${formatTime(audioPlayer.duration)}`;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}


async function deleteAudio(audio) {
  if (!confirm(`Remover "${audio.name}"?`)) return;

  const res = await fetch('/api/audios', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: audio.category, filename: audio.filename })
  });
  if (!res.ok) await reportError(res, 'Não foi possível remover o áudio');

  loadAudios(currentCategory);
}


function openDirectoryModal() {
  setDirBrowserOpen(false);
  loadConfig();
  openModal('modalDirectory');
}

// "Procurar…" in the Pasta de áudios modal. Inside Electron it opens the
// native folder dialog (preload.js). In a plain browser a page can't learn a
// folder's absolute path from the OS picker, so it toggles a folder browser
// fed by the server (/api/fs/directories). Typing a path always works too.
const FOLDER_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
let dirBrowserState = null; // last /api/fs/directories response
let dirBrowseSeq = 0;       // drops responses of superseded requests

function initDirectoryPicker() {
  const btn = document.getElementById('btnBrowseDirectory');
  const input = document.getElementById('inputDirectory');
  const desktop = window.soundbotDesktop;
  const hasNativePicker = !!desktop && typeof desktop.pickDirectory === 'function';

  document.getElementById('directoryHint').textContent =
    'Escolha a pasta onde os áudios serão armazenados ou cole o caminho completo.';

  btn.addEventListener('click', async () => {
    if (!hasNativePicker) {
      toggleDirBrowser();
      return;
    }
    btn.disabled = true;
    try {
      const dir = await desktop.pickDirectory(input.value.trim());
      if (dir) {
        input.value = dir;
        input.focus();
      }
    } catch {
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btnDirUp').addEventListener('click', () => {
    if (dirBrowserState?.parent) browseDirectory(dirBrowserState.parent);
  });
  document.getElementById('btnDirHome').addEventListener('click', () => {
    if (dirBrowserState?.home) browseDirectory(dirBrowserState.home);
  });
  document.getElementById('selectDirRoot').addEventListener('change', e => browseDirectory(e.target.value));
}

function setDirBrowserOpen(open) {
  document.getElementById('dirBrowser').hidden = !open;
  document.getElementById('btnBrowseDirectory').setAttribute('aria-expanded', String(open));
}

function toggleDirBrowser() {
  const opening = document.getElementById('dirBrowser').hidden;
  setDirBrowserOpen(opening);
  if (opening) {
    // Start at what's typed; if that doesn't exist yet, the server's default
    const typed = document.getElementById('inputDirectory').value.trim();
    browseDirectory(typed, { fallbackToDefault: true });
  }
}

async function browseDirectory(target, { fallbackToDefault = false } = {}) {
  const seq = ++dirBrowseSeq;
  const query = target ? `?path=${encodeURIComponent(target)}` : '';
  let res;
  try {
    res = await fetch(`/api/fs/directories${query}`);
  } catch {
    return;
  }
  if (seq !== dirBrowseSeq) return;

  if (!res.ok) {
    if (fallbackToDefault && target && res.status !== 401) return browseDirectory('');
    await reportError(res, 'Não foi possível abrir a pasta');
    return;
  }

  dirBrowserState = await res.json();
  if (seq !== dirBrowseSeq) return;
  renderDirBrowser();
  // The browsed folder is the selection — Salvar uses it
  document.getElementById('inputDirectory').value = dirBrowserState.path;
}

function renderDirBrowser() {
  const state = dirBrowserState;
  const pathEl = document.getElementById('dirBrowserPath');
  pathEl.textContent = state.path;
  pathEl.title = state.path;
  document.getElementById('btnDirUp').disabled = !state.parent;

  // Drive picker only makes sense with more than one root (Windows)
  const rootSelect = document.getElementById('selectDirRoot');
  rootSelect.hidden = state.roots.length < 2;
  rootSelect.innerHTML = '';
  const currentRoot = state.roots.find(r => state.path.toUpperCase().startsWith(r.toUpperCase()));
  state.roots.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    if (r === currentRoot) opt.selected = true;
    rootSelect.appendChild(opt);
  });

  const list = document.getElementById('dirBrowserList');
  list.innerHTML = '';
  list.scrollTop = 0;
  if (!state.directories.length) {
    const empty = document.createElement('li');
    empty.className = 'dir-browser-empty';
    empty.textContent = 'Nenhuma subpasta';
    list.appendChild(empty);
    return;
  }
  state.directories.forEach(d => {
    const li = document.createElement('li');
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'dir-browser-item';
    item.innerHTML = FOLDER_ICON;
    const name = document.createElement('span');
    name.textContent = d.name;
    item.appendChild(name);
    item.addEventListener('click', () => browseDirectory(d.path));
    li.appendChild(item);
    list.appendChild(li);
  });
}

async function saveDirectory() {
  const dir = document.getElementById('inputDirectory').value.trim();
  if (!dir) return;

  const res = await fetch('/api/config/directory', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory: dir })
  });

  if (res.ok) {
    const data = await res.json();
    document.getElementById('currentDir').textContent = data.audioDir;
    closeModal('modalDirectory');
    loadCategories();
  } else {
    await reportError(res, 'Não foi possível alterar a pasta');
  }
}


let addAudioSource = 'file'; 

function openAddAudioModal() {
  clearFile();
  setAddAudioSource('file');
  document.getElementById('inputYoutubeUrl').value = '';
  document.getElementById('inputYoutubeName').value = '';
  document.getElementById('inputYoutubeStart').value = '';
  document.getElementById('inputYoutubeEnd').value = '';
  document.getElementById('inputYoutubeDownload').checked = true;
  updateYoutubeDownloadUi();
  populateCategorySelect();
  openModal('modalAddAudio');
}

function initSourceToggle() {
  document.getElementById('sourceToggle').querySelectorAll('.source-option').forEach(btn => {
    btn.addEventListener('click', () => setAddAudioSource(btn.dataset.source));
  });

  
  document.getElementById('inputYoutubeUrl').addEventListener('input', () => {
    if (addAudioSource === 'youtube') {
      document.getElementById('btnUpload').disabled = !document.getElementById('inputYoutubeUrl').value.trim();
    }
  });

  
  document.getElementById('inputYoutubeDownload').addEventListener('change', updateYoutubeDownloadUi);
}


function updateYoutubeDownloadUi() {
  const download = document.getElementById('inputYoutubeDownload').checked;
  document.getElementById('youtubeSectionArea').style.display = download ? '' : 'none';
}

function setAddAudioSource(source) {
  addAudioSource = source;
  document.querySelectorAll('.source-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.source === source);
  });
  document.getElementById('fileSourceArea').style.display = source === 'file' ? '' : 'none';
  document.getElementById('youtubeSourceArea').style.display = source === 'youtube' ? '' : 'none';

  
  if (source === 'file') {
    document.getElementById('btnUpload').disabled = !document.getElementById('inputAudioFile').files[0];
  } else {
    document.getElementById('btnUpload').disabled = !document.getElementById('inputYoutubeUrl').value.trim();
  }
}

async function populateCategorySelect() {
  const res = await fetch('/api/categories');
  const categories = await res.json();
  const select = document.getElementById('selectCategory');
  select.innerHTML = '';
  categories.filter(c => c !== 'Geral').forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    if (cat === currentCategory) opt.selected = true;
    select.appendChild(opt);
  });
}

async function promptNewCategory() {
  openNewCategoryModal(async (name) => {
    const res = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) return reportError(res, 'Não foi possível criar a categoria');

    await populateCategorySelect();
    document.getElementById('selectCategory').value = name;
    loadCategories();
  });
}

function onFileSelected() {
  const input = document.getElementById('inputAudioFile');
  const file = input.files[0];
  if (!file) return;

  document.getElementById('selectedFileName').textContent = file.name;
  document.getElementById('selectedFile').style.display = 'flex';
  document.getElementById('uploadArea').style.display = 'none';
  document.getElementById('btnUpload').disabled = false;
}

function clearFile() {
  document.getElementById('inputAudioFile').value = '';
  document.getElementById('selectedFile').style.display = 'none';
  document.getElementById('uploadArea').style.display = '';
  document.getElementById('btnUpload').disabled = true;
}

async function uploadAudio() {
  if (addAudioSource === 'youtube') {
    return uploadYouTubeAudio();
  }

  const input = document.getElementById('inputAudioFile');
  const file = input.files[0];
  if (!file) return;

  const category = document.getElementById('selectCategory').value;
  if (!category) return alert('Crie uma categoria antes de adicionar áudios.');
  const formData = new FormData();
  formData.append('audio', file);
  formData.append('category', category);

  document.getElementById('btnUpload').disabled = true;
  document.getElementById('btnUpload').textContent = 'Adicionando…';

  const res = await fetch('/api/audios', { method: 'POST', body: formData });

  if (res.ok) {
    closeModal('modalAddAudio');
    currentCategory = category;
    setActiveCategory(category);
    loadAudios(category);
  } else {
    await reportError(res, 'Não foi possível adicionar o áudio');
  }

  document.getElementById('btnUpload').textContent = 'Adicionar';
  document.getElementById('btnUpload').disabled = false;
}

async function uploadYouTubeAudio() {
  const url = document.getElementById('inputYoutubeUrl').value.trim();
  const name = document.getElementById('inputYoutubeName').value.trim();
  const download = document.getElementById('inputYoutubeDownload').checked;
  const start = download ? document.getElementById('inputYoutubeStart').value.trim() : '';
  const end = download ? document.getElementById('inputYoutubeEnd').value.trim() : '';
  const category = document.getElementById('selectCategory').value;
  if (!url) return;
  if (!category) return alert('Crie uma categoria antes de adicionar áudios.');

  document.getElementById('btnUpload').disabled = true;
  document.getElementById('btnUpload').textContent = download ? 'Baixando...' : 'Salvando...';

  try {
    const res = await fetch('/api/audios/youtube', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, url, name: name || null, download, start: start || null, end: end || null })
    });

    if (res.ok) {
      closeModal('modalAddAudio');
      currentCategory = category;
      setActiveCategory(category);
      loadAudios(category);
    } else {
      await reportError(res, 'Erro ao salvar YouTube');
    }
  } catch (err) {
    console.error('YouTube save error:', err);
    alert('Erro ao salvar YouTube');
  }

  document.getElementById('btnUpload').textContent = 'Adicionar';
  document.getElementById('btnUpload').disabled = false;
}


let editingAudio = null;

async function openEditModal(audio) {
  editingAudio = audio;
  document.getElementById('editAudioName').textContent = audio.name;

  
  const displayInput = document.getElementById('inputDisplayName');
  displayInput.value = audio.display || '';

  
  const res = await fetch('/api/categories');
  const categories = await res.json();
  const select = document.getElementById('selectEditCategory');
  select.innerHTML = '';
  // The audio's own folder must be an option even when it isn't a listed tab
  // (a legacy real "Geral" folder) — otherwise the select falls back to the
  // first category and saving silently moves the audio there.
  const options = categories.filter(c => c !== 'Geral');
  if (!options.includes(audio.category)) options.unshift(audio.category);
  options.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    if (cat === audio.category) opt.selected = true;
    select.appendChild(opt);
  });

  const thumbImg = document.getElementById('thumbImg');
  const thumbPlaceholder = document.getElementById('thumbPlaceholder');
  if (audio.thumbnail) {
    thumbImg.src = audio.thumbnail;
    thumbImg.style.display = 'block';
    thumbPlaceholder.style.display = 'none';
  } else {
    thumbImg.style.display = 'none';
    thumbPlaceholder.style.display = '';
  }

  document.getElementById('inputThumbFile').value = '';
  document.getElementById('btnSaveThumb').disabled = false;
  openModal('modalEditAudio');
}

function initEditModal() {
  const thumbArea = document.getElementById('thumbUploadArea');
  const thumbInput = document.getElementById('inputThumbFile');

  thumbArea.addEventListener('click', () => thumbInput.click());
  thumbInput.addEventListener('change', () => {
    const file = thumbInput.files[0];
    if (!file) return;

    
    const reader = new FileReader();
    reader.onload = e => {
      const img = document.getElementById('thumbImg');
      img.src = e.target.result;
      img.style.display = 'block';
      document.getElementById('thumbPlaceholder').style.display = 'none';
    };
    reader.readAsDataURL(file);
    document.getElementById('btnSaveThumb').disabled = false;
  });

  document.getElementById('btnSaveThumb').addEventListener('click', saveEdit);
}

async function saveEdit() {
  if (!editingAudio) return;

  document.getElementById('btnSaveThumb').disabled = true;
  document.getElementById('btnSaveThumb').textContent = 'Salvando...';

  let activeCategory = editingAudio.category;

  
  const displayName = document.getElementById('inputDisplayName').value;
  const failures = [];
  const displayRes = await fetch('/api/audios/display', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: activeCategory,
      filename: editingAudio.filename,
      display: displayName
    })
  });
  if (!displayRes.ok) failures.push(displayRes);

  
  const file = document.getElementById('inputThumbFile').files[0];
  if (file) {
    const formData = new FormData();
    formData.append('thumbnail', file);
    formData.append('category', activeCategory);
    formData.append('filename', editingAudio.filename);
    const thumbRes = await fetch('/api/audios/thumbnail', { method: 'PUT', body: formData });
    if (!thumbRes.ok) failures.push(thumbRes);
  }

  
  const targetCategory = document.getElementById('selectEditCategory').value;
  if (targetCategory && targetCategory !== activeCategory) {
    const moveRes = await fetch('/api/audios/move', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: activeCategory,
        filename: editingAudio.filename,
        targetCategory
      })
    });
    if (!moveRes.ok) failures.push(moveRes);
  }

  if (failures.length) await reportError(failures[0], 'Não foi possível salvar as alterações');

  closeModal('modalEditAudio');
  loadAudios(currentCategory);

  document.getElementById('btnSaveThumb').textContent = 'Salvar';
  document.getElementById('btnSaveThumb').disabled = false;
}


let searchTimeout = null;

function initSearch() {
  const input = document.getElementById('inputSearch');
  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => performSearch(input.value), 300);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      clearTimeout(searchTimeout);
      performSearch('');
    }
  });
}

async function performSearch(query) {
  const trimmed = query.trim();
  if (!trimmed) {
    
    document.querySelectorAll('.category-tab').forEach(t => t.disabled = false);
    setActiveCategory(currentCategory);
    loadAudios(currentCategory);
    return;
  }

  
  document.querySelectorAll('.category-tab').forEach(t => {
    t.classList.remove('active');
    t.disabled = true;
  });
  document.querySelector('.category-add-btn').disabled = false;

  const seq = ++gridRequestSeq;
  const res = await fetch(`/api/audios/search?q=${encodeURIComponent(trimmed)}`);
  const audios = await res.json();
  if (seq !== gridRequestSeq) return;
  renderAudioGrid(audios, trimmed);
}


let modalReturnFocus = null;

function openModal(id) {
  const overlay = document.getElementById(id);
  modalReturnFocus = document.activeElement;
  overlay.style.display = 'flex';
  const first = overlay.querySelector('.modal-body input:not([type="checkbox"]):not([style*="display:none"]), .modal-body select');
  if (first) setTimeout(() => first.focus(), 50);
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
  if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
  modalReturnFocus = null;
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal-overlay')].filter(o => o.style.display !== 'none');
  if (open.length) closeModal(open[open.length - 1].id);
});


async function loadDiscordStatus() {
  try {
    const res = await fetch('/api/discord/status');
    if (res.status === 401) return;
    discordStatus = await res.json();
    renderDiscordIndicator();
    renderDiscordModal();
    updatePlaylistFromStatus();
  } catch {}
}

function renderDiscordIndicator() {
  const dot = document.getElementById('discordDot');
  const label = document.getElementById('discordLabel');

  dot.className = 'discord-dot';
  if (discordStatus.online) {
    const inVoice = discordStatus.guilds.some(g => g.connected);
    if (inVoice) {
      dot.classList.add('voice');
      const guild = discordStatus.guilds.find(g => g.connected);
      const ch = guild.voiceChannels.find(c => c.id === guild.channelId);
      label.textContent = ch ? ch.name : 'Conectado';
    } else {
      dot.classList.add('online');
      label.textContent = 'Discord';
    }
  } else {
    label.textContent = 'Discord';
  }
}

function renderDiscordModal() {
  const statusDot = document.getElementById('discordStatusDot');
  const statusText = document.getElementById('discordStatusText');
  const onlineSection = document.getElementById('discordOnlineSection');

  statusDot.className = 'discord-status-dot';
  if (discordStatus.online) {
    statusDot.classList.add('online');
    statusText.textContent = `Conectado como ${discordStatus.username}`;
    onlineSection.style.display = '';

    const guildSelect = document.getElementById('selectGuild');
    const previousGuildId = guildSelect.value;
    guildSelect.innerHTML = '';
    discordStatus.guilds.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.userChannelId ? `${g.name} (você está aqui)` : g.name;
      guildSelect.appendChild(opt);
    });

    const preferred = pickPreferredGuildId(previousGuildId);
    if (preferred) guildSelect.value = preferred;

    if (guildSelect.options.length > 0) {
      populateVoiceChannels();
    }
  } else {
    statusText.textContent = 'Desconectado';
    onlineSection.style.display = 'none';
  }
}

// Which server the modal should show. A manual pick survives the 30s status
// polling; otherwise prefer the server where the user is in a voice channel,
// then the one the bot is connected to, then whatever was selected before.
function pickPreferredGuildId(previousGuildId) {
  const guilds = discordStatus.guilds || [];
  const has = id => id && guilds.some(g => g.id === id);

  if (guildPickedManually && has(previousGuildId)) return previousGuildId;

  const userGuild = guilds.find(g => g.userChannelId);
  if (userGuild) return userGuild.id;

  const connectedGuild = guilds.find(g => g.connected);
  if (connectedGuild) return connectedGuild.id;

  if (has(previousGuildId)) return previousGuildId;
  return guilds[0]?.id || null;
}

function populateVoiceChannels() {
  const guildId = document.getElementById('selectGuild').value;
  const guild = discordStatus.guilds.find(g => g.id === guildId);
  const channelSelect = document.getElementById('selectVoiceChannel');
  const previousChannelId = channelSelect.value;
  channelSelect.innerHTML = '';
  if (guild) {
    // A manual pick survives status polling; otherwise the user's own channel
    // wins over the bot's current one
    const keepPrevious = channelPickedManually && guild.voiceChannels.some(c => c.id === previousChannelId);
    const selectedId = keepPrevious
      ? previousChannelId
      : guild.userChannelId || (guild.connected ? guild.channelId : null);
    guild.voiceChannels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = ch.userPresent ? `${ch.name} (você está aqui)` : ch.name;
      if (ch.id === selectedId) opt.selected = true;
      channelSelect.appendChild(opt);
    });
  }
}

function initDiscordModal() {
  document.getElementById('selectGuild').addEventListener('change', () => {
    guildPickedManually = true;
    channelPickedManually = false;
    populateVoiceChannels();
  });
  document.getElementById('selectVoiceChannel').addEventListener('change', () => {
    channelPickedManually = true;
  });

  document.getElementById('btnJoinChannel').addEventListener('click', async () => {
    const guildId = document.getElementById('selectGuild').value;
    const channelId = document.getElementById('selectVoiceChannel').value;
    if (!guildId || !channelId) return;

    try {
      const res = await fetch('/api/discord/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId, channelId })
      });
      if (res.ok) {
        await loadDiscordStatus();
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao entrar no canal');
      }
    } catch {
      alert('Erro de conexão');
    }
  });

  document.getElementById('btnLeaveChannel').addEventListener('click', async () => {
    const guildId = document.getElementById('selectGuild').value;
    if (!guildId) return;

    try {
      await fetch('/api/discord/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId })
      });
      await loadDiscordStatus();
    } catch {}
  });
}

async function playInDiscord(category, filename) {
  try {
    const res = await fetch('/api/discord/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, filename })
    });
    if (!res.ok) {
      const data = await res.json();
      console.error('Discord play error:', data.error);
    }
  } catch (err) {
    console.error('Discord play error:', err);
  }
}

async function stopDiscord() {
  try {
    await fetch('/api/discord/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
  } catch {}
}


function openPlaylistModal() {
  document.getElementById('inputPlaylistUrl').value = '';
  document.getElementById('inputPlaylistLoop').checked = false;
  setPlaylistOrder('order');
  openModal('modalPlaylist');
  setTimeout(() => document.getElementById('inputPlaylistUrl').focus(), 100);
}

function initPlaylistModal() {
  document.getElementById('playlistOrderToggle').querySelectorAll('.source-option').forEach(btn => {
    btn.addEventListener('click', () => setPlaylistOrder(btn.dataset.order));
  });
  document.getElementById('btnPlayPlaylist').addEventListener('click', startPlaylist);
  document.getElementById('inputPlaylistUrl').addEventListener('keydown', e => {
    if (e.key === 'Enter') startPlaylist();
  });
}

function setPlaylistOrder(order) {
  playlistOrder = order;
  document.querySelectorAll('#playlistOrderToggle .source-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.order === order);
  });
}

async function startPlaylist() {
  const url = document.getElementById('inputPlaylistUrl').value.trim();
  if (!url) return;
  const loop = document.getElementById('inputPlaylistLoop').checked;
  const shuffle = playlistOrder === 'shuffle';

  const btn = document.getElementById('btnPlayPlaylist');
  btn.disabled = true;
  btn.textContent = 'Carregando...';

  try {
    const res = await fetch('/api/discord/play-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, loop, shuffle })
    });
    const data = await res.json();
    if (res.ok) {
      closeModal('modalPlaylist');
      
      clearBrowserPlayback();
      
      playlistInfo = { active: true, index: 0, total: data.total, title: data.title, loop, shuffle };
      renderPlaylistToast();
      startPlaylistPoll();
      loadDiscordStatus();
    } else {
      alert(data.error || 'Erro ao tocar a playlist');
    }
  } catch (err) {
    console.error('Playlist error:', err);
    alert('Erro ao tocar a playlist');
  }

  btn.textContent = 'Tocar';
  btn.disabled = false;
}


function clearBrowserPlayback() {
  if (playingCard) {
    playingCard.classList.remove('playing');
    playingCard = null;
  }
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
  clearDiscordProgress();
}

function renderPlaylistToast() {
  if (!playlistInfo) return;
  const single = playlistInfo.total <= 1;
  $toastName.textContent = playlistInfo.title || (single ? 'YouTube' : 'Playlist');
  const flags = [];
  if (!single) flags.push(`${(playlistInfo.index || 0) + 1}/${playlistInfo.total}`);
  if (playlistInfo.shuffle && !single) flags.push('embaralhado');
  if (playlistInfo.loop) flags.push('loop');
  $toastTime.textContent = flags.join(' · ');
  $toast.classList.toggle('single-track', single);
  $toast.style.removeProperty('--pad');
  $toast.classList.add('playlist-mode', 'visible');
}

function startPlaylistPoll() {
  if (playlistPollTimer) return;
  playlistPollTimer = setInterval(loadDiscordStatus, 5000);
}

function stopPlaylistPoll() {
  if (playlistPollTimer) {
    clearInterval(playlistPollTimer);
    playlistPollTimer = null;
  }
}

async function stopPlaylist() {
  playlistInfo = null;
  stopPlaylistPoll();
  $toast.classList.remove('playlist-mode');
  hideToast();
  try {
    await fetch('/api/discord/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
  } catch {}
}


async function changePlaylistTrack(direction) {
  if (!playlistInfo) return;
  try {
    const res = await fetch(`/api/discord/playlist/${direction}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!res.ok) return;
    const data = await res.json();
    
    if (data.ended || data.skipped === false) {
      loadDiscordStatus();
      return;
    }
    
    playlistInfo = { ...playlistInfo, index: data.index, total: data.total, title: data.title };
    renderPlaylistToast();
  } catch (err) {
    console.error('Playlist skip error:', err);
  }
}


function updatePlaylistFromStatus() {
  const guild = (discordStatus.guilds || []).find(g => g.playlist && g.playlist.active);
  if (guild) {
    playlistInfo = { active: true, ...guild.playlist };
    startPlaylistPoll();
    if (!playingCard) renderPlaylistToast();
  } else if (playlistInfo) {
    playlistInfo = null;
    stopPlaylistPoll();
    $toast.classList.remove('playlist-mode');
    if (!playingCard) hideToast();
  }
}


function initPlaybackToggle() {
  
  if (requiresDiscordAuth(playbackMode) && !isAuthed) {
    playbackMode = 'local';
    localStorage.setItem('playbackMode', 'local');
  }

  const toggle = document.getElementById('playbackToggle');
  toggle.querySelectorAll('.toggle-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === playbackMode);
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === playbackMode));

    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (requiresDiscordAuth(mode) && !isAuthed) {
        notifyLoginRequired('tocar no canal de voz');
        return;
      }
      setPlaybackMode(mode);
    });
  });
}

function setPlaybackMode(mode) {
  playbackMode = mode;
  localStorage.setItem('playbackMode', mode);
  document.querySelectorAll('.toggle-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  });
}



function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

