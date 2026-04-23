// ===== State =====
let currentCategory = null;
let audioPlayer = null;
let playingCard = null;
let playbackMode = localStorage.getItem('playbackMode') || 'local';
let discordStatus = { online: false, username: null, guilds: [] };
let discordProgressTimer = null;
let discordStartTime = 0;

// ===== DOM =====
const $grid = document.getElementById('audioGrid');
const $empty = document.getElementById('emptyState');
const $catNav = document.getElementById('categoriesNav');
const $player = document.getElementById('audioPlayer');

// Toast DOM
const $toast = document.getElementById('toastPlayer');
const $toastName = document.getElementById('toastName');
const $toastTime = document.getElementById('toastTime');
const $toastBar = document.getElementById('toastProgressBar');
const $toastTrack = document.getElementById('toastProgressTrack');

// ===== Auth =====
async function checkAuth() {
  try {
    const res = await fetch('/auth/me');
    if (res.status === 401) {
      document.getElementById('loginScreen').style.display = '';
      document.querySelector('.app').style.display = 'none';
      return false;
    }
    const data = await res.json();
    window.currentUser = data.user;

    // Show app, hide login
    document.getElementById('loginScreen').style.display = 'none';
    document.querySelector('.app').style.display = '';

    // Update user display
    const userInfo = document.getElementById('userInfo');
    const avatar = document.getElementById('userAvatar');
    const userName = document.getElementById('userName');
    if (data.user.avatar) {
      avatar.src = `https://cdn.discordapp.com/avatars/${data.user.id}/${data.user.avatar}.png?size=32`;
    } else {
      avatar.src = `https://cdn.discordapp.com/embed/avatars/${(BigInt(data.user.id) >> 22n) % 6n}.png`;
    }
    userName.textContent = data.user.username;
    userInfo.style.display = 'flex';

    document.getElementById('btnLogout').addEventListener('click', async () => {
      await fetch('/auth/logout', { method: 'POST' });
      window.location.reload();
    });

    return true;
  } catch {
    document.getElementById('loginScreen').style.display = '';
    document.querySelector('.app').style.display = 'none';
    return false;
  }
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', async () => {
  // Check auth before anything else
  const authed = await checkAuth();
  if (!authed) return;

  audioPlayer = $player;
  audioPlayer.addEventListener('ended', () => stopPlaying());
  audioPlayer.addEventListener('timeupdate', updateToastProgress);

  // Click on progress bar to seek
  $toastTrack.addEventListener('click', e => {
    if (!audioPlayer.duration) return;
    const rect = $toastTrack.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audioPlayer.currentTime = ratio * audioPlayer.duration;
  });

  document.getElementById('toastClose').addEventListener('click', () => stopPlaying());

  loadConfig();
  loadCategories();
  loadDiscordStatus();
  setInterval(loadDiscordStatus, 30000);
  initPlaybackToggle();
  initDiscordModal();

  // Button listeners
  document.getElementById('btnDirectory').addEventListener('click', openDirectoryModal);
  document.getElementById('btnAddAudio').addEventListener('click', openAddAudioModal);
  document.getElementById('btnSaveDirectory').addEventListener('click', saveDirectory);
  document.getElementById('btnUpload').addEventListener('click', uploadAudio);
  document.getElementById('btnNewCategory').addEventListener('click', promptNewCategory);
  document.getElementById('btnConfirmNewCategory').addEventListener('click', confirmNewCategory);
  document.getElementById('inputNewCategory').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmNewCategory();
  });
  document.getElementById('btnDiscord').addEventListener('click', () => openModal('modalDiscord'));
  initEditModal();
  initSearch();
  initSourceToggle();

  // Upload area interactions
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('inputAudioFile');

  uploadArea.addEventListener('click', () => fileInput.click());
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

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  });

  // Close modal buttons (data-close attribute)
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  // Empty state "add first audio" button
  document.getElementById('btnAddFirstAudio').addEventListener('click', () => {
    document.getElementById('btnAddAudio').click();
  });

  // Clear file button
  document.getElementById('btnClearFile').addEventListener('click', clearFile);
});

// ===== API Calls =====
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

async function loadAudios(category) {
  const res = await fetch(`/api/audios?category=${encodeURIComponent(category)}`);
  const audios = await res.json();
  renderAudioGrid(audios);
}

// ===== Renderers =====
function renderCategories(categories) {
  $catNav.innerHTML = '';
  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'category-tab';
    btn.textContent = cat;
    btn.addEventListener('click', () => {
      // Clear search
      const searchInput = document.getElementById('inputSearch');
      if (searchInput) searchInput.value = '';
      document.querySelectorAll('.category-tab').forEach(t => t.disabled = false);

      currentCategory = cat;
      setActiveCategory(cat);
      loadAudios(cat);
    });
    $catNav.appendChild(btn);
  });

  // Add new category button
  const addBtn = document.createElement('button');
  addBtn.className = 'category-tab category-add-btn';
  addBtn.title = 'Nova categoria';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', addCategoryFromNav);
  $catNav.appendChild(addBtn);
}

// ===== New Category Modal =====
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
    await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    loadCategories();
  });
}

function setActiveCategory(name) {
  document.querySelectorAll('.category-tab').forEach(tab => {
    tab.classList.toggle('active', tab.textContent === name);
  });
}

function renderAudioGrid(audios) {
  $grid.innerHTML = '';

  if (audios.length === 0) {
    $grid.style.display = 'none';
    $empty.style.display = 'flex';
    return;
  }

  $grid.style.display = 'grid';
  $empty.style.display = 'none';

  audios.forEach(audio => {
    const card = document.createElement('div');
    card.className = 'audio-card';
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
        <button class="card-action-btn edit" title="Editar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
            <path d="m15 5 4 4"/>
          </svg>
        </button>
        <button class="card-action-btn delete" title="Remover">&times;</button>
      </div>
      ${iconHtml}
      <div class="card-name">${escapeHtml(audio.display || audio.name)}</div>
    `;

    card.addEventListener('click', e => {
      if (e.target.closest('.card-action-btn')) return;
      if (audio.type === 'youtube') {
        togglePlayYouTube(card, audio.youtubeUrl, audio.display || audio.name);
      } else {
        togglePlay(card, audio.url);
      }
    });

    card.querySelector('.card-action-btn.edit').addEventListener('click', e => {
      e.stopPropagation();
      openEditModal(audio);
    });

    card.querySelector('.card-action-btn.delete').addEventListener('click', e => {
      e.stopPropagation();
      deleteAudio(audio);
    });

    $grid.appendChild(card);
  });
}

// ===== Audio Playback =====
function togglePlay(card, url) {
  if (playingCard === card) {
    stopPlaying();
    return;
  }

  stopPlaying();
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

  // For discord-only mode, load audio metadata for duration and simulate progress
  if (playbackMode === 'discord') {
    audioPlayer.src = url;
    audioPlayer.addEventListener('loadedmetadata', function onMeta() {
      audioPlayer.removeEventListener('loadedmetadata', onMeta);
      discordStartTime = Date.now();
      const duration = audioPlayer.duration;
      discordProgressTimer = setInterval(() => {
        const elapsed = (Date.now() - discordStartTime) / 1000;
        if (elapsed >= duration) {
          stopPlaying();
          return;
        }
        const pct = (elapsed / duration) * 100;
        $toastBar.style.width = pct + '%';
        $toastTime.textContent = `${formatTime(elapsed)} / ${formatTime(duration)}`;
      }, 250);
    });
  }

  showToast(name);
}

function togglePlayYouTube(card, youtubeUrl, name) {
  if (playingCard === card) {
    stopPlaying();
    return;
  }

  stopPlaying();
  playingCard = card;
  card.classList.add('playing');

  // Browser playback (local or both)
  if (playbackMode === 'local' || playbackMode === 'both') {
    const streamUrl = '/api/youtube/stream?url=' + encodeURIComponent(youtubeUrl);
    audioPlayer.src = streamUrl;
    audioPlayer.play();
  }

  // Discord playback (discord or both)
  if (playbackMode === 'discord' || playbackMode === 'both') {
    fetch('/api/discord/play-youtube', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: youtubeUrl })
    }).catch(err => console.error('Discord YouTube play error:', err));
  }

  showToast(name);
}

function stopPlaying() {
  if (playingCard) {
    playingCard.classList.remove('playing');
    playingCard = null;
  }
  audioPlayer.pause();
  audioPlayer.currentTime = 0;

  if (discordProgressTimer) {
    clearInterval(discordProgressTimer);
    discordProgressTimer = null;
  }

  if (playbackMode === 'discord' || playbackMode === 'both') {
    stopDiscord();
  }

  hideToast();
}

function showToast(name) {
  $toastName.textContent = name;
  $toastTime.textContent = '0:00 / 0:00';
  $toastBar.style.width = '0%';
  $toast.classList.add('visible');
}

function hideToast() {
  $toast.classList.remove('visible');
}

function updateToastProgress() {
  if (!audioPlayer.duration) return;
  const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100;
  $toastBar.style.width = pct + '%';
  $toastTime.textContent = `${formatTime(audioPlayer.currentTime)} / ${formatTime(audioPlayer.duration)}`;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ===== Delete Audio =====
async function deleteAudio(audio) {
  if (!confirm(`Remover "${audio.name}"?`)) return;

  await fetch('/api/audios', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: audio.category, filename: audio.filename })
  });

  loadAudios(currentCategory);
}

// ===== Directory Modal =====
function openDirectoryModal() {
  loadConfig();
  openModal('modalDirectory');
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
  }
}

// ===== Add Audio Modal =====
let addAudioSource = 'file'; // 'file' or 'youtube'

function openAddAudioModal() {
  clearFile();
  setAddAudioSource('file');
  document.getElementById('inputYoutubeUrl').value = '';
  document.getElementById('inputYoutubeName').value = '';
  populateCategorySelect();
  openModal('modalAddAudio');
}

function initSourceToggle() {
  document.getElementById('sourceToggle').querySelectorAll('.source-option').forEach(btn => {
    btn.addEventListener('click', () => setAddAudioSource(btn.dataset.source));
  });

  // Enable upload button when YouTube URL is typed
  document.getElementById('inputYoutubeUrl').addEventListener('input', () => {
    if (addAudioSource === 'youtube') {
      document.getElementById('btnUpload').disabled = !document.getElementById('inputYoutubeUrl').value.trim();
    }
  });
}

function setAddAudioSource(source) {
  addAudioSource = source;
  document.querySelectorAll('.source-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.source === source);
  });
  document.getElementById('fileSourceArea').style.display = source === 'file' ? '' : 'none';
  document.getElementById('youtubeSourceArea').style.display = source === 'youtube' ? '' : 'none';

  // Reset upload button state
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
    await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });

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
  const formData = new FormData();
  formData.append('audio', file);
  formData.append('category', category);

  document.getElementById('btnUpload').disabled = true;
  document.getElementById('btnUpload').textContent = 'Enviando...';

  const res = await fetch('/api/audios', { method: 'POST', body: formData });

  if (res.ok) {
    closeModal('modalAddAudio');
    currentCategory = category;
    setActiveCategory(category);
    loadAudios(category);
  }

  document.getElementById('btnUpload').textContent = 'Enviar';
  document.getElementById('btnUpload').disabled = false;
}

async function uploadYouTubeAudio() {
  const url = document.getElementById('inputYoutubeUrl').value.trim();
  const name = document.getElementById('inputYoutubeName').value.trim();
  const category = document.getElementById('selectCategory').value;
  if (!url) return;

  document.getElementById('btnUpload').disabled = true;
  document.getElementById('btnUpload').textContent = 'Salvando...';

  try {
    const res = await fetch('/api/audios/youtube', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, url, name: name || null })
    });

    if (res.ok) {
      closeModal('modalAddAudio');
      currentCategory = category;
      setActiveCategory(category);
      loadAudios(category);
    } else {
      const data = await res.json();
      alert(data.error || 'Erro ao salvar YouTube');
    }
  } catch (err) {
    console.error('YouTube save error:', err);
    alert('Erro ao salvar YouTube');
  }

  document.getElementById('btnUpload').textContent = 'Enviar';
  document.getElementById('btnUpload').disabled = false;
}

// ===== Edit Audio Modal =====
let editingAudio = null;

async function openEditModal(audio) {
  editingAudio = audio;
  document.getElementById('editAudioName').textContent = audio.name;

  // Display name
  const displayInput = document.getElementById('inputDisplayName');
  displayInput.value = audio.display || '';

  // Populate category select
  const res = await fetch('/api/categories');
  const categories = await res.json();
  const select = document.getElementById('selectEditCategory');
  select.innerHTML = '';
  categories.filter(c => c !== 'Geral').forEach(cat => {
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

    // Preview
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

  // Save display name
  const displayName = document.getElementById('inputDisplayName').value;
  await fetch('/api/audios/display', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: activeCategory,
      filename: editingAudio.filename,
      display: displayName
    })
  });

  // Save thumbnail if a new file was selected
  const file = document.getElementById('inputThumbFile').files[0];
  if (file) {
    const formData = new FormData();
    formData.append('thumbnail', file);
    formData.append('category', activeCategory);
    formData.append('filename', editingAudio.filename);
    await fetch('/api/audios/thumbnail', { method: 'PUT', body: formData });
  }

  // Move to another category if changed
  const targetCategory = document.getElementById('selectEditCategory').value;
  if (targetCategory && targetCategory !== activeCategory) {
    await fetch('/api/audios/move', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: activeCategory,
        filename: editingAudio.filename,
        targetCategory
      })
    });
  }

  closeModal('modalEditAudio');
  loadAudios(currentCategory);

  document.getElementById('btnSaveThumb').textContent = 'Salvar';
  document.getElementById('btnSaveThumb').disabled = false;
}

// ===== Search =====
let searchTimeout = null;

function initSearch() {
  const input = document.getElementById('inputSearch');
  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => performSearch(input.value), 300);
  });
}

async function performSearch(query) {
  const trimmed = query.trim();
  if (!trimmed) {
    // Clear search — reload current category
    document.querySelectorAll('.category-tab').forEach(t => t.disabled = false);
    setActiveCategory(currentCategory);
    loadAudios(currentCategory);
    return;
  }

  // Visual feedback: deselect category tabs
  document.querySelectorAll('.category-tab').forEach(t => {
    t.classList.remove('active');
    t.disabled = true;
  });
  document.querySelector('.category-add-btn').disabled = false;

  const res = await fetch(`/api/audios/search?q=${encodeURIComponent(trimmed)}`);
  const audios = await res.json();
  renderAudioGrid(audios);
}

// ===== Modal Helpers =====
function openModal(id) {
  document.getElementById(id).style.display = 'flex';
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

// ===== Discord Integration =====
async function loadDiscordStatus() {
  try {
    const res = await fetch('/api/discord/status');
    if (res.status === 401) return;
    discordStatus = await res.json();
    renderDiscordIndicator();
    renderDiscordModal();
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

    // Populate guilds
    const guildSelect = document.getElementById('selectGuild');
    guildSelect.innerHTML = '';
    discordStatus.guilds.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.name;
      guildSelect.appendChild(opt);
    });

    if (guildSelect.options.length > 0) {
      populateVoiceChannels();
    }
  } else {
    statusText.textContent = 'Desconectado';
    onlineSection.style.display = 'none';
  }
}

function populateVoiceChannels() {
  const guildId = document.getElementById('selectGuild').value;
  const guild = discordStatus.guilds.find(g => g.id === guildId);
  const channelSelect = document.getElementById('selectVoiceChannel');
  channelSelect.innerHTML = '';
  if (guild) {
    guild.voiceChannels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = ch.userPresent ? `${ch.name} (você está aqui)` : ch.name;
      if (guild.connected && guild.channelId === ch.id) {
        opt.selected = true;
      } else if (ch.userPresent) {
        opt.selected = true;
      }
      channelSelect.appendChild(opt);
    });
  }
}

function initDiscordModal() {
  document.getElementById('selectGuild').addEventListener('change', populateVoiceChannels);

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

// ===== Playback Mode =====
function initPlaybackToggle() {
  const toggle = document.getElementById('playbackToggle');
  toggle.querySelectorAll('.toggle-option').forEach(btn => {
    if (btn.dataset.mode === playbackMode) btn.classList.add('active');
    else btn.classList.remove('active');

    btn.addEventListener('click', () => {
      setPlaybackMode(btn.dataset.mode);
    });
  });
}

function setPlaybackMode(mode) {
  playbackMode = mode;
  localStorage.setItem('playbackMode', mode);
  document.querySelectorAll('.toggle-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}


// ===== Utilities =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
