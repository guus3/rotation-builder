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

  // Sub windows within a period: the period is split into about L / subEvery equal blocks (half rounds down), so
  // there's no short tail (10-min quarters, every 4 or 5 min → subs at minutes 0 and 5).
  // win[m]: 0 = sub window, 1 = a minute next to a mid-period window (e.g. 4 or 6 in a 10-min quarter: allowed
  // at a small cost), 2 = off the windows. block = shortest block, unit = block length if all blocks are equal.
  const winCache = new Map();
  function subWindows(cfg) {
    const L = cfg.periodLen, key = `${L}|${cfg.subEvery}`;
    if (winCache.has(key)) return winCache.get(key);
    const k = Math.max(1, Math.ceil(L / Math.max(1, cfg.subEvery || 1) - 0.5));
    const win = new Array(L).fill(2);
    const mids = [];
    for (let j = 0; j < k; j++) { const m = Math.round((j * L) / k); win[m] = 0; if (j) mids.push(m); }
    mids.forEach((w) => [w - 1, w + 1].forEach((m) => { if (m >= 2 && L - m >= 2 && win[m] === 2) win[m] = 1; }));
    const res = { win, block: Math.floor(L / k), unit: L % k === 0 ? L / k : 1 };
    winCache.set(key, res);
    return res;
  }
  // Shortest shift a player should get (cfg.minShift, default 4; 0 = no rule), at most one block between subs.
  const minShiftOf = (cfg) => Math.min(cfg.minShift ?? 4, subWindows(cfg).block);
  // Shortest rest: a player who comes off sits at least minRest minutes, and with a shortest-shift rule also
  // at least that long (out for a minute and straight back in is just as unrealistic).
  const minRestOf = (cfg) => { const ms = minShiftOf(cfg); return Math.max(cfg.minRest ?? 0, ms > 2 ? ms : 0); };

  // Whole minutes that add up to exactly N*T (and stay within the position limits). Players with snap[i] set
  // (automatic minutes) get whole blocks of `unit` minutes where possible, so they can play whole shifts.
  // prefer[i]: who gets the extra block first when shares are equal.
  function roundTargets(x, T, N, groups, limits, unit = 1, snap = null, prefer = null) {
    const lims = limits || [];
    const memb = membership(groups, lims, x.length);
    const step = x.map((_, i) => (unit > 1 && snap && snap[i] ? unit : 1));
    const fl = x.map((v, i) => step[i] * Math.floor(v / step[i] + 1e-9));
    const room = lims.map((L) => L[1] * T);
    fl.forEach((v, i) => memb[i].forEach((l) => (room[l] -= v)));
    let left = N * T - fl.reduce((a, b) => a + b, 0);
    const pref = (i) => (prefer && prefer[i] ? 1 : 0);
    if (unit > 1 && snap) {
      // Whole blocks first, to the players closest to their next block.
      const blocks = x.map((v, i) => [(v - fl[i]) / step[i], i]).filter(([, i]) => step[i] > 1 && x[i] > 0)
        .sort((a, b) => b[0] - a[0] || pref(b[1]) - pref(a[1]) || a[1] - b[1]);
      for (const [, i] of blocks) {
        if (left < unit) break;
        if (fl[i] + unit <= T && memb[i].every((l) => room[l] >= unit)) {
          fl[i] += unit;
          memb[i].forEach((l) => (room[l] -= unit));
          left -= unit;
        }
      }
    }
    const order = x.map((v, i) => [v - fl[i], i]).sort((a, b) => b[0] - a[0] || pref(b[1]) - pref(a[1]) || a[1] - b[1]);
    for (let pass = 0; left > 0; pass++) {
      let moved = false;
      for (const [, i] of order) {
        if (left <= 0) break;
        if (pass === 0 && x[i] <= 0) continue; // players with 0 minutes only get one if nothing else works
        if (fl[i] < T && memb[i].every((l) => room[l] > 0)) {
          // Odd minutes left over: a player on whole blocks takes as many as fit, so few players get odd minutes.
          const k = step[i] > 1 ? Math.min(left, T - fl[i], ...memb[i].map((l) => room[l])) : 1;
          fl[i] += k;
          memb[i].forEach((l) => (room[l] -= k));
          left -= k;
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
  // Rows a position may play, as a bitmask over the rows PG(1) SG(2) SF(4) PF(8) C(16).
  const POS_ROWS = { PG: 1, SG: 2, SF: 4, PF: 8, C: 16, G: 3, F: 12 };
  const ALL_ROWS = 31;
  const GROUP_ROWS = [3, 12, 16]; // guard rows, forward rows, C row
  const popcount = (m) => { let c = 0; for (; m; m &= m - 1) c++; return c; };
  // A player's positions: any number of them, joined by '/' in pos (e.g. 'PG/SG'; the optional pos2 is an extra
  // one, for older data). Empty = plays anywhere (null). With 5 on court a specific position (PG, SG, SF, PF, C)
  // only plays its own row, G either guard row and F either forward row; the player may take the rows of every
  // listed position. The first listed position is the main one. Only a plain G or F player (a single position)
  // may help out a neighbouring group when the roster can't fill it (see POS_MODES).
  function posProfile(pos, pos2) {
    const list = [...new Set(`${pos || ''}/${pos2 || ''}`.split('/').filter((x) => x in POS_ROWS))];
    if (!list.length) return null;
    const prim = POS_ROWS[list[0]];
    return {
      pos: list.join('/'), list, val: POS_VAL[list[0]], vals: list.map((x) => POS_VAL[x]),
      prim, mask: list.reduce((m, x) => m | POS_ROWS[x], 0), generic: list.length === 1 && (list[0] === 'G' || list[0] === 'F'),
    };
  }
  const POS_GROUP = [0, 0, 1, 1, 2]; // row -> group: 0 = guards, 1 = forwards, 2 = centres
  // Group of a player's primary position (-1 = anywhere).
  const groupOf = (pf) => (pf == null ? -1 : pf.val <= 1 ? 0 : pf.val < 4 ? 1 : 2);
  // Is row k outside the player's positions? (Other team sizes: positions only steer the lineups, forwards
  // avoid the last row.)
  const badSlot = (pf, k, N) =>
    pf != null && (N === 5 ? !((pf.mask >> k) & 1) : N > 5 && pf.pos === 'F' && k === N - 1);
  // How far row k is from the player's natural spot (0 = ideal; a further position costs a little).
  function posDist(pf, k, N) {
    if (pf == null) return 0;
    if (N === 5) {
      if ((pf.prim >> k) & 1) return Math.abs(pf.val - k);
      if ((pf.mask >> k) & 1) return 0.75;
      return Math.abs(pf.val - k);
    }
    const t = N === 1 ? 0 : (k * 4) / (N - 1);
    return Math.min(...pf.vals.map((v) => Math.abs(v - t)));
  }
  // If the roster or the typed minutes can't fill a group's rows, plain G / F players help out a neighbouring
  // group. [mode, rows]: rows[g] = row groups that plain players of group g may use, most preferred mode first.
  // Players with a specific or combined position always keep their own rows.
  const POS_MODES = [
    ['strict', [[0], [1], [2]]],
    ['relaxC', [[0], [1, 2], [2]]], // F players also play C
    ['relaxG', [[0], [0, 1], [2]]], // F players also play guard
    ['relaxGC', [[0], [0, 1, 2], [2]]], // F players also play guard and C
    ['relaxFG', [[0, 1], [1], [2]]], // G players also play forward
    ['relaxCF', [[0, 1], [1, 2], [2]]], // G players also play forward, F players also play C
  ];
  // Rows each player may take under a mode's rows (-1 = anywhere).
  const rowMasks = (profs, rows) => profs.map((pf) => {
    if (pf == null) return -1;
    const m = pf.generic && rows ? rows[groupOf(pf)].reduce((a, g) => a | GROUP_ROWS[g], 0) : pf.mask;
    return m === ALL_ROWS ? -1 : m;
  });
  // Which lineups fit the rows: a lineup can fill the rows if, for every set of rows R, the players who may
  // only play within R don't outnumber them (Hall's condition). Players with the same rows share a type
  // (groups[i] = type index, -1 = anywhere). Returns the limits that matter, [bitmask of types, max on court
  // together, rows R], smallest first.
  function limitsOf(masks) {
    const types = [...new Set(masks.filter((m) => m >= 0))];
    const groups = masks.map((m) => (m >= 0 ? types.indexOf(m) : -1));
    const byMembers = new Map();
    for (let R = 1; R < ALL_ROWS; R++) {
      let mem = 0;
      types.forEach((m, t) => { if ((m & ~R) === 0) mem |= 1 << t; });
      if (!mem) continue;
      const cap = popcount(R);
      if (!byMembers.has(mem) || byMembers.get(mem)[1] > cap) byMembers.set(mem, [mem, cap, R]);
    }
    const all = [...byMembers.values()];
    // Drop limits that follow from others (a wider limit with no more room, or two separate ones together).
    const limits = all.filter(([m, c], a) => !all.some(([m1, c1], b) => {
      if (b === a) return false;
      if ((m & m1) === m && c1 <= c) return true;
      return all.some(([m2, c2], d) => d !== a && d !== b && !(m1 & m2) && (m & (m1 | m2)) === m && c1 + c2 <= c);
    }));
    return { groups, limits: limits.sort((x, y) => x[1] - y[1] || popcount(x[0]) - popcount(y[0])) };
  }
  // May player i take row k under the plan from planTargets (masks)?
  const rowOk = (plan, i, k) => !plan || !plan.masks || plan.masks[i] < 0 || ((plan.masks[i] >> k) & 1) === 1;
  // For each player: the limits it counts toward.
  const membership = (groups, lims, n) =>
    Array.from({ length: n }, (_, i) => {
      const g = groups && lims.length ? groups[i] : -1;
      return g < 0 ? [] : lims.map((L, l) => ((L[0] >> g) & 1 ? l : -1)).filter((l) => l >= 0);
    });
  // Can a partial lineup still get exactly k more players? aT[t] = players of type t that could still be added,
  // aFree = players without a position, lo/hi[l] = how many more of limit l's players must / may be added.
  // Exact search over how many of each type are added; results are cached per set of limits.
  const fillCache = new WeakMap();
  function canFill(lims, typeL, k, aFree, aT, lo, hi) {
    let memo = fillCache.get(lims);
    if (!memo || memo.size > 50000) fillCache.set(lims, (memo = new Map()));
    const key = `${k}|${Math.min(aFree, k)}|${aT.map((a) => Math.min(a, k)).join(',')}|${lo.join(',')}|${hi.join(',')}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const sum = lims.map(() => 0);
    const nT = aT.length;
    const rec = (t, left) => {
      if (t === nT) return left <= aFree && lo.every((v, l) => sum[l] >= v);
      const tl = typeL[t];
      const mx = Math.min(aT[t], left);
      let x = 0, found = false;
      for (;;) {
        if (rec(t + 1, left - x)) { found = true; break; }
        if (x === mx) break;
        x++;
        let over = false;
        for (const l of tl) if (++sum[l] > hi[l]) over = true;
        if (over) break;
      }
      for (const l of tl) sum[l] -= x;
      return found;
    };
    const ok = rec(0, k);
    memo.set(key, ok);
    return ok;
  }
  // Fills one lineup under the position limits: at most cap players of a limit, at least need[l] of them,
  // and a player is only added if the lineup can still be completed to N.
  function picker(N, lims, groups, memb, need, live) {
    const chosen = [];
    const cnt = lims ? lims.map(() => 0) : null;
    const nT = lims ? Math.max(0, ...groups.map((g) => g + 1)) : 0;
    const aT = new Array(nT).fill(0);
    const typeL = Array.from({ length: nT }, (_, t) => (lims || []).map((L, l) => ((L[0] >> t) & 1 ? l : -1)).filter((l) => l >= 0));
    let aFree = 0, availAll = 0;
    live.forEach((ok, i) => {
      if (!ok) return;
      availAll++;
      if (lims && groups[i] >= 0) aT[groups[i]]++;
      else aFree++;
    });
    const take = (i, d) => {
      if (lims) memb[i].forEach((l) => (cnt[l] += d));
      if (lims && groups[i] >= 0) aT[groups[i]] -= d;
      else aFree -= d;
      availAll -= d;
    };
    const canAdd = (i, forced) => {
      if (chosen.length >= N || !live[i] || chosen.includes(i)) return false;
      if (!lims) return true;
      const ms = memb[i];
      if (ms.some((l) => cnt[l] >= lims[l][1])) return false;
      if (forced) return true;
      take(i, 1);
      const ok = canFill(lims, typeL, N - chosen.length - 1, aFree, aT,
        lims.map((_, l) => Math.max(0, need[l] - cnt[l])), lims.map(([, cap], l) => cap - cnt[l]));
      take(i, -1);
      return ok;
    };
    const add = (i, forced) => {
      if (!canAdd(i, forced)) return false;
      chosen.push(i);
      take(i, 1);
      return true;
    };
    const short = (i) => !!lims && memb[i].some((l) => cnt[l] < need[l]);
    return { chosen, canAdd, add, short };
  }

  // Cost of how badly a (partial) lineup covers the PG..C spots. 0 = every player fits a spot.
  // Players without a position are flexible and cost nothing.
  function makePosCost(profs, N) {
    const cache = new Map();
    return function (lineup) {
      let key = 0;
      for (const i of lineup) key += 2 ** i;
      if (cache.has(key)) return cache.get(key);
      const ps = lineup.map((i) => profs[i]).filter((v) => v != null);
      const used = new Array(N).fill(false);
      let best = ps.length > N ? 0 : Infinity;
      (function rec(j, acc) {
        if (acc >= best) return;
        if (j === ps.length) { best = acc; return; }
        for (let k = 0; k < N; k++) {
          if (used[k]) continue;
          used[k] = true;
          const d = Math.max(0, posDist(ps[j], k, N) - 0.5);
          rec(j + 1, acc + d + d * d + (badSlot(ps[j], k, N) ? 8 : 0));
          used[k] = false;
        }
      })(0, 0);
      cache.set(key, best);
      return best;
    };
  }

  function buildOnce(targets, starters, cfg, rng, p) {
    const { periods, periodLen, onCourt: N, maxStint, startersEachHalf } = cfg;
    const S = periods * periodLen;
    const n = targets.length;
    const rem = targets.slice();
    const stint = new Array(n).fill(0);
    const shift = new Array(n).fill(0); // minutes on court since the player came in (breaks don't reset it)
    const rest = new Array(n).fill(99);
    const { win } = subWindows(cfg);
    const ms = minShiftOf(cfg);
    const restMin = minRestOf(cfg);
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
      const isWindow = win[m] === 0 || (p.soft && win[m] === 1);
      // Who stays on now stays until the next window: count those minutes against the longest stint.
      let toNext = 1;
      while (m + toNext < periodLen && !(win[m + toNext] === 0 || (p.soft && win[m + toNext] === 1))) toNext++;

      const score = new Array(n);
      for (let i = 0; i < n; i++) {
        // Non-closers aim to use up their minutes before the last C minutes of the game.
        // Picked finishers keep their last minutes for the end of the game.
        const Ri = finLen[i] && R > finLen[i] ? R - finLen[i] : gap[i] && R > C ? R - C : R;
        let sc = (p.urg * Math.max(0, rem[i] - (R > finLen[i] ? finLen[i] : 0))) / Ri + rng() * p.noise;
        if (gap[i] && R <= C) sc -= (p.closeW * gap[i]) / 10;
        if (finLen[i]) sc += R <= finLen[i] ? 5 : rem[i] <= finLen[i] ? -5 : 0;
        if (on.has(i)) {
          if (ms > 2 && shift[i] < ms) sc += 3; // a shift is at least ms minutes
          else if (stint[i] < p.minStint) sc += 1;
          else if (stint[i] + (isWindow ? toNext : 0) > maxStint) sc -= 0.6 + 0.15 * (stint[i] + (isWindow ? toNext : 0) - maxStint);
          else sc += p.stay;
        } else if (rest[i] < restMin) sc -= 0.8;
        score[i] = sc;
      }
      const byScore = (a, b) => score[b] - score[a];

      let base = [];
      if (starters.length && (s === 0 || (startersEachHalf && s === halfSlot))) base = starters.slice();
      else if (!isWindow) base = [...on];

      const need = lim ? remL.map((r, l) => Math.max(0, r - lim[l][1] * (R - 1))) : null;
      // hardFin: picked finishers can't use the minutes they keep for the end of the game.
      const blockedNow = (i) => blockedAfter && blockedAfter[i][s] > blockedAfter[i][s + 1];
      const pk = picker(N, lim, cfg.groups, memb, need, rem.map((r, i) =>
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
          shift[i] = on.has(i) ? shift[i] + 1 : 1;
          rest[i] = 0;
          rem[i]--;
          if (lim) memb[i].forEach((l) => remL[l]--);
          grid[i][s] = 1;
        } else {
          rest[i] = on.has(i) ? 1 : rest[i] + 1;
          stint[i] = 0;
          shift[i] = 0;
        }
      }
      on = next;
    }
    return grid;
  }

  // Cost weights. Stoppages and long stints are what make a sheet hard to run from the bench.
  // short: per minute a shift is shorter than the shortest shift; softWindow: a sub a minute off a mid-period window.
  const W = { moment: 1.5, offWindow: 3, softWindow: 0.75, short: 3, closers: 0.15, long: 0.8, finisher: 30 };
  // A break between periods counts as this many minutes of rest (halftime as a full rest).
  const BREAK = 2;

  function analyze(grid, cfg) {
    const S = cfg.periods * cfg.periodLen;
    const L = cfg.periodLen;
    const half = cfg.periods % 2 === 0 ? (cfg.periods / 2) * L : -1;
    let subs = 0, longStint = 0, shortStint = 0, shortRest = 0, offWindow = 0, softWindow = 0, moments = 0, closers = 0;
    const { win } = subWindows(cfg);
    const ms = minShiftOf(cfg);
    const minRun = Math.max(2, ms);
    const restMin = minRestOf(cfg);
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
            if (win[m] === 2) offWindow++;
            else if (win[m] === 1) softWindow++;
            if (entered && off < restMin) shortRest += ms > 2 ? restMin - off : 1;
          } else if (m === 0 && s > 0 && s + 1 < S && !row[s + 1]) {
            shortStint++; // starts a period and goes straight back out after 1 minute
          }
          run++; load++; off = 0; entered = true; total++;
          if (load > cfg.maxStint) longStint += load - cfg.maxStint; // grows with every extra minute
        } else {
          if (run && run < minRun) shortStint += minRun - run;
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
    const cost = subs + W.moment * moments + W.long * longStint + (ms > 2 ? W.short : 1.5) * shortStint + (ms > 2 ? W.short : 0.5) * shortRest +
      W.offWindow * offWindow + W.softWindow * softWindow + 0.6 * posPenalty + W.closers * closers + W.finisher * finMiss;
    return { subs, moments, posPenalty, finMiss, cost };
  }

  // Give player `idx` exactly `newVal` minutes by editing an existing slot lineup
  // (lineup[s][j] = player index) as little as possible. Minutes are moved in chunks at the
  // start/end of stints (i.e. by shifting substitution times), taken from / given to the
  // other players in a fair way. Players in `locked` keep their minutes.
  function adjustMinutes(lineup, idx, newVal, profs, cfg, locked = new Set()) {
    const S = lineup.length;
    const N = cfg.onCourt;
    const n = profs.length;
    newVal = Math.max(0, Math.min(S, Math.round(newVal)));
    const lu = lineup.map((r) => r.slice());
    const posCost = cfg.balancePositions !== false && profs.some((v) => v != null) ? makePosCost(profs, N) : null;
    const c2 = { ...cfg, posCost };
    const g = Array.from({ length: n }, () => new Array(S).fill(0));
    lu.forEach((row, s) => row.forEach((i) => (g[i][s] = 1)));
    const mins0 = g.map((r) => r.reduce((a, b) => a + b, 0));
    const change = new Array(n).fill(0);
    // Who may take over a row: the plan's rows (cfg.masks from planTargets) if given, else nobody out
    // of position (unless the lineup already has players out of position, then it only costs extra).
    const usePos = !!posCost;
    const strict = usePos && lineup.every((row) => row.every((i, k) => !badSlot(profs[i], k, N)));
    const fits = cfg.masks
      ? (z, j) => rowOk(cfg, z, j)
      : (z, j) => !strict || !badSlot(profs[z], j, N);
    const slotFit = (z, j) => (profs[z] == null || !usePos ? 0 : 0.3 * posDist(profs[z], j, N) + (badSlot(profs[z], j, N) ? 3 : 0));
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
  // position), 'relax…' (the roster or the typed minutes can't fill some rows, so plain G / F players help
  // out there, see POS_MODES), 'soft' (positions only steer the lineups; with 5 on court this means the
  // positions can't fill every row, see posProblem) or 'off'.
  // masks[i]: rows player i may take; starters: picked starters that start; dropped: picked starters that can't.
  function planTargets(players, cfg) {
    const T = cfg.periods * cfg.periodLen;
    const N = cfg.onCourt;
    const raw = players.map((p) => p.target);
    const posVals = players.map((p) => posProfile(p.pos, p.pos2));
    const usePos = cfg.balancePositions !== false && posVals.some((v) => v != null);
    const plain = fitTargets(raw, T, N);
    let plan = { mode: usePos ? 'soft' : 'off', x: plain, groups: null, rows: null, limits: null, masks: null };
    let unfilled = 0;
    const { block } = subWindows(cfg);
    if (usePos && N === 5) {
      let fallback = null;
      const tried = new Set();
      for (const [mode, rows] of POS_MODES) {
        const masks = rowMasks(posVals, rows);
        const key = masks.join();
        if (tried.has(key)) continue; // no plain G / F players this mode would change
        tried.add(key);
        const { groups, limits } = limitsOf(masks);
        const x = fitTargets(raw, T, N, groups, limits);
        if (!x) continue;
        // Staying in position may change the minutes a little, but typed minutes shouldn't grow much and
        // nobody should play (almost) the whole game just for that: then plain G / F players help out.
        // With whole-block shifts, more than one block short of every period would mean playing whole periods.
        const blankCap = Math.min(0.75 * T, minShiftOf(cfg) > 2 && block < cfg.periodLen ? T - cfg.periods * block : T);
        const ok = x.every((v, i) => v <= plain[i] + Math.max(4, 0.3 * plain[i]) || (isBlank(raw[i]) && v <= blankCap));
        if (ok) { plan = { mode, x, groups, rows, limits, masks }; break; }
        fallback = fallback || { mode, x, groups, rows, limits, masks };
      }
      if (plan.mode === 'soft' && fallback) plan = fallback;
      if (plan.mode === 'soft') {
        // Rows nobody (who may get minutes) can play, even with help.
        let reach = 0;
        POS_MODES.forEach(([, rows]) => rowMasks(posVals, rows).forEach((m, i) => {
          if (Number(raw[i]) !== 0 || isBlank(raw[i])) reach |= m < 0 ? ALL_ROWS : m;
        }));
        unfilled = ALL_ROWS & ~reach;
      }
    }
    const { groups, rows, limits, masks } = plan;
    // Automatic minutes come in whole blocks between sub windows (e.g. 10/15/20 with subs every 5 min).
    const unit = minShiftOf(cfg) > 1 ? subWindows(cfg).unit : 1;
    const prefer = players.map((p) => !!(p.starter || p.finisher));
    const targets = roundTargets(plan.x, T, N, groups, limits, unit, raw.map(isBlank), prefer);
    // Picked starters start, even if fewer than N are picked (the rest is filled in automatically). Players
    // who play the whole game always start; if the positions or the lineup size don't allow all picked
    // starters, the ones with the most minutes start.
    // Picked finishers are on court at the end of the game, with the same rules.
    const pickLineup = (flag) =>
      pickFive({ targets, groups, limits }, players.map((p, i) => (p[flag] ? i : -1)).filter((i) => i >= 0), T, N);
    const [starters, dropped] = pickLineup('starter');
    const [finishers, finDropped] = pickLineup('finisher');
    return { targets, unit, posVals, usePos, mode: plan.mode, groups, rows, limits, masks, unfilled, starters, dropped, finishers, finDropped };
  }

  // Why the positions can't fill all 5 rows (null = they can).
  const ROW_POS = ['PG', 'SG', 'SF', 'PF', 'C'];
  function posProblem(plan, N) {
    if (!plan || !plan.usePos || N !== 5 || plan.mode !== 'soft') return null;
    const rows = ROW_POS.filter((_, k) => (plan.unfilled >> k) & 1);
    if (rows.length) {
      const list = rows.length < 2 ? rows[0] : `${rows.slice(0, -1).join(', ')} or ${rows[rows.length - 1]}`;
      return `Nobody can play ${list}. Give a player that position, or set a position to '–' (plays anywhere).`;
    }
    return "These positions can't fill all 5 spots. Add more positions to players, or set a position to '–' (plays anywhere).";
  }

  // Which picked players (indexes) fit one lineup under the plan's minutes and position limits:
  // [on court, dropped]. Players with 0 minutes are ignored; whole-game players are always on court.
  function pickFive(plan, picked, T, N) {
    const { targets, groups, limits } = plan;
    const out = [], drop = [];
    picked = picked.filter((i) => targets[i] > 0);
    if (!picked.length) return [out, drop];
    const memb = membership(groups, limits || [], targets.length);
    const need = limits && limits.map(([, cap], l) =>
      Math.max(0, targets.reduce((a, t, i) => a + (memb[i].includes(l) ? t : 0), 0) - cap * (T - 1)));
    const pk = picker(N, limits, groups, memb, need, targets.map((t) => t > 0));
    targets.forEach((t, i) => { if (t >= T) pk.add(i, true); });
    picked.slice().sort((a, b) => targets[b] - targets[a] || a - b).forEach((i) => {
      if (pk.chosen.includes(i) || pk.add(i)) out.push(i);
      else drop.push(i);
    });
    return [out.sort((a, b) => a - b), drop];
  }

  function buildRotation(players, cfg, opts = {}) {
    const N = cfg.onCourt;
    const plan = planTargets(players, cfg);
    // Players with a position never play outside it: if the positions can't fill every row, nothing is built.
    const problem = posProblem(plan, N);
    if (problem) throw new Error(problem);
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
        soft: k % 3 === 2, // also sub a minute off the mid-period windows (e.g. at 4 or 6)
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
    // Blocks between sub windows (soft ones too, e.g. minute 4 or 6) as [start minute, length]. Swapping whole
    // blocks keeps shifts long, which single-minute swaps can't do once short shifts cost a lot.
    const { win } = subWindows(cfg);
    const L = cfg.periodLen;
    const cuts = [];
    for (let m = 0; m <= L; m++) if (m === L || win[m] <= 1) cuts.push(m);
    const minLen = Math.max(2, minShiftOf(cfg));
    const byLen = new Map();
    for (let p = 0; p < cfg.periods; p++) {
      for (const x of cuts) for (const y of cuts) {
        if (y - x < minLen || y - x === L) continue;
        if (!byLen.has(y - x)) byLen.set(y - x, []);
        byLen.get(y - x).push(p * L + x);
      }
    }
    const blocks = [...byLen.entries()].flatMap(([len, starts]) => starts.map((s) => [s, len]));
    for (let k = 0; k < steps; k++) {
      const a = Math.floor(rng() * n), b = Math.floor(rng() * n);
      if (a === b) continue;
      if (blocks.length > 1 && rng() < 0.3) {
        blockSwap(a, b);
        continue;
      }
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

    // a hands a block starting at s0 to b and takes b's block of the same length starting at t0.
    function blockSwap(a, b) {
      const [s0, len] = blocks[Math.floor(rng() * blocks.length)];
      const same = byLen.get(len);
      const t0 = same[Math.floor(rng() * same.length)];
      if (Math.abs(s0 - t0) < len) return;
      for (let x = 0; x < len; x++) {
        const s = s0 + x, t = t0 + x;
        if (lock.includes(s) || lock.includes(t) || !(g[a][s] && !g[a][t] && !g[b][s] && g[b][t])) return;
      }
      let d = null;
      if (lim) {
        d = lim.map((_, l) => (memb[b].includes(l) ? 1 : 0) - (memb[a].includes(l) ? 1 : 0));
        for (let x = 0; x < len; x++) {
          if (d.some((v, l) => (v > 0 && onL[s0 + x][l] >= lim[l][1]) || (v < 0 && onL[t0 + x][l] >= lim[l][1]))) return;
        }
      }
      const flip = (on) => {
        for (let x = 0; x < len; x++) { g[a][s0 + x] = on ? 0 : 1; g[a][t0 + x] = on ? 1 : 0; g[b][s0 + x] = on ? 1 : 0; g[b][t0 + x] = on ? 0 : 1; }
      };
      flip(true);
      const c = analyze(g, cfg).cost;
      if (c <= cost) {
        cost = c;
        if (d) for (let x = 0; x < len; x++) d.forEach((v, l) => { onL[s0 + x][l] += v; onL[t0 + x][l] -= v; });
      } else flip(false);
    }
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

  // profs: per player a position from posProfile, or null for "any".
  // Players already on court keep their slot; incoming players take the freed slots
  // that best match their position. Returns S rows of N player indices.
  // At period starts everyone is re-placed by position (small penalty for changing rows).
  // plan (from planTargets, optional): rows a player may never take, e.g. a guard at C.
  function assignSlots(grid, profs, N, periodLen, plan) {
    const S = grid.length ? grid[0].length : 0;
    const off = (p, k) => (plan && !rowOk(plan, p, k) ? 1000 : 0) + (badSlot(profs[p], k, N) ? 100 : 0);
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
          c += posDist(profs[p], free[r], N) + off(p, free[r]);
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
            c += off(p, k) + 0.2 * posDist(profs[p], k, N);
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
    POS_VAL, POS_ROWS, GROUP_ROWS, POS_GROUP, POS_MODES, posProfile, posDist, groupOf, badSlot, rowOk, rowMasks,
    limitsOf, pickFive, posProblem, subWindows,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Rotation = api;
})(this);
