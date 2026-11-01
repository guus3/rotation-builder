(function () {
  const STORE_KEY = 'rotation-builder-v1';
  const $ = (id) => document.getElementById(id);

  const defaults = () => ({
    settings: { periods: 4, periodLen: 10, subEvery: 2, maxStint: 6, minRest: 2, onCourt: 5, startersEachHalf: true },
    players: [],
    grid: null,
    seed: 1,
  });

  let state = load();
  let uid = Date.now();

  function load() {
    try {
      if (location.hash.startsWith('#s=')) {
        const s = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(3)))));
        history.replaceState(null, '', location.pathname);
        return { ...defaults(), ...s, settings: { ...defaults().settings, ...s.settings } };
      }
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return { ...defaults(), ...s, settings: { ...defaults().settings, ...s.settings } };
      }
    } catch (e) { console.warn(e); }
    const s = defaults();
    s.players = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, num: '', name: `Player ${i + 1}`, target: '', starter: i < 5,
    }));
    return s;
  }

  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }

  const totalMinutes = () => state.settings.periods * state.settings.periodLen;
  const label = (p) => (p.num !== '' && p.num != null ? `#${p.num} ` : '') + (p.name || 'Player');
  function periodName(k) {
    const P = state.settings.periods;
    if (P === 2) return `H${k + 1}`;
    if (P === 4) return `Q${k + 1}`;
    return `P${k + 1}`;
  }
  function clockAt(slot) {
    const L = state.settings.periodLen;
    return { period: Math.floor(slot / L), clock: `${L - (slot % L)}:00` };
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2200);
  }

  // ---------- Settings ----------
  const settingIds = ['periods', 'periodLen', 'subEvery', 'maxStint', 'minRest', 'onCourt'];
  function renderSettings() {
    const s = state.settings;
    settingIds.forEach((k) => ($(k).value = s[k]));
    $('startersEachHalf').checked = s.startersEachHalf;
    const key = `${s.periods}x${s.periodLen}`;
    $('preset').value = [...$('preset').options].some((o) => o.value === key) ? key : 'custom';
  }
  $('preset').addEventListener('change', (e) => {
    if (e.target.value === 'custom') return;
    const [p, l] = e.target.value.split('x').map(Number);
    state.settings.periods = p;
    state.settings.periodLen = l;
    state.settings.maxStint = Math.max(4, Math.round(l * 0.6));
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

  // ---------- Roster ----------
  function renderRoster() {
    const body = $('rosterBody');
    body.innerHTML = '';
    state.players.forEach((p) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input class="num" inputmode="numeric" maxlength="3" value="${esc(p.num)}" data-f="num" /></td>
        <td><input class="name" value="${esc(p.name)}" data-f="name" placeholder="Name" /></td>
        <td><input class="min" type="number" inputmode="numeric" min="0" max="${totalMinutes()}" value="${esc(p.target)}" placeholder="auto" data-f="target" /></td>
        <td><button class="star ${p.starter ? 'on' : ''}" data-f="starter" aria-label="Starter">★</button></td>
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
    const T = totalMinutes();
    const need = T * s.onCourt;
    const set = state.players.filter((p) => p.target !== '' && p.target != null);
    const sum = set.reduce((a, p) => a + Number(p.target || 0), 0);
    const blanks = state.players.length - set.length;
    const starters = state.players.filter((p) => p.starter).length;
    const parts = [];
    let cls = 'ok';
    if (blanks === 0) {
      if (sum === need) parts.push(`✅ ${sum} / ${need} minutes assigned`);
      else {
        cls = 'warn';
        parts.push(`${sum} / ${need} minutes — will be ${sum < need ? 'scaled up' : 'scaled down'} to fit`);
      }
    } else {
      const each = (need - sum) / blanks;
      if (each < 0) { cls = 'warn'; parts.push(`${sum} / ${need} minutes — too many, will be scaled down`); }
      else parts.push(`${sum} / ${need} set, ${blanks} on auto (~${Math.round(each)} min each)`);
    }
    if (starters !== s.onCourt) {
      cls = 'warn';
      parts.push(`⭐ ${starters} starters picked (pick ${s.onCourt}, or none to auto-pick)`);
    }
    if (state.players.length < s.onCourt) { cls = 'warn'; parts.push(`Need at least ${s.onCourt} players`); }
    const el = $('minuteStatus');
    el.className = `status ${cls}`;
    el.innerHTML = parts.join('<br>');
  }

  $('addPlayer').addEventListener('click', () => {
    state.players.push({ id: ++uid, num: '', name: '', target: '', starter: false });
    renderRoster();
    const names = document.querySelectorAll('#rosterBody .name');
    names[names.length - 1].focus();
    changed();
  });
  $('evenBtn').addEventListener('click', () => {
    state.players.forEach((p) => { if (p.target !== 0) p.target = ''; });
    renderRoster();
    changed();
  });
  $('clearBtn').addEventListener('click', () => {
    if (!confirm('Clear all players?')) return;
    state.players = [];
    state.grid = null;
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
      let tokens = line.split(/[\s,;\t]+/);
      let num = '', target = '';
      if (/^#?\d{1,2}$/.test(tokens[0]) && tokens.length > 1) num = tokens.shift().replace('#', '');
      if (tokens.length > 1 && /^\d{1,2}$/.test(tokens[tokens.length - 1])) target = Number(tokens.pop());
      return { id: ++uid, num, name: tokens.join(' '), target, starter: i < state.settings.onCourt };
    });
    $('pasteBox').hidden = true;
    $('pasteText').value = '';
    renderRoster();
    build();
  });

  // ---------- Build ----------
  let debounce;
  function changed(typing) {
    save();
    if (!state.grid) return;
    clearTimeout(debounce);
    debounce = setTimeout(build, typing ? 600 : 0);
  }

  function build() {
    const err = $('error');
    err.hidden = true;
    try {
      const cfg = { ...state.settings };
      cfg.subEvery = Math.max(1, cfg.subEvery);
      let players = state.players.map((p) => ({ ...p }));
      // Starters are only enforced when exactly onCourt are picked.
      const r = Rotation.buildRotation(players, cfg, { seed: state.seed });
      state.grid = {};
      state.players.forEach((p, i) => (state.grid[p.id] = r.grid[i]));
      state.targets = {};
      state.players.forEach((p, i) => (state.targets[p.id] = r.targets[i]));
      save();
      renderResult();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      state.grid = null;
      renderResult();
    }
  }

  $('buildBtn').addEventListener('click', () => {
    build();
    if (state.grid) $('result').scrollIntoView({ behavior: 'smooth' });
  });
  $('rebuildBtn').addEventListener('click', () => {
    state.seed = (state.seed || 1) + 1;
    build();
    toast('New version built');
  });
  $('printBtn').addEventListener('click', () => window.print());
  $('shareBtn').addEventListener('click', async () => {
    const data = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
    const url = `${location.origin}${location.pathname}#s=${data}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Rotation', url });
      else { await navigator.clipboard.writeText(url); toast('Link copied'); }
    } catch (e) {
      prompt('Copy this link:', url);
    }
  });

  // ---------- Result ----------
  function renderResult() {
    const sec = $('result');
    const S = totalMinutes();
    const valid = state.grid && state.players.length && state.players.every((p) => state.grid[p.id]?.length === S);
    if (!valid) { sec.hidden = true; return; }
    sec.hidden = false;
    const L = state.settings.periodLen;
    const N = state.settings.onCourt;
    const players = state.players;
    const chart = $('chart');
    const colors = ['#e4572e', '#29335c', '#f3a712', '#669bbc', '#a8c686', '#8e5572', '#2a9d8f', '#e76f51', '#457b9d', '#bc6c25', '#6d597a', '#588157', '#c1121f', '#3a86ff', '#8338ec'];

    let html = '<thead><tr><th class="pname"></th>';
    for (let k = 0; k < state.settings.periods; k++) html += `<th class="per" colspan="${L}">${periodName(k)}</th>`;
    html += '<th class="tot">Min</th></tr><tr><th class="pname"></th>';
    for (let s = 0; s < S; s++) html += `<th class="clk ${s % L === 0 ? 'pstart' : ''}">${L - (s % L)}</th>`;
    html += '<th class="tot"></th></tr></thead><tbody>';
    players.forEach((p, i) => {
      const row = state.grid[p.id];
      const tot = row.reduce((a, b) => a + b, 0);
      const target = state.targets?.[p.id];
      const off = target != null && tot !== target;
      html += `<tr><th class="pname">${esc(label(p))}</th>`;
      for (let s = 0; s < S; s++) {
        const on = row[s];
        html += `<td class="cell ${on ? 'on' : ''} ${s % L === 0 ? 'pstart' : ''}" data-p="${p.id}" data-s="${s}" ${on ? `style="background:${colors[i % colors.length]}"` : ''}></td>`;
      }
      html += `<td class="tot ${off ? 'bad' : ''}" title="target ${target ?? '-'}">${tot}${off ? `<small>/${target}</small>` : ''}</td></tr>`;
    });
    html += `<tr class="count"><th class="pname">On court</th>`;
    for (let s = 0; s < S; s++) {
      const c = players.reduce((a, p) => a + state.grid[p.id][s], 0);
      html += `<td class="${c !== N ? 'bad' : ''} ${s % L === 0 ? 'pstart' : ''}">${c}</td>`;
    }
    html += '<td></td></tr></tbody>';
    chart.innerHTML = html;
    renderSubs();
  }

  $('chart').addEventListener('click', (e) => {
    const td = e.target.closest('td.cell');
    if (!td) return;
    const row = state.grid[td.dataset.p];
    const s = Number(td.dataset.s);
    row[s] = row[s] ? 0 : 1;
    save();
    renderResult();
  });

  function renderSubs() {
    const S = totalMinutes();
    const players = state.players;
    const grid = players.map((p) => state.grid[p.id]);
    const L = state.settings.periodLen;
    const names = (idx) => idx.map((i) => esc(label(players[i]))).join(', ');
    const lineup = (s) => grid.map((r, i) => (r[s] ? i : -1)).filter((i) => i >= 0);
    let html = '';
    const events = Rotation.subEvents(grid, S);
    for (let k = 0; k < state.settings.periods; k++) {
      html += `<div class="period"><h3>${periodName(k)}</h3>`;
      html += `<div class="lineup"><b>Start:</b> ${names(lineup(k * L))}</div><ul>`;
      events
        .filter((ev) => ev.slot > k * L && ev.slot < (k + 1) * L)
        .forEach((ev) => {
          html += `<li><span class="time">${clockAt(ev.slot).clock}</span>
            <span class="in">IN ${names(ev.ins)}</span>
            <span class="out">OUT ${names(ev.outs)}</span></li>`;
        });
      html += '</ul></div>';
    }
    $('subs').innerHTML = html;
  }

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  renderSettings();
  renderRoster();
  renderResult();
})();
