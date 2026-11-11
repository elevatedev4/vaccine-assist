// Throwaway QA server: Next dev + in-memory Supabase stub on ONE port.
// Synthetic data only. Never talks to a real Supabase or Acuity.
import http from "node:http";
import { createRequire } from "node:module";
import { parse } from "node:url";

const APP_DIR = process.env.QA_APP_DIR;
const PORT = 3126;
const require = createRequire(APP_DIR + "/package.json");
const next = require("next");

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const USER = {
  id: "00000000-0000-4000-8000-0000000000qa".replace("qa", "aa"),
  aud: "authenticated",
  role: "authenticated",
  email: "qa@example.test",
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};
const TOKEN = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: USER.id, role: "authenticated", aud: "authenticated", email: USER.email, exp: now() + 86400, iat: now() })}.qa-sig`;
const session = () => ({
  access_token: TOKEN,
  token_type: "bearer",
  expires_in: 86400,
  expires_at: now() + 86400,
  refresh_token: "qa-refresh",
  user: USER,
});

// --- in-memory tables (synthetic) ---
const today = new Date().toISOString().slice(0, 10);
const tables = {
  vaccine: [
    { id: "v-flucelvax", name: "Flucelvax PFS", short_code: "FLC", ndc: "70461-0000-01", active: true },
    { id: "v-mflusiva", name: "mFLUSIVA 2026-27", short_code: "MFL", ndc: "00000-0000-02", active: process.env.QA_NO_MFLUSIVA ? false : true },
    { id: "v-fluad", name: "Fluad", short_code: "FLD", ndc: "70461-0000-03", active: true },
  ],
  on_hand_count: [],
  ordering_target: [],
  ordering_ordered_today: [],
  app_setting: [],
  acuity_credentials: [{ id: 1, acuity_user_id: "qa-fake-user", acuity_api_key: "qa-fake-key-0000", updated_at: "2026-01-01T00:00:00Z", updated_by: null }],
  acuity_poll_cache: "dynamic",
};
function pollCacheRows() {
  return [{
    range_key: "any",
    counts: [
      { date: today, vaccineName: "Flu · 50-64", count: 10 },
      { date: today, vaccineName: "Flu · 3-49", count: 5 },
      { date: today, vaccineName: "Flu · 65+", count: 3 },
    ],
    computed_at: new Date().toISOString(),
    possibly_truncated: false,
    hourly_counts: [],
  }];
}
const log = [];

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

function filterRows(rows, query) {
  return rows.filter((row) =>
    Object.entries(query).every(([k, v]) => {
      if (["select", "order", "limit", "offset", "on_conflict", "columns", "or"].includes(k)) return true;
      const val = Array.isArray(v) ? v[0] : v;
      if (val.startsWith("eq.")) return String(row[k]) === val.slice(3);
      if (val === "is.null") return row[k] == null;
      return true;
    })
  );
}

async function handleRest(req, res, table, query) {
  const body = await readBody(req);
  log.push(`${req.method} /rest/v1/${table} ${JSON.stringify(query)} ${body.slice(0, 200)}`);
  if (!(table in tables)) {
    return sendJson(res, 404, { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache`, details: null, hint: null });
  }
  const single = (req.headers.accept || "").includes("vnd.pgrst.object");
  if (table === "acuity_poll_cache") {
    if (req.method === "GET") {
      const rows = pollCacheRows();
      return single ? sendJson(res, 200, rows[0]) : sendJson(res, 200, rows);
    }
    return sendJson(res, 201, []);
  }
  const rows = tables[table];
  if (req.method === "GET" || req.method === "HEAD") {
    const out = filterRows(rows, query);
    if (single) {
      if (out.length !== 1) return sendJson(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `Results contain ${out.length} rows`, hint: null });
      return sendJson(res, 200, out[0]);
    }
    return sendJson(res, 200, out, { "content-range": `0-${Math.max(out.length - 1, 0)}/${out.length}` });
  }
  if (req.method === "POST") {
    const incoming = JSON.parse(body || "[]");
    const list = Array.isArray(incoming) ? incoming : [incoming];
    const conflict = query.on_conflict || (table === "app_setting" ? "key" : null);
    for (const r of list) {
      const keys = conflict ? String(conflict).split(",") : null;
      const idx = keys ? rows.findIndex((x) => keys.every((k) => x[k] === r[k])) : -1;
      if (idx >= 0) rows[idx] = { ...rows[idx], ...r };
      else rows.push(r);
    }
    return sendJson(res, 201, single ? list[0] : list);
  }
  if (req.method === "DELETE") {
    const del = filterRows(rows, query);
    tables[table] = rows.filter((r) => !del.includes(r));
    return sendJson(res, 200, del);
  }
  if (req.method === "PATCH") {
    const patch = JSON.parse(body || "{}");
    for (const r of filterRows(rows, query)) Object.assign(r, patch);
    return sendJson(res, 200, []);
  }
  return sendJson(res, 405, { message: "method not allowed" });
}

async function handleAuth(req, res, path, query) {
  await readBody(req);
  log.push(`${req.method} /auth/v1${path} ${JSON.stringify(query)}`);
  if (path === "/token") return sendJson(res, 200, session());
  if (path === "/user") {
    const auth = req.headers.authorization || "";
    if (auth === `Bearer ${TOKEN}`) return sendJson(res, 200, USER);
    return sendJson(res, 401, { code: 401, msg: "invalid token" });
  }
  if (path === "/logout") return sendJson(res, 204);
  return sendJson(res, 404, { msg: "qa stub: not implemented" });
}

const app = next({ dev: true, dir: APP_DIR, hostname: "127.0.0.1", port: PORT });
await app.prepare();
const handle = app.getRequestHandler();
const upgrade = app.getUpgradeHandler();

const server = http.createServer(async (req, res) => {
  const parsed = parse(req.url, true);
  const p = parsed.pathname || "";
  try {
    if (p.startsWith("/rest/v1/")) return await handleRest(req, res, p.slice("/rest/v1/".length), parsed.query);
    if (p.startsWith("/auth/v1")) return await handleAuth(req, res, p.slice("/auth/v1".length), parsed.query);
    if (p === "/__qa/log") return sendJson(res, 200, { log, app_setting: tables.app_setting });
    return handle(req, res, parsed);
  } catch (err) {
    console.error("qa-server error", err);
    sendJson(res, 500, { message: String(err) });
  }
});
server.on("upgrade", (req, socket, head) => upgrade(req, socket, head));
server.listen(PORT, "127.0.0.1", () => console.log(`QA server ready on http://127.0.0.1:${PORT}`));
