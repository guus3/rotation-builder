# 🏀 Rotation Builder

Enter players and target minutes → get a minute-by-minute rotation chart and substitution sheet.

- Paste a roster (`4 Mikko 32` per line), leave minutes blank to split evenly, ⭐ starters.
- Rotation is built automatically: exact minutes, 5 on court, subs on chosen intervals, max stint & rest rules.
- Tap chart cells to adjust by hand; print or share a link. Data is saved in the browser.

Static site (no backend): `index.html`, `app.js`, `rotation.js` (engine), `style.css`.
Run locally: `python3 -m http.server` and open http://localhost:8000.
