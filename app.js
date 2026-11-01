(function () {
  const STORE_KEY = 'rotation-builder-v1';
  const TEAMS_KEY = 'rotation-builder-teams';
  const ROTATIONS_KEY = 'rotation-builder-rotations';
  const TIPS_KEY = 'rotation-builder-tips'; // tips the coach has hidden
  const ROSTER_KEY = 'rotation-builder-roster';
  const ROSTER_VERSION = '2';
  const TEAM = [
    ['Akseli', 'F'], ['Anssi', 'F'], ['Beni', 'C'], ['Eero', 'F'], ['Erkka', 'G'], ['Erno', 'F'], ['Kalle', 'F'], ['Lauri', 'G'],
    ['Markus', 'F'], ['Matias', 'C'], ['Sele', 'G'], ['Tomi', 'F'], ['Waltteri S', 'G'], ['Waltteri V', 'G'],
  ];
  const teamRoster = () => TEAM.map(([name, pos], i) => ({ id: i + 1, num: '', name, pos, target: '', starter: false, finisher: false, out: false }));
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
    mode: null, // position rules the lineup was built with (see Rotation.POS_MODES)
    edited: false, // lineup changed by hand since the last build
  });

  let state;
  let uid = Date.now();
  let undoStack = [];
  let rotationId = null;
  let starterTop = []; // player ids in the order they were picked as starters, newest first

  // ---------- Helpers ----------
  const S = () => state.settings.periods * state.settings.periodLen;
  const L = () => state.settings.periodLen;
  const N = () => state.settings.onCourt;
  const byId = (id) => state.players.find((p) => p.id === id);
  const active = () => state.players.filter((p) => !p.out);
  // Unnamed players get a unique fallback so two of them can be told apart on the sheet.
  const noName = (p) => `Player ${state.players.indexOf(p) + 1 || ''}`.trim();
  const label = (p) => (p.num !== '' && p.num != null ? `#${p.num} ` : '') + (p.name || noName(p));
  const shortName = (p) => (p ? p.name || (p.num !== '' && p.num != null ? `#${p.num}` : noName(p)) : '?');
  // Rows are named PG..C only when positions are in use; otherwise they're just numbered.
  const posRows = () => N() === 5 && state.settings.balancePositions && active().some((p) => p.pos in POS_VAL);
  const slotLabel = (j) => (posRows() ? POS[j] : String(j + 1));
  const GROUPS = ['guards', 'forwards', 'centres'];
  const LOCK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>';
  const GROUP_ONE = ['guard', 'forward', 'centre'];
  const ROW_NAMES = ['guard', 'forward', 'C'];
  const listAnd = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  const isBlank = (v) => v === '' || v == null;
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

  function lineupValid(s = state) {
    const lu = s.lineup;
    if (!Array.isArray(lu) || lu.length !== s.settings.periods * s.settings.periodLen) return false;
    const ids = new Set(s.players.filter((p) => !p.out).map((p) => p.id));
    return lu.every((row) => Array.isArray(row) && row.length === s.settings.onCourt && row.every((id) => ids.has(id)));
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
  // Position rules of the current rotation (null = none): which rows each active player may take.
  function posPlan() {
    const rows = posRows() && Rotation.POS_MODES.find(([m]) => m === state.mode)?.[1];
    return rows ? { rows, groups: active().map((p) => Rotation.groupOf(posValOf(p))) } : null;
  }
  // What a build would do with the roster as it is now: minutes, position rules, starters.
  function currentPlan() {
    if (active().length < N()) return null;
    try { return Rotation.planTargets(active().map((p) => ({ ...p })), { ...state.settings }); } catch (e) { return null; }
  }
  const actIndex = () => new Map(active().map((p, i) => [p.id, i]));
  const canPlay = (plan, idx, id, k) => !plan || Rotation.rowOk(plan, idx.get(id), k);
  // gridRows are indexed like active()
  function lineupFromGrid(gridRows, plan = posPlan()) {
    const act = active();
    return Rotation.assignSlots(gridRows, act.map(posValOf), N(), L(), plan).map((row) => row.map((i) => act[i].id));
  }
  // Undo restores the whole state (players, settings and rotation), so automatic rebuilds can be undone too.
  const snap = () => JSON.stringify({
    players: state.players, settings: state.settings, lineup: state.lineup, targets: state.targets,
    pinned: state.pinned, seed: state.seed, mode: state.mode, edited: state.edited,
  });
  let lastSnap = null; // state after the last build / edit / undo
  let pending = false; // a rebuild is scheduled
  function pushUndo(s = snap()) {
    if (!s) return;
    undoStack.push(s);
    if (undoStack.length > 50) undoStack.shift();
  }
  function commit() {
    save();
    if (!pending) lastSnap = snap();
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
  // Settings are kept within the limits of their inputs (also for saved state and share links).
  function clampSetting(k, v, fallback) {
    v = parseInt(v, 10);
    if (isNaN(v)) return fallback;
    const el = $(k), lo = el?.getAttribute('min'), hi = el?.getAttribute('max');
    if (el?.tagName === 'SELECT') return [...el.options].some((o) => Number(o.value) === v) ? v : fallback;
    if (lo != null) v = Math.max(Number(lo), v);
    if (hi != null) v = Math.min(Number(hi), v);
    return v;
  }
  function normalize(s) {
    const d = defaults();
    const out = { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
    settingIds.forEach((k) => (out.settings[k] = clampSetting(k, out.settings[k], d.settings[k])));
    out.players = (out.players || []).map((p) => {
      const t = p.target === '' || p.target == null ? NaN : Number(p.target);
      return {
        ...p, out: !!p.out, starter: !!p.starter, finisher: !!p.finisher, name: String(p.name ?? ''), num: String(p.num ?? ''),
        pos: POS_OPTIONS.includes(p.pos) ? p.pos : '', target: Number.isFinite(t) && t >= 0 ? t : '',
      };
    });
    out.pinned = out.pinned || [];
    if (![...Rotation.POS_MODES.map(([m]) => m), 'soft', 'off'].includes(out.mode)) out.mode = null;
    return out;
  }
  function save(s = state) {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
    localStorage.setItem(ROSTER_KEY, ROSTER_VERSION);
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
      p: state.players.map((p) => [p.num, p.name, p.target, p.starter ? 1 : 0, p.pos || '', p.out ? 1 : 0, p.finisher ? 1 : 0]),
      g: state.players.map((p) => state.targets?.[p.id] ?? null),
      w,
      l: lineupValid() ? state.lineup.map((row) => row.map((id) => idx.get(id).toString(36).padStart(w, '0')).join('')).join('') : '',
      m: lineupValid() ? state.mode : null,
      e: state.edited ? 1 : 0,
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
    settingIds.forEach((k) => (s.settings[k] = clampSetting(k, s.settings[k], defaults().settings[k])));
    s.players = d.p.map((a, i) => ({ id: i + 1, num: a[0] ?? '', name: a[1] ?? '', target: a[2] ?? '', starter: !!a[3], pos: a[4] || '', out: !!a[5], finisher: !!a[6] }));
    s.targets = {};
    s.players.forEach((p, i) => (s.targets[p.id] = d.g?.[i] ?? null));
    s.mode = d.m ?? null;
    s.edited = !!d.e;
    if (d.l) {
      const w = d.w === 2 ? 2 : 1;
      const { periods: P, periodLen: PL, onCourt: NC } = s.settings;
      s.lineup = [];
      for (let m = 0; m < P * PL; m++) {
        const row = [];
        for (let j = 0; j < NC; j++) {
          const at = (m * NC + j) * w;
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
        const rosterVersion = localStorage.getItem(ROSTER_KEY);
        // Older saved games (generic or empty rosters) switch to the team roster once.
        if (![ROSTER_VERSION, '1'].includes(rosterVersion) || !s.players.length) {
          Object.assign(s, { players: teamRoster(), lineup: null, targets: null, pinned: [], teamId: null, edited: false });
        } else if (rosterVersion === '1') {
          if (!s.players.some((p) => p.name.trim().toLowerCase() === 'kalle')) {
            const kalle = teamRoster().find((p) => p.name === 'Kalle');
            s.players.push({ ...kalle, id: Math.max(0, ...s.players.map((p) => p.id)) + 1 });
          }
          s.players.sort((a, b) => a.name.localeCompare(b.name, 'fi'));
        }
        return s;
      }
    } catch (e) { console.warn(e); }
    const s = defaults();
    s.players = teamRoster();
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
      state.settings[k] = clampSetting(k, e.target.value, state.settings[k]);
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
  $('balanceInfoBtn').addEventListener('click', (e) => {
    const box = $('balanceInfo');
    box.hidden = !box.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
  });
  $('title').addEventListener('input', (e) => {
    state.title = e.target.value;
    $('printTitle').textContent = state.title || 'Rotation';
    save();
  });

  // ---------- Roster ----------
  function renderRoster() {
    const body = $('rosterBody');
    body.innerHTML = '';
    const rank = (p) => { const k = p.starter ? starterTop.indexOf(p.id) : -1; return k < 0 ? Infinity : k; };
    [...state.players].sort((a, b) => Number(a.out) - Number(b.out) || (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1)).forEach((p) => {
      const tr = document.createElement('tr');
      tr.dataset.id = p.id;
      tr.className = p.out ? 'is-out' : '';
      tr.innerHTML = `
        <td class="c-in"><button class="inout ${p.out ? '' : 'on'}" aria-label="Playing this game" aria-pressed="${!p.out}" title="Playing this game">${p.out ? '' : '✓'}</button></td>
        <td><input class="name" value="${esc(p.name)}" data-f="name" placeholder="Name" /></td>
        <td><select class="pos" data-f="pos">${POS_OPTIONS.map((o) => `<option value="${o}" ${o === (p.pos || '') ? 'selected' : ''}>${o || '–'}</option>`).join('')}</select></td>
        <td><input class="min" type="number" inputmode="numeric" min="0" max="${S()}" value="${p.out ? 0 : esc(p.target)}" placeholder="auto" data-f="target" ${p.out ? 'disabled' : ''} /></td>
        <td class="c-pick"><button class="pick star" data-flag="starter" aria-label="Starter"></button></td>
        <td class="c-pick"><button class="pick fin" data-flag="finisher" aria-label="Finisher – on court at the end of the game"></button></td>
        <td><button class="del" aria-label="Remove">✕</button></td>`;
      tr.querySelectorAll('input').forEach((inp) =>
        inp.addEventListener('input', () => {
          const f = inp.dataset.f;
          p[f] = f === 'target' ? (inp.value === '' ? '' : Number(inp.value)) : inp.value;
          renderStatus();
          if (f === 'target') changed(true);
          else { commit(); renderResult(); }
        })
      );
      // Default names ("Player 3") are replaced by typing, not by deleting them first.
      const nameInp = tr.querySelector('.name');
      nameInp.addEventListener('focus', () => { if (/^Player \d+$/.test(nameInp.value)) nameInp.select(); });
      tr.querySelector('.pos').addEventListener('change', (e) => {
        p.pos = e.target.value;
        renderStatus();
        if (lineupValid() && state.edited && !pending && !p.out) reseat();
        else changed();
      });
      tr.querySelector('.inout').addEventListener('click', () => {
        p.out = !p.out;
        if (p.out) state.pinned = state.pinned.filter((id) => id !== p.id);
        renderRoster();
        body.querySelector(`tr[data-id="${p.id}"] .inout`).focus({ preventScroll: true });
        changed();
      });
      tr.querySelectorAll('.pick').forEach((btn) =>
        btn.addEventListener('click', () => {
          const f = btn.dataset.flag;
          // A pick that doesn't fit isn't made; the reason is shown instead (also on touch screens).
          if (!p[f] && btn.dataset.block) { toast(btn.dataset.block); return; }
          p[f] = !p[f];
          if (f === 'starter') {
            starterTop = p.starter ? [p.id, ...starterTop.filter((id) => id !== p.id)] : starterTop.filter((id) => id !== p.id);
            renderRoster();
            body.querySelector(`tr[data-id="${p.id}"] [data-flag="${f}"]`).focus({ preventScroll: true });
          } else renderStatus();
          changed();
        })
      );
      tr.querySelector('.del').addEventListener('click', () => {
        if (p.name && !/^Player \d+$/.test(p.name) && !confirm(`Remove ${p.name} from the list?\n(If they just miss this game, untick them in the In column instead.)`)) return;
        state.players = state.players.filter((x) => x !== p);
        renderRoster();
        changed();
      });
      body.appendChild(tr);
    });
    renderStatus();
  }

  // Minutes each player plays out of position in the current rotation, per kind of row (r: 0 guard, 1 forward,
  // 2 C). allowed: the position rules let them, because there aren't enough minutes for that position.
  function posReport() {
    if (!posRows() || !lineupValid()) return [];
    const plan = posPlan(), idx = actIndex(), acc = new Map();
    state.lineup.forEach((row) => row.forEach((id, k) => {
      const pv = posValOf(byId(id));
      if (!Rotation.badSlot(pv, k, 5)) return;
      const r = Rotation.POS_GROUP[k], key = `${id}:${r}`;
      if (!acc.has(key)) acc.set(key, { id, r, g: Rotation.groupOf(pv), min: 0, allowed: canPlay(plan, idx, id, k) });
      acc.get(key).min++;
    }));
    return [...acc.values()].sort((a, b) => b.min - a.min);
  }

  // Why picked starter (or finisher) i (index in active()) can't start (finish). list: who is on court instead.
  function dropReason(plan, i, finish, list = finish ? plan.finishers : plan.starters) {
    const act = active();
    const forced = plan.targets.map((t, k) => (t >= S() && !list.includes(k) ? k : -1)).filter((k) => k >= 0);
    const onCourt = [...list, ...forced];
    const g = plan.groups ? plan.groups[i] : -1;
    const lim = g >= 0 && plan.limits.find(([m]) => (m >> g) & 1);
    if (lim && onCourt.filter((k) => plan.groups[k] >= 0 && (lim[0] >> plan.groups[k]) & 1).length >= lim[1]) {
      const gs = [0, 1, 2].filter((x) => (lim[0] >> x) & 1);
      return lim[1] === 1 ? `only 1 ${GROUP_ONE[gs[0]]} fits on court` : `only ${lim[1]} ${listAnd(gs.map((x) => GROUPS[x]))} fit on court`;
    }
    if (forced.length) return `${listAnd(forced.map((k) => esc(shortName(act[k]))))} play${forced.length > 1 ? '' : 's'} the whole game`;
    return `only ${N()} can ${finish ? 'finish' : 'start'}`;
  }

  const PICK = {
    starter: { one: 'starter', verb: 'start' },
    finisher: { one: 'finisher', verb: 'finish' },
  };
  // Why player i (index in active()) can't be picked as a starter / finisher now (null = can be picked).
  function pickBlock(plan, i, flag) {
    const act = active(), w = PICK[flag];
    const picked = act.map((p, k) => (p[flag] ? k : -1)).filter((k) => k >= 0);
    if (picked.length >= N()) return `${N()} ${w.one}s already picked – untick one first`;
    if (!plan) return null;
    const who = shortName(act[i]);
    if (!(plan.targets[i] > 0)) return `${who} gets 0 minutes`;
    const [on, before] = Rotation.pickFive(plan, picked, S(), N());
    const [, after] = Rotation.pickFive(plan, [...picked, i], S(), N());
    if (after.length <= before.length) return null;
    // dropReason is HTML (escaped names); the reason is shown as plain text.
    const why = new DOMParser().parseFromString(dropReason(plan, i, flag === 'finisher', on), 'text/html').body.textContent;
    return `${who} can't ${w.verb} – ${why}`;
  }
  // Pick buttons and column counters.
  function renderPicks(plan) {
    const act = active(), idx = actIndex();
    document.querySelectorAll('#rosterBody tr').forEach((tr) => {
      const p = byId(Number(tr.dataset.id));
      tr.querySelectorAll('.pick').forEach((btn) => {
        const f = btn.dataset.flag, on = !!p[f];
        const block = !on && !p.out && idx.has(p.id) ? pickBlock(plan, idx.get(p.id), f) : null;
        btn.classList.toggle('on', on);
        btn.classList.toggle('blocked', !!block);
        btn.setAttribute('aria-pressed', on);
        btn.setAttribute('aria-disabled', !!block);
        btn.textContent = on ? '✓' : '';
        btn.title = block || (on ? `Picked – tap to untick` : `Tap to pick as ${PICK[f].one}`);
        if (block) btn.dataset.block = block;
        else delete btn.dataset.block;
      });
    });
    ['starter', 'finisher'].forEach((f) => {
      const n = act.filter((p) => p[f]).length;
      $(`${f}Count`).textContent = `${n}/${N()}`;
      $(`${f}Count`).classList.toggle('full', n === N());
    });
  }

  function renderStatus() {
    const s = state.settings;
    const need = S() * s.onCourt;
    const act = active();
    const nm = (p) => esc(shortName(p));
    const set = act.filter((p) => !isBlank(p.target));
    const sum = set.reduce((a, p) => a + Number(p.target || 0), 0);
    const blanks = act.length - set.length;
    const starters = act.filter((p) => p.starter).length;
    const plan = currentPlan();
    const fresh = plan && !state.edited; // after hand edits the rotation itself is the plan
    const parts = [];
    const outN = state.players.length - act.length;
    if (outN) parts.push(`${act.length} playing, ${outN} out`);
    let cls = 'ok';
    if (blanks === 0) {
      if (sum === need) parts.push(`${sum} / ${need} minutes assigned`);
      else { cls = 'warn'; parts.push(`${sum} / ${need} minutes — will be ${sum < need ? 'scaled up' : 'scaled down'} to fit`); }
    } else if (sum > need) {
      cls = 'warn';
      parts.push(`${sum} / ${need} minutes — too many, will be scaled down`);
    } else {
      const auto = plan ? act.map((p, i) => (isBlank(p.target) ? plan.targets[i] : null)).filter((v) => v != null) : [];
      const lo = Math.min(...auto), hi = Math.max(...auto);
      const each = auto.length ? `~${lo}${hi > lo ? `–${hi}` : ''}` : `~${Math.round((need - sum) / blanks)}`;
      parts.push(`${sum} / ${need} set, ${blanks} on auto (${each} min each)`);
    }

    const dropped = fresh ? plan.dropped : [];
    if (starters > s.onCourt) {
      cls = 'warn';
      parts.push(`${starters} starters picked – only ${s.onCourt} can start${dropped.length ? ` (${listAnd(dropped.map((i) => nm(act[i])))} won't)` : ''}`);
    } else {
      if (dropped.length) cls = 'warn';
      dropped.forEach((i) => parts.push(`${nm(act[i])} can't start – ${dropReason(plan, i)}`));
    }
    const finishers = act.filter((p) => p.finisher).length;
    const finDropped = fresh ? plan.finDropped : [];
    if (finishers > s.onCourt) {
      cls = 'warn';
      parts.push(`${finishers} finishers picked – only ${s.onCourt} can finish${finDropped.length ? ` (${listAnd(finDropped.map((i) => nm(act[i])))} won't)` : ''}`);
    } else {
      if (finDropped.length) cls = 'warn';
      finDropped.forEach((i) => parts.push(`${nm(act[i])} can't finish – ${dropReason(plan, i, true)}`));
    }
    // Picked finishers who still aren't on court at the end (hand edits, or minutes and positions that clash).
    if (lineupValid() && finishers) {
      const last = state.lineup[state.lineup.length - 1];
      const skip = new Set(finDropped.map((i) => act[i].id));
      const miss = act.filter((p) => p.finisher && !skip.has(p.id) && !last.includes(p.id));
      if (miss.length) {
        cls = 'warn';
        parts.push(`Finisher${miss.length > 1 ? 's' : ''} ${listAnd(miss.map(nm))} ${miss.length > 1 ? "aren't" : "isn't"} on court at the end${state.edited ? '' : ' – the minutes and positions don\'t allow it'}`);
      }
    }

    // Positions: typed minutes that had to change, and who plays out of position (and why).
    if (fresh && plan.rows) {
      const plain = Rotation.normalizeTargets(act.map((p) => p.target), S(), s.onCourt);
      const ch = act.map((p, i) => i).filter((i) => !isBlank(act[i].target) && plan.targets[i] !== plain[i]);
      if (ch.length) parts.push(`Minutes changed to keep positions: ${ch.slice(0, 4).map((i) => `${nm(act[i])} ${esc(act[i].target)}→${plan.targets[i]}`).join(', ')}${ch.length > 4 ? ', …' : ''}`);
      const zero = act.map((p, i) => i).filter((i) => isBlank(act[i].target) && plan.targets[i] === 0 && plain[i] > 0);
      if (zero.length) {
        cls = 'warn';
        parts.push(`${listAnd(zero.map((i) => nm(act[i])))} get${zero.length > 1 ? '' : 's'} 0 min – the typed minutes already fill the ${listAnd([...new Set(zero.map((i) => GROUP_ONE[plan.groups[i]]))])} spots`);
      }
    }
    const rep = posReport();
    const bad = rep.filter((o) => !o.allowed);
    if (bad.length) {
      cls = 'warn';
      parts.push(`Out of position: ${bad.slice(0, 4).map((o) => `${nm(byId(o.id))} (${esc(byId(o.id).pos)}) at ${ROW_NAMES[o.r]} ${o.min} min`).join(', ')}${bad.length > 4 ? ', …' : ''} – New version fixes this`);
    }
    const help = [0, 1, 2].map((r) => rep.filter((o) => o.allowed && o.r === r)).filter((c) => c.length);
    if (help.length) {
      cls = 'warn';
      const fixes = [];
      help.forEach((c) => {
        const r = c[0].r, total = c.reduce((a, o) => a + o.min, 0);
        const has = act.some((p) => Rotation.groupOf(posValOf(p)) === r);
        fixes.push(has ? `give your ${GROUPS[r]} more minutes` : `mark a player ${'GFC'[r]}`);
        parts.push(`${has ? `Not enough ${GROUP_ONE[r]} minutes` : `No ${GROUP_ONE[r]}`}: ${listAnd([...new Set(c.map((o) => GROUPS[o.g]))])} play ${ROW_NAMES[r]} ${total} min (${c.map((o) => `${nm(byId(o.id))} ${o.min}`).join(', ')})`);
      });
      parts.push(`<small>To keep everyone in position: ${listAnd(fixes)}, or set a player's position to '–' (plays anywhere).</small>`);
    } else if (!lineupValid() && plan && plan.rows && plan.mode !== 'strict') {
      const t = [], short = new Set();
      plan.rows.forEach((rs, g) => rs.forEach((r) => { if (r !== g) { t.push(`${GROUPS[g]} also play ${ROW_NAMES[r]}`); short.add(r); } }));
      cls = 'warn';
      parts.push(`Not enough ${listAnd([...short].map((r) => GROUP_ONE[r]))} minutes – ${listAnd(t)}`);
    }
    if (plan && plan.usePos && s.onCourt === 5 && plan.mode === 'soft') {
      cls = 'warn';
      parts.push("These positions can't fill all 5 spots – positions only guide the lineups");
    }
    if (act.length < s.onCourt) { cls = 'warn'; parts.push(`Need at least ${s.onCourt} players`); }
    const el = $('minuteStatus');
    el.className = `status ${cls}`;
    el.innerHTML = parts.join('<br>');
    renderPicks(plan);
    // Show what "auto" will be for each empty minutes box.
    document.querySelectorAll('#rosterBody tr').forEach((tr) => {
      const i = act.findIndex((p) => p.id === Number(tr.dataset.id));
      const inp = tr.querySelector('.min');
      if (inp) inp.placeholder = fresh && i >= 0 ? `~${plan.targets[i]}` : 'auto';
    });
  }

  $('addPlayer').addEventListener('click', () => {
    state.players.push({ id: ++uid, num: '', name: '', target: '', starter: false, finisher: false, pos: '', out: false });
    renderRoster();
    const names = document.querySelectorAll('#rosterBody .name');
    names[names.length - 1].focus();
    changed();
  });
  // Back to the default view: everyone in, original order, automatic minutes, no Start/Finish picks.
  $('resetBtn').addEventListener('click', () => {
    state.players.forEach((p) => { p.out = false; p.target = ''; p.starter = false; p.finisher = false; });
    state.pinned = [];
    starterTop = [];
    renderRoster();
    changed();
    toast('Players and minutes reset');
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
    state.edited = false;
    state.teamId = null;
    renderTeams();
    renderRoster();
    renderResult();
    commit();
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
      return { id: ++uid, num, name: tokens.join(' '), target, starter: i < state.settings.onCourt, finisher: false, pos, out: false };
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
    renderTips();
  }

  // ---------- Tips ----------
  // One-time tips: the team tip until a team is saved, the edit tip until "Got it" ("How to edit" shows it again).
  function hiddenTips() {
    try { return JSON.parse(localStorage.getItem(TIPS_KEY)) || {}; } catch (e) { return {}; }
  }
  function setTip(name, hide) {
    try { localStorage.setItem(TIPS_KEY, JSON.stringify({ ...hiddenTips(), [name]: hide })); } catch (e) { /* private mode */ }
    renderTips();
  }
  function renderTips() {
    const h = hiddenTips();
    $('teamTip').hidden = !!h.team || loadTeams().length > 0;
    $('editTip').hidden = !!h.edit;
    $('editHelp').hidden = !h.edit;
  }
  document.querySelectorAll('[data-tip]').forEach((b) => b.addEventListener('click', () => setTip(b.dataset.tip, true)));
  $('editHelp').addEventListener('click', () => { setTip('edit', false); $('editTip').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  $('teamSel').addEventListener('change', (e) => {
    const id = Number(e.target.value);
    const team = loadTeams().find((t) => t.id === id);
    if (!team) { state.teamId = null; renderTeams(); save(); return; }
    if (state.lineup && !confirm(`Load "${team.name}"? The current rotation will be replaced.`)) { renderTeams(); return; }
    state.teamId = team.id;
    state.players = team.players.map((p) => ({ id: ++uid, num: '', name: '', target: '', starter: false, finisher: false, pos: '', ...p, out: false }));
    if (team.settings) state.settings = { ...state.settings, ...team.settings };
    state.lineup = null;
    state.targets = null;
    state.pinned = [];
    state.edited = false;
    undoStack = [];
    renderSettings();
    renderTeams();
    renderRoster();
    renderResult();
    commit();
    toast(`${team.name} loaded – untick players who are out`);
  });
  $('saveTeam').addEventListener('click', () => {
    if (!state.players.length) { toast('Add players first'); return; }
    const teams = loadTeams();
    const cur = teams.find((t) => t.id === state.teamId);
    const name = (prompt('Team name', cur ? cur.name : state.title || '') || '').trim();
    if (!name) return;
    const players = state.players.map((p) => ({ num: p.num, name: p.name, pos: p.pos || '', target: p.target, starter: !!p.starter, finisher: !!p.finisher }));
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

  // ---------- Saved rotations ----------
  function loadRotations() {
    try {
      const rotations = JSON.parse(localStorage.getItem(ROTATIONS_KEY) || '[]');
      if (!Array.isArray(rotations) || rotations.some((r) =>
        !r || !Number.isSafeInteger(r.id) || typeof r.name !== 'string' || !r.state || typeof r.state !== 'object'
      )) throw new Error('Invalid saved rotation library');
      return rotations;
    } catch (e) {
      console.warn(e);
      toast('Could not read saved rotations');
      return null;
    }
  }
  function storeRotations(rotations) {
    try {
      localStorage.setItem(ROTATIONS_KEY, JSON.stringify(rotations));
      return true;
    } catch (e) {
      console.warn(e);
      toast('Could not save rotations. Browser storage may be full or unavailable.');
      return false;
    }
  }
  function renderRotations() {
    const rotations = loadRotations();
    if (!rotations?.some((r) => r.id === rotationId)) rotationId = null;
    $('rotationSel').innerHTML = `<option value="">${rotations == null ? 'Saved rotations unavailable' : rotations.length ? 'Pick a saved rotation' : 'No saved rotations yet'}</option>` +
      (rotations || []).map((r) => `<option value="${r.id}" ${r.id === rotationId ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
    $('loadRotation').disabled = rotationId == null;
    $('delRotation').hidden = rotationId == null;
  }
  $('rotationSel').addEventListener('change', (e) => {
    rotationId = e.target.value ? Number(e.target.value) : null;
    $('loadRotation').disabled = rotationId == null;
    $('delRotation').hidden = rotationId == null;
  });
  $('saveRotation').addEventListener('click', () => {
    if (pending) build(null, true);
    if (!lineupValid()) { toast('Build a valid rotation first'); return; }
    const rotations = loadRotations();
    if (!rotations) return;
    const cur = rotations.find((r) => r.id === rotationId);
    const name = (prompt('Save rotation as', state.title || cur?.name || '') || '').trim();
    if (!name) return;
    const existing = rotations.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (existing && !confirm(`Replace saved rotation "${existing.name}"?`)) return;
    const rotation = existing || { id: rotations.reduce((id, r) => Math.max(id, r.id + 1), Date.now()), name };
    Object.assign(rotation, { name, state: JSON.parse(JSON.stringify(state)) });
    if (!existing) rotations.push(rotation);
    rotations.sort((a, b) => a.name.localeCompare(b.name));
    if (!storeRotations(rotations)) return;
    rotationId = rotation.id;
    renderRotations();
    toast(`Saved rotation "${name}"`);
  });
  $('loadRotation').addEventListener('click', () => {
    const rotations = loadRotations();
    if (!rotations) return;
    const rotation = rotations.find((r) => r.id === rotationId);
    if (!rotation) { renderRotations(); toast('Pick a saved rotation first'); return; }
    let next;
    try {
      next = normalize(rotation.state);
      if (!lineupValid(next)) throw new Error('Saved rotation has an invalid lineup');
    } catch (e) {
      console.warn(e);
      toast('Could not load this saved rotation');
      return;
    }
    if (!confirm(`Load "${rotation.name}"? This replaces the current game. Changes to the loaded copy will not change the saved rotation.`)) return;
    try {
      save(next);
    } catch (e) {
      console.warn(e);
      toast('Could not load rotation. Browser storage may be full or unavailable.');
      return;
    }
    clearTimeout(debounce);
    pending = false;
    state = next;
    uid = Math.max(uid, ...state.players.map((p) => p.id));
    undoStack = [];
    $('error').hidden = true;
    $('pasteBox').hidden = true;
    if (state.mode == null) state.mode = currentPlan()?.mode ?? 'off';
    renderSettings();
    renderTeams();
    renderRoster();
    renderResult();
    commit();
    toast(`"${rotation.name}" loaded as a copy – change the game name for your next game`);
  });
  $('delRotation').addEventListener('click', () => {
    const rotations = loadRotations();
    if (!rotations) return;
    const rotation = rotations.find((r) => r.id === rotationId);
    if (!rotation) { renderRotations(); toast('Pick a saved rotation first'); return; }
    if (!confirm(`Delete saved rotation "${rotation.name}"? The current game stays.`)) return;
    if (!storeRotations(rotations.filter((r) => r.id !== rotation.id))) return;
    rotationId = null;
    renderRotations();
    toast(`Deleted saved rotation "${rotation.name}"`);
  });

  // ---------- Build ----------
  // Roster or settings changed: an existing rotation is rebuilt (undoable).
  let debounce;
  function changed(typing) {
    save();
    if (!state.lineup) return;
    clearTimeout(debounce);
    pending = true;
    debounce = setTimeout(() => build(null, true), typing ? 600 : 0);
  }
  // What the rotation is built from: names, numbers and players who are out don't matter.
  const buildKey = (s) => JSON.stringify([s.settings, s.seed, s.players.filter((p) => !p.out).map((p) => [p.id, p.pos, p.target, p.starter, p.finisher])]);

  function build(note, auto) {
    clearTimeout(debounce);
    pending = false;
    const err = $('error');
    err.hidden = true;
    const prev = state.lineup ? lastSnap : null;
    const wasEdited = state.lineup && state.edited;
    // Nothing the rotation depends on changed (e.g. an out player's details): keep it, but make the change undoable.
    if (auto && prev && lineupValid() && buildKey(JSON.parse(prev)) === buildKey(state)) {
      if (prev !== snap()) pushUndo(prev);
      commit();
      renderResult();
      renderStatus();
      return;
    }
    try {
      const act = active();
      const r = Rotation.buildRotation(act.map((p) => ({ ...p })), { ...state.settings }, { seed: state.seed });
      state.mode = r.mode;
      state.lineup = lineupFromGrid(r.grid, r.plan);
      state.targets = {};
      act.forEach((p, i) => (state.targets[p.id] = r.targets[i]));
      state.pinned = [];
      state.edited = false;
      pushUndo(prev);
      commit();
      renderResult();
      renderStatus();
      if (note || wasEdited) toast(`${note || 'Rotation rebuilt'}${wasEdited ? ' – Undo brings your changes back' : ''}`);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      state.lineup = null;
      renderResult();
    }
  }

  // Positions changed in a hand-edited rotation: keep who plays when and only re-sort the rows. If someone
  // would then be out of position, rebuild instead (undoable).
  function reseat() {
    const before = lastSnap;
    state.mode = currentPlan()?.mode ?? 'off';
    const g = playerGrid();
    state.lineup = lineupFromGrid(active().map((x) => g[x.id]));
    if (posReport().some((o) => !o.allowed)) { build('Positions changed – rotation rebuilt'); return; }
    pushUndo(before);
    commit();
    renderResult();
    renderStatus();
  }

  $('buildBtn').addEventListener('click', () => {
    build();
    if (state.lineup) $('result').scrollIntoView({ behavior: 'smooth' });
  });
  $('rebuildBtn').addEventListener('click', () => {
    state.seed = (state.seed || 1) + 1;
    build('New version built');
  });
  $('undoBtn').addEventListener('click', () => {
    // A change whose rebuild hasn't run yet has no undo step of its own: undo just that change.
    const s = pending ? lastSnap : undoStack.pop();
    if (!s) return;
    clearTimeout(debounce);
    pending = false;
    const typed = new Map(state.players.map((p) => [p.id, [p.name, p.num]]));
    Object.assign(state, JSON.parse(s));
    // Names and numbers aren't undone: keep what was typed since.
    state.players.forEach((p) => { if (typed.has(p.id)) [p.name, p.num] = typed.get(p.id); });
    renderSettings();
    renderRoster();
    renderResult();
    commit();
    toast('Undone');
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
    const mp = minutesPlayed();
    $('printTitle').textContent = state.title || 'Rotation';
    $('printMinutes').textContent = `Minutes: ${active().map((p) => `${shortName(p)} ${mp[p.id]}`).join(' · ')}`;
    renderSubs();
    renderChart();
    renderStatus();
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
          <button class="pin" title="${pinned ? 'Locked – tap to let it change automatically' : 'Tap to lock these minutes'}" aria-label="Lock minutes" aria-pressed="${pinned}">${LOCK_ICON}</button>
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
    const res = Rotation.adjustMinutes(luIdx, idx, newVal, act.map(posValOf), { ...state.settings, ...posPlan() }, locked);
    pushUndo();
    state.lineup = res.map((row) => row.map((i) => act[i].id));
    if (!state.pinned.includes(id)) state.pinned.push(id);
    state.edited = true;
    syncTargetsToLineup();
    commit();
    renderResult();
    const after = minutesPlayed();
    const diffs = act
      .filter((p) => p.id !== id && after[p.id] !== before[p.id])
      .map((p) => `${shortName(p)} ${after[p.id] > before[p.id] ? '+' : ''}${after[p.id] - before[p.id]}`);
    const p = byId(id);
    if (after[id] !== newVal) toast(`${shortName(p)}: could only get ${after[id]} min (unlock others to free minutes)`);
    else toast(`${shortName(p)} ${after[id]} min${diffs.length ? ' · ' + diffs.join(', ') : ''}`);
  }

  $('minutes').addEventListener('click', (e) => {
    const row = e.target.closest('.mrow');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (e.target.closest('.pin')) {
      state.pinned = state.pinned.includes(id) ? state.pinned.filter((x) => x !== id) : [...state.pinned, id];
      commit();
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
    const rows = posRows();
    const tag = (j) => (rows ? `<small>${POS[j]}</small> ` : '');
    let html = '';
    for (let k = 0; k < state.settings.periods; k++) {
      const start = state.lineup[k * L()];
      html += `<div class="period"><h3>${periodTitle(k)}</h3><div class="lineup"><b>Start:</b> ${start.map((id, j) => `${tag(j)}${esc(shortName(byId(id)))}`).join(', ')}</div><ul>`;
      for (let s = k * L() + 1; s < (k + 1) * L(); s++) {
        const pairs = subsAt(s);
        if (!pairs.length) continue;
        html += `<li><span class="time">${clock(s)}</span><div>${pairs
          .map((pr) => `<div><span class="in">${esc(shortName(byId(pr.in)))}</span> for <span class="out">${esc(shortName(byId(pr.out)))}</span>${rows ? ` <small>${POS[pr.j]}</small>` : ''}</div>`)
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
    $('dlgTitle').textContent = posRows() ? `${POS[j]} · ${periodTitle(k)}` : periodTitle(k);
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
    // Only players who may play this row; one already on court swaps rows, so the other player must fit theirs.
    const plan = posPlan(), idx = actIndex();
    const fits = (p) => {
      if (!canPlay(plan, idx, p.id, j)) return false;
      for (let s = a; s < b; s++) {
        const k = state.lineup[s].indexOf(p.id);
        if (k >= 0 && k !== j && !canPlay(plan, idx, state.lineup[s][j], k)) return false;
      }
      return true;
    };
    const cands = active().filter((p) => !(curIds.size === 1 && curIds.has(p.id)));
    const hidden = cands.filter((p) => !fits(p)).length;
    const list = cands
      .filter(fits)
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
      .join('') +
      (hidden ? `<p class="hint dlg-note">${list.length ? `Only players who can play ${POS[j]} are listed.` : `Nobody else can play ${POS[j]} here.`} Position '–' = plays anywhere.</p>` : '');
  }

  $('dlgPlayers').addEventListener('click', (e) => {
    const btn = e.target.closest('.dlg-player');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const [a, b] = dlgRange();
    pushUndo();
    for (let s = a; s < b; s++) setCell(state.lineup, s, edit.j, id);
    $('editDlg').close();
    state.edited = true;
    syncTargetsToLineup();
    commit();
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
      undo: snap(),
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
    // Keep positions: don't follow the pointer into a lineup that puts someone in a row they can't play.
    const plan = posPlan(), idx = actIndex();
    for (let s = drag.lo; s < drag.hi; s++) {
      for (let k = 0; k < N(); k++) {
        const id = lu[s][k];
        if (id !== drag.snapshot[s][k] && !canPlay(plan, idx, id, k)) { toast(`${shortName(byId(id))} can't play ${POS[k]}`); return; }
      }
    }
    state.lineup = lu;
    toast(tip);
    cancelAnimationFrame(dragFrame);
    dragFrame = requestAnimationFrame(() => { renderLineup(); renderMinutes(); });
  });

  function endDrag(apply) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    dragJustEnded = true;
    setTimeout(() => (dragJustEnded = false), 50);
    cancelAnimationFrame(dragFrame);
    const differs = JSON.stringify(state.lineup) !== JSON.stringify(d.snapshot);
    if (!apply || !differs) {
      state.lineup = d.snapshot;
    } else {
      pushUndo(d.undo);
      state.edited = true;
      syncTargetsToLineup();
      commit();
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
    // Rotations saved by older versions don't know their position rules: use what a build would use now.
    if (lineupValid() && state.mode == null) state.mode = currentPlan()?.mode ?? 'off';
    commit();
    renderSettings();
    renderTeams();
    renderRotations();
    renderRoster();
    renderResult();
  })();
})();
