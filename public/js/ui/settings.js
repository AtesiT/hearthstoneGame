// settings.js — панель настроек (Этап 5): музыка, звуки, подсказки.
// Хранение: localStorage emberfall:settings (безопасно в приватном режиме).
import * as music from '../audio/music.js';
import * as sfx from '../audio/sfx.js';

const $ = (s) => document.querySelector(s);
const LS_KEY = 'emberfall:settings';

const defaults = { musicVol: 80, sfxOn: true, hintsOn: true };

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...defaults };
}

function save(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

let state = load();
// применяем сохранённое сразу (до открытия панели)
music.setVolume(state.musicVol / 100);
sfx.setMuted(!state.sfxOn);

export function hintsOn() {
  return !!state.hintsOn;
}

export function getSettings() {
  return { ...state };
}

function apply() {
  save(state);
  music.setVolume(state.musicVol / 100);
  sfx.setMuted(!state.sfxOn);
}

export function init() {
  const panel = $('#settings-panel');
  if (!panel) return;

  const vol = $('#set-music-vol');
  const sfxChk = $('#set-sfx');
  const hintsChk = $('#set-hints');
  vol.value = String(state.musicVol);
  vol.nextElementSibling.textContent = `${state.musicVol}%`;
  sfxChk.checked = state.sfxOn;
  hintsChk.checked = state.hintsOn;

  vol.addEventListener('input', () => {
    state.musicVol = Math.max(0, Math.min(100, parseInt(vol.value, 10) || 0));
    vol.nextElementSibling.textContent = `${state.musicVol}%`;
    apply();
  });
  sfxChk.addEventListener('change', () => {
    state.sfxOn = sfxChk.checked;
    apply();
    if (state.sfxOn) sfx.play('blip');
  });
  hintsChk.addEventListener('change', () => {
    state.hintsOn = hintsChk.checked;
    apply();
  });

  $('#btn-settings').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });
  $('#btn-settings-close').addEventListener('click', () => {
    panel.hidden = true;
  });
  panel.addEventListener('click', (e) => {
    if (e.target === panel) panel.hidden = true;
  });
}
