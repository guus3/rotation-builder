# 🏀 Rotation Builder

Enter players and target minutes → get a minute-by-minute rotation chart and substitution sheet.

- Paste a roster (`4 Mikko 32` per line), leave minutes blank to split evenly, ⭐ starters.
- Rotation is built automatically: exact minutes, 5 on court, subs roughly every 4 minutes by default (adjustable under *Rotation style*), max stint & rest rules.
- Position-aware: with positions set, lineups are balanced (ball-handler + big on court, no double centres) while keeping exact minutes. Toggle under *Rotation style*.
- Lineup view per quarter with position rows (PG/SG/SF/PF/C); tap a bar to swap a player in for any time range (with undo).
- 💾 Teams: save your roster once as a team, pick it each game and untick ✓ players who are out (saved in the browser).
- Editor: drag the white line between two bars to move a sub, drag a bar sideways to shift a stint, or use − / + (or type) per player to change minutes – the rotation and other players adjust automatically. 📌 keeps a player's minutes fixed.
- Forwards (F) are never used at C.
- 🔗 Share link: the whole rotation is compressed into the URL – whoever opens it gets an editable copy (no server/login).
- 🖼️ Image: exports a PNG of the lineup + minutes (share sheet on phones, download on desktop). Print also supported.
- Paste format: `4 Mikko PG 32` (number, name, optional position, optional minutes). Data is saved in the browser.

Static site (no backend): `index.html`, `app.js`, `rotation.js` (engine), `style.css`.
Run locally: `python3 -m http.server` and open http://localhost:8000.
