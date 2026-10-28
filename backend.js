// Connects the hub to Supabase. It gives the page the same small "db" and "user"
// interface the Claude version used, so the hub code barely changes.
// Openings, resources and events come from the data/ files in this repository
// (refreshed every morning); ticks, RSVPs, names and added items live in Supabase.
const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm";

const cfg = window.IEM_CONFIG || {};
const STATIC = { openings: "data/openings.json", resources: "data/resources.json", events: "data/events.json" };
const LIVE = new Set(["people", "rsvp", "profiles", "openings", "resources"]);

let sb = null, session = null, uid = null, admin = false;
const staticData = {}, liveData = {}, subs = {};

async function loadStatic(coll){
  if (!STATIC[coll]) return [];
  if (!staticData[coll]){
    try { const r = await fetch(STATIC[coll] + "?v=" + Date.now()); staticData[coll] = r.ok ? await r.json() : []; }
    catch(e){ staticData[coll] = []; }
  }
  return staticData[coll];
}

async function loadLive(coll){
  if (!sb || !LIVE.has(coll)) return [];
  const { data, error } = await sb.from("docs").select("id,data,owner").eq("coll", coll).limit(5000);
  if (error) throw error;
  liveData[coll] = data || [];
  return liveData[coll];
}

function snapshot(coll){
  const docs = [];
  for (const s of staticData[coll] || []){ const { id, ...rest } = s; docs.push({ id, data: () => ({ ...rest, custom: false }) }); }
  for (const r of liveData[coll] || []) docs.push({ id: r.id, data: () => ({ ...r.data, ...(coll === "openings" || coll === "resources" ? { custom: true, mine: r.owner === uid } : {}) }) });
  return { docs };
}

async function refresh(coll){
  try { await loadLive(coll); } catch(e){ (subs[coll] || []).forEach(s => s.err && s.err(e)); return; }
  (subs[coll] || []).forEach(s => s.cb(snapshot(coll)));
}

const timers = {};
function soon(coll){ clearTimeout(timers[coll]); timers[coll] = setTimeout(() => refresh(coll), 250); }

function collection(coll){
  return {
    onSnapshot(cb, err){
      (subs[coll] = subs[coll] || []).push({ cb, err });
      Promise.all([loadStatic(coll), loadLive(coll).catch(() => [])]).then(() => cb(snapshot(coll))).catch(e => err && err(e));
      return () => { subs[coll] = (subs[coll] || []).filter(s => s.cb !== cb); };
    },
    doc(id){ return docRef(coll, id); },
    async add(data){
      if (!uid) throw new Error("Not signed in yet");
      const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 20);
      const { error } = await sb.from("docs").insert({ coll, id, data, owner: uid });
      if (error) throw error;
      soon(coll); return { id };
    }
  };
}

function docRef(coll, id){
  return {
    async set(data){
      if (!uid) throw new Error("Not signed in yet");
      const { error } = await sb.from("docs").upsert({ coll, id, data, owner: uid, updated_at: new Date().toISOString() }, { onConflict: "coll,id" });
      if (error) throw error;
      soon(coll);
    },
    async delete(){
      const { error } = await sb.from("docs").delete().eq("coll", coll).eq("id", id);
      if (error) throw error;
      soon(coll);
    },
    onSnapshot(cb){
      // Only meta/refresh is read this way; it comes from data/meta.json.
      fetch("data/meta.json?v=" + Date.now()).then(r => r.ok ? r.json() : null).then(d => cb({ exists: !!d, data: () => d })).catch(() => cb({ exists: false, data: () => null }));
      return () => {};
    }
  };
}

function initials(name){ return (name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "?"; }
function avatar(name, id){
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="hsl(${hue},55%,45%)"/><text x="32" y="41" font-family="Arial,sans-serif" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">${initials(name).replace(/[<&>]/g, "")}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

const user = {
  async id(){ return uid; },
  async isOwner(){ return admin; },
  async can(){ return !!uid; },
  async profiles(ids){
    try { await loadLive("profiles"); } catch(e){}
    const by = {}; for (const r of liveData.profiles || []) by[r.id] = r.data || {};
    const out = {};
    for (const id of ids){ const n = (by[id] && by[id].name) || ""; out[id] = { name: n, avatarUrl: avatar(n || "?", id) }; }
    return out;
  }
};

// ---------- Name prompt and organiser sign-in ----------
function el(tag, attrs, ...kids){ const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v); for (const k of kids) if (k != null) e.append(k); return e; }

function modal(title, text, field, button, onSubmit, canClose){
  const input = el("input", { type: field.type || "text", placeholder: field.placeholder || "", maxlength: "80", required: "", autocomplete: field.autocomplete || "off", "aria-label": field.placeholder || title });
  if (field.value) input.value = field.value;
  const msg = el("p", { class: "nm-msg" });
  const form = el("form", { class: "nm-box" }, el("h2", {}, title), el("p", {}, text), input, el("button", { class: "btn", type: "submit" }, button), msg);
  const close = canClose ? el("button", { class: "nm-x", type: "button", "aria-label": "Close" }, "×") : null;
  if (close) form.prepend(close);
  const wrap = el("div", { class: "nm-wrap", role: "dialog", "aria-modal": "true" }, form);
  document.body.append(wrap);
  setTimeout(() => input.focus(), 50);
  const done = () => wrap.remove();
  if (close) close.addEventListener("click", done);
  form.addEventListener("submit", async ev => {
    ev.preventDefault();
    const v = input.value.trim(); if (!v) return;
    try { const m = await onSubmit(v); if (m) { msg.textContent = m; } else done(); } catch(e){ msg.textContent = "Something went wrong: " + (e.message || e); }
  });
}

async function myName(){
  const { data } = await sb.from("docs").select("data").eq("coll", "profiles").eq("id", uid).maybeSingle();
  return data && data.data && data.data.name || "";
}
async function saveName(name){
  const { error } = await sb.from("docs").upsert({ coll: "profiles", id: uid, data: { name: name.slice(0, 60) }, owner: uid, updated_at: new Date().toISOString() }, { onConflict: "coll,id" });
  if (error) throw error;
  const nm = document.getElementById("nm-who"); if (nm) nm.textContent = name;
  soon("people"); soon("rsvp");
}

function askName(current){
  modal(current ? "Change your name" : "Welcome to IEM Careers",
    current ? "This is the name the careers leads see when you tick an opening or say you're going." : (() => { const f = document.createDocumentFragment(); f.append("What's your name?", document.createElement("br"), el("em", {}, "You only need to do this once on this device.")); return f; })(),
    { placeholder: "First and last name", value: current, autocomplete: "name" }, current ? "Save" : "Continue",
    async v => { await saveName(v); }, !!current);
}

function wireFooter(name){
  const box = document.getElementById("nm-foot"); if (!box) return;
  box.hidden = false;
  document.getElementById("nm-who").textContent = name || "not set";
  document.getElementById("nm-edit").addEventListener("click", async () => askName(await myName()));
  const org = document.getElementById("org-in");
  if (admin){ org.textContent = "Signed in as organiser"; org.disabled = true; return; }
  org.addEventListener("click", () => modal("Organiser sign-in", "For the careers leads only. Enter your email and we'll send you a sign-in link.", { type: "email", placeholder: "Email", autocomplete: "email" }, "Send link",
    async email => {
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: false } });
      if (error) return "This email isn't set up as an organiser.";
      return "Check your inbox and open the link on this device.";
    }, true));
}

async function start(){
  if (!cfg.url || !cfg.key){ console.warn("IEM Careers: add the Supabase link and key in config.js"); return; }
  let createClient;
  try { ({ createClient } = await import(SUPABASE_JS)); } catch(e){ console.warn("IEM Careers: couldn't load the database library; browsing only", e); return; }
  sb = createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  ({ data: { session } } = await sb.auth.getSession());
  if (!session){
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) console.warn("Anonymous sign-in failed", error); else session = data.session;
  }
  uid = session && session.user ? session.user.id : null;
  if (uid){ try { const { data } = await sb.rpc("is_admin"); admin = !!data; } catch(e){} }
  sb.channel("docs").on("postgres_changes", { event: "*", schema: "public", table: "docs" }, p => {
    const coll = (p.new && p.new.coll) || (p.old && p.old.coll);
    if (coll) soon(coll); else Object.keys(subs).forEach(soon);
    if (coll === "profiles"){ soon("people"); soon("rsvp"); }
  }).subscribe();
  if (uid){
    const name = await myName();
    wireFooter(name);
    if (!name) askName("");
  }
}

window.claude = { use: async kind => kind === "db" ? { collection, doc: path => { const [c, id] = path.split("/"); return docRef(c, id); } } : kind === "user" ? (uid ? user : null) : null };
start().catch(e => console.error(e)).finally(() => window.__iemResolve && window.__iemResolve());
