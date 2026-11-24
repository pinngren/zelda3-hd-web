// Zelda 3 HD-3D Chromebook PWA Controller
(() => {
  'use strict';

  const PRESET_NAMES = [
    'HD-3D Diorama',
    'HD-3D Sculpted',
    'HD Smooth Vector',
    'HD-2D Pixel + Lighting',
    'Retro CRT Glow',
    'Classic Original',
  ];

  const PRESET_DEFAULTS = {
    0: { RELIEF_STRENGTH: 1.10, SPECULAR_STRENGTH: 0.36, AO_STRENGTH: 0.58, BLOOM_STRENGTH: 0.38, TILT_SHIFT_STRENGTH: 0.60, COLOR_VIBRANCE: 0.24, VIGNETTE_STRENGTH: 0.18 },
    1: { RELIEF_STRENGTH: 1.05, SPECULAR_STRENGTH: 0.34, AO_STRENGTH: 0.52, BLOOM_STRENGTH: 0.35, TILT_SHIFT_STRENGTH: 0.00, COLOR_VIBRANCE: 0.22, VIGNETTE_STRENGTH: 0.14 },
    2: { RELIEF_STRENGTH: 0.00, SPECULAR_STRENGTH: 0.00, AO_STRENGTH: 0.00, BLOOM_STRENGTH: 0.16, TILT_SHIFT_STRENGTH: 0.00, COLOR_VIBRANCE: 0.18, VIGNETTE_STRENGTH: 0.06 },
    3: { RELIEF_STRENGTH: 0.65, SPECULAR_STRENGTH: 0.25, AO_STRENGTH: 0.42, BLOOM_STRENGTH: 0.38, TILT_SHIFT_STRENGTH: 0.35, COLOR_VIBRANCE: 0.20, VIGNETTE_STRENGTH: 0.18 },
    4: {},
    5: {},
  };

  // IndexedDB store for zelda3_assets.dat & optional .zspr
  const DB_NAME = 'Zelda3HD3D_Assets';
  const STORE_NAME = 'files';

  function openAssetDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openAssetDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(key, val) {
    const db = await openAssetDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(key) {
    const db = await openAssetDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // UI Elements
  const $ = (id) => document.getElementById(id);
  const setupScreen = $('setup-screen');
  const gameStage = $('game-stage');
  const canvas = $('canvas');
  const engineStatus = $('engine-status');
  const cachedBar = $('cached-assets-bar');
  const cachedMeta = $('cached-asset-meta');
  const dropZone = $('drop-zone');
  const fileInput = $('file-input');
  const topBar = $('top-bar');
  const studioDrawer = $('studio-drawer');
  const savesDrawer = $('saves-drawer');
  const touchOverlay = $('touch-overlay');
  const toastEl = $('toast');
  const presetBadge = $('preset-badge');

  let wasmReady = false;
  let gameStarted = false;
  let cachedAssets = null;
  let cachedZspr = null;
  let toastTimer = null;
  let barFadeTimer = null;
  let deferredInstallPrompt = null;

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
  }

  function setStatus(msg, isError = false) {
    engineStatus.textContent = msg;
    engineStatus.classList.toggle('error', isError);
  }

  // Register Service Worker for offline Chromebook PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // Handle PWA Install Prompt on Chromebook
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $('btn-install-pwa').classList.remove('hidden');
  });

  $('btn-install-pwa').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('btn-install-pwa').classList.add('hidden');
  });

  // Emscripten Module configuration
  window.ZeldaSyncSaves = () => {
    if (!window.Module || !Module.FS) return;
    Module.FS.syncfs(false, (err) => {
      if (err) console.error('Save sync error:', err);
    });
  };

  window.ZeldaOnStatus = (msg) => {
    showToast(msg);
    if (window.Module && Module._web_get_graphics_preset) {
      const idx = Module._web_get_graphics_preset();
      syncPresetUI(idx);
    }
  };

  window.ZeldaOnReady = () => {
    gameStarted = true;
    setupScreen.classList.add('hidden');
    gameStage.classList.remove('hidden');
    resizeGameCanvas();
    canvas.focus();
    const idx = Module._web_get_graphics_preset();
    syncPresetUI(idx);
    showToast(`Graphics: ${PRESET_NAMES[idx] || 'HD-3D Diorama'} (Press F11 to switch)`);
    scheduleTopBarFade();
  };

  window.ZeldaOnError = (err) => {
    setStatus(`Error: ${err}`, true);
    showToast(`Error: ${err}`);
  };

  window.Module = {
    canvas: canvas,
    print: (text) => console.log('[zelda3]', text),
    printErr: (text) => console.warn('[zelda3]', text),
    onRuntimeInitialized: async () => {
      wasmReady = true;
      // Mount persistent IDBFS for /saves
      try {
        Module.FS.mkdir('/saves');
      } catch (_) {}
      try {
        Module.FS.mount(Module.IDBFS, {}, '/saves');
        await new Promise((resolve) => Module.FS.syncfs(true, () => resolve()));
      } catch (e) {
        console.warn('IDBFS mount fallback:', e);
      }

      setStatus('WebAssembly HD-3D Engine Ready');
      await checkCachedAssets();
    },
  };

  async function checkCachedAssets() {
    try {
      cachedAssets = await idbGet('zelda3_assets.dat');
      cachedZspr = await idbGet('custom_link.zspr');
      if (cachedAssets && cachedAssets.byteLength > 100000) {
        const mb = (cachedAssets.byteLength / (1024 * 1024)).toFixed(2);
        cachedMeta.textContent = `zelda3_assets.dat (${mb} MB)${cachedZspr ? ' + custom Link sprite' : ''}`;
        cachedBar.classList.remove('hidden');
      }
    } catch (e) {
      console.warn('IndexedDB unavailable:', e);
    }
  }

  function buildIniConfig() {
    const preset = $('launch-preset').value || 'hd3d_diorama';
    const widescreen = $('launch-widescreen').checked;
    const aspect = widescreen ? 'extend_y, 16:9' : 'extend_y, 4:3';
    const linkLine = cachedZspr ? 'LinkGraphics = /custom_link.zspr\n' : '';
    return `[General]
Autosave = 0
ExtendedAspectRatio = ${aspect}
DisableFrameDelay = 1

[Graphics]
WindowSize = Auto
Fullscreen = 0
WindowScale = 3
NewRenderer = 1
EnhancedMode7 = 1
IgnoreAspectRatio = 0
NoSpriteLimits = 1
OutputMethod = OpenGL ES
GraphicsPreset = ${preset}
${linkLine}
[Sound]
EnableAudio = 1
AudioFreq = 44100
AudioChannels = 2
AudioSamples = 1024

[KeyMap]
CycleShader = F11
`;
  }

  function launchGame(assetsBytes) {
    if (!wasmReady) {
      setStatus('Still loading WebAssembly engine — please wait a moment...');
      return;
    }
    try {
      Module.FS.writeFile('/zelda3_assets.dat', new Uint8Array(assetsBytes));
      if (cachedZspr) {
        Module.FS.writeFile('/custom_link.zspr', new Uint8Array(cachedZspr));
      }
      Module.FS.writeFile('/zelda3.ini', buildIniConfig());
      Module._web_start_game();
    } catch (err) {
      console.error(err);
      setStatus(`Failed to start game: ${err.message || err}`, true);
    }
  }

  async function handleFiles(fileList) {
    for (const file of fileList) {
      const name = file.name.toLowerCase();
      const buf = await file.arrayBuffer();
      if (name.endsWith('.zspr')) {
        cachedZspr = new Uint8Array(buf);
        await idbPut('custom_link.zspr', cachedZspr).catch(() => {});
        if (gameStarted && wasmReady) {
          Module.FS.writeFile('/custom_link.zspr', cachedZspr);
          Module.ccall('web_load_link_zspr', 'number', ['string'], ['/custom_link.zspr']);
        } else {
          showToast(`Custom Link sprite loaded: ${file.name}`);
          await checkCachedAssets();
        }
      } else if (name.endsWith('.dat')) {
        cachedAssets = new Uint8Array(buf);
        await idbPut('zelda3_assets.dat', cachedAssets).catch(() => {});
        await checkCachedAssets();
        launchGame(cachedAssets);
        return;
      } else if (name.endsWith('.bps')) {
        Module.FS.writeFile('/zelda3_assets.bps', new Uint8Array(buf));
        showToast('Loaded zelda3_assets.bps — now drop zelda3.sfc');
      } else if (name.endsWith('.sfc') || name.endsWith('.smc')) {
        if (wasmReady && Module.FS.analyzePath('/zelda3_assets.bps').exists) {
          Module.FS.writeFile('/zelda3.sfc', new Uint8Array(buf));
          Module.FS.writeFile('/zelda3.ini', buildIniConfig());
          Module._web_start_game();
          return;
        } else {
          setStatus('Raw .sfc ROM detected: please extract zelda3_assets.dat using restool.py (see help below) or drop zelda3_assets.bps first.', true);
        }
      }
    }
  }

  // Drop zone & buttons
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });

  $('btn-play-cached').addEventListener('click', () => {
    if (cachedAssets) launchGame(cachedAssets);
  });

  $('btn-clear-cached').addEventListener('click', async () => {
    await idbDelete('zelda3_assets.dat').catch(() => {});
    cachedAssets = null;
    cachedBar.classList.add('hidden');
  });

  // Canvas responsive resizing (handles Chromebook HiDPI & Fullscreen)
  function resizeGameCanvas() {
    if (!gameStarted || !wasmReady) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, Math.floor(window.innerWidth * dpr));
    const h = Math.max(240, Math.floor(window.innerHeight * dpr));
    canvas.width = w;
    canvas.height = h;
    if (Module._web_resize_canvas) {
      Module._web_resize_canvas(w, h);
    }
  }

  window.addEventListener('resize', resizeGameCanvas);
  document.addEventListener('fullscreenchange', () => setTimeout(resizeGameCanvas, 60));

  // Auto-fade top bar during gameplay
  function scheduleTopBarFade() {
    topBar.classList.remove('faded');
    clearTimeout(barFadeTimer);
    barFadeTimer = setTimeout(() => {
      if (studioDrawer.classList.contains('hidden') && savesDrawer.classList.contains('hidden')) {
        topBar.classList.add('faded');
      }
    }, 3200);
  }
  window.addEventListener('mousemove', () => { if (gameStarted) scheduleTopBarFade(); });

  // Graphics Studio Drawer & Live Controls
  function syncPresetUI(idx) {
    presetBadge.textContent = PRESET_NAMES[idx] || 'HD-3D Diorama';
    document.querySelectorAll('.preset-card').forEach((card) => {
      card.classList.toggle('active', Number(card.dataset.preset) === idx);
    });
    const defs = PRESET_DEFAULTS[idx] || {};
    Object.entries(defs).forEach(([param, val]) => {
      const input = document.querySelector(`input[data-param="${param}"]`);
      const out = $(`val-${param}`);
      if (input && out) {
        input.value = val;
        out.textContent = Number(val).toFixed(2);
      }
    });
  }

  function closeDrawers() {
    studioDrawer.classList.add('hidden');
    savesDrawer.classList.add('hidden');
    canvas.focus();
  }

  $('btn-studio').addEventListener('click', () => {
    savesDrawer.classList.add('hidden');
    studioDrawer.classList.toggle('hidden');
  });
  $('btn-close-studio').addEventListener('click', closeDrawers);

  $('btn-saves').addEventListener('click', () => {
    studioDrawer.classList.add('hidden');
    savesDrawer.classList.toggle('hidden');
  });
  $('btn-close-saves').addEventListener('click', closeDrawers);

  $('btn-cycle-preset').addEventListener('click', () => {
    if (!gameStarted) return;
    const idx = Module._web_cycle_graphics_preset();
    syncPresetUI(idx);
    canvas.focus();
  });

  document.querySelectorAll('.preset-card').forEach((card) => {
    card.addEventListener('click', () => {
      if (!gameStarted) return;
      const idx = Number(card.dataset.preset);
      Module._web_set_graphics_preset(idx);
      syncPresetUI(idx);
    });
  });

  document.querySelectorAll('input[data-param]').forEach((slider) => {
    slider.addEventListener('input', () => {
      const param = slider.dataset.param;
      const val = parseFloat(slider.value);
      const out = $(`val-${param}`);
      if (out) out.textContent = val.toFixed(2);
      if (gameStarted) {
        Module.ccall('web_set_shader_param', null, ['string', 'number'], [param, val]);
      }
    });
  });

  $('slider-volume').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    $('val-volume').textContent = `${v}%`;
    if (gameStarted) Module._web_set_volume(v);
  });

  $('btn-pause').addEventListener('click', () => {
    if (!gameStarted) return;
    Module._web_toggle_pause();
    const paused = Module._web_is_paused();
    $('btn-pause').textContent = paused ? 'Resume' : 'Pause';
    showToast(paused ? 'Paused' : 'Resumed');
  });

  $('btn-reset').addEventListener('click', () => {
    if (!gameStarted) return;
    Module._web_reset_game();
    showToast('Game Reset');
  });

  $('btn-upload-zspr').addEventListener('click', () => $('zspr-input').click());
  $('zspr-input').addEventListener('change', (e) => handleFiles(e.target.files));

  $('btn-fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      gameStage.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
    canvas.focus();
  });

  $('btn-touch-toggle').addEventListener('click', () => {
    touchOverlay.classList.toggle('hidden');
    canvas.focus();
  });

  // Escape opens/closes HD-3D Studio
  window.addEventListener('keydown', (e) => {
    if (!gameStarted) return;
    if (e.key === 'Escape') {
      if (!studioDrawer.classList.contains('hidden') || !savesDrawer.classList.contains('hidden')) {
        closeDrawers();
      } else {
        studioDrawer.classList.remove('hidden');
      }
    }
  });

  // Build Save State Slots UI
  const saveSlotsEl = $('save-slots');
  for (let i = 0; i < 5; i++) {
    const row = document.createElement('div');
    row.className = 'save-slot';
    row.innerHTML = `
      <span>Slot ${i + 1} <small style="color:var(--text-dim)">(F${i + 1})</small></span>
      <div class="btn-row">
        <button class="btn btn-primary btn-sm" data-save="${i}">Save</button>
        <button class="btn btn-ghost btn-sm" data-load="${i}">Load</button>
      </div>`;
    saveSlotsEl.appendChild(row);
  }
  saveSlotsEl.addEventListener('click', (e) => {
    if (!gameStarted) return;
    const saveSlot = e.target.dataset.save;
    const loadSlot = e.target.dataset.load;
    if (saveSlot !== undefined) {
      Module._web_save_state(Number(saveSlot));
      showToast(`Saved to Slot ${Number(saveSlot) + 1}`);
    } else if (loadSlot !== undefined) {
      Module._web_load_state(Number(loadSlot));
      showToast(`Loaded Slot ${Number(loadSlot) + 1}`);
    }
  });

  // SRAM Export / Import
  $('btn-export-sram').addEventListener('click', () => {
    if (!wasmReady) return;
    try {
      const data = Module.FS.readFile('/saves/sram.dat');
      const blob = new Blob([data], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'zelda3_sram.dat';
      a.click();
      URL.revokeObjectURL(a.href);
      showToast('Exported sram.dat');
    } catch (_) {
      showToast('No in-game save (sram.dat) found yet');
    }
  });

  $('btn-import-sram').addEventListener('click', () => $('sram-input').click());
  $('sram-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f || !wasmReady) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    Module.FS.writeFile('/saves/sram.dat', buf);
    window.ZeldaSyncSaves();
    showToast('Imported sram.dat — reset or reload to apply');
  });

  // Touch Controls Binding
  document.querySelectorAll('.tbtn[data-bit]').forEach((btn) => {
    const bit = Number(btn.dataset.bit);
    const press = (e) => {
      e.preventDefault();
      btn.classList.add('pressed');
      if (gameStarted) Module._web_set_touch_button(bit, 1);
    };
    const release = (e) => {
      e.preventDefault();
      btn.classList.remove('pressed');
      if (gameStarted) Module._web_set_touch_button(bit, 0);
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  });
})();
