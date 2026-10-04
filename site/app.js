// Mo's Applications. Reads the encrypted daily file, unlocks it with your passphrase,
// and keeps applications, notes, culture flags and your CV in this browser.
const REPO = "modib000/job-radar";
const DAY = 864e5;
const STAGES = [["applied", "Applied"], ["interview", "Interviewing"], ["final", "Final round"], ["offer", "Offer"], ["closed", "Closed"]];
const COLORS = ["#3D5AFE", "#0B9483", "#C77700", "#D6336C", "#7E57C2", "#00897B", "#5C6BC0", "#EF6C00", "#2E7D32", "#AD1457"];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }, del(k) { try { localStorage.removeItem(k); } catch (e) {} } };
const PFX = "mo-apps-";
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = n => ymd(new Date(today().getTime() + n * DAY));
const dayDiff = s => Math.round((new Date(s + "T00:00:00") - today()) / DAY);
const nice = s => s ? new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
const ago = n => n === 0 ? "Today" : n === 1 ? "Yesterday" : `${n}d ago`;
const fmtM = (a, cur = "$") => a >= 1 ? `${cur}${+a.toFixed(1)}m` : a ? `${cur}${Math.round(a * 1000)}k` : "an undisclosed amount";
const colorOf = n => COLORS[[...n].reduce((a, ch) => a + ch.charCodeAt(0), 0) % COLORS.length];
const initials = n => n.replace(/[^A-Za-z0-9 ]/g, "").split(" ").filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || n[0];
const av = n => `<div class="avatar" style="background:${colorOf(n)}">${esc(initials(n))}</div>`;

// ---------- theme ----------
let theme = store.get("bdr-theme", null); if (theme) document.documentElement.dataset.theme = theme;
$("theme").onclick = () => { const cur = document.documentElement.dataset.theme; const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; theme = dark ? "light" : "dark"; document.documentElement.dataset.theme = theme; store.set("bdr-theme", theme); };

// ---------- unlock ----------
const u8 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function decryptFile(file, pass) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: u8(file.salt), iterations: 200000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u8(file.iv) }, key, u8(file.data))));
}
let FILE = null;
async function boot() {
  try { const r = await fetch("data/leads.enc.json?t=" + Date.now(), { cache: "no-store" }); if (!r.ok) throw 0; FILE = await r.json(); }
  catch (e) { $("lock-msg").innerHTML = `No roles yet. Open <a href="https://github.com/${REPO}/actions" target="_blank" rel="noopener">GitHub Actions</a>, run <b>Daily refresh</b>, then reload this page.`; $("lock-form").style.display = "none"; return; }
  const saved = store.get(PFX + "pass", null);
  if (saved) { try { start(await decryptFile(FILE, saved)); return; } catch (e) { store.del(PFX + "pass"); } }
  $("pass").focus();
}
$("lock-form").onsubmit = async e => {
  e.preventDefault(); const p = $("pass").value; if (!p) return;
  $("unlock").disabled = true; $("lock-err").textContent = "";
  try { const d = await decryptFile(FILE, p); if ($("remember").checked) store.set(PFX + "pass", p); start(d); }
  catch (err) { $("lock-err").textContent = "That passphrase doesn't match. Try again."; }
  if ($("unlock")) $("unlock").disabled = false;
};

// ---------- state (all private, in this browser) ----------
// apps: { id: {title, company, url, location, salary, stage, applied, next, note, manual} }
// hidden: { roleId: date }   co: { companyName: {culture, cultureNote} }
let DATA, companies = [], roles = [];
let APPS = store.get(PFX + "apps", {}), HIDDEN = store.get(PFX + "hidden", {}), CO = store.get(PFX + "co", {});
const save = () => { store.set(PFX + "apps", APPS); store.set(PFX + "hidden", HIDDEN); store.set(PFX + "co", CO); };
const isActive = a => a.stage !== "closed" && a.stage !== "offer";

// role fit: start from the company score, then adjust for this role's own freshness and level
const fresh = a => a <= 2 ? 4 : a <= 7 ? 3 : a <= 14 ? 1 : 0;
const levelPts = r => r.disc.includes("Senior AE") ? 2 : 5;
const regionPts = r => ({ london: 3, uk: 3, remote: 2, unknown: 2, abroad: 0 })[r.region || "unknown"];
const companyLocPts = c => c.loc === "strong" ? 3 : c.loc === "some" ? 2 : 0;
const ukFriendly = r => r.region !== "abroad";
const flexible = r => ukFriendly(r) && (r.workplace === "Remote" || r.workplace === "Hybrid");
function placeLabel(r) {
  const w = r.workplace && r.workplace !== "On site" ? ` · ${r.workplace}` : "";
  if (r.region === "abroad") return `${r.location || "Abroad"} · Abroad${w}`;
  return `${r.location || "Location not listed"}${w}`;
}
function start(d) {
  DATA = d;
  companies = d.companies;
  roles = [];
  for (const c of companies) {
    if (!c.roles.length) continue;
    const newest = Math.min(...c.roles.map(r => r.age));
    const anyFit = c.roles.some(r => !r.disc.includes("Senior AE"));
    for (const r of c.roles) {
      const score = Math.max(0, Math.min(20, c.score - fresh(newest) + fresh(r.age) - (anyFit ? 5 : 2) + levelPts(r) - companyLocPts(c) + regionPts(r)));
      roles.push({ ...r, id: r.id || r.url, company: c.name, c, score, isNew: r.firstSeen === d.date });
    }
  }
  $("lock").remove();
  document.querySelector(".app").hidden = false;
  const hr = new Date().getHours();
  $("greet").textContent = (hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening") + ", Mo";
  const gen = new Date(d.generatedAt), live = (Date.now() - gen) / DAY < 1.5;
  $("rail-foot").innerHTML = `<b><span class="dot ${live ? "live" : ""}"></span>${live ? "Up to date" : "Refresh overdue"}</b>Updated ${gen.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, ${gen.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. Refreshes every morning.`;
  renderSources(); renderCV(); refresh();
}

// ---------- roles ----------
let type = "all", sort = "fit", q = "", place = "uk";
document.querySelectorAll("#placeSeg button").forEach(b => b.onclick = () => { place = b.dataset.place; document.querySelectorAll("#placeSeg button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderRoles(); });
document.querySelectorAll("#typeSeg button").forEach(b => b.onclick = () => { type = b.dataset.type; document.querySelectorAll("#typeSeg button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderRoles(); });
document.querySelectorAll("#sortSeg button").forEach(b => b.onclick = () => { sort = b.dataset.sort; document.querySelectorAll("#sortSeg button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderRoles(); });
$("q").oninput = e => { q = e.target.value.toLowerCase(); if (!$("v-roles").classList.contains("on")) go("roles"); renderRoles(); };
const openRoles = () => roles.filter(r => !APPS[r.id] && !HIDDEN[r.id] && !((CO[r.company] || {}).culture === "avoid"));
function renderRoles() {
  if (!DATA) return;
  let r = openRoles();
  if (type !== "all") r = r.filter(x => x.disc.includes(type));
  if (place === "uk") r = r.filter(ukFriendly); else if (place === "flex") r = r.filter(flexible);
  if (q) r = r.filter(x => `${x.title} ${x.company} ${x.location} ${x.c.vertical}`.toLowerCase().includes(q));
  r.sort(sort === "new" ? (a, b) => a.age - b.age || b.score - a.score : (a, b) => b.score - a.score || a.age - b.age);
  const all = openRoles().filter(ukFriendly), nw = all.filter(x => x.isNew).length, abroad = openRoles().length - all.length;
  const active = Object.values(APPS).filter(isActive).length, due = Object.values(APPS).filter(a => isActive(a) && a.next && dayDiff(a.next) <= 0).length;
  $("subline").textContent = `${all.length} open roles in the UK or remote${abroad ? ` (plus ${abroad} abroad)` : ""}, ${nw} new today. ${active} application${active === 1 ? "" : "s"} in progress${due ? `, ${due} follow up${due === 1 ? "" : "s"} due` : ""}.`;
  $("c-roles").textContent = nw || "";
  $("rlist").innerHTML = r.length ? r.slice(0, 250).map(x => `<div class="rrow" data-role="${esc(x.id)}">${av(x.company)}<div class="meta"><b>${x.isNew ? '<span class="newdot" title="New today"></span>' : ""}${esc(x.title)}</b><span>${esc(x.company)} · ${esc(placeLabel(x))}${x.salary ? ` · ${esc(x.salary)}` : ""}${(CO[x.company] || {}).culture === "mixed" ? " · mixed culture" : (CO[x.company] || {}).culture === "good" ? " · good culture" : ""}</span></div><div class="when">${ago(x.age)}</div><div class="fit ${x.score >= 15 ? "hi" : ""}" title="Fit score out of 20">${x.score}</div><div class="ract"><a href="${esc(x.url)}" target="_blank" rel="noopener" data-stop>Apply ↗</a><button class="go" data-applied>Applied</button><button class="x" data-hide title="Not interested">✕</button></div></div>`).join("")
    : `<div class="qempty">${q || type !== "all" || place !== "all" ? "Nothing matches. Try another search or location." : "You're all caught up. New roles land here every morning."}</div>`;
  const raised = companies.filter(c => !c.roles.length && c.funding && (CO[c.name] || {}).culture !== "avoid").sort((a, b) => b.score - a.score);
  $("raisedBox").style.display = raised.length ? "" : "none";
  $("raisedSum").textContent = `Just raised, no sales roles posted yet (${raised.length})`;
  $("raisedList").innerHTML = raised.map(c => `<div class="rrow" data-co="${esc(c.name)}">${av(c.name)}<div class="meta"><b>${esc(c.name)}</b><span>Raised ${fmtM(c.funding.amountM, c.funding.currency)} · ${esc(c.funding.round)} · ${esc(c.vertical)}</span></div><div class="when">${nice(c.funding.date)}</div></div>`).join("");
}
$("rlist").addEventListener("click", e => {
  const row = e.target.closest(".rrow"); if (!row) return;
  if (e.target.closest("[data-stop]")) return;
  const r = roles.find(x => x.id === row.dataset.role);
  if (e.target.closest("[data-applied]")) { markApplied(r); return; }
  if (e.target.closest("[data-hide]")) { HIDDEN[r.id] = ymd(new Date()); save(); refresh(); return; }
  openRole(r);
});
$("raisedList").addEventListener("click", e => { const row = e.target.closest("[data-co]"); if (row) openCompany(companies.find(c => c.name === row.dataset.co)); });
function markApplied(r) {
  APPS[r.id] = { title: r.title, company: r.company, url: r.url, location: r.location, salary: r.salary || "", stage: "applied", applied: ymd(new Date()), next: addDays(7), note: "" };
  save(); closeD(); refresh();
}

// ---------- applications ----------
function renderApps() {
  const list = Object.entries(APPS);
  const active = list.filter(([, a]) => isActive(a)).length, due = list.filter(([, a]) => isActive(a) && a.next && dayDiff(a.next) <= 0).length;
  $("c-apps").textContent = active || "";
  $("appsSub").textContent = list.length ? `${active} in progress${due ? `, ${due} follow up${due === 1 ? "" : "s"} due` : ""}. Drag a card or use its menu to move it along.` : "Mark a role as Applied and it moves here, with a follow up reminder a week later.";
  $("board").innerHTML = STAGES.map(([k, l]) => {
    const cs = list.filter(([, a]) => a.stage === k).sort((a, b) => (a[1].next || "9").localeCompare(b[1].next || "9"));
    return `<div class="lane" data-lane="${k}"><h3>${l}<span>${cs.length}</span></h3>${cs.map(([id, a]) => {
      const d = a.next && isActive(a) ? dayDiff(a.next) : null;
      return `<div class="acard" draggable="true" data-app="${esc(id)}"><b>${esc(a.title)}</b><span>${esc(a.company)} · applied ${nice(a.applied)}</span>${d != null ? `<span class="due ${d < 0 ? "over" : d === 0 ? "today" : ""}">Follow up ${d < 0 ? `${-d}d overdue` : d === 0 ? "today" : nice(a.next)}</span>` : ""}<select class="mini" data-move="${esc(id)}" aria-label="Move">${STAGES.map(s => `<option value="${s[0]}" ${s[0] === k ? "selected" : ""}>${s[0] === k ? "Move to…" : s[1]}</option>`).join("")}</select></div>`;
    }).join("") || `<div class="qempty" style="padding:16px 6px">Nothing here yet.</div>`}</div>`;
  }).join("");
}
function moveApp(id, stage) { const a = APPS[id]; if (!a) return; a.stage = stage; if (stage === "interview" && (!a.next || dayDiff(a.next) > 2)) a.next = addDays(2); if (!isActive(a)) a.next = ""; save(); refresh(); }
const board = $("board");
board.addEventListener("change", e => { if (e.target.dataset.move) moveApp(e.target.dataset.move, e.target.value); });
board.addEventListener("click", e => { if (e.target.closest("select")) return; const c = e.target.closest("[data-app]"); if (c) openApp(c.dataset.app); });
board.addEventListener("dragstart", e => { const c = e.target.closest("[data-app]"); if (c) { e.dataTransfer.setData("text/plain", c.dataset.app); c.classList.add("dragging"); } });
board.addEventListener("dragend", e => { const c = e.target.closest("[data-app]"); if (c) c.classList.remove("dragging"); board.querySelectorAll(".lane").forEach(x => x.classList.remove("over")); });
board.addEventListener("dragover", e => { const l = e.target.closest(".lane"); if (l) { e.preventDefault(); board.querySelectorAll(".lane").forEach(x => x.classList.toggle("over", x === l)); } });
board.addEventListener("drop", e => { const l = e.target.closest(".lane"); if (!l) return; e.preventDefault(); moveApp(e.dataTransfer.getData("text/plain"), l.dataset.lane); });
$("addBtn").onclick = () => { $("addForm").classList.toggle("on"); $("a-date").value = ymd(new Date()); $("a-company").focus(); };
$("a-cancel").onclick = () => $("addForm").classList.remove("on");
$("a-save").onclick = () => {
  const company = $("a-company").value.trim(), title = $("a-role").value.trim(); if (!company || !title) { (!company ? $("a-company") : $("a-role")).focus(); return; }
  const applied = $("a-date").value || ymd(new Date());
  APPS["manual-" + Date.now()] = { title, company, url: $("a-url").value.trim(), location: "", salary: "", stage: "applied", applied, next: ymd(new Date(new Date(applied + "T00:00:00").getTime() + 7 * DAY)), note: "", manual: true };
  ["a-company", "a-role", "a-url"].forEach(i => $(i).value = ""); $("addForm").classList.remove("on"); save(); refresh();
};

// ---------- drawer ----------
const drawer = $("drawer"), scrim = $("scrim");
function showD(html) { drawer.innerHTML = html; drawer.classList.add("on"); scrim.classList.add("on"); drawer.setAttribute("aria-hidden", "false"); const x = $("close"); if (x) { x.onclick = closeD; x.focus(); } }
function closeD() { drawer.classList.remove("on"); scrim.classList.remove("on"); drawer.setAttribute("aria-hidden", "true"); }
scrim.onclick = closeD; document.addEventListener("keydown", e => { if (e.key === "Escape" && drawer.classList.contains("on")) closeD(); });
const head = (title, sub) => `<div class="dhead">${av(title)}<div style="flex:1;min-width:0"><h3>${esc(title)}</h3><p>${sub}</p></div><button class="iconbtn" id="close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
function companyBits(c, name) {
  const co = CO[name] || {}, K = c && c.contact;
  const li = encodeURIComponent(`${name} ("Head of Sales" OR "VP Sales" OR "SDR Manager" OR "Sales Director")`);
  const reasons = c ? c.parts.filter(p => p[0] > 0).map(p => p[1]) : [];
  return `
    ${c ? `<div class="sect"><h4>Why it fits</h4><ul class="reasons">${reasons.map(t => `<li>${esc(t)}</li>`).join("")}</ul></div>
    <div class="sect"><h4>Tip</h4><p>${esc(c.angle)}</p></div>` : ""}
    ${c && c.funding ? `<div class="sect"><h4>Funding</h4><p>Raised ${fmtM(c.funding.amountM, c.funding.currency)} (${esc(c.funding.round)}) on ${esc(c.funding.date)}. ${c.funding.url ? `<a href="${esc(c.funding.url)}" target="_blank" rel="noopener">Read more</a>` : ""}</p></div>` : ""}
    <div class="sect"><h4>Who to message</h4>
      <div class="contact"><div class="pic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="19" height="19"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></div><div style="flex:1;min-width:0"><b>${esc(K && K.name ? K.name : "Head of Sales or SDR Manager")}</b><span>${K && K.name ? esc([K.title, K.email].filter(Boolean).join(" · ")) : "Apollo finds the sales leader at your best fit companies automatically."}</span></div>${K && K.linkedin ? `<a class="tag t-ok" href="${esc(K.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>` : ""}</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><a class="btn tonal" href="https://www.linkedin.com/search/results/people/?keywords=${li}" target="_blank" rel="noopener">Find sales leaders on LinkedIn</a><a class="btn ghost" href="https://www.glassdoor.co.uk/Search/results.htm?keyword=${encodeURIComponent(name)}" target="_blank" rel="noopener">Glassdoor</a></div>
    </div>
    <div class="sect"><h4>Culture (private to you)</h4><div class="statuspick">${[["good", "Good"], ["mixed", "Mixed"], ["avoid", "Avoid"]].map(x => `<button class="chip" data-cult="${x[0]}" aria-pressed="${co.culture === x[0]}">${x[1]}</button>`).join("")}</div>
      <textarea id="cnote" placeholder="What you've heard about the culture, sales team, OTE, management" style="margin-top:8px;min-height:60px">${esc(co.cultureNote || "")}</textarea>
      ${co.culture === "avoid" ? `<p style="color:var(--muted);font-size:12.5px;margin-top:6px">Roles from here are hidden from your list.</p>` : ""}</div>`;
}
function wireCompany(name, redraw) {
  drawer.querySelectorAll("[data-cult]").forEach(b => b.onclick = () => { const co = CO[name] = CO[name] || {}; co.culture = co.culture === b.dataset.cult ? "" : b.dataset.cult; save(); refresh(); redraw(); });
  const n = $("cnote"); if (n) n.oninput = e => { (CO[name] = CO[name] || {}).cultureNote = e.target.value; save(); };
}
function openRole(r) {
  showD(head(r.title, `${esc(r.company)} · ${esc(placeLabel(r))}`) + `<div class="dbody">
    <div class="scorebox"><div class="ring" style="--v:${r.score * 5}"><div>${r.score}</div></div><div><b>${r.score >= 15 ? "Great fit" : r.score >= 11 ? "Good fit" : "Worth a look"}</b><span>Posted ${ago(r.age).toLowerCase()}${r.salary ? ` · ${esc(r.salary)}` : ""}</span></div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn primary" href="${esc(r.url)}" target="_blank" rel="noopener">Open the job ad ↗</a><button class="btn tonal" id="d-applied">I've applied</button><button class="btn ghost" id="d-hide">Not interested</button></div>
    ${companyBits(r.c, r.company)}
  </div>`);
  $("d-applied").onclick = () => markApplied(r);
  $("d-hide").onclick = () => { HIDDEN[r.id] = ymd(new Date()); save(); closeD(); refresh(); };
  wireCompany(r.company, () => openRole(r));
}
function openCompany(c) {
  showD(head(c.name, `${esc(c.vertical)}${c.domain ? ` · <a href="https://${esc(c.domain)}" target="_blank" rel="noopener">${esc(c.domain)}</a>` : ""}`) + `<div class="dbody">${companyBits(c, c.name)}</div>`);
  wireCompany(c.name, () => openCompany(c));
}
function openApp(id) {
  const a = APPS[id]; if (!a) return;
  const c = companies.find(x => x.name === a.company);
  showD(head(a.title, `${esc(a.company)}${a.location ? " · " + esc(a.location) : ""} · applied ${nice(a.applied)}`) + `<div class="dbody">
    <div class="sect"><h4>Stage</h4><div class="statuspick">${STAGES.map(s => `<button class="chip" data-st="${s[0]}" aria-pressed="${a.stage === s[0]}">${s[1]}</button>`).join("")}</div></div>
    ${isActive(a) ? `<div class="sect"><h4>Next follow up</h4><div class="fu"><input type="date" id="fu" value="${a.next || ""}" aria-label="Follow up date"><button class="chip" data-fu="1">Tomorrow</button><button class="chip" data-fu="3">3 days</button><button class="chip" data-fu="7">1 week</button><button class="chip" data-fu="x">Clear</button></div></div>` : ""}
    <div class="sect"><h4>Notes</h4><textarea id="anote" placeholder="Who you spoke to, interview dates, what they asked, how it went">${esc(a.note || "")}</textarea></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${a.url ? `<a class="btn ghost" href="${esc(a.url)}" target="_blank" rel="noopener">Job ad ↗</a>` : ""}<button class="btn ghost" id="d-remove">Remove from applications</button></div>
    ${companyBits(c, a.company)}
  </div>`);
  drawer.querySelectorAll("[data-st]").forEach(b => b.onclick = () => { moveApp(id, b.dataset.st); openApp(id); });
  const fu = $("fu"); if (fu) fu.onchange = () => { a.next = fu.value; save(); refresh(); };
  drawer.querySelectorAll("[data-fu]").forEach(b => b.onclick = () => { a.next = b.dataset.fu === "x" ? "" : addDays(+b.dataset.fu); save(); refresh(); openApp(id); });
  $("anote").oninput = e => { a.note = e.target.value; save(); };
  $("d-remove").onclick = () => { if (confirm("Remove this application? If the role is still open it'll go back into your Roles list.")) { delete APPS[id]; save(); closeD(); refresh(); } };
  wireCompany(a.company, () => openApp(id));
}

// ---------- my CV (stored in this browser with IndexedDB) ----------
function idb() { return new Promise((res, rej) => { const r = indexedDB.open("mo-apps", 1); r.onupgradeneeded = () => r.result.createObjectStore("files"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function cvGet() { try { const db = await idb(); return await new Promise(res => { const t = db.transaction("files").objectStore("files").get("cv"); t.onsuccess = () => res(t.result || null); t.onerror = () => res(null); }); } catch (e) { return null; } }
async function cvPut(v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction("files", "readwrite"); v ? tx.objectStore("files").put(v, "cv") : tx.objectStore("files").delete("cv"); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function renderCV() {
  const f = await cvGet();
  $("cvPanel").innerHTML = f ? `<div class="cvfile"><div class="ic">${esc((f.name.split(".").pop() || "CV").toUpperCase())}</div><div class="meta"><b>${esc(f.name)}</b><span>Added ${nice(f.added)} · ${Math.max(1, Math.round(f.blob.size / 1024))} KB</span></div><button class="btn primary" id="cvOpen">Open</button><button class="btn ghost" id="cvReplace">Replace</button><button class="btn ghost" id="cvDel">Remove</button></div>`
    : `<div class="drop" id="cvDrop"><b style="display:block;color:var(--ink);font-size:15px;margin-bottom:4px">Add your CV</b>Drop a PDF or Word file here, or click to choose one</div>`;
  if (f) {
    $("cvOpen").onclick = () => { const u = URL.createObjectURL(f.blob); const a = document.createElement("a"); a.href = u; a.target = "_blank"; if (!/pdf/i.test(f.blob.type)) a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 60000); };
    $("cvReplace").onclick = () => $("cvInput").click();
    $("cvDel").onclick = async () => { if (confirm("Remove your CV from this browser?")) { await cvPut(null); renderCV(); } };
  } else {
    const d = $("cvDrop");
    d.onclick = () => $("cvInput").click();
    d.ondragover = e => { e.preventDefault(); d.classList.add("over"); };
    d.ondragleave = () => d.classList.remove("over");
    d.ondrop = e => { e.preventDefault(); d.classList.remove("over"); if (e.dataTransfer.files[0]) addCV(e.dataTransfer.files[0]); };
  }
}
async function addCV(file) { await cvPut({ name: file.name, added: ymd(new Date()), blob: file }); renderCV(); }
$("cvInput").onchange = e => { if (e.target.files[0]) addCV(e.target.files[0]); e.target.value = ""; };
$("pitch").value = store.get(PFX + "pitch", "");
$("pitch").oninput = e => store.set(PFX + "pitch", e.target.value);

// ---------- sources ----------
function renderSources() {
  const S2 = DATA.sources || {};
  const live = (k, paid) => { const s = S2[k]; if (!s) return ["Not set up", "t-plain"]; if (!s.ok && paid) return ["Add keys", "t-p1"]; return [`Live · ${s.count}`, "t-ok"]; };
  const cards = [
    ["Company careers pages", "Sales roles from the careers pages of every company on your watchlist, including big names on Workday. Roles abroad are kept but hidden unless you choose Everywhere.", live("jobs"), S2.jobs],
    ["UK job boards", "SDR, BDR and AE roles at tech companies across Adzuna, Reed and Y Combinator, so you catch roles at companies you'd never think to check. Recruitment agency ads are filtered out.", live("sites", true), S2.sites],
    ["VC portfolio job boards", "Sales roles at startups backed by London VCs like Seedcamp, Balderton, LocalGlobe, Index and Atomico.", live("vc"), S2.vc],
    ["Funding news", "Fresh raises from Sifted, UKTN, TechCrunch, Tech.eu and Finextra. Crypto tokens and gambling are filtered out.", live("funding"), S2.funding],
    ["Apollo.io", "Finds the Head of Sales or SDR Manager at your best fit companies.", live("apollo", true), S2.apollo]
  ];
  $("srcs").innerHTML = `<div class="srcgrid">${cards.map(([t, d, [lab, cls], info]) => `<div class="src"><div class="src-top"><h3>${t}</h3><span class="tag ${cls}">${lab}</span></div><p>${d}</p>${info && info.notes && info.notes.length ? `<details><summary>Last run details</summary><ul>${info.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}</div>`).join("")}</div>`;
}
$("refreshbtn").href = `https://github.com/${REPO}/actions/workflows/daily.yml`;

// ---------- backup ----------
$("export").onclick = () => {
  const blob = new Blob([JSON.stringify({ app: "mo-applications", exported: new Date().toISOString(), apps: APPS, hidden: HIDDEN, co: CO, pitch: store.get(PFX + "pitch", "") }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `applications-backup-${ymd(new Date())}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$("import").onclick = () => $("importfile").click();
$("importfile").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { const d = JSON.parse(await f.text()); Object.assign(APPS, d.apps || {}); Object.assign(HIDDEN, d.hidden || {}); Object.assign(CO, d.co || {}); if (d.pitch) { store.set(PFX + "pitch", d.pitch); $("pitch").value = d.pitch; } save(); refresh(); alert("Backup imported."); }
  catch (err) { alert("That file isn't an applications backup."); }
  e.target.value = "";
};
$("forget").onclick = () => { store.del(PFX + "pass"); location.reload(); };

// ---------- nav ----------
function go(v) { document.querySelectorAll(".view").forEach(x => x.classList.toggle("on", x.id === "v-" + v)); document.querySelectorAll(".nav").forEach(n => { if (n.dataset.view === v) n.setAttribute("aria-current", "page"); else n.removeAttribute("aria-current"); }); document.querySelector("main").scrollTop = 0; }
document.querySelectorAll(".nav").forEach(n => n.onclick = () => go(n.dataset.view));
function refresh() { renderRoles(); renderApps(); }
boot();
