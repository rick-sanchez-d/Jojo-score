// JoJoScore backend. Run: API_KEY=your_key node server.js   (Node 18+, no npm install needed)
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const KEY = process.env.API_KEY, PORT = process.env.PORT || 3000, SEASON = process.env.SEASON || 2026;
const SECRET = process.env.SECRET || "change-me-please";
const DB = path.join(__dirname, "users.json");
const TTL = { live: 120e3, fixtures: 120e3, stats: 300e3, standings: 900e3 };
const cache = new Map();

async function api(endpoint, ttl) {
  const hit = cache.get(endpoint);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  const r = await fetch("https://v3.football.api-sports.io" + endpoint, { headers: { "x-apisports-key": KEY } });
  const d = await r.json();
  if (!d.errors || !Object.keys(d.errors).length) cache.set(endpoint, { t: Date.now(), d });
  return d;
}

const users = () => { try { return JSON.parse(fs.readFileSync(DB)); } catch { return {}; } };
const saveUsers = u => fs.writeFileSync(DB, JSON.stringify(u, null, 2));
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
const sign = n => { const b = Buffer.from(JSON.stringify({ n, e: Date.now() + 6048e5 })).toString("base64url");
  return b + "." + crypto.createHmac("sha256", SECRET).update(b).digest("base64url"); };
function who(req) {
  const [b, s] = (req.headers.authorization || "").replace("Bearer ", "").split(".");
  if (!b || s !== crypto.createHmac("sha256", SECRET).update(b).digest("base64url")) return null;
  const p = JSON.parse(Buffer.from(b, "base64url")); return p.e > Date.now() ? p.n : null;
}
const body = req => new Promise(r => { let s = ""; req.on("data", c => (s += c)); req.on("end", () => { try { r(JSON.parse(s)); } catch { r({}); } }); });
const send = (res, c, o) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  try {
    if (p === "/api/fixtures") return send(res, 200, await api("/fixtures?date=" + (u.searchParams.get("date") || new Date().toISOString().slice(0, 10)), TTL.fixtures));
    if (p === "/api/live") return send(res, 200, await api("/fixtures?live=all", TTL.live));
    if (p === "/api/stats") return send(res, 200, await api("/fixtures/statistics?fixture=" + +u.searchParams.get("id"), TTL.stats));
    if (p === "/api/standings") return send(res, 200, await api(`/standings?league=${+u.searchParams.get("league") || 39}&season=${SEASON}`, TTL.standings));
    if (p === "/api/signup" || p === "/api/login") {
      const { name, pass } = await body(req), all = users();
      if (!name || !pass || pass.length < 6) return send(res, 400, { error: "Name and a 6+ character password required" });
      if (p === "/api/signup") {
        if (all[name]) return send(res, 409, { error: "Username taken" });
        const salt = crypto.randomBytes(16).toString("hex");
        all[name] = { salt, hash: hash(pass, salt), favs: [] }; saveUsers(all);
      } else if (!all[name] || all[name].hash !== hash(pass, all[name].salt)) return send(res, 401, { error: "Wrong username or password" });
      return send(res, 200, { token: sign(name), name, favs: all[name].favs });
    }
    if (p === "/api/fav") {
      const n = who(req); if (!n) return send(res, 401, { error: "Sign in first" });
      const { favs } = await body(req), all = users(); all[n].favs = (favs || []).slice(0, 100); saveUsers(all);
      return send(res, 200, { ok: 1 });
    }
    if (p === "/api/me") { const n = who(req); return n ? send(res, 200, { name: n, favs: users()[n]?.favs || [] }) : send(res, 401, {}); }
    const f = path.join(__dirname, "public", p === "/" ? "index.html" : p);
    if (!f.startsWith(path.join(__dirname, "public")) || !fs.existsSync(f)) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html" : "text/plain" }); fs.createReadStream(f).pipe(res);
  } catch (e) { send(res, 500, { error: "Server error" }); }
}).listen(PORT, () => console.log("JoJoScore on http://localhost:" + PORT + (KEY ? "" : "  (794015509a9fe7bc4b67dde9d4560437)")));
