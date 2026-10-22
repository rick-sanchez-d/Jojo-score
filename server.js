// JoJoScore backend. Run: node server.js   (Node 18+, no npm install). Keys live in .env
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
try { fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }); } catch {}
const KEY = process.env.API_KEY, PORT = process.env.PORT || 3000, SEASON = process.env.SEASON || 2026, SECRET = process.env.SECRET || crypto.randomBytes(16).toString("hex");
const DB = path.join(__dirname, "users.json"), PUB = path.join(__dirname, "public");
const TTL = { live: 90e3, fixtures: 120e3, stats: 300e3, events: 120e3, standings: 900e3 };
const cache = new Map(), hits = new Map();
setInterval(() => hits.clear(), 9e5).unref();

async function api(endpoint, ttl) {
  const hit = cache.get(endpoint);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  try {
    const r = await fetch("https://v3.football.api-sports.io" + endpoint, { headers: { "x-apisports-key": KEY || "" } });
    const d = await r.json();
    if (!d.errors || !Object.keys(d.errors).length) cache.set(endpoint, { t: Date.now(), d });
    else if (hit) return hit.d;
    return d;
  } catch { return hit ? hit.d : { errors: { network: "Could not reach the football data provider" }, response: [] }; }
}
const users = () => { try { return JSON.parse(fs.readFileSync(DB)); } catch { return {}; } };
const saveUsers = u => fs.writeFileSync(DB, JSON.stringify(u, null, 2));
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
const sign = n => { const b = Buffer.from(JSON.stringify({ n, e: Date.now() + 6048e5 })).toString("base64url");
  return b + "." + crypto.createHmac("sha256", SECRET).update(b).digest("base64url"); };
function who(req) {
  try {
    const [b, s] = (req.headers.authorization || "").replace("Bearer ", "").split(".");
    if (!b || s !== crypto.createHmac("sha256", SECRET).update(b).digest("base64url")) return null;
    const p = JSON.parse(Buffer.from(b, "base64url")); return p.e > Date.now() ? p.n : null;
  } catch { return null; }
}
const body = req => new Promise(r => { let s = ""; req.on("data", c => { s += c; if (s.length > 1e5) req.destroy(); }); req.on("end", () => { try { r(JSON.parse(s)); } catch { r({}); } }); });
const H = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const send = (res, c, o) => { res.writeHead(c, { ...H, "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname, q = k => u.searchParams.get(k) || "";
  try {
    if (p === "/api/fixtures") {
      const ids = q("ids").replace(/[^0-9-]/g, "").split("-").filter(Boolean).slice(0, 20).join("-");
      const date = /^\d{4}-\d{2}-\d{2}$/.test(q("date")) ? q("date") : new Date().toISOString().slice(0, 10);
      return send(res, 200, await api(ids ? "/fixtures?ids=" + ids : "/fixtures?date=" + date, TTL.fixtures));
    }
    if (p === "/api/live") return send(res, 200, await api("/fixtures?live=all", TTL.live));
    if (p === "/api/stats") return send(res, 200, await api("/fixtures/statistics?fixture=" + +q("id"), TTL.stats));
    if (p === "/api/events") return send(res, 200, await api("/fixtures/events?fixture=" + +q("id"), TTL.events));
    if (p === "/api/standings") return send(res, 200, await api(`/standings?league=${+q("league") || 39}&season=${SEASON}`, TTL.standings));
    if (p === "/api/signup" || p === "/api/login") {
      if (req.method !== "POST") return send(res, 405, { error: "POST only" });
      const ip = req.socket.remoteAddress, n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
      if (n > 20) return send(res, 429, { error: "Too many attempts, try again in 15 minutes" });
      const { name, pass } = await body(req), all = users(), k = "u_" + name;
      if (!/^[A-Za-z0-9_]{3,20}$/.test(name || "") || !pass || pass.length < 6) return send(res, 400, { error: "Username: 3-20 letters/numbers. Password: 6+ characters." });
      if (p === "/api/signup") {
        if (all[k]) return send(res, 409, { error: "Username taken" });
        const salt = crypto.randomBytes(16).toString("hex");
        all[k] = { salt, hash: hash(pass, salt), favs: [], created: Date.now() }; saveUsers(all);
      } else if (!all[k] || all[k].hash !== hash(pass, all[k].salt)) return send(res, 401, { error: "Wrong username or password" });
      return send(res, 200, { token: sign(name), name, favs: all[k].favs });
    }
    if (p === "/api/fav") {
      const n = who(req), all = users(), k = "u_" + n; if (!n || !all[k]) return send(res, 401, { error: "Sign in first" });
      const { favs } = await body(req); all[k].favs = (Array.isArray(favs) ? favs : []).map(Number).filter(Boolean).slice(0, 100); saveUsers(all);
      return send(res, 200, { ok: 1 });
    }
    if (p === "/api/me") { const n = who(req), a = users()["u_" + n]; return n && a ? send(res, 200, { name: n, favs: a.favs }) : send(res, 401, {}); }
    const f = path.join(PUB, p === "/" ? "index.html" : p);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, H); return res.end("Not found"); }
    res.writeHead(200, { ...H, "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
  } catch (e) { send(res, 500, { error: "Server error" }); }
}).listen(PORT, () => console.log("JoJoScore on http://localhost:" + PORT + (KEY ? "" : "  (API_KEY missing in .env!)")));
