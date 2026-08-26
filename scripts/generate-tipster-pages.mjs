#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Generates one static page per tipster at /t/<username>/index.html.

   Why static files at all, when the numbers on the page are fetched live:
   link-preview crawlers (Telegram, WhatsApp, Facebook, X, Discord, iMessage)
   fetch the HTML and read its <meta> tags without ever running JavaScript. A
   single shared page could therefore only ever produce one generic preview
   card for every tipster, which defeats the point of a shareable link. So the
   tipster's identity and record are baked into their own file, and the browser
   refreshes the figures on load for the humans who arrive.

   The baked numbers are not throwaway: they are what search engines index,
   what paints first, and what remains if the API is unreachable.

   Usage:  node scripts/generate-tipster-pages.mjs
   Env:    API_BASE   default https://api.insidr.tips
           APP_URL    default https://www.insidr.tips   (the Flutter app)
           SITE_URL   default https://insidr.tips       (this static site)
--------------------------------------------------------------------------- */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_BASE = (process.env.API_BASE || 'https://api.insidr.tips').replace(/\/+$/, '');
const APP_URL  = (process.env.APP_URL  || 'https://www.insidr.tips').replace(/\/+$/, '');
const SITE_URL = (process.env.SITE_URL || 'https://insidr.tips').replace(/\/+$/, '');

/** Static pages that already exist on the site and must survive a sitemap rewrite. */
const STATIC_URLS = [
  { loc: '/',        changefreq: 'weekly', priority: '1.0' },
  { loc: '/terms',   changefreq: 'yearly', priority: '0.3' },
  { loc: '/privacy', changefreq: 'yearly', priority: '0.3' },
];

/* -- safety ---------------------------------------------------------------- */

/** Every interpolated value is user-controlled, so nothing reaches the template unescaped. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Usernames become filesystem paths and URLs; anything outside this set is refused. */
const SAFE_USERNAME = /^[A-Za-z0-9._-]{1,64}$/;

/** An avatar URL is written into src=, so a javascript: or data: value must not survive. */
function safeImageUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch { return null; }
}

/* -- formatting ------------------------------------------------------------ */

const signed  = (n) => `${Number(n) > 0 ? '+' : ''}${Number(n).toFixed(1)}%`;
const odds    = (n) => Number(n).toFixed(2);
const sign    = (n) => (Number(n) > 0 ? 'pos' : Number(n) < 0 ? 'neg' : '');

/* -- template -------------------------------------------------------------- */

function renderPage(t) {
  // rawName feeds values that are escaped once at the point of output (the meta
  // tags); name is pre-escaped for interpolation straight into markup. Mixing the
  // two up double-escapes, and a preview card reading "Maria &amp;amp; ..." is the
  // visible result.
  const rawName  = t.displayName || t.username;
  const name     = esc(rawName);
  const username = esc(t.username);
  const all      = t.allTime;
  const recent   = t.last30Days;
  const hasRecord = all.totalGames > 0;
  const avatar   = safeImageUrl(t.profilePictureUrl);
  const canonical = `${SITE_URL}/t/${username}/`;

  // The preview card is the advertisement: it leads with the number, because a
  // card that reads "Insidr" converts far worse than one that reads "+12.4% ROI".
  // Deliberately free of statistics.
  //
  // These tags are the only part of the page a preview crawler reads, and they are frozen
  // at build time — so any figure placed here is stale the moment the next result settles.
  // Worse, it is stale in the one place nobody can refresh: a card already pasted into a
  // chat. A tipster who deleted three losing bets kept advertising "-21.8% ROI" for a day
  // after the real number had moved to -4.7%.
  //
  // There is a second reason, and it may be the better one: a card leading with a negative
  // return is a card nobody shares. Pinning the preview to the claim rather than the score
  // makes the link worth sending on a bad week as well as a good one — and the claim is
  // both always true and the thing that actually distinguishes us.
  //
  // The figures still ship inside the page body, where the browser refreshes them on load.
  const ogTitle = `${rawName} — verified tipster on Insidr`;
  const ogDescription =
    'Every tip is priced from bookmaker odds, locked before kick-off and settled '
    + 'automatically. The record cannot be edited.';

  const ogImage = avatar || `${SITE_URL}/logo.png`;

  const row = (label, allVal, allCls, recentVal, recentCls) => `
          <tr>
            <th scope="row">${label}</th>
            <td class="${allCls}" data-field="${label.toLowerCase().replace(/ /g, '-')}-all">${allVal}</td>
            <td class="${recentCls}" data-field="${label.toLowerCase().replace(/ /g, '-')}-30">${recentVal}</td>
          </tr>`;

  const recentCell = (value, cls) =>
    recent.totalGames > 0 ? [value, cls] : ['—', 'none'];

  const [roi30, roi30cls]   = recentCell(signed(recent.roi), sign(recent.roi));
  const [odds30, odds30cls] = recentCell(odds(recent.avgOdds), '');
  const [n30, n30cls]       = recentCell(String(recent.totalGames), '');

  // Both the record and the empty state ship on every page, one of them hidden.
  // A tipster's first settled tip is exactly when this page matters most, and the
  // live fetch has to be able to reveal a record the last build didn't know about
  // without waiting for the next one.
  const recordSection = `
      <section class="record" aria-labelledby="record-h" id="record"${hasRecord ? '' : ' hidden'}>
        <h2 id="record-h">Settled record</h2>
        <div class="table-scroll">
          <table>
            <caption>Career figures against the last 30 days. Cancelled and pending tips are excluded.</caption>
            <thead>
              <tr><th scope="col">Metric</th><th scope="col">All time</th><th scope="col">Last 30 days</th></tr>
            </thead>
            <tbody>
${row('ROI', signed(all.roi), sign(all.roi), roi30, roi30cls)}
${row('Average odds', odds(all.avgOdds), '', odds30, odds30cls)}
${row('Settled tips', String(all.totalGames), '', n30, n30cls)}
            </tbody>
          </table>
        </div>
        <p class="asof" id="asof"><span class="dot"></span><span id="asof-text">Figures from the last site build</span></p>
      </section>`;

  const heroFigure = `
        <div class="headline" id="hero-record"${hasRecord ? '' : ' hidden'}>
          <div class="figures">
            <div class="figure">
              <span class="figure-value"><span data-field="wins-hero">${all.wins}</span><span class="of">of</span><span data-field="games-hero">${all.totalGames}</span></span>
              <span class="figure-label">settled tips won</span>
            </div>
            <div class="figure">
              <span class="figure-value ${sign(all.roi)}" data-field="roi-hero">${signed(all.roi)}</span>
              <span class="figure-label">return on investment, all time</span>
            </div>
          </div>
        </div>
        <div class="headline" id="hero-empty"${hasRecord ? ' hidden' : ''}>
          <span class="headline-value">No settled tips yet</span>
          <span class="headline-label">
            ${name} has joined Insidr but has no settled tips so far. Their record starts
            building with the first one, and every entry after that is recorded automatically.
          </span>
        </div>`;

  const price = Number(t.subscriptionPrice) > 0
    ? `<span class="price">€${Number(t.subscriptionPrice).toFixed(2)}/month</span> for VIP tips.`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — verified tipster record | Insidr</title>
<meta name="description" content="${esc(ogDescription)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/favicon.png">

<meta property="og:type" content="profile">
<meta property="og:site_name" content="Insidr">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDescription)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${esc(ogImage)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(ogDescription)}">
<meta name="twitter:image" content="${esc(ogImage)}">

<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'ProfilePage',
  name: `${t.displayName || t.username} — tipster record`,
  url: canonical,
  mainEntity: {
    '@type': 'Person',
    name: t.displayName || t.username,
    alternateName: `@${t.username}`,
    ...(avatar ? { image: avatar } : {}),
  },
}, null, 2)}
</script>

<link rel="stylesheet" href="/t/assets/tipster.css">
<script>
  /* Inline and blocking on purpose: the stored theme has to be applied before
     first paint, otherwise the page flashes the wrong palette. */
  try {
    var s = localStorage.getItem('insidr-theme');
    if (s === 'light' || s === 'dark') document.documentElement.setAttribute('data-theme', s);
  } catch (e) {}
</script>
</head>
<body data-username="${username}" data-api="${esc(API_BASE)}">

<header class="nav">
  <div class="wrap nav-inner">
    <a class="brand" href="/" aria-label="Insidr home"><span class="logo-mark" role="img" aria-label="Insidr"></span></a>
    <div class="nav-actions">
      <button class="theme-toggle" id="themeToggle" aria-label="Switch colour theme" title="Switch theme">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>
      </button>
      <a class="btn btn-primary" href="${APP_URL}">Open app</a>
    </div>
  </div>
</header>

<main class="wrap">
  <section class="hero">
    <div class="who">
      ${avatar
        ? `<img class="avatar" src="${esc(avatar)}" alt="${name}" width="76" height="76" loading="eager" decoding="async">`
        : `<span class="avatar avatar-fallback" aria-hidden="true">${esc((t.displayName || t.username).trim().charAt(0).toUpperCase())}</span>`}
      <div>
        <h1>${name}</h1>
        <p class="handle">@${username}</p>
      </div>
    </div>
${heroFigure}
  </section>
${recordSection}

  <section class="method" aria-labelledby="method-h">
    <h2 id="method-h">Why these numbers can be trusted</h2>
    <p>${name} does not enter this record. Insidr produces it, which is the whole reason the platform exists.</p>
    <ul>
      <li>Odds come from the bookmakers, not from the tipster.</li>
      <li>Every tip is locked to a specific fixture before kick-off, so nothing can be added or altered once a match starts.</li>
      <li>Results are settled automatically from the match result — a loss cannot be quietly deleted.</li>
    </ul>
  </section>

  <section class="cta">
    <div>
      <h2>See what ${name} is tipping now</h2>
      <p>Past results are public. Upcoming picks and the reasoning behind them are for subscribers. ${price}</p>
    </div>
    <div class="cta-actions">
      <a class="btn btn-primary btn-lg" href="${APP_URL}">Open in Insidr</a>
      <a class="btn btn-ghost btn-lg" href="/">What is Insidr?</a>
    </div>
  </section>
</main>

<footer class="ft">
  <div class="wrap ft-bottom">
    <span>© 2026 Insidr. All rights reserved.</span>
    <span class="ft-links">
      <a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="mailto:support@insidr.tips">Contact</a>
    </span>
    <span style="display:inline-flex;align-items:center;gap:10px;">
      <span class="age">18+</span> Tips are opinions, not guarantees. Please bet responsibly.
    </span>
  </div>
</footer>

<script src="/t/assets/tipster.js" defer></script>
</body>
</html>
`;
}

/* -- not-found fallback ---------------------------------------------------- */

/**
 * GitHub Pages serves this for any unknown path. It matters here because a tipster
 * can share their link in the gap between activating and the next build: without a
 * fallback that visitor would hit a dead page, which for a link whose entire job is
 * a first impression is the worst possible outcome.
 *
 * It resolves the username against the API and shows the record inline. Crawlers
 * still get a 404 status and won't index it — correct, since the real page is about
 * to exist at the same URL.
 */
function renderNotFound() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Insidr</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.png">
<link rel="stylesheet" href="/t/assets/tipster.css">
<script>
  try {
    var s = localStorage.getItem('insidr-theme');
    if (s === 'light' || s === 'dark') document.documentElement.setAttribute('data-theme', s);
  } catch (e) {}
</script>
</head>
<body data-api="${esc(API_BASE)}">
<header class="nav">
  <div class="wrap nav-inner">
    <a class="brand" href="/" aria-label="Insidr home"><span class="logo-mark" role="img" aria-label="Insidr"></span></a>
    <div class="nav-actions"><a class="btn btn-primary" href="${APP_URL}">Open app</a></div>
  </div>
</header>
<main class="wrap">
  <section class="hero">
    <div id="state">
      <h1>Page not found</h1>
      <p class="headline-label">The link may be mistyped, or the page may have moved.</p>
      <p style="margin-top:22px"><a class="btn btn-primary btn-lg" href="/">Go to Insidr</a></p>
    </div>
  </section>
</main>
<script>
(function () {
  var m = location.pathname.match(/^\\/t\\/([A-Za-z0-9._-]{1,64})\\/?$/);
  if (!m) return;
  var username = m[1];
  var api = document.body.dataset.api;
  var state = document.getElementById('state');
  state.innerHTML = '<h1>Loading…</h1>';

  fetch(api + '/api/public/tipster/' + encodeURIComponent(username), { headers: { accept: 'application/json' } })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (d) {
      var all = d.allTime;
      var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
      var name = esc(d.displayName || d.username);
      var body = all.totalGames > 0
        ? '<span class="headline-value ' + (all.roi > 0 ? 'pos' : all.roi < 0 ? 'neg' : '') + '">' +
          (all.roi > 0 ? '+' : '') + all.roi.toFixed(1) + '%</span>' +
          '<span class="headline-label">return on investment across <b>' + all.totalGames +
          '</b> settled tips.</span>'
        : '<span class="headline-value">No settled tips yet</span>' +
          '<span class="headline-label">' + name + ' has joined Insidr but has no settled tips so far.</span>';

      state.innerHTML =
        '<h1>' + name + '</h1><p class="handle">@' + esc(d.username) + '</p>' +
        '<p class="headline">' + body + '</p>' +
        '<p style="margin-top:26px"><a class="btn btn-primary btn-lg" href="${APP_URL}">Open in Insidr</a></p>';
    })
    .catch(function () {
      state.innerHTML =
        '<h1>Page not found</h1><p class="headline-label">We couldn\\'t find a tipster at this address.</p>' +
        '<p style="margin-top:22px"><a class="btn btn-primary btn-lg" href="/">Go to Insidr</a></p>';
    });
})();
</script>
</body>
</html>
`;
}

/* -- sitemap --------------------------------------------------------------- */

function renderSitemap(usernames) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = (loc, changefreq, priority) =>
    `  <url>\n    <loc>${SITE_URL}${loc}</loc>\n    <lastmod>${today}</lastmod>\n` +
    `    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;

  const urls = [
    ...STATIC_URLS.map((u) => entry(u.loc, u.changefreq, u.priority)),
    // One indexable URL per tipster — the reason this generator exists at all.
    ...usernames.map((u) => entry(`/t/${u}/`, 'daily', '0.7')),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/* -- run ------------------------------------------------------------------- */

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function main() {
  console.log(`Reading tipsters from ${API_BASE}`);
  const list = await getJson(`${API_BASE}/api/public/tipsters`);

  const usernames = (list.tipsters || [])
    .map((t) => t.username)
    .filter((u) => {
      if (SAFE_USERNAME.test(u)) return true;
      console.warn(`  ! skipping unsafe username: ${JSON.stringify(u)}`);
      return false;
    });

  console.log(`${usernames.length} tipster(s) to generate`);

  const built = [];
  for (const username of usernames) {
    try {
      const profile = await getJson(`${API_BASE}/api/public/tipster/${encodeURIComponent(username)}`);
      const dir = join(ROOT, 't', username);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'index.html'), renderPage(profile), 'utf8');
      built.push(username);
      console.log(`  ✓ /t/${username}/`);
    } catch (err) {
      // One tipster failing must not abandon the rest — the pages already on
      // disk stay valid, and the next run picks this one up again.
      console.error(`  ✗ ${username}: ${err.message}`);
    }
    // Stay well inside the API's per-IP rate limit; a build is not a stampede.
    await new Promise((r) => setTimeout(r, 250));
  }

  // Remove pages for tipsters who are no longer live (deleted, banned, stopped),
  // so a stale profile can't keep being shared after it should have gone.
  const keep = new Set(built);
  const tDir = join(ROOT, 't');
  if (existsSync(tDir)) {
    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(tDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'assets') continue;
      if (!keep.has(entry.name)) {
        await rm(join(tDir, entry.name), { recursive: true, force: true });
        console.log(`  - removed /t/${entry.name}/ (no longer a live tipster)`);
      }
    }
  }

  await writeFile(join(ROOT, '404.html'), renderNotFound(), 'utf8');
  await writeFile(join(ROOT, 'sitemap.xml'), renderSitemap(built), 'utf8');
  console.log(`Wrote sitemap.xml with ${built.length + STATIC_URLS.length} URLs, and 404.html`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
