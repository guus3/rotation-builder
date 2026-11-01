// Rotation engine: turns target minutes into a minute-by-minute lineup grid.
(function (global) {
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Blank targets share the leftover minutes; totals are scaled to exactly N*T and rounded to whole minutes.
  function normalizeTargets(rawTargets, T, N) {
    const n = rawTargets.length;
    const total = N * T;
    if (n < N) throw new Error(`Need at least ${N} players (you have ${n}).`);
    let x = rawTargets.map((v) =>
      v === '' || v == null || isNaN(Number(v)) ? null : Math.max(0, Math.min(T, Number(v)))
    );
    const fixedSum = x.reduce((a, v) => a + (v ?? 0), 0);
    const blanks = x.filter((v) => v === null).length;
    if (blanks) {
      const each = Math.max(0, total - fixedSum) / blanks;
      x = x.map((v) => (v === null ? Math.min(T, each) : v));
    }
    for (let iter = 0; iter < 100; iter++) {
      const sum = x.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - total) < 1e-9) break;
      if (sum > total) {
        const s = total / sum;
        x = x.map((v) => v * s);
      } else {
        const free = x.map((v, i) => (v < T - 1e-9 ? i : -1)).filter((i) => i >= 0);
        if (!free.length) break;
        const fsum = free.reduce((a, i) => a + x[i], 0);
        const need = total - sum;
        free.forEach((i) => { x[i] += fsum > 0 ? (need * x[i]) / fsum : need / free.length; });
      }
      x = x.map((v) => Math.min(T, v));
    }
    const fl = x.map((v) => Math.floor(v + 1e-9));
    let left = total - fl.reduce((a, b) => a + b, 0);
    const order = x.map((v, i) => [v - fl[i], i]).sort((a, b) => b[0] - a[0]);
    while (left > 0) {
      let moved = false;
      for (const [, i] of order) {
        if (left <= 0) break;
        if (fl[i] < T) { fl[i]++; left--; moved = true; }
      }
      if (!moved) break;
    }
    return fl;
  }

  const POS_VAL = { PG: 0, SG: 1, SF: 2, PF: 3, C: 4, G: 0.5, F: 2.5 };
  // Forwards (F = SF/PF) must never be used as the centre.
  const forbidden = (pv, k, N) => pv === POS_VAL.F && N >= 5 && k === N - 1;

  // Cost of how badly a (partial) lineup covers the PG..C spots. 0 = every player fits a spot.
  // Players without a position are flexible and cost nothing.
  function makePosCost(posVals, N) {
    const cache = new Map();
    const tgt = (k) => (N === 1 ? 0 : (k * 4) / (N - 1));
    return function (lineup) {
      let key = 0;
      for (const i of lineup) key += 2 ** i;
      if (cache.has(key)) return cache.get(key);
      const pv = lineup.map((i) => posVals[i]).filter((v) => v != null);
      const used = new Array(N).fill(false);
      let best = pv.length > N ? 0 : Infinity;
      (function rec(j, acc) {
        if (acc >= best) return;
        if (j === pv.length) { best = acc; return; }
        for (let k = 0; k < N; k++) {
          if (used[k]) continue;
          used[k] = true;
          const d = Math.max(0, Math.abs(pv[j] - tgt(k)) - 0.5);
          rec(j + 1, acc + d + d * d + (forbidden(pv[j], k, N) ? 8 : 0));
          used[k] = false;
        }
      })(0, 0);
      cache.set(key, best);
      return best;
    };
  }

  function buildOnce(targets, starters, cfg, rng, p) {
    const { periods, periodLen, onCourt: N, subEvery, maxStint, minRest, startersEachHalf } = cfg;
    const S = periods * periodLen;
    const n = targets.length;
    const rem = targets.slice();
    const stint = new Array(n).fill(0);
    const rest = new Array(n).fill(99);
    let on = new Set();
    const grid = targets.map(() => new Array(S).fill(0));
    const halfSlot = periods % 2 === 0 ? (periods / 2) * periodLen : -1;
    const startersOk = starters.length === N;

    for (let s = 0; s < S; s++) {
      const R = S - s;
      const m = s % periodLen;
      if (s === halfSlot) { stint.fill(0); for (let i = 0; i < n; i++) rest[i] = 99; }
      const isWindow = m === 0 || m % subEvery === 0;

      const score = new Array(n);
      for (let i = 0; i < n; i++) {
        let sc = (p.urg * rem[i]) / R + rng() * p.noise;
        if (on.has(i)) {
          if (stint[i] < p.minStint) sc += 1;
          else if (stint[i] >= maxStint) sc -= 0.6 + 0.15 * (stint[i] - maxStint);
          else sc += p.stay;
        } else if (rest[i] < minRest) sc -= 0.8;
        score[i] = sc;
      }
      const byScore = (a, b) => score[b] - score[a];

      let base = [];
      if (startersOk && (s === 0 || (startersEachHalf && s === halfSlot))) base = starters.slice();
      else if (!isWindow) base = [...on];

      const chosen = [];
      const add = (i) => { if (chosen.length < N && rem[i] > 0 && !chosen.includes(i)) chosen.push(i); };
      // Players whose remaining minutes equal remaining time must play every minute from now on.
      for (let i = 0; i < n; i++) if (rem[i] === R) add(i);
      base.slice().sort(byScore).forEach(add);
      if (cfg.posCost && p.posW) {
        while (chosen.length < N) {
          const baseCost = cfg.posCost(chosen);
          let bi = -1, bv = -Infinity;
          for (let i = 0; i < n; i++) {
            if (rem[i] <= 0 || chosen.includes(i)) continue;
            const v = score[i] - p.posW * (cfg.posCost([...chosen, i]) - baseCost);
            if (v > bv) { bv = v; bi = i; }
          }
          if (bi < 0) break;
          chosen.push(bi);
        }
      }
      [...Array(n).keys()].sort(byScore).forEach(add);

      const next = new Set(chosen);
      for (let i = 0; i < n; i++) {
        if (next.has(i)) {
          stint[i] = on.has(i) ? stint[i] + 1 : 1;
          rest[i] = 0;
          rem[i]--;
          grid[i][s] = 1;
        } else {
          rest[i] = on.has(i) ? 1 : rest[i] + 1;
          stint[i] = 0;
        }
      }
      on = next;
    }
    return grid;
  }

  function analyze(grid, cfg) {
    const S = cfg.periods * cfg.periodLen;
    let subs = 0, longStint = 0, shortStint = 0, shortRest = 0, offWindow = 0;
    grid.forEach((row) => {
      let run = 0, off = 0, entered = false;
      for (let s = 0; s <= S; s++) {
        const v = s < S ? row[s] : 0;
        if (v) {
          if (s > 0 && !row[s - 1]) {
            const m = s % cfg.periodLen;
            subs += m === 0 ? 0.4 : 1;
            if (m % cfg.subEvery !== 0) offWindow++;
            if (entered && off < cfg.minRest) shortRest++;
          }
          run++; off = 0; entered = true;
        } else {
          if (run) {
            if (run > cfg.maxStint) longStint += run - cfg.maxStint;
            if (run < 2) shortStint++;
          }
          run = 0; off++;
        }
      }
    });
    let posPenalty = 0;
    if (cfg.posCost) {
      for (let s = 0; s < S; s++) {
        const on = [];
        for (let i = 0; i < grid.length; i++) if (grid[i][s]) on.push(i);
        posPenalty += cfg.posCost(on);
      }
    }
    return { subs, posPenalty, cost: subs + 0.7 * longStint + 1.5 * shortStint + 0.5 * shortRest + 0.5 * offWindow + 0.6 * posPenalty };
  }

  function buildRotation(players, cfg, opts = {}) {
    const T = cfg.periods * cfg.periodLen;
    const targets = normalizeTargets(players.map((p) => p.target), T, cfg.onCourt);
    const starters = players.map((p, i) => (p.starter && targets[i] > 0 ? i : -1)).filter((i) => i >= 0);
    const posVals = players.map((p) => (p.pos in POS_VAL ? POS_VAL[p.pos] : null));
    cfg = { ...cfg, posCost: cfg.balancePositions !== false && posVals.some((v) => v != null) ? makePosCost(posVals, cfg.onCourt) : null };
    const rng = mulberry32(opts.seed ?? 12345);
    const iters = opts.iterations ?? 600;
    let best = null;
    for (let k = 0; k < iters; k++) {
      const p = {
        noise: k === 0 ? 0 : 0.05 + rng() * 0.35,
        stay: 0.1 + rng() * 0.5,
        minStint: 2 + Math.floor(rng() * 3),
        urg: k === 0 ? 1 : 0.7 + rng() * 2.3,
        posW: k === 0 ? 0.3 : rng() * 0.8,
      };
      const grid = buildOnce(targets, starters, cfg, rng, p);
      const a = analyze(grid, cfg);
      if (!best || a.cost < best.cost) best = { grid, ...a };
    }
    const grid = polish(best.grid, cfg, rng, opts.polishSteps ?? 40000);
    const fin = analyze(grid, cfg);
    return { grid, targets, subs: fin.subs, posPenalty: fin.posPenalty };
  }

  // Hill-climb with swaps that keep every player's minutes and the on-court count unchanged.
  function polish(grid, cfg, rng, steps) {
    const S = cfg.periods * cfg.periodLen;
    const n = grid.length;
    const g = grid.map((r) => r.slice());
    let cost = analyze(g, cfg).cost;
    for (let k = 0; k < steps; k++) {
      const a = Math.floor(rng() * n), b = Math.floor(rng() * n);
      if (a === b) continue;
      const s = Math.floor(rng() * S);
      let t = rng() < 0.5 ? Math.floor(rng() * S) : s + (rng() < 0.5 ? -1 : 1) * (1 + Math.floor(rng() * 4));
      if (t < 0 || t >= S) continue;
      if (!(g[a][s] && !g[a][t] && !g[b][s] && g[b][t])) continue;
      g[a][s] = 0; g[a][t] = 1; g[b][s] = 1; g[b][t] = 0;
      const c = analyze(g, cfg).cost;
      if (c <= cost) cost = c;
      else { g[a][s] = 1; g[a][t] = 0; g[b][s] = 0; g[b][t] = 1; }
    }
    return g;
  }

  // Substitution events: [{slot, ins:[idx], outs:[idx]}]
  function subEvents(grid, S) {
    const ev = [];
    for (let s = 1; s < S; s++) {
      const ins = [], outs = [];
      grid.forEach((row, i) => {
        if (row[s] && !row[s - 1]) ins.push(i);
        if (!row[s] && row[s - 1]) outs.push(i);
      });
      if (ins.length || outs.length) ev.push({ slot: s, ins, outs });
    }
    return ev;
  }

  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    arr.forEach((v, i) => {
      permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).forEach((p) => out.push([v, ...p]));
    });
    return out;
  }

  // posVals: per player a number on the PG(0)..C(4) scale, or null for "any".
  // Players already on court keep their slot; incoming players take the freed slots
  // that best match their position. Returns S rows of N player indices.
  // At period starts everyone is re-placed by position (small penalty for changing rows).
  function assignSlots(grid, posVals, N, periodLen) {
    const S = grid.length ? grid[0].length : 0;
    const slotTarget = (k) => (N === 1 ? 0 : (k * 4) / (N - 1));
    const out = [];
    let prev = null;
    for (let s = 0; s < S; s++) {
      const on = grid.map((r, i) => (r[s] ? i : -1)).filter((i) => i >= 0);
      const slots = new Array(N).fill(-1);
      const placed = new Set();
      const reset = !prev || (periodLen && s % periodLen === 0);
      if (!reset) prev.forEach((p, k) => { if (p >= 0 && grid[p][s]) { slots[k] = p; placed.add(p); } });
      const incoming = on.filter((i) => !placed.has(i));
      const free = slots.map((v, k) => (v < 0 ? k : -1)).filter((k) => k >= 0);
      const inc = incoming.slice(0, free.length);
      let best = inc, bestCost = Infinity;
      const cands = inc.length <= 7 ? permutations(inc) : [inc];
      for (const perm of cands) {
        let c = 0;
        perm.forEach((p, r) => {
          const pv = posVals[p];
          c += pv == null ? 0 : Math.abs(pv - slotTarget(free[r])) + (forbidden(pv, free[r], N) ? 100 : 0);
          c += 1e-3 * Math.abs(inc.indexOf(p) - r);
          if (prev && reset && prev.includes(p) && prev[free[r]] !== p) c += 0.3;
        });
        if (c < bestCost) { bestCost = c; best = perm; }
      }
      best.forEach((p, r) => (slots[free[r]] = p));
      out.push(slots);
      prev = slots;
    }
    return out;
  }

  const api = { normalizeTargets, buildRotation, subEvents, analyze, assignSlots, makePosCost, POS_VAL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Rotation = api;
})(this);
