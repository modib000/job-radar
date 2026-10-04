// Job Radar daily refresh (sales roles). Runs on GitHub Actions every morning.
// Pulls hiring, funding and social signals, scores every company,
// and writes an encrypted data file the dashboard unlocks with your passphrase.
// No packages needed: Node 20+.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { webcrypto as crypto } from "node:crypto";

const ROOT = new URL("..", import.meta.url);
const DATA_FILE = new URL("data/leads.enc.json", ROOT);
const PASS = process.env.RADAR_PASSPHRASE;
const KEYS = {
  apollo: process.env.APOLLO_API_KEY || "",
  twitter: process.env.TWITTERAPI_KEY || "",
  neynar: process.env.NEYNAR_API_KEY || "",
  github: process.env.GITHUB_TOKEN || ""
};
const DAY = 864e5;
const NOW = process.env.RADAR_NOW ? new Date(process.env.RADAR_NOW) : new Date();
const TODAY = NOW.toISOString().slice(0, 10);
const UA = { "User-Agent": "Mozilla/5.0 (BD Radar daily refresh)", "Accept": "*/*" };

if (!PASS) {
  console.error("\nMissing RADAR_PASSPHRASE. Add it under Settings > Secrets and variables > Actions, then run again.\n");
  process.exit(1);
}

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || "").toLowerCase().replace(/\.(com|io|xyz|fi|finance|network|labs?)$/, "").replace(/[^a-z0-9]/g, "");
const daysSince = iso => iso ? Math.floor((NOW - new Date(iso)) / DAY) : null;
const strip = h => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").trim();

async function get(url, opts = {}, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: ctrl.signal });
      clearTimeout(t);
      if (r.status === 429) { await sleep(3000); continue; }
      return r;
    } catch (e) { if (i === tries - 1) throw e; await sleep(1000); }
  }
  throw new Error("rate limited");
}
async function getJSON(url, opts) { const r = await get(url, opts); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }
async function getText(url, opts) { const r = await get(url, opts); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------- encryption (same as the dashboard) ----------
const b64 = b => Buffer.from(b).toString("base64");
const unb64 = s => new Uint8Array(Buffer.from(s, "base64"));
async function keyFrom(pass, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encrypt(obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(PASS, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, salt: b64(salt), iv: b64(iv), data: b64(ct) };
}
async function decrypt(file) {
  const key = await keyFrom(PASS, unb64(file.salt));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(file.iv) }, key, unb64(file.data));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---------- classification ----------
// Target roles: SDR / BDR and Account Executive. ENG / isEng keep their names so shared code works.
const ENG = /\b(sales development|business development (?:rep|representative|executive|associate)|sdr|bdr|account executive|\bae\b|new business|inside sales|sales (?:executive|representative|associate)|commercial (?:associate|executive)|market development rep(?:resentative)?|growth (?:rep|representative)|outbound|demand generation rep)\b/i;
const NOT_ENG = /\b(manager|director|head|vp|vice president|lead|principal|chief|engineer|engineering|solutions|operations|ops|enablement|recruit|recruiter|talent|marketing manager|customer success|support|partner manager|intern|graduate scheme|analyst)\b/i;
const isEng = t => ENG.test(t) && !NOT_ENG.test(t);
const STRETCH = /\b(senior|sr\.?|enterprise|strategic|major|global|key account)\b/i;
function discipline(role) {
  const r = role.toLowerCase();
  if (/sales development|business development rep|\bsdr\b|\bbdr\b|market development|growth rep|demand generation rep|outbound/.test(r)) return ["SDR / BDR"];
  if (STRETCH.test(role)) return ["Senior AE"];
  return ["Account Executive"];
}
const SENIOR = STRETCH;
let MARKET = { include: [], exclude: [] };
const inMarket = loc => {
  const l = String(loc || "").toLowerCase();
  if (!l) return true;
  if (MARKET.include.some(w => l.includes(w))) return true;
  if (MARKET.exclude.some(w => l.includes(w))) return false;
  return !/\b(usa|united states|us only|canada|new york|san francisco|austin|chicago|boston|seattle|denver|toronto|singapore|sydney|india|bangalore|tokyo|dubai|brazil|mexico)\b/.test(l);
};
const ukRole = loc => /london|united kingdom|\buk\b|england|manchester|edinburgh|bristol|leeds|birmingham|cambridge/.test(String(loc || "").toLowerCase());
let EXCLUDE = [];
const excluded = text => { const t = String(text || "").toLowerCase(); return EXCLUDE.some(w => new RegExp(`\\b${w}`).test(t)); };
function vertical(s) {
  const a = String(s || "").toLowerCase();
  const rules = [["legal", "Legal tech"], ["law", "Legal tech"], ["stablecoin", "Stablecoins"], ["payment", "Payments"], ["remit", "Payments"], ["card", "Payments"], ["bank", "Banking tech"], ["lending", "Fintech"], ["insur", "Fintech"], ["fintech", "Fintech"], ["wealth", "Fintech"], ["invest", "Fintech"], ["compliance", "RegTech"], ["fraud", "RegTech"], ["kyc", "RegTech"], ["security", "Security"], ["cyber", "Security"], ["hr", "HR tech"], ["payroll", "HR tech"], ["recruit", "HR tech"], ["data", "Data & analytics"], ["analytics", "Data & analytics"], ["ai", "AI"], ["machine learning", "AI"], ["llm", "AI"], ["sales", "SaaS"], ["crm", "SaaS"], ["software", "SaaS"], ["saas", "SaaS"], ["platform", "SaaS"]];
  for (const [k, v] of rules) if (new RegExp("\\b" + k).test(a)) return v;
  return "SaaS";
}

// ---------- Workday (large companies) ----------
const WD_TERMS = ["sales development", "business development", "account executive"];
function parseWorkdayPosted(t) { const s = String(t || "").toLowerCase(); if (/today/.test(s)) return 0; if (/yesterday/.test(s)) return 1; const m = s.match(/(\d+)\+?\s*day/); return m ? +m[1] : null; }
async function workdayJobs(siteUrl) {
  const u = new URL(siteUrl);
  const tenant = u.hostname.split(".")[0];
  const site = u.pathname.split("/").filter(Boolean).filter(x => !/^[a-z]{2}-[A-Z]{2}$/.test(x))[0];
  const api = `${u.origin}/wday/cxs/${tenant}/${site}/jobs`;
  const out = new Map();
  for (const term of WD_TERMS) {
    for (let offset = 0; offset < 100; offset += 20) {
      const j = await getJSON(api, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: term }) });
      const posts = j.jobPostings || [];
      for (const p of posts) {
        if (!p.title || out.has(p.externalPath)) continue;
        const age = parseWorkdayPosted(p.postedOn);
        out.set(p.externalPath, { title: p.title, url: `${u.origin}/${site}${p.externalPath}`, location: p.locationsText || "", posted: age == null ? null : new Date(NOW - age * DAY).toISOString() });
      }
      if (posts.length < 20) break;
    }
  }
  return [...out.values()];
}

// ---------- ATS job boards ----------
const fmtSalary = (min, max, cur, period) => {
  if (!min && !max) return "";
  const k = v => v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`;
  const per = /hour/i.test(period || "") ? " an hour" : "";
  const sym = { GBP: "£", USD: "$", EUR: "€" }[(cur || "").toUpperCase()];
  const v = x => sym ? `${sym}${k(x)}` : k(x);
  return `${sym ? "" : (cur || "").toUpperCase() + " "}${min && max && min !== max ? `${v(min)} to ${v(max)}` : v(min || max)}${per}`.trim();
};
const xmlTag = (b, tag) => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")); return m ? strip(m[1].replace(/<!\[CDATA\[|\]\]>/g, "")) : ""; };
const ATS = {
  greenhouse: {
    url: s => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    parse: j => (j.jobs || []).map(x => ({ title: x.title, url: x.absolute_url, location: x.location && x.location.name, posted: x.first_published || x.updated_at }))
  },
  ashby: {
    url: s => `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`,
    parse: j => (j.jobs || []).filter(x => x.isListed !== false).map(x => ({ title: x.title, url: x.jobUrl, location: x.location, posted: x.publishedAt, salary: (x.compensation && (x.compensation.scrapeableCompensationSalarySummary || x.compensation.compensationTierSummary)) || "" }))
  },
  lever: {
    url: s => `https://api.lever.co/v0/postings/${s}?mode=json`,
    parse: j => (Array.isArray(j) ? j : []).map(x => ({ title: x.text, url: x.hostedUrl, location: x.categories && x.categories.location, posted: x.createdAt ? new Date(x.createdAt).toISOString() : null, salary: x.salaryRange ? fmtSalary(x.salaryRange.min, x.salaryRange.max, x.salaryRange.currency, x.salaryRange.interval) : "" }))
  },
  workable: {
    url: s => `https://apply.workable.com/api/v1/widget/accounts/${s}`,
    parse: j => (j.jobs || []).map(x => ({ title: x.title, url: x.url || x.shortlink, location: [x.city, x.country].filter(Boolean).join(", "), posted: x.published_on }))
  },
  smartrecruiters: {
    url: s => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`,
    parse: (j, s) => (j.content || []).map(x => ({ title: x.name, url: `https://jobs.smartrecruiters.com/${s}/${x.id}`, location: x.location && [x.location.city, x.location.country].filter(Boolean).join(", ") + (x.location.remote ? " (Remote)" : ""), posted: x.releasedDate })),
    valid: j => (j.totalFound || 0) > 0
  },
  recruitee: {
    url: s => `https://${s}.recruitee.com/api/offers/`,
    parse: j => (j.offers || []).map(x => ({ title: x.title, url: x.careers_url || x.url, location: x.location || [x.city, x.country].filter(Boolean).join(", "), posted: x.published_at || x.created_at, salary: x.salary && (x.salary.min || x.salary.max) ? fmtSalary(+x.salary.min, +x.salary.max, x.salary.currency, x.salary.period) : "" }))
  },
  personio: {
    xml: true,
    url: s => `https://${s}.jobs.personio.de/xml`,
    parse: (t, s) => (t.match(/<position>[\s\S]*?<\/position>/gi) || []).map(b => ({ title: xmlTag(b, "name"), url: `https://${s}.jobs.personio.de/job/${xmlTag(b, "id")}`, location: xmlTag(b, "office"), posted: xmlTag(b, "createdAt") })),
    valid: t => /<workzag-jobs|<position>/i.test(t)
  },
  teamtailor: {
    xml: true,
    url: s => `https://${s}.teamtailor.com/jobs.rss`,
    parse: t => parseFeed(t).map(i => ({ title: i.title, url: i.link, location: "", posted: i.date })),
    valid: t => /<rss|<feed/i.test(t) && /teamtailor/i.test(t)
  },
  bamboohr: {
    url: s => `https://${s}.bamboohr.com/careers/list`,
    parse: (j, s) => (j.result || []).map(x => ({ title: x.jobOpeningName, url: `https://${s}.bamboohr.com/careers/${x.id}`, location: x.location && [x.location.city, x.location.state, x.location.country].filter(Boolean).join(", "), posted: x.datePosted || null })),
    valid: j => Array.isArray(j.result)
  }
};
const ATS_ORDER = Object.keys(ATS);
function slugGuesses(c) {
  const n = c.name.toLowerCase();
  return [...new Set([c.slug, n.replace(/[^a-z0-9]/g, ""), n.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")].filter(Boolean))];
}
async function tryBoard(type, slug) {
  try {
    const A = ATS[type];
    const r = await get(A.url(slug), {}, 1);
    if (!r.ok) return null;
    if (A.xml) { const t = await r.text(); if (A.valid && !A.valid(t)) return null; return A.parse(t, slug); }
    const j = await r.json();
    if (type === "lever" && !Array.isArray(j)) return null;
    if (A.valid && !A.valid(j)) return null;
    return A.parse(j, slug);
  } catch { return null; }
}
const DETECT = { budget: 160 };
async function findBoard(c, cache) {
  if (c.workday) { try { return { type: "workday", slug: c.workday, jobs: await workdayJobs(c.workday) }; } catch { return null; } }
  const hit = cache[c.name];
  if (hit && hit.type) { const jobs = await tryBoard(hit.type, hit.slug); if (jobs) return { ...hit, jobs }; }
  if (hit && hit.none && hit.v === 2 && daysSince(hit.none) < 14 && !c.slug) return null;
  if (!c.watch && DETECT.budget <= 0) return null;
  if (!c.watch) DETECT.budget--;
  let empty = null;
  for (const slug of slugGuesses(c)) for (const type of ATS_ORDER) {
    const jobs = await tryBoard(type, slug);
    if (jobs && jobs.length) { cache[c.name] = { type, slug }; return { type, slug, jobs }; }
    if (jobs && !empty) empty = { type, slug, jobs };
  }
  if (empty) { cache[c.name] = { type: empty.type, slug: empty.slug }; return empty; }
  cache[c.name] = { none: TODAY, v: 2 };
  return null;
}

// ---------- crypto job sites (aggregators) ----------
function splitListing(title) {
  const t = strip(title);
  let m = t.match(/^(.{2,40}?)\s+is (?:hiring|looking for)(?: an?)?\s+(.{3,100}?)(?:\s+to join.*)?$/i); if (m) return { company: m[1], role: m[2] };
  m = t.match(/^(.{3,100}?)\s+(?:at|@)\s+(.{2,40})$/i); if (m) return { company: m[2], role: m[1] };
  m = t.match(/^(.{2,40}?)\s*[:|]\s*(.{3,100})$/); if (m) return isEng(m[2]) ? { company: m[1], role: m[2] } : { company: m[2], role: m[1] };
  m = t.match(/^(.{3,100}?)\s+[-–]\s+(.{2,40})$/); if (m) return isEng(m[1]) ? { company: m[2], role: m[1] } : { company: m[1], role: m[2] };
  return null;
}
async function jobSites(sites, report) {
  const out = [];
  await pool(sites, 3, async site => {
    try {
      let items = [];
      if (site.type === "web3career") {
        const token = process.env.WEB3CAREER_TOKEN;
        if (!token) { report.push(`${site.name}: add a WEB3CAREER_TOKEN secret to switch on`); return; }
        const j = await getJSON(`https://web3.career/api/v1?token=${token}&limit=100&tag=engineering`);
        const arr = Array.isArray(j) ? j.find(x => Array.isArray(x)) || [] : (j.jobs || []);
        items = arr.map(x => ({ company: x.company, role: x.title, url: x.apply_url || x.url, location: x.location || x.country || "", posted: x.date || x.date_epoch }));
      } else {
        const feed = parseFeed(await getText(site.url));
        items = feed.map(i => { const sp = splitListing(i.title); return sp ? { company: sp.company, role: sp.role, url: i.link, location: "", posted: i.date } : null; }).filter(Boolean);
      }
      const eng = items.filter(i => i.company && i.role && isEng(i.role) && (!i.posted || daysSince(toISO(i.posted)) <= 45));
      eng.forEach(i => out.push({ company: String(i.company).trim(), title: String(i.role).trim(), url: i.url, location: i.location, posted: toISO(i.posted), site: site.name }));
      report.push(`${site.name}: ${items.length} listings, ${eng.length} engineering`);
    } catch (e) { report.push(`${site.name}: ${e.message}`); }
  });
  return out;
}

// ---------- where is the role ----------
const UK_RE = /london|united kingdom|\buk\b|\bgb\b|great britain|england|scotland|wales|northern ireland|manchester|edinburgh|bristol|leeds|birmingham|cambridge|oxford|glasgow|belfast|reading|brighton|liverpool|nottingham|sheffield|newcastle|cardiff|milton keynes|guildford/;
const FOREIGN_RE = /\b(usa|united states|u\.s\.|us|americas|north america|canada|new york|nyc|san francisco|bay area|austin|chicago|boston|seattle|denver|atlanta|miami|los angeles|toronto|vancouver|singapore|sydney|melbourne|india|bangalore|bengaluru|tokyo|dubai|uae|brazil|mexico|hong kong|apac|latam|israel|tel aviv|germany|berlin|munich|france|paris|spain|madrid|barcelona|netherlands|amsterdam|ireland|dublin|poland|warsaw|portugal|lisbon|switzerland|zurich|sweden|stockholm|denmark|copenhagen|italy|milan|austria|vienna|ca|ny|tx|ma|wa|co|il|ga|fl)\b/;
function placeRole(loc, title, desc) {
  const l = `${loc || ""} ${title || ""}`.toLowerCase(), d = String(desc || "").toLowerCase();
  const remote = /\bremote\b|work from home|\bwfh\b|anywhere/.test(l) || /fully remote|remote[- ]first/.test(d);
  const hybrid = /hybrid/.test(l) || /\bhybrid\b/.test(d);
  const uk = UK_RE.test(l), foreign = FOREIGN_RE.test(l), europe = /emea|europe|\beu\b/.test(l);
  let region;
  if (uk) region = /london/.test(l) ? "london" : "uk";
  else if (remote && (europe || !foreign)) region = "remote";
  else if (!String(loc || "").trim()) region = "unknown";
  else region = "abroad";
  return { region, workplace: remote ? "Remote" : hybrid ? "Hybrid" : (String(loc || "").trim() ? "On site" : "") };
}

// ---------- UK job boards (Adzuna, Reed) and Y Combinator ----------
const TECH = /\b(saas|software|fintech|platform|ai|artificial intelligence|machine learning|tech|technology|b2b|cloud|data|payments|startup|scale-?up|series [a-d]|api|cyber|security|legal tech|regtech|insurtech|proptech|crm|enterprise software|stablecoin)\b/i;
let AGENCY = [];
const isAgency = n => AGENCY.some(w => String(n || "").toLowerCase().includes(w));
const ukDate = d => { const m = String(d || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : d; };
async function ukBoards(cfg, report) {
  const out = [], B = cfg.ukBoards || {}, terms = B.searchTerms || [], where = B.location || "", maxDays = B.maxDaysOld || 14;
  const keep = (company, title, text) => company && title && isEng(title) && !isAgency(company) && !excluded(`${company} ${title} ${text}`) && (B.requireTech === false || TECH.test(`${title} ${company} ${text}`));
  // Adzuna
  const aid = process.env.ADZUNA_APP_ID, akey = process.env.ADZUNA_APP_KEY;
  if (aid && akey) {
    let n = 0, seen = 0;
    for (const t of terms) {
      try {
        const j = await getJSON(`https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=${aid}&app_key=${akey}&what_phrase=${encodeURIComponent(t)}${where ? `&where=${encodeURIComponent(where)}&distance=25` : ""}&max_days_old=${maxDays}&results_per_page=50&content-type=application/json`);
        for (const x of j.results || []) {
          seen++;
          const company = x.company && x.company.display_name, desc = strip(x.description || "");
          if (!keep(company, x.title, desc)) continue;
          out.push({ company: company.trim(), title: strip(x.title), url: x.redirect_url, location: (x.location && x.location.display_name) || where || "UK", posted: x.created, salary: x.salary_min ? fmtSalary(Math.round(x.salary_min), Math.round(x.salary_max || x.salary_min), "GBP", "year") : "", desc, site: "Adzuna" });
          n++;
        }
      } catch (e) { report.push(`Adzuna "${t}": ${e.message}`); }
    }
    report.push(`Adzuna: ${seen} listings checked, ${n} tech sales roles kept`);
  } else report.push("Adzuna: add ADZUNA_APP_ID and ADZUNA_APP_KEY secrets to switch on");
  // Reed
  const rkey = process.env.REED_API_KEY;
  if (rkey) {
    let n = 0, seen = 0;
    const auth = "Basic " + Buffer.from(rkey + ":").toString("base64");
    for (const t of terms) {
      try {
        const j = await getJSON(`https://www.reed.co.uk/api/1.0/search?keywords=${encodeURIComponent(t)}${where ? `&locationName=${encodeURIComponent(where)}&distanceFromLocation=15` : ""}&resultsToTake=100`, { headers: { Authorization: auth } });
        for (const x of j.results || []) {
          seen++;
          const posted = ukDate(x.date);
          if (posted && daysSince(posted) > maxDays) continue;
          if (!keep(x.employerName, x.jobTitle, x.jobDescription || "")) continue;
          out.push({ company: String(x.employerName).trim(), title: strip(x.jobTitle), url: x.jobUrl, location: x.locationName || where || "UK", posted, salary: x.minimumSalary ? fmtSalary(Math.round(x.minimumSalary), Math.round(x.maximumSalary || x.minimumSalary), "GBP", "year") : "", desc: strip(x.jobDescription || "").slice(0, 600), site: "Reed" });
          n++;
        }
      } catch (e) { report.push(`Reed "${t}": ${e.message}`); }
    }
    report.push(`Reed: ${seen} listings checked, ${n} tech sales roles kept`);
  } else report.push("Reed: add a REED_API_KEY secret to switch on");
  // Y Combinator startup jobs (public listing pages)
  if (B.ycombinator !== false) {
    let n = 0;
    for (const path of ["sales"]) {
      try {
        const html = await getText(`https://www.ycombinator.com/jobs/role/${path}`);
        const dp = html.match(/data-page="([^"]+)"/);
        const json = dp ? JSON.parse(dp[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'")) : null;
        const found = [];
        const walk = (o, d = 0) => { if (!o || typeof o !== "object" || d > 10) return; if (Array.isArray(o)) { o.forEach(x => walk(x, d + 1)); return; } if (o.title && (o.companyName || (o.company && o.company.name))) found.push(o); for (const k in o) walk(o[k], d + 1); };
        walk(json);
        for (const x of found) {
          const company = x.companyName || x.company.name, loc = x.location || x.locations || "";
          if (!isEng(x.title) || !inMarket(Array.isArray(loc) ? loc.join(", ") : loc)) continue;
          out.push({ company, title: x.title, url: x.url ? (x.url.startsWith("http") ? x.url : "https://www.ycombinator.com" + x.url) : `https://www.ycombinator.com/jobs/role/${path}`, location: Array.isArray(loc) ? loc.join(", ") : loc, posted: x.createdAt || x.lastActive || null, salary: x.salaryRange || "", site: "Y Combinator" });
          n++;
        }
        report.push(`Y Combinator: ${found.length} listings read, ${n} UK or remote sales roles`);
      } catch (e) { report.push(`Y Combinator: ${e.message}`); }
    }
  }
  return out;
}

// ---------- funding ----------
const RAISE = /^(.{2,70}?)\s+(?:raises|secures|closes|lands|nabs|bags|gets|announces|completes|scores)\s+(?:a\s+|an\s+|over\s+|nearly\s+|about\s+)?(\$|£|€|usd\s?|gbp\s?|eur\s?)([\d.,]+)\s*(million|mln|m|billion|bn|b|thousand|k)?\b/i;
const DESCRIPTOR = /^(?:(?:[a-z0-9-]+\s+){0,3}(?:startup|firm|company|platform|protocol|project|provider|network|lender|exchange|issuer|developer|app|fintech|neobank|marketplace|studio|venture|operator|unicorn|player|outfit|specialist|infrastructure)\s+)/i;
function cleanName(raw) {
  let n = raw.replace(/^(exclusive|breaking|report|scoop)\s*[:|-]\s*/i, "").replace(/,.*$/, "").replace(/['’]s$/, "").trim();
  for (let i = 0; i < 2; i++) { const s = n.replace(DESCRIPTOR, "").trim(); if (s && s !== n && /^[A-Z0-9]/.test(s)) n = s; }
  return n.length > 1 && n.length < 45 && /[A-Za-z]/.test(n) && n.split(/\s+/).length <= 5 ? n : null;
}
function toMillions(num, unit) {
  const v = parseFloat(String(num).replace(/,/g, "")); const u = (unit || "m").toLowerCase();
  return u.startsWith("b") ? v * 1000 : u === "k" || u === "thousand" ? v / 1000 : v;
}
const ROUND = t => { const m = String(t).match(/pre[- ]seed|seed|series [a-f]\b|strategic|private|growth|bridge/i); return m ? m[0].replace(/\b\w/g, c => c.toUpperCase()) : "Undisclosed round"; };
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const g = tag => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")); return m ? strip(m[1].replace(/<!\[CDATA\[|\]\]>/g, "")) : ""; };
    let link = g("link"); if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1] : ""; }
    items.push({ title: g("title"), link, date: g("pubDate") || g("published") || g("updated") || g("dc:date"), desc: g("description").slice(0, 400) });
  }
  return items;
}
async function fundingFromNews(feeds, lookback, report) {
  const out = [];
  await pool(feeds, 4, async url => {
    try {
      const items = parseFeed(await getText(url));
      let n = 0;
      for (const it of items) {
        const m = it.title.match(RAISE); if (!m) continue;
        const d = it.date ? new Date(it.date) : NOW; if (isNaN(d) || (NOW - d) / DAY > lookback) continue;
        const name = cleanName(m[1]); if (!name) continue;
        const cur = /£|gbp/i.test(m[2]) ? "£" : /€|eur/i.test(m[2]) ? "€" : "$";
        out.push({ name, currency: cur, amountM: toMillions(m[3], m[4]), round: ROUND(it.title + " " + it.desc), date: d.toISOString().slice(0, 10), url: it.link, headline: it.title, vertical: vertical(it.title + " " + it.desc), source: new URL(url).hostname.replace(/^www\./, "") });
        n++;
      }
      report.push(`${new URL(url).hostname}: ${n} raises`);
    } catch (e) { report.push(`${url}: ${e.message}`); }
  });
  return out;
}
async function fundingFromDefiLlama(lookback, report) {
  try {
    const j = await getJSON("https://api.llama.fi/raises");
    const out = (j.raises || []).filter(r => (NOW / 1000 - r.date) / 86400 <= lookback).map(r => ({
      name: r.name, amountM: r.amount || 0, round: r.round || "Undisclosed round", date: new Date(r.date * 1000).toISOString().slice(0, 10),
      url: r.source || "", headline: `${r.name} raised ${r.amount ? "$" + r.amount + "m" : "an undisclosed amount"}${r.round ? " (" + r.round + ")" : ""}`,
      vertical: vertical([r.category, r.sector].join(" ")), investors: [...(r.leadInvestors || []), ...(r.otherInvestors || [])].slice(0, 5), source: "DeFiLlama"
    }));
    report.push(`DeFiLlama: ${out.length} raises`);
    return out;
  } catch (e) { report.push(`DeFiLlama: ${e.message} (may need a paid plan, news feeds still cover funding)`); return []; }
}

// ---------- social ----------
const HIRING = /\b(hiring|we're looking for|we are looking for|join (?:our|the) team|open role|now recruiting|job opening|come build)\b/i;
const IS_HIRING = /(?:^|[•\n·|-]\s*)([A-Z][A-Za-z0-9.&' -]{1,38}?)\s+is (?:now )?(?:hiring|looking for)(?: an?)?\s+([^\n•|]{3,90}?)(?=\s+to join|\n|•|\||$)/g;
function socialPosts(text) {
  const posts = [];
  for (const m of text.matchAll(IS_HIRING)) {
    const role = m[2].replace(/\s*(\(|apply|→|http|📍|🌍).*$/i, "").trim();
    if (isEng(role)) posts.push({ company: m[1].trim(), role });
  }
  return posts;
}
async function telegram(channels, report) {
  const out = [];
  await pool(channels, 3, async ch => {
    try {
      const html = await getText(`https://t.me/s/${ch}`);
      const chunks = html.split('class="tgme_widget_message_wrap').slice(1);
      let n = 0;
      for (const c of chunks) {
        const t = c.match(/<time[^>]*datetime="([^"]+)"/); const date = t ? t[1] : null;
        if (!date || daysSince(date) > 3) continue;
        const post = (c.match(/data-post="([^"]+)"/) || [])[1];
        const body = c.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
        const text = strip(body ? body[1] : "");
        for (const p of socialPosts(text)) { out.push({ ...p, platform: "Telegram", date: date.slice(0, 10), url: post ? `https://t.me/${post}` : `https://t.me/s/${ch}`, text: `${p.company} is hiring ${p.role}` }); n++; }
      }
      report.push(`@${ch}: ${n} hiring posts`);
    } catch (e) { report.push(`@${ch}: ${e.message}`); }
  });
  return out;
}
async function farcaster(queries, report) {
  if (!KEYS.neynar) { report.push("No NEYNAR_API_KEY secret, skipped"); return []; }
  const out = [];
  for (const q of queries) {
    try {
      const j = await getJSON(`https://api.neynar.com/v2/farcaster/cast/search?q=${encodeURIComponent(q)}&limit=50&sort_type=desc_chron`, { headers: { "x-api-key": KEYS.neynar, accept: "application/json" } });
      const casts = (j.result && j.result.casts) || j.casts || [];
      let n = 0;
      for (const c of casts) {
        if (daysSince(c.timestamp) > 3 || !HIRING.test(c.text) || !ENG.test(c.text)) continue;
        out.push({ company: null, role: "", platform: "Farcaster", date: String(c.timestamp).slice(0, 10), url: `https://warpcast.com/${c.author && c.author.username}/${String(c.hash).slice(0, 10)}`, text: c.text.slice(0, 280), author: c.author && (c.author.display_name || c.author.username) });
        n++;
      }
      report.push(`"${q}": ${n} casts`);
    } catch (e) { report.push(`"${q}": ${e.message}`); }
  }
  return out;
}
async function xSearch(queries, report) {
  if (!KEYS.twitter) { report.push("No TWITTERAPI_KEY secret, skipped"); return []; }
  const out = [];
  for (const q of queries) {
    try {
      const j = await getJSON(`https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=Latest&query=${encodeURIComponent(q + " since:" + new Date(NOW - 2 * DAY).toISOString().slice(0, 10))}`, { headers: { "X-API-Key": KEYS.twitter } });
      const tweets = j.tweets || [];
      for (const t of tweets) out.push({ company: null, role: "", platform: "X", date: new Date(t.createdAt).toISOString().slice(0, 10), url: t.url, text: String(t.text).slice(0, 280), author: t.author && (t.author.name || t.author.userName) });
      report.push(`${tweets.length} posts`);
    } catch (e) { report.push(`X: ${e.message}`); }
  }
  return out;
}

// ---------- VC portfolio job boards (Getro) ----------
function findInNext(obj) {
  let networkId = null; const jobs = [];
  const walk = (o, d = 0) => {
    if (!o || typeof o !== "object" || d > 14) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, d + 1); return; }
    if (networkId == null && o.network && o.network.id != null) networkId = o.network.id;
    if (o.title && o.organization && typeof o.organization === "object" && o.organization.name) jobs.push(o);
    for (const k in o) if (k !== "organization") walk(o[k], d + 1);
  };
  walk(obj);
  return { networkId, jobs };
}
const toISO = v => { if (!v) return null; if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000).toISOString(); const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
async function vcBoard(board, report) {
  const base = board.url.replace(/\/+$/, "").replace(/\/jobs$/, "");
  let html;
  try { html = await getText(base + "/jobs"); } catch (e) { report.push(`${board.name}: ${e.message}`); return []; }
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  let next = null; try { next = m && JSON.parse(m[1]); } catch {}
  let { networkId, jobs } = findInNext(next);
  let paged = false;
  if (networkId != null) {
    const all = [];
    for (let page = 0; page < 40; page++) {
      try {
        const j = await getJSON(`https://api.getro.com/api/v2/collections/${networkId}/search/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", origin: base, referer: base + "/jobs" },
          body: JSON.stringify({ hitsPerPage: 100, page, filters: {}, query: "" })
        });
        const batch = (j.results && j.results.jobs) || j.jobs || (Array.isArray(j.results) ? j.results : []);
        all.push(...batch);
        if (batch.length < 100) break;
      } catch (e) { if (!all.length) report.push(`${board.name}: search API ${e.message}, using the first page only`); break; }
    }
    if (all.length) { jobs = all; paged = true; }
  }
  const out = jobs.map(x => {
    const org = x.organization || {};
    const locs = Array.isArray(x.locations) ? x.locations.map(l => typeof l === "string" ? l : (l && (l.name || l.label)) || "").filter(Boolean).join("; ") : (x.location || "");
    const url = x.url && /^https?:/.test(x.url) ? x.url : `${base}/companies/${org.slug || ""}/jobs/${x.slug || ""}`;
    return { company: String(org.name).trim(), domain: (org.domain || "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, ""), title: String(x.title).trim(), url, location: locs, posted: toISO(x.created_at || x.createdAt || x.posted_at), vc: board.name };
  }).filter(j => j.company && isEng(j.title) && !/talent network|talent collective|general application|open application/i.test(j.title) && norm(j.company) !== norm(board.name));
  report.push(`${board.name}: ${jobs.length} jobs read${paged ? "" : " (first page only)"}, ${out.length} engineering`);
  return out;
}

// ---------- GitHub activity ----------
let ghCalls = 0;
async function gh(path) {
  if (ghCalls >= 900) throw new Error("daily GitHub budget used");
  ghCalls++;
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (KEYS.github) headers.Authorization = `Bearer ${KEYS.github}`;
  const r = await get(`https://api.github.com${path}`, { headers }, 1);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const rootDomain = d => String(d || "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "");
async function findGithubOrg(u, cache) {
  const hit = cache[u.name];
  if (hit && hit.org) return hit.org;
  if (hit && hit.none && daysSince(hit.none) < 30 && !u.github) return null;
  const guesses = [...new Set([u.github, ...slugGuesses(u), u.domain && rootDomain(u.domain).split(".")[0]].filter(Boolean))].slice(0, 4);
  for (const g of guesses) {
    const o = await gh(`/orgs/${encodeURIComponent(g)}`).catch(() => null);
    if (!o) continue;
    const blog = rootDomain(o.blog), dom = rootDomain(u.domain);
    const ok = (u.github && g === u.github) || (dom && blog && (blog.endsWith(dom) || dom.endsWith(blog))) || (!dom && norm(o.name || o.login) === norm(u.name));
    if (ok) { cache[u.name] = { org: o.login }; return o.login; }
  }
  cache[u.name] = { none: TODAY };
  return null;
}
async function devActivity(org) {
  const repos = (await gh(`/orgs/${org}/repos?sort=pushed&per_page=8&type=public`) || []).filter(r => !r.fork && !r.archived).slice(0, 3);
  const since = new Date(NOW - 60 * DAY).toISOString(), cut = NOW - 30 * DAY;
  const recent = new Set(), prior = new Set(); let commits = 0;
  for (const r of repos) {
    const cs = await gh(`/repos/${org}/${r.name}/commits?since=${since}&per_page=100`) || [];
    for (const c of cs) {
      const who = (c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.email);
      if (!who || /\[bot\]|dependabot|github-actions/i.test(who)) continue;
      const t = new Date(c.commit && c.commit.author && c.commit.author.date);
      if (t >= cut) { recent.add(who); commits++; } else prior.add(who);
    }
  }
  const newRepos = (await gh(`/orgs/${org}/repos?sort=created&per_page=10&type=public`) || []).filter(r => !r.fork && daysSince(r.created_at) <= 14).length;
  const a = recent.size, b = prior.size;
  const spike = (a - b >= 3 && a >= b * 1.3) || (b === 0 && a >= 5) || newRepos >= 3;
  return { org, contributors: a, prevContributors: b, commits, newRepos, repos: repos.map(r => r.name), spike, checked: TODAY };
}

// ---------- X tracked accounts (pre-round signals) ----------
const X_SKIP = new Set(["frontrunvc", "ustyianskyi", "home", "i", "search", "x", "twitter", "paradigm", "a16z", "a16zcrypto", "polychain", "multicoincap", "dragonfly_xyz", "dragonflycap", "panteracapital", "cbventures", "coinbaseventures", "haunventures", "variantfund", "placeholdervc", "electriccapital", "hackvc", "1kxnetwork", "blockchaincap", "robotventures", "frameworkvc", "binancelabs", "yzilabs", "sequoia", "lightspeedvp", "vitalikbuterin", "elonmusk", "cz_binance", "coinbase", "binance"]);
let VC_NAMES = new Set();
async function xAccounts(handles, queries, report) {
  if (!KEYS.twitter) { report.push("No TWITTERAPI_KEY secret, tracked accounts skipped"); return []; }
  const out = [];
  const qs = [...handles.map(h => ({ q: `from:${h.replace(/^@/, "")}`, via: "@" + h.replace(/^@/, "") })), ...queries.map(q => ({ q, via: "search" }))];
  for (const { q, via } of qs) {
    try {
      const j = await getJSON(`https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=Latest&query=${encodeURIComponent(q + " since:" + new Date(NOW - 3 * DAY).toISOString().slice(0, 10))}`, { headers: { "X-API-Key": KEYS.twitter } });
      const tweets = j.tweets || [];
      let n = 0;
      for (const t of tweets) {
        const author = (t.author && t.author.userName || "").toLowerCase();
        const ents = (t.entities && t.entities.user_mentions) || [];
        const handlesIn = [...new Set([...ents.map(e => e.screen_name), ...[...String(t.text).matchAll(/@([A-Za-z0-9_]{2,15})/g)].map(m => m[1])])]
          .filter(h => h && h.toLowerCase() !== author && !X_SKIP.has(h.toLowerCase()) && !VC_NAMES.has(norm(h)));
        for (const h of handlesIn.slice(0, 6)) {
          const e = ents.find(x => x.screen_name && x.screen_name.toLowerCase() === h.toLowerCase());
          out.push({ platform: "X", handle: h, handleName: e && e.name, company: null, role: "", date: new Date(t.createdAt).toISOString().slice(0, 10), url: t.url, text: String(t.text).slice(0, 280), author: t.author && (t.author.name || t.author.userName), via });
          n++;
        }
      }
      report.push(`${via === "search" ? "Signal search" : via}: ${tweets.length} posts, ${n} projects mentioned`);
    } catch (e) { report.push(`${via}: ${e.message}`); }
  }
  return out;
}

// ---------- Apollo ----------
async function apolloContact(domain, titles) {
  const r = await get("https://api.apollo.io/api/v1/mixed_people/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": KEYS.apollo },
    body: JSON.stringify({ q_organization_domains_list: [domain], person_titles: titles, page: 1, per_page: 3 })
  }, 1);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  const j = await r.json();
  const p = (j.people || j.contacts || [])[0];
  return p ? { name: p.name || [p.first_name, p.last_name].filter(Boolean).join(" "), title: p.title, linkedin: p.linkedin_url || "", email: p.email && !/not_unlocked|email_not/.test(p.email) ? p.email : "", source: "Apollo", found: TODAY } : { none: TODAY };
}

// ---------- scoring ----------
let SECTOR_FIT = {};
function score(c) {
  const parts = [], roles = c.roles;
  if (roles.length) {
    const types = new Set(c.disc);
    if (types.has("SDR / BDR") || types.has("Account Executive")) parts.push([5, `${types.has("SDR / BDR") ? "SDR / BDR" : "Account Executive"} role that fits your level`]);
    else parts.push([2, "Senior AE role, a stretch but worth a look"]);
    const newest = Math.min(...roles.map(r => r.age));
    parts.push([newest <= 2 ? 4 : newest <= 7 ? 3 : newest <= 14 ? 1 : 0, newest <= 2 ? "Posted in the last 2 days, apply early" : newest <= 7 ? "Posted this week" : newest <= 14 ? "Posted in the last 2 weeks" : "Open a while, may be filling"]);
    if (roles.length >= 3) parts.push([2, `${roles.length} sales roles open, building out the team`]);
    if (roles.some(r => r.salary)) parts.push([1, "Salary or OTE listed"]);
  }
  if (c.loc === "strong") parts.push([3, "London or UK based"]); else if (c.loc === "some") parts.push([2, "Remote UK or Europe"]);
  if (c.funding) {
    const a = c.funding.amountM || 0;
    parts.push([a >= 50 ? 4 : a >= 10 ? 3 : 2, a ? `Raised ${c.funding.currency || "$"}${+a.toFixed(1)}m, likely growing sales` : "Recently raised"]);
  }
  if (c.surge) parts.push([2, `Sales hiring surge: ${c.surge.from} to ${c.surge.to} roles in a week`]);
  if (c.backers && c.backers.length) parts.push([1, `Backed by ${c.backers.slice(0, 2).join(", ")}`]);
  const sf = SECTOR_FIT[c.vertical] ?? 1;
  if (sf) parts.push([sf, `${c.vertical} is ${sf >= 2 ? "one of your target sectors" : "a decent sector for tech sales"}`]);
  if (c.contact && c.contact.name) parts.push([1, "Sales leader found to message"]);
  c.parts = parts;
  c.score = Math.min(20, parts.reduce((a, p) => a + p[0], 0));
  c.tier = c.score >= 15 ? "hot" : c.score >= 11 ? "strong" : "watch";
}
function story(c) {
  const R = c.roles, F = c.funding, bits = [];
  if (R.length) { const newest = Math.min(...R.map(r => r.age)); bits.push(`${R.length} open sales role${R.length > 1 ? "s" : ""} (${c.disc.join(", ")}), newest posted ${newest === 0 ? "today" : newest === 1 ? "yesterday" : newest + " days ago"}.`); }
  if (F) bits.push(`Raised ${F.amountM ? (F.currency || "$") + (+F.amountM.toFixed(1)) + "m" : "an undisclosed amount"} (${F.round}) on ${F.date}.`);
  if (c.surge) bits.push(`Sales roles jumped from ${c.surge.from} to ${c.surge.to} in a week.`);
  if (c.backers && c.backers.length) bits.push(`Backed by ${c.backers.join(", ")}.`);
  c.why = bits.join(" ");
  const sdr = R.find(r => r.disc.includes("SDR / BDR")), ae = R.find(r => r.disc.includes("Account Executive"));
  if (R.length && Math.min(...R.map(r => r.age)) <= 2) c.angle = `Fresh posting, so apply today while the shortlist is still forming. Then message the hiring manager on LinkedIn with one line on your outbound numbers.`;
  else if (c.surge || R.length >= 3) c.angle = `They're building out the sales team fast. Lead with your weekly outbound volume and your company wide ranking.`;
  else if (F && R.length) c.angle = `Fresh funding plus live sales roles. Mention the raise and show you can help them turn it into pipeline quickly.`;
  else if (F) c.angle = `Just raised but no sales roles posted yet. Message the founder or Head of Sales directly, because early outreach beats waiting for the advert.`;
  else if (sdr) c.angle = `Your recruitment BD is basically SDR work already: cold outreach, qualifying, booking meetings. Frame it that way for the ${sdr.title} role.`;
  else if (ae) c.angle = `For the ${ae.title} role, lead with full cycle ownership: you ran deals from first call to signed terms, so lead with your placements and revenue.`;
  else c.angle = `Senior role, so it's a stretch. Worth applying if the company is a strong fit, or ask about junior openings in the team.`;
}

// ---------- main ----------
async function main() {
  const watch = JSON.parse(await readFile(new URL("config/watchlist.json", ROOT), "utf8")).companies;
  const cfg = JSON.parse(await readFile(new URL("config/sources.json", ROOT), "utf8"));
  MARKET = { include: (cfg.market && cfg.market.include) || [], exclude: (cfg.market && cfg.market.exclude) || [] };
  EXCLUDE = (cfg.excludeKeywords || []).map(w => w.toLowerCase());
  SECTOR_FIT = cfg.sectorFit || {};
  let prev = { history: { roles: {}, companies: {}, ats: {}, apollo: {} }, companies: [] };
  try { prev = await decrypt(JSON.parse(await readFile(DATA_FILE, "utf8"))); console.log("Loaded previous data"); }
  catch (e) { console.log("No previous data (first run or passphrase changed). Starting fresh."); }
  const H = Object.assign({ roles: {}, companies: {}, ats: {}, apollo: {} }, prev.history);
  const sources = {};

  // 1. funding
  const fundRep = [];
  const raises = [...(cfg.defillama === false ? [] : await fundingFromDefiLlama(cfg.fundingLookbackDays || 30, fundRep)), ...await fundingFromNews(cfg.newsFeeds || [], cfg.fundingLookbackDays || 30, fundRep)];
  const fundBy = {};
  for (const r of raises) { if (excluded(`${r.name} ${r.headline} ${r.vertical}`)) continue; const k = norm(r.name); if (!fundBy[k] || (r.amountM || 0) > (fundBy[k].amountM || 0) || r.date > fundBy[k].date) fundBy[k] = r; }
  sources.funding = { ok: true, count: Object.keys(fundBy).length, notes: fundRep };
  console.log(`Funding: ${Object.keys(fundBy).length} companies`);

  // 2. social
  const tgRep = [], fcRep = [], xRep = [];
  VC_NAMES = new Set((cfg.vcBoards || []).map(b => norm(b.name)));
  const social = [...await telegram(cfg.telegramChannels || [], tgRep), ...await farcaster(cfg.farcasterQueries || [], fcRep), ...await xSearch(cfg.xQueries || [], xRep), ...await xAccounts(cfg.xAccounts || [], cfg.xSignalQueries || [], xRep)];
  sources.telegram = { ok: true, count: social.filter(s => s.platform === "Telegram").length, notes: tgRep };
  sources.farcaster = { ok: !!KEYS.neynar, count: social.filter(s => s.platform === "Farcaster").length, notes: fcRep };
  sources.x = { ok: !!KEYS.twitter, count: social.filter(s => s.platform === "X").length, notes: xRep };

  // 3. company universe: watchlist + newly funded + companies seen hiring on social
  const universe = new Map();
  const add = (name, extra = {}) => { const k = norm(name); if (!k) return null; if (!universe.has(k)) universe.set(k, { name, ...extra }); else Object.assign(universe.get(k), Object.fromEntries(Object.entries(extra).filter(([, v]) => v))); return universe.get(k); };
  watch.forEach(w => add(w.name, { ...w, watch: true }));
  Object.values(fundBy).forEach(f => add(f.name, { vertical: f.vertical }));
  social.filter(s => s.company).forEach(s => add(s.company, {}));
  // map X handles to known companies, otherwise track them as new projects
  const byKey = () => { const m = {}; for (const u of universe.values()) { m[norm(u.name)] = u; if (u.domain) m[norm(rootDomain(u.domain).split(".")[0])] = u; if (u.x) m[norm(u.x)] = u; } return m; };
  { const idx = byKey(); for (const s of social.filter(s => s.handle)) { const hit = idx[norm(s.handle)] || (s.handleName && idx[norm(s.handleName)]); s.company = hit ? hit.name : (s.handleName && s.handleName.length < 40 ? s.handleName : "@" + s.handle); if (!hit) add(s.company, { x: s.handle }); } }
  // self growing watchlist: companies surfaced before keep getting checked
  H.discovered = H.discovered || {};
  const autoCount = Object.entries(H.discovered).filter(([, d]) => daysSince(d.last) <= 120).map(([k, d]) => { if (!universe.has(k)) add(d.name, { domain: d.domain, x: d.x, auto: true }); return k; }).length;
  // match unnamed social posts (Farcaster, X) to known companies by name in text
  const known = [...universe.values()].filter(u => u.name.length >= 4);
  social.filter(s => !s.company).forEach(s => { const hit = known.find(u => new RegExp(`\\b${u.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(s.text)); if (hit) s.company = hit.name; });

  // 3b. VC portfolio job boards
  const vcRep = [];
  const vcJobs = (await pool(cfg.vcBoards || [], 3, b => vcBoard(b, vcRep))).flat();
  const vcByCo = {};
  for (const j of vcJobs) {
    const k = norm(j.company); if (!k || excluded(j.company)) continue;
    (vcByCo[k] = vcByCo[k] || { name: j.company, domain: j.domain, jobs: [], backers: new Set() });
    vcByCo[k].jobs.push(j); vcByCo[k].backers.add(j.vc);
  }
  sources.vc = { ok: vcJobs.length > 0, count: Object.keys(vcByCo).length, notes: vcRep };
  console.log(`VC boards: ${vcJobs.length} engineering roles at ${Object.keys(vcByCo).length} companies`);

  // 3c. crypto job sites
  const siteRep = [];
  AGENCY = ((cfg.ukBoards && cfg.ukBoards.skipEmployers) || []).map(w => w.toLowerCase());
  const siteJobs = [...await jobSites(cfg.jobSites || [], siteRep), ...await ukBoards(cfg, siteRep)];
  const siteByCo = {};
  for (const j of siteJobs) { const k = norm(j.company); if (!k || excluded(j.company)) continue; (siteByCo[k] = siteByCo[k] || { name: j.company, jobs: [], sites: new Set() }); siteByCo[k].jobs.push(j); siteByCo[k].sites.add(j.site); }
  sources.sites = { ok: siteJobs.length > 0, count: Object.keys(siteByCo).length, notes: siteRep };

  // 4. job boards
  const list = [...universe.values()];
  let boards = 0, missing = [];
  await pool(list, 8, async u => {
    const b = await findBoard(u, H.ats);
    if (!b) { if (u.watch) missing.push(u.name); u.jobs = []; return; }
    boards++; u.ats = { type: b.type, slug: b.slug };
    u.jobs = b.jobs.filter(j => j.title && isEng(j.title));
  });
  sources.jobs = { ok: true, count: boards, notes: [`${boards} company job boards read across ${ATS_ORDER.length} systems`, `${autoCount} companies auto added to the watchlist from earlier signals`, ...(missing.length ? [`Jobs page not found for: ${missing.sort().join(", ")}. Add a slug in config/watchlist.json if they're hiring.`] : [])] };
  console.log(`Job boards: ${boards} found, ${missing.length} watchlist companies not found`);
  // add VC portfolio roles (after ATS detection so we don't probe hundreds of new boards)
  for (const [k, v] of Object.entries(vcByCo)) {
    let u = universe.get(k);
    if (!u) { u = { name: v.name, domain: v.domain, jobs: [], fromVC: true }; universe.set(k, u); list.push(u); }
    if (!u.domain && v.domain) u.domain = v.domain;
    u.backers = [...v.backers];
    const have = new Set((u.jobs || []).map(j => j.title.toLowerCase().replace(/[^a-z0-9]/g, "")));
    for (const j of v.jobs) { const t = j.title.toLowerCase().replace(/[^a-z0-9]/g, ""); if (!have.has(t)) { have.add(t); u.jobs.push(j); } }
  }
  for (const [k, v] of Object.entries(siteByCo)) {
    let u = universe.get(k);
    if (!u) { u = { name: v.name, jobs: [] }; universe.set(k, u); list.push(u); }
    u.jobs = u.jobs || []; u.sites = [...v.sites];
    const have = new Set(u.jobs.map(j => j.title.toLowerCase().replace(/[^a-z0-9]/g, "")));
    for (const j of v.jobs) { const t = j.title.toLowerCase().replace(/[^a-z0-9]/g, ""); if (!have.has(t)) { have.add(t); u.jobs.push(j); } }
  }

  // 4b. GitHub activity (rotates through companies, a slice per day)
  const prevByName = Object.fromEntries((prev.companies || []).map(c => [norm(c.name), c]));
  H.gh = H.gh || {}; H.ghChecked = H.ghChecked || {};
  const ghCfg = cfg.github || {};
  const ghRep = []; let ghDone = 0, spikes = 0;
  if (ghCfg.enabled !== false) {
    const cands = list.filter(u => u.watch || u.github || (u.jobs && u.jobs.length) || fundBy[norm(u.name)])
      .sort((a, b) => (H.ghChecked[norm(a.name)] || "").localeCompare(H.ghChecked[norm(b.name)] || "") || (b.watch - a.watch))
      .slice(0, ghCfg.maxCompaniesPerDay || 60);
    for (const u of cands) {
      const k = norm(u.name);
      try {
        const org = await findGithubOrg(u, H.gh);
        H.ghChecked[k] = TODAY;
        if (!org) continue;
        u.dev = await devActivity(org); ghDone++; if (u.dev.spike) spikes++;
      } catch (e) { ghRep.push(`Stopped early: ${e.message}`); break; }
    }
    for (const u of list) if (!u.dev && prevByName[norm(u.name)] && prevByName[norm(u.name)].dev) u.dev = prevByName[norm(u.name)].dev;
    ghRep.unshift(`Checked ${ghDone} GitHub orgs today (${ghCalls} API calls), ${spikes} growing${KEYS.github ? "" : ". No GITHUB_TOKEN, so only a few checks fit in the free limit"}`);
  }
  sources.github = { ok: ghCfg.enabled !== false, count: list.filter(u => u.dev && u.dev.spike).length, notes: ghRep };

  // 5. build companies
  const companies = [];
  for (const u of list) {
    const k = norm(u.name);
    const roles = (u.jobs || []).filter(j => cfg.keepAbroad !== false || inMarket(j.location)).map(j => {
      const id = j.url || `${u.name}|${j.title}`;
      const posted = j.posted && !isNaN(new Date(j.posted)) ? new Date(j.posted).toISOString().slice(0, 10) : null;
      if (!H.roles[id]) H.roles[id] = posted && posted <= TODAY ? posted : TODAY;
      const first = H.roles[id];
      const pl = placeRole(j.location, j.title, j.desc);
      return { id, title: j.title.trim(), url: j.url, location: j.location || "", region: pl.region, workplace: pl.workplace, firstSeen: first, age: daysSince(first), disc: discipline(j.title), salary: j.salary || "", via: j.vc || j.site || "" };
    }).sort((a, b) => a.age - b.age);
    const funding = fundBy[k] || null;
    const soc = social.filter(s => s.company && norm(s.company) === k);
    const dev = u.dev || null;
    if (!roles.length && !funding && !soc.length && !(dev && dev.spike)) { if (H.live && H.live[k] && Object.keys(H.live[k]).length === 0) delete H.live[k]; continue; }
    if (!H.companies[k]) H.companies[k] = TODAY;
    const c = {
      id: k, name: u.name, domain: u.domain || "", vertical: u.vertical || (funding && funding.vertical) || "Infra & data",
      locations: [...new Set(roles.map(r => r.location).filter(Boolean))].slice(0, 3),
      roles, disc: [...new Set(roles.flatMap(r => r.disc))], funding, social: soc,
      contact: (prevByName[k] && prevByName[k].contact) || null,
      firstSeen: H.companies[k], isNew: H.companies[k] === TODAY, watch: !!u.watch, ats: u.ats || null,
      backers: u.backers || [], dev
    };
    c.stale = roles.some(r => r.age >= 30);
    c.sites = u.sites || [];
    // hiring surge: compare with the count about a week ago
    H.counts = H.counts || {}; const hc = H.counts[k] = H.counts[k] || {};
    hc[TODAY] = roles.length;
    for (const d of Object.keys(hc)) if (daysSince(d) > 21) delete hc[d];
    const weekAgo = Object.entries(hc).filter(([d]) => daysSince(d) >= 6 && daysSince(d) <= 10).sort()[0];
    if (weekAgo && roles.length - weekAgo[1] >= 3 && roles.length >= 2 * Math.max(1, weekAgo[1])) c.surge = { from: weekAgo[1], to: roles.length };
    // roles closing: only judged when we can see the company's roles today
    H.live = H.live || {}; H.closed = H.closed || {};
    const prevLive = H.live[k] || {};
    if (roles.length) {
      const nowIds = new Set(roles.map(r => r.id));
      for (const [id, [title, first]] of Object.entries(prevLive)) if (!nowIds.has(id)) (H.closed[k] = H.closed[k] || []).push({ title, closed: TODAY, openDays: daysSince(first) });
      H.live[k] = Object.fromEntries(roles.map(r => [r.id, [r.title, r.firstSeen]]));
    }
    if (H.closed[k]) H.closed[k] = H.closed[k].filter(x => daysSince(x.closed) <= 30);
    c.closed = H.closed[k] || [];
    c.closing = c.closed.filter(x => daysSince(x.closed) <= 14 && x.openDays <= 21);
    // location
    const LB = cfg.locationBoost || {};
    const locText = roles.map(r => r.location).join(" | ").toLowerCase();
    const hasAny = arr => (arr || []).some(w => new RegExp(`\\b${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(locText));
    c.loc = roles.some(r => r.region === "london" || r.region === "uk") ? "strong" : roles.some(r => r.region === "remote" || r.region === "unknown") ? "some" : "";
    // remember companies surfaced outside the watchlist
    if (!u.watch) H.discovered[k] = { name: u.name, domain: u.domain || "", x: u.x || "", since: (H.discovered[k] && H.discovered[k].since) || TODAY, last: TODAY };
    c.newRoles = roles.filter(r => r.firstSeen === TODAY).length;
    score(c); companies.push(c);
  }

  // 6. Apollo contacts for top leads
  const ap = cfg.apollo || {};
  if (KEYS.apollo) {
    const targets = companies.filter(c => c.domain && c.score >= (ap.minScore || 16) && !(c.contact && c.contact.name) && !(H.apollo[c.id] && daysSince(H.apollo[c.id]) < 30)).sort((a, b) => b.score - a.score).slice(0, ap.dailyLimit || 8);
    const notes = []; let found = 0;
    for (const c of targets) {
      try { const r = await apolloContact(c.domain, ap.titles || ["CTO", "VP Engineering", "Head of Engineering"]); H.apollo[c.id] = TODAY; if (r.name) { c.contact = r; found++; score(c); } }
      catch (e) { notes.push(`${c.name}: ${e.message}`); if (/401|403/.test(e.message)) break; }
    }
    sources.apollo = { ok: !notes.some(n => /401|403/.test(n)), count: found, notes: [`Looked up ${targets.length}, found ${found}`, ...notes] };
  } else sources.apollo = { ok: false, count: 0, notes: ["No APOLLO_API_KEY secret yet"] };

  companies.forEach(story);
  companies.sort((a, b) => b.score - a.score);

  // prune history older than 120 days
  for (const [k, v] of Object.entries(H.roles)) if (daysSince(v) > 120) delete H.roles[k];

  const payload = { generatedAt: NOW.toISOString(), date: TODAY, companies, sources, history: H };
  await mkdir(new URL("data/", ROOT), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(await encrypt(payload)));
  // Public demo for your CV: same leads, contact details removed, no history.
  const demo = {
    generatedAt: payload.generatedAt, date: TODAY, demo: true,
    companies: companies.map(c => ({ ...c, contact: c.contact && c.contact.name ? { name: "", title: c.contact.title || "", hidden: true } : null })),
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { ok: v.ok, count: v.count, notes: [] }]))
  };
  if (cfg.demo !== false) await writeFile(new URL("data/demo.json", ROOT), JSON.stringify(demo));
  console.log(`Done: ${companies.length} companies, ${companies.filter(c => c.isNew).length} new today, ${companies.filter(c => c.tier === "hot").length} hot.`);
}
main().catch(e => { console.error(e); process.exit(1); });
