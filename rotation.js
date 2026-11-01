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

  const isBlank = (v) => v === '' || v == null || isNaN(Number(v));

  // Minutes as real numbers: typed values are kept where possible, blanks share the rest evenly and the
  // total is scaled to exactly N*T. With position limits (groups[i] = position group or -1, limits =
  // [[bitmask of groups, rows], ...], see POS_MODES) the players of a limit get at most rows*T minutes
  // together; returns null if the total can't be reached that way.
  function fitTargets(rawTargets, T, N, groups, limits) {
    const n = rawTargets.length;
    const total = N * T;
    if (n < N) throw new Error(`Need at least ${N} players (you have ${n}).`);
    const lims = limits || [];
    const memb = membership(groups, lims, n);
    const capT = lims.map((L) => L[1] * T);
    const sums = (x) => {
      const s = lims.map(() => 0);
      x.forEach((v, i) => memb[i].forEach((l) => (s[l] += v ?? 0)));
      return s;
    };
    let x = rawTargets.map((v) => (isBlank(v) ? null : Math.max(0, Math.min(T, Number(v)))));
    const zero = x.map((v) => v === 0);
    // Typed minutes can't be more than the rows they may use hold.
    lims.forEach((_, l) => {
      const s = sums(x)[l];
      if (s > capT[l]) x = x.map((v, i) => (v !== null && memb[i].includes(l) ? (v * capT[l]) / s : v));
    });
    // Blanks get equal shares of what is left, each limited by the game length and the room in its rows.
    let act = x.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
    act.forEach((i) => (x[i] = 0));
    let left = Math.max(0, total - x.reduce((a, b) => a + b, 0));
    while (act.length && left > 1e-9) {
      const s = sums(x);
      let d = left / act.length;
      act.forEach((i) => (d = Math.min(d, T - x[i])));
      lims.forEach((_, l) => {
        const k = act.filter((i) => memb[i].includes(l)).length;
        if (k) d = Math.min(d, (capT[l] - s[l]) / k);
      });
      d = Math.max(0, d);
      act.forEach((i) => (x[i] += d));
      left -= d * act.length;
      const s2 = sums(x);
      act = act.filter((i) => x[i] < T - 1e-9 && memb[i].every((l) => s2[l] < capT[l] - 1e-9));
    }
    // Then scale to the exact total (with positions, players typed as 0 stay at 0).
    for (let iter = 0; iter < 200; iter++) {
      const sum = x.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - total) < 1e-9) break;
      if (sum > total) {
        const f = total / sum;
        x = x.map((v) => v * f);
        continue;
      }
      const s = sums(x);
      const free = [];
      for (let i = 0; i < n; i++) {
        if (x[i] < T - 1e-9 && !(limits && zero[i]) && memb[i].every((l) => s[l] < capT[l] - 1e-9)) free.push(i);
      }
      if (!free.length) break;
      const need = total - sum;
      const fsum = free.reduce((a, i) => a + x[i], 0);
      const inc = new Array(n).fill(0);
      free.forEach((i) => { inc[i] = Math.min(T - x[i], fsum > 0 ? (need * x[i]) / fsum : need / free.length); });
      lims.forEach((_, l) => {
        const add = free.reduce((a, i) => a + (memb[i].includes(l) ? inc[i] : 0), 0);
        const room = capT[l] - s[l];
        if (add > room) free.forEach((i) => { if (memb[i].includes(l)) inc[i] *= room / add; });
      });
      x = x.map((v, i) => v + inc[i]);
    }
    if (limits && Math.abs(x.reduce((a, b) => a + b, 0) - total) > 1e-6) return null;
    return x;
  }

  // Whole minutes that add up to exactly N*T (and stay within the position limits).
  function roundTargets(x, T, N, groups, limits) {
    const lims = limits || [];
    const memb = membership(groups, lims, x.length);
    const fl = x.map((v) => Math.floor(v + 1e-9));
    const room = lims.map((L) => L[1] * T);
    fl.forEach((v, i) => memb[i].forEach((l) => (room[l] -= v)));
    let left = N * T - fl.reduce((a, b) => a + b, 0);
    const order = x.map((v, i) => [v - fl[i], i]).sort((a, b) => b[0] - a[0]);
    for (let pass = 0; left > 0; pass++) {
      let moved = false;
      for (const [, i] of order) {
        if (left <= 0) break;
        if (pass === 0 && x[i] <= 0) continue; // players with 0 minutes only get one if nothing else works
        if (fl[i] < T && memb[i].every((l) => room[l] > 0)) {
          fl[i]++;
          memb[i].forEach((l) => room[l]--);
          left--;
          moved = true;
        }
      }
      if (!moved && pass > 0) break;
    }
    return fl;
  }

  // Blank targets share the leftover minutes; totals are scaled to exactly N*T and rounded to whole minutes.
  function normalizeTargets(rawTargets, T, N, groups, limits) {
    const x = fitTargets(rawTargets, T, N, groups, limits);
    return x && roundTargets(x, T, N, groups, limits);
  }

  // The last minutes of the game go to the picked finishers, then to the players with the most minutes
  // ("closers"). gap = how many minutes a player is below the N-th highest of the rest; small differences are
  // ignored. Picked finishers (fin) have no gap.
  const closeLenOf = (cfg) => Math.min(4, Math.ceil(cfg.periodLen / 3));
  function closerGaps(mins, N, fin = []) {
    const k = N - fin.length;
    const nth = k > 0 ? mins.filter((_, i) => !fin.includes(i)).sort((a, b) => b - a)[k - 1] ?? 0 : Infinity;
    return mins.map((m, i) => (fin.includes(i) ? 0 : nth === Infinity ? 10 : Math.max(0, nth - m - 2)));
  }
  // Minutes at the end of the game each picked finisher must be on court (0 = not a finisher). A finisher who
  // also starts keeps the minutes needed for the starting lineups.
  function finishLens(cfg, targets, starters, finishers) {
    const S = cfg.periods * cfg.periodLen;
    const half = cfg.periods % 2 === 0 ? (cfg.periods / 2) * cfg.periodLen : -1;
    const starts = 1 + (cfg.startersEachHalf && half > 0 ? 1 : 0);
    return targets.map((t, i) => {
      if (!finishers.includes(i)) return 0;
      const keep = starters.includes(i) && t < S ? starts : 0;
      return Math.max(0, Math.min(closeLenOf(cfg), t - keep));
    });
  }

  const POS_VAL = { PG: 0, SG: 1, SF: 2, PF: 3, C: 4, G: 0.5, F: 2.5 };
  // With 5 on court the rows are PG, SG | SF, PF | C and positions are strict: guards (PG/SG/G) play the guard
  // rows, forwards (SF/PF/F) the forward rows and centres the C row. Players without a position can play
  // anywhere. (Other team sizes: positions only steer the lineups, forwards avoid the last row.)
  const POS_GROUP = [0, 0, 1, 1, 2]; // row -> group: 0 = guards, 1 = forwards, 2 = centres
  const groupOf = (pv) => (pv == null ? -1 : pv <= 1 ? 0 : pv < 4 ? 1 : 2);
  const badSlot = (pv, k, N) =>
    pv != null && (N === 5 ? groupOf(pv) !== POS_GROUP[k] : N > 5 && pv === POS_VAL.F && k === N - 1);
  // If the roster or the typed minutes can't fill a group's rows, a neighbouring group helps out there (and
  // only there). [mode, rows]: rows[g] = row groups that group g may use, most preferred mode first.
  const POS_MODES = [
    ['strict', [[0], [1], [2]]],
    ['relaxC', [[0], [1, 2], [2]]], // forwards also play C
    ['relaxG', [[0], [0, 1], [2]]], // forwards also play guard
    ['relaxF', [[0], [1], [1, 2]]], // centres also play forward
    ['relaxGC', [[0], [0, 1, 2], [2]]], // forwards also play guard and C
    ['relaxFG', [[0, 1], [1], [2]]], // guards also play forward
    ['relaxCF', [[0, 1], [1, 2], [2]]], // guards also play forward, forwards also play C
    ['relaxGF', [[0], [0, 1], [1, 2]]], // forwards also play guard, centres also play forward
  ];
  // Which lineups fit the rows: players of a set of groups can't outnumber the rows they may use. Returns the
  // limits that matter, [bitmask of groups (1 = guards, 2 = forwards, 4 = centres), max on court together],
  // inner ones first (for these modes they are nested or disjoint).
  function limitsOf(rows) {
    const ROWS = [2, 2, 1];
    const cap = (m) => {
      const used = new Set();
      rows.forEach((r, g) => { if ((m >> g) & 1) r.forEach((x) => used.add(x)); });
      return [...used].reduce((a, x) => a + ROWS[x], 0);
    };
    const size = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1);
    const out = [];
    for (let m = 1; m < 8; m++) {
      const c = cap(m);
      let implied = c >= 5;
      for (let m2 = 1; m2 < 8; m2++) if (m2 !== m && (m & m2) === m && cap(m2) <= c) implied = true;
      for (let a = (m - 1) & m; a > 0; a = (a - 1) & m) if (cap(a) + cap(m ^ a) <= c) implied = true;
      if (!implied) out.push([m, c]);
    }
    return out.sort((a, b) => size(a[0]) - size(b[0]));
  }
  // May player i take row k under the plan from planTargets (rows/groups)?
  const rowOk = (plan, i, k) => !plan.rows || plan.groups[i] < 0 || plan.rows[plan.groups[i]].includes(POS_GROUP[k]);
  // For each player: the limits it counts toward.
  const membership = (groups, lims, n) =>
    Array.from({ length: n }, (_, i) => {
      const g = groups && lims.length ? groups[i] : -1;
      return g < 0 ? [] : lims.map((L, l) => ((L[0] >> g) & 1 ? l : -1)).filter((l) => l >= 0);
    });
  // Limits are nested or disjoint: parent[l] = smallest other limit that contains limit l (or -1).
  function limitTree(lims) {
    const size = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1);
    return lims.map(([m], l) => {
      let p = -1;
      lims.forEach(([m2], k) => {
        if (k !== l && m2 !== m && (m & m2) === m && (p < 0 || size(m2) < size(lims[p][0]))) p = k;
      });
      return p;
    });
  }
  // Can a partial lineup still get exactly k more players? Per limit: cnt = on court, need = must be on court,
  // avail = members that could still be added; availAll = everyone that could still be added.
  function completable(lims, parent, cnt, need, avail, availAll, k) {
    const req = [], hi = [];
    let totReq = 0, totHi = availAll;
    for (let l = 0; l < lims.length; l++) {
      let r = Math.max(0, need[l] - cnt[l]);
      let h = Math.min(lims[l][1] - cnt[l], avail[l]);
      let cr = 0, ch = 0, ca = 0;
      for (let c = 0; c < l; c++) if (parent[c] === l) { cr += req[c]; ch += hi[c]; ca += avail[c]; }
      r = Math.max(r, cr);
      h = Math.min(h, ch + avail[l] - ca);
      if (r > h) return false;
      req[l] = r;
      hi[l] = h;
      if (parent[l] < 0) { totReq += r; totHi -= avail[l] - h; }
    }
    return totReq <= k && k <= totHi;
  }
  // Fills one lineup under the position limits: at most cap players of a limit, at least need[l] of them,
  // and a player is only added if the lineup can still be completed to N.
  function picker(N, lims, memb, parent, need, live) {
    const chosen = [];
    const cnt = lims ? lims.map(() => 0) : null;
    const avail = lims ? lims.map(() => 0) : null;
    let availAll = 0;
    if (lims) live.forEach((ok, i) => { if (ok) { availAll++; memb[i].forEach((l) => avail[l]++); } });
    const canAdd = (i, forced) => {
      if (chosen.length >= N || !live[i] || chosen.includes(i)) return false;
      if (!lims) return true;
      const ms = memb[i];
      if (ms.some((l) => cnt[l] >= lims[l][1])) return false;
      if (forced) return true;
      ms.forEach((l) => { cnt[l]++; avail[l]--; });
      const ok = completable(lims, parent, cnt, need, avail, availAll - 1, N - chosen.length - 1);
      ms.forEach((l) => { cnt[l]--; avail[l]++; });
      return ok;
    };
    const add = (i, forced) => {
      if (!canAdd(i, forced)) return false;
      chosen.push(i);
      if (lims) { memb[i].forEach((l) => { cnt[l]++; avail[l]--; }); availAll--; }
      return true;
    };
    const short = (i) => !!lims && memb[i].some((l) => cnt[l] < need[l]);
    return { chosen, canAdd, add, short };
  }

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
          rec(j + 1, acc + d + d * d + (badSlot(pv[j], k, N) ? 8 : 0));
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
    const C = closeLenOf(cfg);
    const fin = cfg.finishers || [];
    const gap = closerGaps(targets, N, fin);
    const finLen = cfg.finLen || targets.map(() => 0);
    // Strict positions: a limit's players can't outnumber its rows, and when their minutes no longer fit into
    // the rest of the game some of them must be on court now.
    const lim = cfg.limits;
    const memb = lim ? membership(cfg.groups, lim, n) : null;
    const parent = lim ? limitTree(lim) : null;
    const remL = lim ? lim.map((_, l) => targets.reduce((a, t, i) => a + (memb[i].includes(l) ? t : 0), 0)) : null;
    // hardFin: at the end the finishers' spots are taken. blockedAfter[i][s] = minutes from s on in which player
    // i can't get on court because the finishers fill every spot i could take.
    let blockedAfter = null;
    if (p.hardFin) {
      blockedAfter = targets.map(() => new Array(S + 1).fill(0));
      for (let s = S - 1; s >= 0; s--) {
        const F = [];
        for (let i = 0; i < n; i++) if (finLen[i] && s >= S - finLen[i]) F.push(i);
        for (let i = 0; i < n; i++) {
          const blocked = !finLen[i] && F.length > 0 &&
            (F.length >= N || (lim && memb[i].some((l) => F.filter((f) => memb[f].includes(l)).length >= lim[l][1])));
          blockedAfter[i][s] = blockedAfter[i][s + 1] + (blocked ? 1 : 0);
        }
      }
    }

    for (let s = 0; s < S; s++) {
      const R = S - s;
      const m = s % periodLen;
      if (s === halfSlot) { stint.fill(0); for (let i = 0; i < n; i++) rest[i] = 99; }
      else if (m === 0 && s > 0) for (let i = 0; i < n; i++) { stint[i] = Math.max(0, stint[i] - BREAK); if (!on.has(i)) rest[i] += BREAK; }
      const isWindow = m === 0 || m % subEvery === 0;

      const score = new Array(n);
      for (let i = 0; i < n; i++) {
        // Non-closers aim to use up their minutes before the last C minutes of the game.
        // Picked finishers keep their last minutes for the end of the game.
        const Ri = finLen[i] && R > finLen[i] ? R - finLen[i] : gap[i] && R > C ? R - C : R;
        let sc = (p.urg * Math.max(0, rem[i] - (R > finLen[i] ? finLen[i] : 0))) / Ri + rng() * p.noise;
        if (gap[i] && R <= C) sc -= (p.closeW * gap[i]) / 10;
        if (finLen[i]) sc += R <= finLen[i] ? 5 : rem[i] <= finLen[i] ? -5 : 0;
        if (on.has(i)) {
          if (stint[i] < p.minStint) sc += 1;
          else if (stint[i] >= maxStint) sc -= 0.6 + 0.15 * (stint[i] - maxStint);
          else sc += p.stay;
        } else if (rest[i] < minRest) sc -= 0.8;
        score[i] = sc;
      }
      const byScore = (a, b) => score[b] - score[a];

      let base = [];
      if (starters.length && (s === 0 || (startersEachHalf && s === halfSlot))) base = starters.slice();
      else if (!isWindow) base = [...on];

      const need = lim ? remL.map((r, l) => Math.max(0, r - lim[l][1] * (R - 1))) : null;
      // hardFin: picked finishers can't use the minutes they keep for the end of the game.
      const blockedNow = (i) => blockedAfter && blockedAfter[i][s] > blockedAfter[i][s + 1];
      const pk = picker(N, lim, memb, parent, need, rem.map((r, i) =>
        r > (p.hardFin && R > finLen[i] && !base.includes(i) ? finLen[i] : 0) && !blockedNow(i)));
      const chosen = pk.chosen;
      // Players whose remaining minutes equal the minutes they still can play must play every one of them.
      for (let i = 0; i < n; i++) if (rem[i] === R - (blockedAfter ? blockedAfter[i][s] : 0)) pk.add(i, true);
      base.slice().sort(byScore).forEach((i) => pk.add(i));
      const ranked = [...Array(n).keys()].sort(byScore);
      if (lim) for (const i of ranked) if (pk.short(i)) pk.add(i);
      if (cfg.posCost && p.posW) {
        while (chosen.length < N) {
          const baseCost = cfg.posCost(chosen);
          let bi = -1, bv = -Infinity;
          for (let i = 0; i < n; i++) {
            if (!pk.canAdd(i)) continue;
            const v = score[i] - p.posW * (cfg.posCost([...chosen, i]) - baseCost);
            if (v > bv) { bv = v; bi = i; }
          }
          if (bi < 0) break;
          pk.add(bi);
        }
      }
      ranked.forEach((i) => pk.add(i));

      const next = new Set(chosen);
      for (let i = 0; i < n; i++) {
        if (next.has(i)) {
          stint[i] = on.has(i) ? stint[i] + 1 : 1;
          rest[i] = 0;
          rem[i]--;
          if (lim) memb[i].forEach((l) => remL[l]--);
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

  // Cost weights. Stoppages and long stints are what make a sheet hard to run from the bench.
  const W = { moment: 1.5, offWindow: 2, closers: 0.15, long: 0.8, finisher: 30 };
  // A break between periods counts as this many minutes of rest (halftime as a full rest).
  const BREAK = 2;

  function analyze(grid, cfg) {
    const S = cfg.periods * cfg.periodLen;
    const L = cfg.periodLen;
    const half = cfg.periods % 2 === 0 ? (cfg.periods / 2) * L : -1;
    let subs = 0, longStint = 0, shortStint = 0, shortRest = 0, offWindow = 0, moments = 0, closers = 0;
    const subAt = new Uint8Array(S);
    const mins = new Array(grid.length);
    grid.forEach((row, i) => {
      let run = 0, load = 0, off = 0, entered = false, total = 0;
      for (let s = 0; s <= S; s++) {
        const v = s < S ? row[s] : 0;
        const m = s % L;
        if (m === 0 && s > 0 && s < S) {
          if (s === half) { load = 0; off = 99; }
          else { load = Math.max(0, load - BREAK); if (off) off += BREAK; }
        }
        if (v) {
          if (s > 0 && !row[s - 1]) {
            subs += m === 0 ? 0.4 : 1;
            if (m) subAt[s] = 1;
            if (m % cfg.subEvery !== 0) offWindow++;
            if (entered && off < cfg.minRest) shortRest++;
          } else if (m === 0 && s > 0 && s + 1 < S && !row[s + 1]) {
            shortStint++; // starts a period and goes straight back out after 1 minute
          }
          run++; load++; off = 0; entered = true; total++;
          if (load > cfg.maxStint) longStint += load - cfg.maxStint; // grows with every extra minute
        } else {
          if (run && run < 2) shortStint++;
          run = 0; load = 0; off++;
        }
      }
      mins[i] = total;
    });
    // Every in-play stoppage with subs is work for the coach: prefer fewer, grouped subs.
    for (let s = 0; s < S; s++) moments += subAt[s];
    const fin = cfg.finishers || [];
    const gap = closerGaps(mins, cfg.onCourt, fin);
    for (let s = Math.max(0, S - closeLenOf(cfg)); s < S; s++) grid.forEach((row, i) => { if (row[s]) closers += gap[i]; });
    let finMiss = 0;
    if (cfg.finLen) cfg.finLen.forEach((len, i) => { for (let s = S - len; s < S; s++) if (!grid[i][s]) finMiss++; });
    let posPenalty = 0;
    if (cfg.posCost) {
      for (let s = 0; s < S; s++) {
        const on = [];
        for (let i = 0; i < grid.length; i++) if (grid[i][s]) on.push(i);
        posPenalty += cfg.posCost(on);
      }
    }
    const cost = subs + W.moment * moments + W.long * longStint + 1.5 * shortStint + 0.5 * shortRest +
      W.offWindow * offWindow + 0.6 * posPenalty + W.closers * closers + W.finisher * finMiss;
    return { subs, moments, posPenalty, finMiss, cost };
  }

  // Give player `idx` exactly `newVal` minutes by editing an existing slot lineup
  // (lineup[s][j] = player index) as little as possible. Minutes are moved in chunks at the
  // start/end of stints (i.e. by shifting substitution times), taken from / given to the
  // other players in a fair way. Players in `locked` keep their minutes.
  function adjustMinutes(lineup, idx, newVal, posVals, cfg, locked = new Set()) {
    const S = lineup.length;
    const N = cfg.onCourt;
    const n = posVals.length;
    newVal = Math.max(0, Math.min(S, Math.round(newVal)));
    const lu = lineup.map((r) => r.slice());
    const posCost = cfg.balancePositions !== false && posVals.some((v) => v != null) ? makePosCost(posVals, N) : null;
    const c2 = { ...cfg, posCost };
    const slotTarget = (k) => (N === 1 ? 0 : (k * 4) / (N - 1));
    const g = Array.from({ length: n }, () => new Array(S).fill(0));
    lu.forEach((row, s) => row.forEach((i) => (g[i][s] = 1)));
    const mins0 = g.map((r) => r.reduce((a, b) => a + b, 0));
    const change = new Array(n).fill(0);
    // Who may take over a row: the plan's rows (cfg.rows/groups from planTargets) if given, else nobody out
    // of position (unless the lineup already has players out of position, then it only costs extra).
    const usePos = !!posCost;
    const strict = usePos && lineup.every((row) => row.every((i, k) => !badSlot(posVals[i], k, N)));
    const fits = cfg.rows
      ? (z, j) => rowOk(cfg, z, j)
      : (z, j) => !strict || !badSlot(posVals[z], j, N);
    const slotFit = (z, j) => (posVals[z] == null || !usePos ? 0 : 0.3 * Math.abs(posVals[z] - slotTarget(j)) + (badSlot(posVals[z], j, N) ? 3 : 0));
    const fair = (i, k) => (0.6 * ((Math.abs(change[i]) + k) ** 2 - change[i] ** 2)) / (1 + mins0[i] / 8);
    let need = newVal - mins0[idx];

    for (let iter = 0; iter < 400 && need !== 0; iter++) {
      const base = analyze(g, c2).cost;
      let best = null;
      // Runs of `from` in slot j get (partly) handed over to `to`.
      const tryRun = (from, to, j, s, e, maxK, other) => {
        if (!fits(to, j)) return;
        for (const fromStart of [true, false]) {
          for (let k = 1; k <= Math.min(maxK, e - s); k++) {
            const a = fromStart ? s : e - k, b = fromStart ? s + k : e;
            const t = fromStart ? b - 1 : a;
            if (g[to][t]) break;
            g[from].fill(0, a, b); g[to].fill(1, a, b);
            const c = (analyze(g, c2).cost - base + k * slotFit(to, j) + fair(other, k)) / k;
            g[from].fill(1, a, b); g[to].fill(0, a, b);
            if (!best || c < best.c) best = { c, a, b, j, from, to, other };
          }
        }
      };
      for (let j = 0; j < N; j++) {
        for (let s = 0; s < S; s++) {
          const y = lu[s][j];
          if (s > 0 && lu[s - 1][j] === y) continue;
          let e = s;
          while (e < S && lu[e][j] === y) e++;
          if (need > 0 && y !== idx && !locked.has(y)) tryRun(y, idx, j, s, e, need, y);
          if (need < 0 && y === idx) {
            for (let z = 0; z < n; z++) {
              if (z === idx || locked.has(z) || mins0[z] === 0) continue;
              tryRun(idx, z, j, s, e, -need, z);
            }
          }
        }
      }
      if (!best) break;
      const k = best.b - best.a;
      for (let t = best.a; t < best.b; t++) lu[t][best.j] = best.to;
      g[best.from].fill(0, best.a, best.b);
      g[best.to].fill(1, best.a, best.b);
      change[best.other] += need > 0 ? -k : k;
      need += need > 0 ? -k : k;
    }
    return lu;
  }

  // Minutes per player plus the position rules the rotation is built with. mode: 'strict' (everyone in
  // position), 'relax…' (the roster or the typed minutes can't fill some rows, so a neighbouring group helps
  // out there, see POS_MODES), 'soft' (positions only steer the lineups) or 'off'.
  // starters: picked starters that start; dropped: picked starters that can't.
  function planTargets(players, cfg) {
    const T = cfg.periods * cfg.periodLen;
    const N = cfg.onCourt;
    const raw = players.map((p) => p.target);
    const posVals = players.map((p) => (p.pos in POS_VAL ? POS_VAL[p.pos] : null));
    const usePos = cfg.balancePositions !== false && posVals.some((v) => v != null);
    const plain = fitTargets(raw, T, N);
    let plan = { mode: usePos ? 'soft' : 'off', x: plain, groups: null, rows: null, limits: null };
    if (usePos && N === 5) {
      const groups = posVals.map(groupOf);
      let fallback = null;
      for (const [mode, rows] of POS_MODES) {
        const limits = limitsOf(rows);
        const x = fitTargets(raw, T, N, groups, limits);
        if (!x) continue;
        // Staying in position may change the minutes a little, but typed minutes shouldn't grow much and
        // nobody should play (almost) the whole game just for that: then a neighbouring group helps out.
        const ok = x.every((v, i) => v <= plain[i] + Math.max(4, 0.3 * plain[i]) || (isBlank(raw[i]) && v <= 0.75 * T));
        if (ok) { plan = { mode, x, groups, rows, limits }; break; }
        fallback = fallback || { mode, x, groups, rows, limits };
      }
      if (plan.mode === 'soft' && fallback) plan = fallback;
    }
    const { groups, rows, limits } = plan;
    const targets = roundTargets(plan.x, T, N, groups, limits);
    // Picked starters start, even if fewer than N are picked (the rest is filled in automatically). Players
    // who play the whole game always start; if the positions or the lineup size don't allow all picked
    // starters, the ones with the most minutes start.
    // Picked finishers are on court at the end of the game, with the same rules.
    const pickLineup = (flag) => {
      const out = [], drop = [];
      const picked = players.map((p, i) => (p[flag] && targets[i] > 0 ? i : -1)).filter((i) => i >= 0);
      if (!picked.length) return [out, drop];
      const memb = membership(groups, limits || [], players.length);
      const need = limits && limits.map(([, cap], l) =>
        Math.max(0, targets.reduce((a, t, i) => a + (memb[i].includes(l) ? t : 0), 0) - cap * (T - 1)));
      const pk = picker(N, limits, memb, limits && limitTree(limits), need, targets.map((t) => t > 0));
      targets.forEach((t, i) => { if (t >= T) pk.add(i, true); });
      picked.sort((a, b) => targets[b] - targets[a] || a - b).forEach((i) => {
        if (pk.chosen.includes(i) || pk.add(i)) out.push(i);
        else drop.push(i);
      });
      return [out.sort((a, b) => a - b), drop];
    };
    const [starters, dropped] = pickLineup('starter');
    const [finishers, finDropped] = pickLineup('finisher');
    return { targets, posVals, usePos, mode: plan.mode, groups, rows, limits, starters, dropped, finishers, finDropped };
  }

  function buildRotation(players, cfg, opts = {}) {
    const N = cfg.onCourt;
    const plan = planTargets(players, cfg);
    const { targets, starters, finishers, posVals } = plan;
    const halfSlot = cfg.periods % 2 === 0 ? (cfg.periods / 2) * cfg.periodLen : -1;
    cfg = {
      ...cfg,
      posCost: plan.usePos ? makePosCost(posVals, N) : null,
      groups: plan.groups,
      limits: plan.limits,
      // Polishing must not move anyone out of the starting lineups.
      lockSlots: starters.length ? [0, ...(cfg.startersEachHalf && halfSlot > 0 ? [halfSlot] : [])] : [],
      finishers,
      finLen: finishers.length ? finishLens(cfg, targets, starters, finishers) : null,
    };
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
        closeW: k === 0 ? 1 : rng() * 2,
        hardFin: finishers.length > 0 && k % 2 === 1,
      };
      const grid = buildOnce(targets, starters, cfg, rng, p);
      // The hard finisher rule can paint itself into a corner: skip those (the soft builds always work).
      if (p.hardFin && !grid.every((row, i) => row.reduce((a, b) => a + b, 0) === targets[i] && (!starters.includes(i) || row[0]))) continue;
      const a = analyze(grid, cfg);
      if (!best || a.cost < best.cost) best = { grid, ...a };
    }
    const grid = finish(polish(finish(best.grid, cfg), cfg, rng, opts.polishSteps ?? 40000), cfg);
    const fin = analyze(grid, cfg);
    return { grid, targets, starters, plan, mode: plan.mode, subs: fin.subs, moments: fin.moments, posPenalty: fin.posPenalty };
  }

  // Puts picked finishers on court for the end of the game: finisher f moves a minute from earlier in the game
  // (t) to the end (s), and a player b on court at s takes f's minute t. Minutes, the on-court count, starting
  // lineups and position limits stay as they are; the cheapest such swap is used.
  function finish(grid, cfg) {
    const fin = cfg.finishers || [];
    if (!fin.length) return grid;
    const S = cfg.periods * cfg.periodLen;
    const n = grid.length;
    const g = grid.map((r) => r.slice());
    const lock = cfg.lockSlots || [];
    const lim = cfg.limits;
    const memb = lim ? membership(cfg.groups, lim, n) : null;
    const fits = (s) => !lim || lim.every(([, cap], l) => g.reduce((a, r, i) => a + (r[s] && memb[i].includes(l) ? 1 : 0), 0) <= cap);
    const from = (i) => S - cfg.finLen[i];
    for (const f of fin) {
      for (let s = S - 1; s >= from(f); s--) {
        if (g[f][s]) continue;
        let best = null;
        for (let t = 0; t < S; t++) {
          if (!g[f][t] || t >= from(f) || lock.includes(t) || lock.includes(s)) continue;
          for (let b = 0; b < n; b++) {
            if (!g[b][s] || g[b][t] || s >= from(b)) continue;
            g[f][t] = 0; g[f][s] = 1; g[b][s] = 0; g[b][t] = 1;
            if (fits(s) && fits(t)) {
              const c = analyze(g, cfg).cost;
              if (!best || c < best.c) best = { c, t, b };
            }
            g[f][t] = 1; g[f][s] = 0; g[b][s] = 1; g[b][t] = 0;
          }
        }
        if (best) { g[f][best.t] = 0; g[f][s] = 1; g[best.b][s] = 0; g[best.b][best.t] = 1; }
      }
    }
    return g;
  }

  // Hill-climb with swaps that keep every player's minutes and the on-court count unchanged.
  function polish(grid, cfg, rng, steps) {
    const S = cfg.periods * cfg.periodLen;
    const n = grid.length;
    const lock = cfg.lockSlots || [];
    const g = grid.map((r) => r.slice());
    // Position limits: players of each limit on court per minute (swaps must stay within the limits).
    const lim = cfg.limits;
    const memb = lim ? membership(cfg.groups, lim, n) : null;
    const onL = lim
      ? Array.from({ length: S }, (_, s) => lim.map((_, l) => g.reduce((a, r, i) => a + (r[s] && memb[i].includes(l) ? 1 : 0), 0)))
      : null;
    let cost = analyze(g, cfg).cost;
    for (let k = 0; k < steps; k++) {
      const a = Math.floor(rng() * n), b = Math.floor(rng() * n);
      if (a === b) continue;
      const s = Math.floor(rng() * S);
      let t = rng() < 0.5 ? Math.floor(rng() * S) : s + (rng() < 0.5 ? -1 : 1) * (1 + Math.floor(rng() * 4));
      if (t < 0 || t >= S || lock.includes(s) || lock.includes(t)) continue;
      if (!(g[a][s] && !g[a][t] && !g[b][s] && g[b][t])) continue;
      // a moves from minute s to t, b from t to s: d[l] = change of limit l at minute s (minus that at t).
      let d = null;
      if (lim) {
        d = lim.map((_, l) => (memb[b].includes(l) ? 1 : 0) - (memb[a].includes(l) ? 1 : 0));
        if (d.some((v, l) => (v > 0 && onL[s][l] >= lim[l][1]) || (v < 0 && onL[t][l] >= lim[l][1]))) continue;
      }
      g[a][s] = 0; g[a][t] = 1; g[b][s] = 1; g[b][t] = 0;
      const c = analyze(g, cfg).cost;
      if (c <= cost) {
        cost = c;
        if (d) d.forEach((v, l) => { onL[s][l] += v; onL[t][l] -= v; });
      } else { g[a][s] = 1; g[a][t] = 0; g[b][s] = 0; g[b][t] = 1; }
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
  // plan (from planTargets, optional): rows a player may never take, e.g. a guard at C.
  function assignSlots(grid, posVals, N, periodLen, plan) {
    const S = grid.length ? grid[0].length : 0;
    const slotTarget = (k) => (N === 1 ? 0 : (k * 4) / (N - 1));
    const off = (p, k) => (plan && !rowOk(plan, p, k) ? 1000 : 0) + (badSlot(posVals[p], k, N) ? 100 : 0);
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
          c += (pv == null ? 0 : Math.abs(pv - slotTarget(free[r]))) + off(p, free[r]);
          c += 1e-3 * Math.abs(inc.indexOf(p) - r);
          if (prev && reset && prev.includes(p) && prev[free[r]] !== p) c += 0.3;
        });
        if (c < bestCost) { bestCost = c; best = perm; }
      }
      best.forEach((p, r) => (slots[free[r]] = p));
      // Keeping players in their row must not leave e.g. a guard at SF: then re-seat everyone, moving as few as possible.
      if (!reset && on.length === N && N <= 7 && slots.some((p, k) => p >= 0 && off(p, k))) {
        let bestAll = null, bestAllCost = Infinity;
        for (const perm of permutations(on)) {
          let c = 0;
          perm.forEach((p, k) => {
            const pv = posVals[p];
            c += off(p, k) + (pv == null ? 0 : 0.2 * Math.abs(pv - slotTarget(k)));
            if (prev[k] !== p) c += prev.includes(p) ? 1 : 0.01;
          });
          if (c < bestAllCost) { bestAllCost = c; bestAll = perm; }
        }
        bestAll.forEach((p, k) => (slots[k] = p));
      }
      out.push(slots);
      prev = slots;
    }
    return out;
  }

  const api = {
    normalizeTargets, planTargets, buildRotation, subEvents, analyze, assignSlots, makePosCost, adjustMinutes,
    POS_VAL, POS_GROUP, POS_MODES, groupOf, badSlot, rowOk, limitsOf,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Rotation = api;
})(this);
