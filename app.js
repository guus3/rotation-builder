(function () {
  const STORE_KEY = 'rotation-builder-v1';
  const TEAMS_KEY = 'rotation-builder-teams';
  const $ = (id) => document.getElementById(id);
  const POS = ['PG', 'SG', 'SF', 'PF', 'C'];
  const POS_OPTIONS = ['', 'PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'];
  const POS_VAL = { PG: 0, SG: 1, SF: 2, PF: 3, C: 4, G: 0.5, F: 2.5 };
  const COLORS = ['#ff7043', '#ec407a', '#26c6da', '#ffca28', '#ffa726', '#42a5f5', '#26a69a', '#66bb6a', '#5c6bc0', '#ab47bc', '#ef5350', '#8d6e63', '#9ccc65', '#7e57c2', '#78909c', '#d4e157'];

  const defaults = () => ({
    title: '',
    settings: { periods: 4, periodLen: 10, subEvery: 4, maxStint: 6, minRest: 2, onCourt: 5, startersEachHalf: true, balancePositions: true },
    players: [],
    lineup: null, // lineup[minute][slot] = player id
    targets: null, // { playerId: minutes }
    pinned: [], // player ids whose minutes were set by hand and should not be changed automatically
    teamId: null,
    seed: 1,
  });

  let state;
  let uid = Date.now();
  let undoStack = [];

  // ---------- Helpers ----------
  const S = () => state.settings.periods * state.settings.periodLen;
  const L = () => state.settings.periodLen;
  const N = () => state.settings.onCourt;
  const byId = (id) => state.players.find((p) => p.id === id);
  const active = () => state.players.filter((p) => !p.out);
  const label = (p) => (p.num !== '' && p.num != null ? `#${p.num} ` : '') + (p.name || 'Player');
  const shortName = (p) => (p ? p.name || (p.num !== '' ? `#${p.num}` : 'Player') : '?');
  const slotLabel = (j) => (N() === 5 ? POS[j] : String(j + 1));
  const clock = (slot) => `${L() - (slot % L())}:00`;
  const endClock = (slot) => (slot % L() === 0 ? '0:00' : clock(slot));
  const colorOf = (id) => COLORS[Math.max(0, state.players.findIndex((p) => p.id === id)) % COLORS.length];
  function periodTitle(k) {
    const P = state.settings.periods;
    if (P === 4) return ['1st', '2nd', '3rd', '4th'][k] + ' Quarter';
    if (P === 2) return ['1st', '2nd'][k] + ' Half';
    return `Period ${k + 1}`;
  }
  const periodShort = (k) => (state.settings.periods === 4 ? 'Q' : state.settings.periods === 2 ? 'H' : 'P') + (k + 1);
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2500);
  }

  function lineupValid() {
    const lu = state.lineup;
    if (!lu || lu.length !== S()) return false;
    const ids = new Set(active().map((p) => p.id));
    return lu.every((row) => row.length === N() && row.every((id) => ids.has(id)));
  }
  function playerGrid() {
    const g = {};
    state.players.forEach((p) => (g[p.id] = new Array(S()).fill(0)));
    state.lineup.forEach((row, s) => row.forEach((id) => g[id] && (g[id][s] = 1)));
    return g;
  }
  function minutesPlayed() {
    const m = {};
    state.players.forEach((p) => (m[p.id] = 0));
    state.lineup.forEach((row) => row.forEach((id) => (m[id] = (m[id] || 0) + 1)));
    return m;
  }
  const posValOf = (p) => (p.pos in POS_VAL ? POS_VAL[p.pos] : null);
  // gridRows are indexed like active()
  function lineupFromGrid(gridRows) {
    const act = active();
    return Rotation.assignSlots(gridRows, act.map(posValOf), N(), L()).map((row) => row.map((i) => act[i].id));
  }
  function pushUndo() {
    undoStack.push(JSON.stringify({ lineup: state.lineup, targets: state.targets, pinned: state.pinned }));
    if (undoStack.length > 50) undoStack.shift();
  }
  // After hand edits the rotation is the truth: targets (and roster minutes) follow it.
  function syncTargetsToLineup() {
    const mp = minutesPlayed();
    state.targets = {};
    active().forEach((p) => {
      state.targets[p.id] = mp[p.id];
      p.target = mp[p.id];
    });
    document.querySelectorAll('#rosterBody tr').forEach((tr) => {
      const p = byId(Number(tr.dataset.id));
      const inp = tr.querySelector('.min');
      if (p && inp && !p.out) inp.value = p.target;
    });
    renderStatus();
  }

  // ---------- Storage & share links ----------
  function normalize(s) {
    const d = defaults();
    const out = { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
    out.players = (out.players || []).map((p) => ({ pos: '', out: false, ...p }));
    out.pinned = out.pinned || [];
    return out;
  }
  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }

  const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  async function pipe(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  }

  async function encodeShare() {
    const st = state.settings;
    const n = state.players.length;
    const w = n > 36 ? 2 : 1;
    const idx = new Map(state.players.map((p, i) => [p.id, i]));
    const payload = {
      v: 2,
      t: state.title,
      s: [st.periods, st.periodLen, st.subEvery, st.maxStint, st.minRest, st.onCourt, st.startersEachHalf ? 1 : 0, st.balancePositions ? 1 : 0],
      p: state.players.map((p) => [p.num, p.name, p.target, p.starter ? 1 : 0, p.pos || '', p.out ? 1 : 0]),
      g: state.players.map((p) => state.targets?.[p.id] ?? null),
      w,
      l: lineupValid() ? state.lineup.map((row) => row.map((id) => idx.get(id).toString(36).padStart(w, '0')).join('')).join('') : '',
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    if (typeof CompressionStream !== 'undefined') return 'z' + b64url(await pipe(bytes, new CompressionStream('deflate-raw')));
    return 'j' + b64url(bytes);
  }

  async function decodeShare(str) {
    let bytes = unb64url(str.slice(1));
    if (str[0] === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    const d = JSON.parse(new TextDecoder().decode(bytes));
    const s = defaults();
    s.title = d.t || '';
    const [periods, periodLen, subEvery, maxStint, minRest, onCourt, seh, bal] = d.s;
    s.settings = { periods, periodLen, subEvery, maxStint, minRest, onCourt, startersEachHalf: !!seh, balancePositions: bal !== 0 };
    s.players = d.p.map((a, i) => ({ id: i + 1, num: a[0] ?? '', name: a[1] ?? '', target: a[2] ?? '', starter: !!a[3], pos: a[4] || '', out: !!a[5] }));
    s.targets = {};
    s.players.forEach((p, i) => (s.targets[p.id] = d.g?.[i] ?? null));
    if (d.l) {
      const w = d.w || 1;
      const T = periods * periodLen;
      s.lineup = [];
      for (let m = 0; m < T; m++) {
        const row = [];
        for (let j = 0; j < onCourt; j++) {
          const at = (m * onCourt + j) * w;
          row.push(s.players[parseInt(d.l.slice(at, at + w), 36)]?.id);
        }
        s.lineup.push(row);
      }
    }
    return s;
  }

  async function load() {
    const hash = location.hash;
    if (hash.startsWith('#r=')) {
      try {
        const s = await decodeShare(hash.slice(3));
        history.replaceState(null, '', location.pathname);
        toast('Shared rotation opened – edit away!');
        return normalize(s);
      } catch (e) {
        console.warn(e);
        toast('Could not open shared link');
      }
    }
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = normalize(JSON.parse(raw));
        // Migrate v1 state (per-player grid) to the slot-based lineup.
        if (!s.lineup && s.grid) {
          state = s;
          try {
            if (s.players.every((p) => s.grid[p.id]?.length === S())) s.lineup = lineupFromGrid(s.players.map((p) => s.grid[p.id]));
          } catch (e) { /* ignore */ }
        }
        delete s.grid;
        return s;
      }
    } catch (e) { console.warn(e); }
    const s = defaults();
    s.players = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, num: '', name: `Player ${i + 1}`, target: '', starter: i < 5, pos: '' }));
    return s;
  }

  // ---------- Settings ----------
  const settingIds = ['periods', 'periodLen', 'subEvery', 'maxStint', 'minRest', 'onCourt'];
  function renderSettings() {
    const s = state.settings;
    settingIds.forEach((k) => ($(k).value = s[k]));
    $('startersEachHalf').checked = s.startersEachHalf;
    $('balancePositions').checked = s.balancePositions;
    $('title').value = state.title || '';
    const key = `${s.periods}x${s.periodLen}`;
    $('preset').value = [...$('preset').options].some((o) => o.value === key) ? key : 'custom';
  }
  $('preset').addEventListener('change', (e) => {
    if (e.target.value === 'custom') return;
    const [p, l] = e.target.value.split('x').map(Number);
    Object.assign(state.settings, { periods: p, periodLen: l, maxStint: Math.max(4, Math.round(l * 0.6)) });
    if (p === 2) state.settings.subEvery = 4;
    renderSettings();
    changed();
  });
  settingIds.forEach((k) =>
    $(k).addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      if (!isNaN(v)) state.settings[k] = v;
      renderSettings();
      changed();
    })
  );
  $('startersEachHalf').addEventListener('change', (e) => {
    state.settings.startersEachHalf = e.target.checked;
    changed();
  });
  $('balancePositions').addEventListener('change', (e) => {
    state.settings.balancePositions = e.target.checked;
    changed();
  });
  $('title').addEventListener('input', (e) => {
    state.title = e.target.value;
    save();
  });

  // ---------- Roster ----------
  function renderRoster() {
    const body = $('rosterBody');
    body.innerHTML = '';
    state.players.forEach((p) => {
      const tr = document.createElement('tr');
      tr.dataset.id = p.id;
      tr.className = p.out ? 'is-out' : '';
      tr.innerHTML = `
        <td class="c-in"><button class="inout ${p.out ? '' : 'on'}" aria-label="Playing this game" title="Playing this game">${p.out ? '' : '✓'}</button></td>
        <td class="c-num"><input class="num" inputmode="numeric" maxlength="3" value="${esc(p.num)}" data-f="num" /></td>
        <td><input class="name" value="${esc(p.name)}" data-f="name" placeholder="Name" /></td>
        <td><select class="pos" data-f="pos">${POS_OPTIONS.map((o) => `<option value="${o}" ${o === (p.pos || '') ? 'selected' : ''}>${o || '–'}</option>`).join('')}</select></td>
        <td><input class="min" type="number" inputmode="numeric" min="0" max="${S()}" value="${esc(p.target)}" placeholder="auto" data-f="target" /></td>
        <td><button class="star ${p.starter ? 'on' : ''}" aria-label="Starter">★</button></td>
        <td><button class="del" aria-label="Remove">✕</button></td>`;
      tr.querySelectorAll('input').forEach((inp) =>
        inp.addEventListener('input', () => {
          const f = inp.dataset.f;
          p[f] = f === 'target' ? (inp.value === '' ? '' : Number(inp.value)) : inp.value;
          renderStatus();
          if (f === 'target') changed(true);
          else { save(); renderResult(); }
        })
      );
      tr.querySelector('.pos').addEventListener('change', (e) => {
        p.pos = e.target.value;
        if (state.settings.balancePositions && lineupValid() && !undoStack.length) { changed(); return; }
        // Re-sort rows by position but keep who plays when (preserves manual edits).
        if (lineupValid()) {
          const g = playerGrid();
          state.lineup = lineupFromGrid(active().map((x) => g[x.id]));
        }
        save();
        renderResult();
      });
      tr.querySelector('.inout').addEventListener('click', () => {
        p.out = !p.out;
        if (p.out) state.pinned = state.pinned.filter((id) => id !== p.id);
        renderRoster();
        changed();
      });
      tr.querySelector('.star').addEventListener('click', (e) => {
        p.starter = !p.starter;
        e.currentTarget.classList.toggle('on', p.starter);
        renderStatus();
        changed();
      });
      tr.querySelector('.del').addEventListener('click', () => {
        state.players = state.players.filter((x) => x !== p);
        renderRoster();
        changed();
      });
      body.appendChild(tr);
    });
    renderStatus();
  }

  function renderStatus() {
    const s = state.settings;
    const need = S() * s.onCourt;
    const act = active();
    const set = act.filter((p) => p.target !== '' && p.target != null);
    const sum = set.reduce((a, p) => a + Number(p.target || 0), 0);
    const blanks = act.length - set.length;
    const starters = act.filter((p) => p.starter).length;
    const parts = [];
    const outN = state.players.length - act.length;
    if (outN) parts.push(`${act.length} playing, ${outN} out`);
    let cls = 'ok';
    if (blanks === 0) {
      if (sum === need) parts.push(`✅ ${sum} / ${need} minutes assigned`);
      else { cls = 'warn'; parts.push(`${sum} / ${need} minutes — will be ${sum < need ? 'scaled up' : 'scaled down'} to fit`); }
    } else {
      const each = (need - sum) / blanks;
      if (each < 0) { cls = 'warn'; parts.push(`${sum} / ${need} minutes — too many, will be scaled down`); }
      else parts.push(`${sum} / ${need} set, ${blanks} on auto (~${Math.round(each)} min each)`);
    }
    if (starters !== s.onCourt) { cls = 'warn'; parts.push(`⭐ ${starters} starters picked (pick ${s.onCourt}, or none to auto-pick)`); }
    if (act.length < s.onCourt) { cls = 'warn'; parts.push(`Need at least ${s.onCourt} players`); }
    const el = $('minuteStatus');
    el.className = `status ${cls}`;
    el.innerHTML = parts.join('<br>');
  }

  $('addPlayer').addEventListener('click', () => {
    state.players.push({ id: ++uid, num: '', name: '', target: '', starter: false, pos: '', out: false });
    renderRoster();
    const names = document.querySelectorAll('#rosterBody .name');
    names[names.length - 1].focus();
    changed();
  });
  $('evenBtn').addEventListener('click', () => {
    state.players.forEach((p) => { if (p.target !== 0) p.target = ''; });
    state.pinned = [];
    renderRoster();
    changed();
  });
  $('clearBtn').addEventListener('click', () => {
    if (!confirm('Clear all players?')) return;
    state.players = [];
    state.lineup = null;
    state.pinned = [];
    state.teamId = null;
    renderTeams();
    renderRoster();
    renderResult();
    save();
  });
  $('pasteBtn').addEventListener('click', () => {
    $('pasteBox').hidden = !$('pasteBox').hidden;
    if (!$('pasteBox').hidden) $('pasteText').focus();
  });
  $('pasteApply').addEventListener('click', () => {
    const lines = $('pasteText').value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    state.players = lines.map((line, i) => {
      const tokens = line.split(/[\s,;\t]+/);
      let num = '', target = '', pos = '';
      if (/^#?\d{1,2}$/.test(tokens[0]) && tokens.length > 1) num = tokens.shift().replace('#', '');
      if (tokens.length > 1 && /^\d{1,2}$/.test(tokens[tokens.length - 1])) target = Number(tokens.pop());
      const pi = tokens.findIndex((t, k) => k > 0 && /^(PG|SG|SF|PF|C|G|F)$/i.test(t));
      if (pi > 0) pos = tokens.splice(pi, 1)[0].toUpperCase();
      return { id: ++uid, num, name: tokens.join(' '), target, starter: i < state.settings.onCourt, pos, out: false };
    });
    state.pinned = [];
    state.teamId = null;
    renderTeams();
    $('pasteBox').hidden = true;
    $('pasteText').value = '';
    renderRoster();
    build();
  });

  // ---------- Teams ----------
  function loadTeams() {
    try { return JSON.parse(localStorage.getItem(TEAMS_KEY)) || []; } catch (e) { return []; }
  }
  function storeTeams(teams) {
    localStorage.setItem(TEAMS_KEY, JSON.stringify(teams));
  }
  function renderTeams() {
    const teams = loadTeams();
    if (!teams.some((t) => t.id === state.teamId)) state.teamId = null;
    $('teamSel').innerHTML = `<option value="">${teams.length ? '— pick a team —' : '— no saved teams yet —'}</option>` +
      teams.map((t) => `<option value="${t.id}" ${t.id === state.teamId ? 'selected' : ''}>${esc(t.name)} (${t.players.length})</option>`).join('');
    $('delTeam').hidden = !state.teamId;
  }
  $('teamSel').addEventListener('change', (e) => {
    const id = Number(e.target.value);
    const team = loadTeams().find((t) => t.id === id);
    if (!team) { state.teamId = null; renderTeams(); save(); return; }
    if (state.lineup && !confirm(`Load "${team.name}"? The current rotation will be replaced.`)) { renderTeams(); return; }
    state.teamId = team.id;
    state.players = team.players.map((p) => ({ id: ++uid, num: '', name: '', target: '', starter: false, pos: '', ...p, out: false }));
    if (team.settings) state.settings = { ...state.settings, ...team.settings };
    state.lineup = null;
    state.targets = null;
    state.pinned = [];
    undoStack = [];
    renderSettings();
    renderTeams();
    renderRoster();
    renderResult();
    save();
    toast(`${team.name} loaded – untick ✓ for players who are out`);
  });
  $('saveTeam').addEventListener('click', () => {
    if (!state.players.length) { toast('Add players first'); return; }
    const teams = loadTeams();
    const cur = teams.find((t) => t.id === state.teamId);
    const name = (prompt('Team name', cur ? cur.name : state.title || '') || '').trim();
    if (!name) return;
    const players = state.players.map((p) => ({ num: p.num, name: p.name, pos: p.pos || '', target: p.target, starter: !!p.starter }));
    const existing = teams.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const team = existing || { id: Date.now(), name };
    Object.assign(team, { name, players, settings: { ...state.settings } });
    if (!existing) teams.push(team);
    teams.sort((a, b) => a.name.localeCompare(b.name));
    storeTeams(teams);
    state.teamId = team.id;
    save();
    renderTeams();
    toast(`Saved team "${name}" (${players.length} players)`);
  });
  $('delTeam').addEventListener('click', () => {
    const teams = loadTeams();
    const team = teams.find((t) => t.id === state.teamId);
    if (!team || !confirm(`Delete team "${team.name}"? (The current players stay.)`)) return;
    storeTeams(teams.filter((t) => t.id !== team.id));
    state.teamId = null;
    save();
    renderTeams();
  });

  // ---------- Build ----------
  let debounce;
  function changed(typing) {
    save();
    if (!state.lineup) return;
    clearTimeout(debounce);
    debounce = setTimeout(build, typing ? 600 : 0);
  }

  function build() {
    const err = $('error');
    err.hidden = true;
    try {
      const act = active();
      const r = Rotation.buildRotation(act.map((p) => ({ ...p })), { ...state.settings }, { seed: state.seed });
      state.lineup = lineupFromGrid(r.grid);
      state.targets = {};
      act.forEach((p, i) => (state.targets[p.id] = r.targets[i]));
      state.pinned = [];
      undoStack = [];
      save();
      renderResult();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      state.lineup = null;
      renderResult();
    }
  }

  $('buildBtn').addEventListener('click', () => {
    build();
    if (state.lineup) $('result').scrollIntoView({ behavior: 'smooth' });
  });
  $('rebuildBtn').addEventListener('click', () => {
    if (undoStack.length && !confirm('Build a new version? Your manual changes will be lost.')) return;
    state.seed = (state.seed || 1) + 1;
    build();
    toast('New version built');
  });
  $('undoBtn').addEventListener('click', () => {
    if (!undoStack.length) return;
    const u = JSON.parse(undoStack.pop());
    state.lineup = u.lineup;
    state.targets = u.targets;
    state.pinned = u.pinned || [];
    syncTargetsToLineup();
    save();
    renderResult();
  });
  $('printBtn').addEventListener('click', () => window.print());

  $('shareBtn').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#r=${await encodeShare()}`;
    try {
      if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
        await navigator.share({ title: state.title || 'Rotation', url });
      } else {
        await navigator.clipboard.writeText(url);
        toast('Link copied – anyone with it can open and edit a copy');
      }
    } catch (e) {
      if (e.name !== 'AbortError') prompt('Copy this link:', url);
    }
  });

  $('imageBtn').addEventListener('click', async () => {
    const canvas = drawImage();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const fname = `${(state.title || 'rotation').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'rotation'}.png`;
    const file = new File([blob], fname, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
      try {
        await navigator.share({ files: [file], title: state.title || 'Rotation' });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Image downloaded');
  });

  // ---------- Result ----------
  function segments(k, j) {
    const segs = [];
    for (let s = k * L(); s < (k + 1) * L(); s++) {
      const id = state.lineup[s][j];
      const last = segs[segs.length - 1];
      if (last && last.id === id) last.b = s + 1;
      else segs.push({ id, a: s, b: s + 1 });
    }
    return segs;
  }

  function renderResult() {
    const sec = $('result');
    if (!state.players.length || !lineupValid()) { sec.hidden = true; return; }
    sec.hidden = false;
    $('undoBtn').hidden = !undoStack.length;
    renderLineup();
    renderMinutes();
    renderSubs();
    renderChart();
  }

  function renderLineup() {
    const P = state.settings.periods;
    let html = '';
    for (let c = 0; c < P; c += 2) {
      html += '<div class="lu-card">';
      for (let k = c; k < Math.min(P, c + 2); k++) {
        html += `<div class="lu-period"><h3>${periodTitle(k)}</h3><div class="lu-axis">`;
        for (let m = 0; m < L(); m++) html += `<span class="${m % 2 ? 'odd' : ''}" style="left:${(m / L()) * 100}%">${L() - m}:00</span>`;
        html += '</div>';
        for (let j = 0; j < N(); j++) {
          html += `<div class="lu-row"><span class="lu-pos">${slotLabel(j)}</span><div class="lu-bar" data-j="${j}" data-k="${k}">`;
          const segs = segments(k, j);
          segs.forEach((sg) => {
            const p = byId(sg.id);
            html += `<button class="lu-seg" style="flex:${sg.b - sg.a} 1 0;background:${colorOf(sg.id)}" data-j="${j}" data-a="${sg.a}" data-b="${sg.b}" title="${esc(label(p))} ${clock(sg.a)}–${endClock(sg.b)}"><span class="chip">${esc(shortName(p))}</span></button>`;
          });
          segs.slice(0, -1).forEach((sg) => {
            html += `<span class="lu-handle" data-j="${j}" data-t="${sg.b}" style="left:${((sg.b - k * L()) / L()) * 100}%" title="Drag to move the substitution"></span>`;
          });
          html += '</div></div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    $('lineup').innerHTML = html;
  }

  function renderMinutes() {
    const mp = minutesPlayed();
    $('minutes').innerHTML = active()
      .map((p) => {
        const pinned = state.pinned.includes(p.id);
        return `<div class="mrow ${pinned ? 'pinned' : ''}" data-id="${p.id}">
          <i style="background:${colorOf(p.id)}"></i>
          <span class="nm">${esc(shortName(p))}</span>
          <button class="pin" title="${pinned ? 'Fixed – tap to let it change automatically' : 'Tap to keep these minutes fixed'}" aria-label="Pin">📌</button>
          <button class="mstep" data-d="-1" aria-label="One minute less">−</button>
          <input class="mval" type="number" inputmode="numeric" min="0" max="${S()}" value="${mp[p.id]}" aria-label="Minutes" />
          <button class="mstep" data-d="1" aria-label="One minute more">+</button>
        </div>`;
      })
      .join('');
  }

  // Give one player new minutes; the rotation and the other players adjust automatically.
  function adjustPlayer(id, newVal) {
    const act = active();
    const idx = act.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const before = minutesPlayed();
    newVal = Math.max(0, Math.min(S(), Math.round(newVal)));
    if (newVal === before[id]) { renderMinutes(); return; }
    const pos = new Map(act.map((p, i) => [p.id, i]));
    const locked = new Set(state.pinned.filter((x) => x !== id && pos.has(x)).map((x) => pos.get(x)));
    const luIdx = state.lineup.map((row) => row.map((x) => pos.get(x)));
    const res = Rotation.adjustMinutes(luIdx, idx, newVal, act.map(posValOf), { ...state.settings }, locked);
    pushUndo();
    state.lineup = res.map((row) => row.map((i) => act[i].id));
    if (!state.pinned.includes(id)) state.pinned.push(id);
    syncTargetsToLineup();
    save();
    renderResult();
    const after = minutesPlayed();
    const diffs = act
      .filter((p) => p.id !== id && after[p.id] !== before[p.id])
      .map((p) => `${shortName(p)} ${after[p.id] > before[p.id] ? '+' : ''}${after[p.id] - before[p.id]}`);
    const p = byId(id);
    if (after[id] !== newVal) toast(`${shortName(p)}: could only get ${after[id]} min (unpin 📌 others to free minutes)`);
    else toast(`${shortName(p)} ${after[id]} min${diffs.length ? ' · ' + diffs.join(', ') : ''}`);
  }

  $('minutes').addEventListener('click', (e) => {
    const row = e.target.closest('.mrow');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (e.target.closest('.pin')) {
      state.pinned = state.pinned.includes(id) ? state.pinned.filter((x) => x !== id) : [...state.pinned, id];
      save();
      renderMinutes();
      return;
    }
    const step = e.target.closest('.mstep');
    if (step) adjustPlayer(id, minutesPlayed()[id] + Number(step.dataset.d));
  });
  $('minutes').addEventListener('change', (e) => {
    const inp = e.target.closest('.mval');
    if (!inp || inp.value === '') return;
    adjustPlayer(Number(inp.closest('.mrow').dataset.id), Number(inp.value));
  });
  $('minutes').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('.mval')) e.target.blur();
  });

  function subsAt(s) {
    const prev = state.lineup[s - 1], cur = state.lineup[s];
    const ins = cur.filter((id) => !prev.includes(id));
    const outs = prev.filter((id) => !cur.includes(id));
    const pairs = [];
    const leftOuts = outs.slice();
    ins.forEach((id) => {
      const j = cur.indexOf(id);
      let out = leftOuts.includes(prev[j]) ? prev[j] : leftOuts[0];
      leftOuts.splice(leftOuts.indexOf(out), 1);
      pairs.push({ in: id, out, j });
    });
    return pairs;
  }

  function renderSubs() {
    let html = '';
    for (let k = 0; k < state.settings.periods; k++) {
      const start = state.lineup[k * L()];
      html += `<div class="period"><h3>${periodTitle(k)}</h3><div class="lineup"><b>Start:</b> ${start.map((id, j) => `<small>${slotLabel(j)}</small> ${esc(shortName(byId(id)))}`).join(', ')}</div><ul>`;
      for (let s = k * L() + 1; s < (k + 1) * L(); s++) {
        const pairs = subsAt(s);
        if (!pairs.length) continue;
        html += `<li><span class="time">${clock(s)}</span><div>${pairs
          .map((pr) => `<div><span class="in">${esc(shortName(byId(pr.in)))}</span> for <span class="out">${esc(shortName(byId(pr.out)))}</span> <small>${slotLabel(pr.j)}</small></div>`)
          .join('')}</div></li>`;
      }
      html += '</ul></div>';
    }
    $('subs').innerHTML = html;
  }

  function renderChart() {
    const T = S();
    const g = playerGrid();
    const mp = minutesPlayed();
    let html = '<thead><tr><th class="pname"></th>';
    for (let k = 0; k < state.settings.periods; k++) html += `<th class="per" colspan="${L()}">${periodShort(k)}</th>`;
    html += '<th class="tot">Min</th></tr></thead><tbody>';
    active().forEach((p) => {
      html += `<tr><th class="pname">${esc(label(p))}</th>`;
      for (let s = 0; s < T; s++) html += `<td class="cell ${s % L() === 0 ? 'pstart' : ''}" ${g[p.id][s] ? `style="background:${colorOf(p.id)}"` : ''}></td>`;
      html += `<td class="tot">${mp[p.id]}</td></tr>`;
    });
    $('chart').innerHTML = html + '</tbody>';
  }

  // ---------- Edit dialog ----------
  let edit = null;
  $('lineup').addEventListener('click', (e) => {
    const seg = e.target.closest('.lu-seg');
    if (!seg || dragJustEnded) return;
    openEdit(Number(seg.dataset.j), Number(seg.dataset.a), Number(seg.dataset.b));
  });

  function openEdit(j, a, b) {
    const k = Math.floor(a / L());
    const base = k * L();
    edit = { j, k };
    const cur = byId(state.lineup[a][j]);
    $('dlgTitle').textContent = `${slotLabel(j)} · ${periodTitle(k)}`;
    $('dlgNow').innerHTML = `Now: <b>${esc(label(cur))}</b> ${clock(a)}–${endClock(b)}`;
    let from = '', to = '';
    for (let m = 0; m < L(); m++) from += `<option value="${base + m}" ${base + m === a ? 'selected' : ''}>${L() - m}:00</option>`;
    for (let m = 1; m <= L(); m++) to += `<option value="${base + m}" ${base + m === b ? 'selected' : ''}>${m === L() ? '0:00 (end)' : `${L() - m}:00`}</option>`;
    $('dlgFrom').innerHTML = from;
    $('dlgTo').innerHTML = to;
    renderDlgPlayers();
    $('editDlg').showModal();
  }

  function dlgRange() {
    let a = Number($('dlgFrom').value), b = Number($('dlgTo').value);
    if (b <= a) b = a + 1;
    return [a, b];
  }
  $('dlgFrom').addEventListener('change', () => {
    if (Number($('dlgTo').value) <= Number($('dlgFrom').value)) $('dlgTo').value = String(Number($('dlgFrom').value) + 1);
    renderDlgPlayers();
  });
  $('dlgTo').addEventListener('change', () => {
    if (Number($('dlgTo').value) <= Number($('dlgFrom').value)) $('dlgFrom').value = String(Number($('dlgTo').value) - 1);
    renderDlgPlayers();
  });

  function renderDlgPlayers() {
    const [a, b] = dlgRange();
    const j = edit.j;
    const curIds = new Set();
    for (let s = a; s < b; s++) curIds.add(state.lineup[s][j]);
    const mp = minutesPlayed();
    const list = active()
      .filter((p) => !(curIds.size === 1 && curIds.has(p.id)))
      .map((p) => {
        let onCourt = false;
        for (let s = a; s < b; s++) if (state.lineup[s].includes(p.id) && state.lineup[s][j] !== p.id) onCourt = true;
        const t = state.targets?.[p.id];
        return { p, onCourt, need: (t ?? 0) - mp[p.id], t };
      })
      .sort((x, y) => x.onCourt - y.onCourt || y.need - x.need);
    $('dlgPlayers').innerHTML = list
      .map(
        ({ p, onCourt, need, t }) => `<button type="button" class="dlg-player" data-id="${p.id}">
          <i style="background:${colorOf(p.id)}"></i>
          <span class="nm">${esc(label(p))}${p.pos ? ` <small>${p.pos}</small>` : ''}</span>
          <span class="meta">${onCourt ? '<em>on court → swap</em> ' : ''}${mp[p.id]}${t != null ? `/${t}` : ''} min${need > 0 ? ` <b class="need">+${need}</b>` : need < 0 ? ` <b class="over">${need}</b>` : ''}</span>
        </button>`
      )
      .join('');
  }

  $('dlgPlayers').addEventListener('click', (e) => {
    const btn = e.target.closest('.dlg-player');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const [a, b] = dlgRange();
    pushUndo();
    for (let s = a; s < b; s++) setCell(state.lineup, s, edit.j, id);
    $('editDlg').close();
    syncTargetsToLineup();
    save();
    renderResult();
  });
  $('editDlg').addEventListener('click', (e) => {
    if (e.target === $('editDlg')) $('editDlg').close();
  });

  // ---------- Drag editor ----------
  // Put player `id` into slot j at minute s; if they were on court in another slot, swap.
  function setCell(lu, s, j, id) {
    const row = lu[s];
    const old = row[j];
    if (old === id) return;
    const other = row.indexOf(id);
    if (other >= 0) row[other] = old;
    row[j] = id;
  }
  const runStart = (lu, j, t, lo) => { while (t > lo && lu[t - 1][j] === lu[t][j]) t--; return t; };
  const runEnd = (lu, j, t, hi) => { while (t + 1 < hi && lu[t + 1][j] === lu[t][j]) t++; return t + 1; };

  let drag = null;
  let dragJustEnded = false;
  let dragFrame = 0;

  $('lineup').addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const handle = e.target.closest('.lu-handle');
    const seg = handle ? null : e.target.closest('.lu-seg');
    if (!handle && !seg) return;
    const bar = (handle || seg).closest('.lu-bar');
    const j = Number(bar.dataset.j), k = Number(bar.dataset.k);
    const lo = k * L(), hi = (k + 1) * L();
    const lu = state.lineup;
    const d = {
      j, lo, hi, x0: e.clientX, rect: bar.getBoundingClientRect(), moved: false,
      snapshot: lu.map((r) => r.slice()),
      undo: JSON.stringify({ lineup: state.lineup, targets: state.targets, pinned: state.pinned }),
    };
    if (handle) {
      const t = Number(handle.dataset.t);
      Object.assign(d, { mode: 'edge', t, A: lu[t - 1][j], B: lu[t][j], sa: runStart(lu, j, t - 1, lo), eb: runEnd(lu, j, t, hi) });
      e.preventDefault();
    } else {
      const a = Number(seg.dataset.a), b = Number(seg.dataset.b);
      Object.assign(d, {
        mode: 'move', a, b, P: lu[a][j],
        left: a > lo ? lu[a - 1][j] : null, leftStart: a > lo ? runStart(lu, j, a - 1, lo) : a,
        right: b < hi ? lu[b][j] : null, rightEnd: b < hi ? runEnd(lu, j, b, hi) : b,
      });
    }
    drag = d;
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 6) return;
    drag.moved = true;
    const minW = drag.rect.width / L();
    const lu = drag.snapshot.map((r) => r.slice());
    const j = drag.j;
    let tip;
    if (drag.mode === 'edge') {
      let t = drag.lo + Math.round((e.clientX - drag.rect.left) / minW);
      t = Math.max(drag.sa, Math.min(drag.eb, t));
      if (t > drag.t) for (let s = drag.t; s < t; s++) setCell(lu, s, j, drag.A);
      else for (let s = t; s < drag.t; s++) setCell(lu, s, j, drag.B);
      tip = t === drag.sa ? `${shortName(byId(drag.B))} plays the whole stint` : t === drag.eb ? `${shortName(byId(drag.A))} plays the whole stint` : `${shortName(byId(drag.B))} in for ${shortName(byId(drag.A))} at ${clock(t)}`;
    } else {
      let m = Math.round(dx / minW);
      // Moving needs a neighbour on both sides: one gives minutes, the other takes the freed ones.
      if (drag.left == null || drag.right == null) m = 0;
      m = Math.max(drag.leftStart - drag.a, Math.min(drag.rightEnd - drag.b, m));
      for (let s = drag.a + m; s < drag.b + m; s++) setCell(lu, s, j, drag.P);
      if (m > 0) for (let s = drag.a; s < drag.a + m; s++) setCell(lu, s, j, drag.left);
      if (m < 0) for (let s = drag.b + m; s < drag.b; s++) setCell(lu, s, j, drag.right);
      tip = drag.left == null || drag.right == null
        ? 'Drag the white line between players to change the sub time'
        : `${shortName(byId(drag.P))} ${clock(drag.a + m)}–${endClock(drag.b + m)}`;
    }
    state.lineup = lu;
    toast(tip);
    cancelAnimationFrame(dragFrame);
    dragFrame = requestAnimationFrame(() => { renderLineup(); renderMinutes(); });
  });

  function endDrag(commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    dragJustEnded = true;
    setTimeout(() => (dragJustEnded = false), 50);
    cancelAnimationFrame(dragFrame);
    const changed = JSON.stringify(state.lineup) !== JSON.stringify(d.snapshot);
    if (!commit || !changed) {
      state.lineup = d.snapshot;
    } else {
      undoStack.push(d.undo);
      if (undoStack.length > 50) undoStack.shift();
      syncTargetsToLineup();
      save();
    }
    renderResult();
  }
  window.addEventListener('pointerup', () => endDrag(true));
  window.addEventListener('pointercancel', () => endDrag(false));

  // ---------- Image export ----------
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text.length > 1 ? text + '…' : '';
  }

  function drawImage() {
    const P = state.settings.periods, Lm = L(), Nn = N();
    const W = 1280, pad = 24, cardPad = 22, gap = 18, colGap = 44;
    const cols = P >= 2 ? 2 : 1;
    const labelW = 36, rowH = 32, rowGap = 10;
    const periodH = 30 + 24 + Nn * rowH + (Nn - 1) * rowGap;
    const cardH = periodH + cardPad * 2;
    const nCards = Math.ceil(P / cols);
    const headerH = 50;
    const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

    // Measure minutes chips to size the footer.
    const mp = minutesPlayed();
    const chips = active().filter((p) => mp[p.id] || state.targets?.[p.id]).map((p) => ({ p, text: `${shortName(p)}  ${mp[p.id]} min` }));
    const mctx = document.createElement('canvas').getContext('2d');
    mctx.font = `500 14px ${font}`;
    let cx = 0, chipRows = 1;
    const chipPos = chips.map((c) => {
      const w = mctx.measureText(c.text).width + 34;
      if (cx + w > W - pad * 2 - cardPad * 2) { cx = 0; chipRows++; }
      const pos = { x: cx, row: chipRows - 1, w };
      cx += w + 8;
      return pos;
    });
    const footerH = cardPad * 2 + 24 + chipRows * 34;
    const H = pad + headerH + nCards * (cardH + gap) + footerH + pad;

    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#f4f5f7';
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#1d1d1f';
    ctx.font = `700 24px ${font}`;
    ctx.fillText(state.title || 'Rotation', pad + 4, pad + 20);

    const card = (y, h) => {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.06)';
      ctx.shadowBlur = 6;
      ctx.fillStyle = '#fff';
      rr(ctx, pad, y, W - pad * 2, h, 16);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = '#e6e8eb';
      ctx.lineWidth = 1;
      rr(ctx, pad + 0.5, y + 0.5, W - pad * 2 - 1, h - 1, 16);
      ctx.stroke();
    };

    const innerW = W - pad * 2 - cardPad * 2;
    const colW = cols === 2 ? (innerW - colGap) / 2 : innerW;
    for (let c = 0; c < nCards; c++) {
      const y0 = pad + headerH + c * (cardH + gap);
      card(y0, cardH);
      if (cols === 2 && c * 2 + 1 < P) {
        ctx.strokeStyle = '#e6e8eb';
        ctx.beginPath();
        ctx.moveTo(W / 2, y0 + cardPad);
        ctx.lineTo(W / 2, y0 + cardH - cardPad);
        ctx.stroke();
      }
      for (let col = 0; col < cols; col++) {
        const k = c * cols + col;
        if (k >= P) break;
        const x0 = pad + cardPad + col * (colW + colGap);
        let y = y0 + cardPad;
        ctx.fillStyle = '#1d1d1f';
        ctx.font = `700 16px ${font}`;
        ctx.fillText(periodTitle(k), x0, y + 10);
        y += 30;
        const barX = x0 + labelW, barW = colW - labelW;
        ctx.font = `400 11px ${font}`;
        ctx.fillStyle = '#6b6f76';
        ctx.textAlign = 'center';
        for (let m = 0; m < Lm; m++) {
          if (Lm > 12 && m % 2) continue;
          const tx = barX + (m / Lm) * barW;
          ctx.fillText(`${Lm - m}:00`, tx, y + 6);
          ctx.fillRect(tx - 0.5, y + 14, 1, 5);
        }
        ctx.textAlign = 'left';
        y += 24;
        for (let j = 0; j < Nn; j++) {
          const ry = y + j * (rowH + rowGap);
          ctx.fillStyle = '#4a4f57';
          ctx.font = `500 14px ${font}`;
          ctx.fillText(slotLabel(j), x0, ry + rowH / 2);
          ctx.save();
          rr(ctx, barX, ry, barW, rowH, 6);
          ctx.clip();
          segments(k, j).forEach((sg) => {
            const sx = barX + ((sg.a - k * Lm) / Lm) * barW;
            const sw = ((sg.b - sg.a) / Lm) * barW;
            ctx.fillStyle = colorOf(sg.id);
            ctx.fillRect(sx, ry, sw, rowH);
            ctx.fillStyle = 'rgba(0,0,0,0.12)';
            ctx.fillRect(sx, ry, 1, rowH);
            ctx.font = `600 13px ${font}`;
            const name = fitText(ctx, shortName(byId(sg.id)), sw - 22);
            if (name) {
              const tw = ctx.measureText(name).width + 14;
              ctx.fillStyle = 'rgba(255,255,255,0.88)';
              rr(ctx, sx + 6, ry + 6, tw, rowH - 12, 4);
              ctx.fill();
              ctx.fillStyle = '#1d1d1f';
              ctx.fillText(name, sx + 13, ry + rowH / 2 + 0.5);
            }
          });
          ctx.restore();
        }
      }
    }

    const fy = pad + headerH + nCards * (cardH + gap);
    card(fy, footerH);
    ctx.fillStyle = '#1d1d1f';
    ctx.font = `700 16px ${font}`;
    ctx.fillText('Minutes', pad + cardPad, fy + cardPad + 10);
    chips.forEach((c, i) => {
      const pos = chipPos[i];
      const x = pad + cardPad + pos.x, y = fy + cardPad + 30 + pos.row * 34;
      ctx.fillStyle = '#f1f2f4';
      rr(ctx, x, y, pos.w, 26, 13);
      ctx.fill();
      ctx.fillStyle = colorOf(c.p.id);
      ctx.beginPath();
      ctx.arc(x + 14, y + 13, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1d1d1f';
      ctx.font = `500 14px ${font}`;
      ctx.fillText(c.text, x + 26, y + 13.5);
    });
    return canvas;
  }

  // ---------- Init ----------
  (async function init() {
    state = await load();
    save();
    renderSettings();
    renderTeams();
    renderRoster();
    renderResult();
  })();
})();
