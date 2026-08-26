/* ---------------------------------------------------------------------------
   Tipster record pages: theme toggle + live figures.

   The page ships with the numbers from the last site build already rendered, so
   it is complete before this file runs — which is what crawlers index and what
   paints first. This script then asks the API for the current figures and swaps
   them in, so a person never reads a stale record.

   Everything here is best-effort. If the request fails, the baked numbers stay
   on screen and the page is still correct, just not current.
--------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* -- theme --------------------------------------------------------------- */

  var root = document.documentElement;
  var toggle = document.getElementById('themeToggle');

  if (toggle) {
    toggle.addEventListener('click', function () {
      var current = root.getAttribute('data-theme');
      if (!current) {
        current = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      var next = current === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('insidr-theme', next); } catch (e) {}
    });
  }

  /* -- formatting ---------------------------------------------------------- */
  /* Kept identical to the generator's helpers: the same figure must not render
     one way at build time and another way after the refresh. */

  function signed(n) { return (Number(n) > 0 ? '+' : '') + Number(n).toFixed(1) + '%'; }
  function odds(n)   { return Number(n).toFixed(2); }
  function sign(n)   { return Number(n) > 0 ? 'pos' : Number(n) < 0 ? 'neg' : ''; }

  function setField(name, value, cls) {
    var el = document.querySelector('[data-field="' + name + '"]');
    if (!el) return;
    el.textContent = value;
    if (cls !== undefined) {
      el.classList.remove('pos', 'neg', 'none');
      if (cls) el.classList.add(cls);
    }
  }

  /* -- live figures -------------------------------------------------------- */

  var username = document.body.dataset.username;
  var api = document.body.dataset.api;
  if (!username || !api) return;

  fetch(api + '/api/public/tipster/' + encodeURIComponent(username), {
    headers: { accept: 'application/json' }
  })
    .then(function (res) {
      if (!res.ok) throw new Error(res.status);
      return res.json();
    })
    .then(function (data) {
      var all = data.allTime;
      var recent = data.last30Days;
      var hasRecord = all.totalGames > 0;

      var heroRecord = document.getElementById('hero-record');
      var heroEmpty = document.getElementById('hero-empty');
      var record = document.getElementById('record');

      // A tipster whose first tip settled since the last build gets their record
      // revealed here rather than waiting for the next one.
      if (heroRecord) heroRecord.hidden = !hasRecord;
      if (heroEmpty) heroEmpty.hidden = hasRecord;
      if (record) record.hidden = !hasRecord;

      if (hasRecord) {
        setField('wins-hero', String(all.wins));
        setField('games-hero', String(all.totalGames));
        setField('roi-hero', signed(all.roi), sign(all.roi));

        setField('roi-all', signed(all.roi), sign(all.roi));
        setField('average-odds-all', odds(all.avgOdds));
        setField('settled-tips-all', String(all.totalGames));

        // An em dash rather than a zero: no tips in the window is an absence of
        // data, and printing 0.0% would read as a month of losing.
        if (recent.totalGames > 0) {
          setField('roi-30', signed(recent.roi), sign(recent.roi));
          setField('average-odds-30', odds(recent.avgOdds));
          setField('settled-tips-30', String(recent.totalGames));
        } else {
          setField('roi-30', '—', 'none');
          setField('average-odds-30', '—', 'none');
          setField('settled-tips-30', '—', 'none');
        }
      }

      var asof = document.getElementById('asof');
      var asofText = document.getElementById('asof-text');
      if (asof && asofText) {
        asof.classList.add('live');
        asofText.textContent = 'Live figures, updated just now';
      }
    })
    .catch(function () {
      // Deliberately silent. The baked figures are still on screen and still
      // true as of the last build; an error banner would be worse than useless.
    });
})();
