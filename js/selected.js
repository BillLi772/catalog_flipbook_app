/**
 * selected.js — the top of the Publications page: the page title and
 * "Selected publications", a slow row of large covers that drifts across the page.
 * The covers stand alone; the artist and title of one appear when it is pointed at.
 *
 * Which catalogues: first those by the artists on view at the gallery right now
 * (read from the Exhibitions page through /api/current, see functions/api/current.js),
 * then a few others picked at random, one per artist, different on each visit.
 * If the Exhibitions page cannot be read, the row is simply all random.
 *
 * The row moves on its own, slowly. It eases to a stop while the pointer is over
 * it or a cover has keyboard focus, and can be dragged or swiped sideways (a flick
 * coasts on a little). People who have asked their device for less motion get a
 * still row they can drag. Clicking a cover opens that catalogue in the reader.
 *
 * library.js builds it once (see _renderHero there):
 *
 *   Selected.render(containerEl, catalogs, options)  builds the section
 *   Selected.prettyTitle(text)                       "Off The Wall" -> "Off the Wall"
 */
const Selected = (() => {
  'use strict';

  const DEFAULTS = {
    size: 12,              // covers in the row
    perArtist: 3,          // at most this many catalogues from one artist on view
    speed: 26,             // how fast the row drifts, in pixels per second
    title: 'Publications',
    label: 'Selected publications',
    showsUrl: '/api/current',   // answers { shows: [{ artist, title }] }; '' to skip
    // "-rj" asks Google for a JPEG; left alone it sends a PNG several times the size
    coverUrl: (c, w, plain) => `https://lh3.googleusercontent.com/d/${encodeURIComponent(c.driveFileId)}=w${w}${plain ? '' : '-rj'}`,
    readPath: c => `/catalog/${encodeURIComponent(c.id)}`,
    navigate: null,        // App.navigate, so reading stays inside the app
    splitTitle: null,      // Library.splitTitle: raw title -> { artist, catalog }
    artistKey: c => c.title.split(' : ')[0].trim(),
  };

  const SHOWS_KEY = 'bdg-on-view-v1';       // remembered answer from /api/current
  const SHOWS_FRESH = 6 * 60 * 60 * 1000;   // ask again after six hours
  // Cover images are offered in three widths; the browser takes the one that suits the screen.
  // COVER_SIZES mirrors the cover width set in css/publications.css (--sp-w).
  const COVER_WIDTHS = [480, 720, 1040];
  const COVER_SIZES = '(min-width: 1703px) 518px, (max-width: 680px) 207px, 30.4vw';
  const SMALL_WORDS = new Set('a an and as at but by de des du en et for from in into la le of on or the to via with'.split(' '));

  let o = DEFAULTS;
  let root, viewport, track;
  let step = 0, period = 0, count = 0, gutter = 0;     // geometry of one set of covers
  let offset = 0, pace = 0, raf = 0, last = 0;         // where the row is, how fast it is going now, the animation frame
  let hover = false, byKeyboard = false, onScreen = true, holdUntil = 0, lastPress = 0;
  let drag = null, justDragged = false;
  let sizeWatch = null, viewWatch = null;

  // ── Helpers ────────────────────────────────────

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** "Danielle Mužina:" and "MUZINA Danielle" both become "danielle muzina" / "muzina danielle". */
  const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  /** A name whichever way round it is written: "McElwee Van" and "Van McElwee" give the same key. */
  const nameKey = s => norm(s).split(' ').sort().join(' ');

  /**
   * "Off The Wall" -> "Off the Wall". The catalogue sync capitalises every word of
   * a file name; this puts the small words back in lower case. The first and last
   * word, a word after a colon or dash, and ALL-CAPS words ("AND / OR") are left alone.
   */
  function prettyTitle(title) {
    const words = String(title).trim().split(/\s+/);
    return words.map((w, i) => {
      if (i === 0 || i === words.length - 1 || /[:\u2013\u2014-]$/.test(words[i - 1])) return w;
      return /^[A-Z][a-z]*$/.test(w) && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w;
    }).join(' ');
  }

  function parts(c) {
    let artist = '';
    let catalog = c.title;
    if (o.splitTitle) {
      ({ artist, catalog } = o.splitTitle(c.title));
    } else if (c.title.includes(' : ')) {
      const [a, ...rest] = c.title.split(' : ');
      artist = a.trim();
      catalog = rest.join(' : ').trim();
    }
    return { artist: artist || '', title: prettyTitle(catalog || c.title) };
  }

  // ── Which catalogues ───────────────────────────

  /** The shows on view now. A remembered answer is used for six hours, so most visits ask nothing. */
  function loadShows() {
    if (!o.showsUrl) return Promise.resolve([]);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SHOWS_KEY)); } catch (e) { /* no storage */ }
    if (saved && Array.isArray(saved.shows) && Date.now() - saved.t < SHOWS_FRESH) return Promise.resolve(saved.shows);
    const ask = fetch(o.showsUrl, { headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d || !Array.isArray(d.shows)) return null;
        try { localStorage.setItem(SHOWS_KEY, JSON.stringify({ t: Date.now(), shows: d.shows })); } catch (e) { /* fine */ }
        return d.shows;
      })
      .catch(() => null);
    const giveUp = new Promise(resolve => setTimeout(() => resolve(null), 1500));   // never hold the page up
    return Promise.race([ask, giveUp]).then(shows => shows || (saved && saved.shows) || []);
  }

  /** Catalogues by the artists on view first, then random others (one per artist) up to o.size. */
  function choose(all, shows) {
    const current = [];
    (shows || []).forEach(show => {
      const heading = String((show && show.artist) || '');
      const title = norm(show && show.title);
      // "Ann Smith" as it stands, and each name of a shared show: "Ann Smith & Bo Lee", "Ann Smith, Bo Lee"
      const names = [heading].concat(heading.split(/\s*(?:,|&|\+|\/|\band\b)\s*/i)).map(nameKey).filter(Boolean);
      new Set(names).forEach(want => {
        const mine = all.filter(c => nameKey(parts(c).artist) === want);
        // a catalogue named like the show itself comes first
        mine.sort((a, b) => (norm(parts(b).title) === title) - (norm(parts(a).title) === title));
        mine.slice(0, o.perArtist).forEach(c => { if (!current.includes(c)) current.push(c); });
      });
    });
    const taken = new Set(current.map(o.artistKey));
    const rest = all.filter(c => !taken.has(o.artistKey(c)));
    for (let i = rest.length - 1; i > 0; i--) {          // shuffle
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const others = [];
    const seen = new Set();
    for (const c of rest) {
      if (current.length + others.length >= o.size) break;
      const k = o.artistKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      others.push(c);
    }
    return current.concat(others).slice(0, Math.max(o.size, current.length));
  }

  // ── Markup ─────────────────────────────────────

  function itemHTML(c, copy) {
    const p = parts(c);
    // The caption under a cover is only shown while it is pointed at (and not at all on
    // touch screens), so the link carries its name itself.
    const name = p.artist ? `${p.artist}: ${p.title}` : p.title;
    const srcset = COVER_WIDTHS.map(w => `${o.coverUrl(c, w)} ${w}w`).join(', ');
    return `
      <li class="sp-item"${copy ? ' aria-hidden="true"' : ''}>
        <a class="sp-card" href="${esc(o.readPath(c))}" data-read draggable="false"${copy ? ' tabindex="-1"' : ` aria-label="${esc(name)}"`}>
          <span class="sp-cover">
            <span class="sp-ph" aria-hidden="true"><span>${esc(p.artist)}</span><b>${esc(p.title)}</b></span>
            <img alt="" draggable="false" decoding="async" src="${esc(o.coverUrl(c, 720))}" srcset="${esc(srcset)}" sizes="${COVER_SIZES}" data-plain="${esc(o.coverUrl(c, 720, true))}">
          </span>
          <span class="sp-caption" aria-hidden="true">
            <span class="sp-name">${esc(p.artist || p.title)}</span>
            ${p.artist ? `<span class="sp-sub">${esc(p.title)}</span>` : ''}
          </span>
        </a>
      </li>`;
  }

  function render(container, catalogs, options) {
    teardown();
    o = Object.assign({}, DEFAULTS, options || {});
    const all = (catalogs || []).filter(c => c && c.id && c.title);

    container.innerHTML = `
      <section class="sp" aria-labelledby="sp-title">
        <div class="sp-inner">
          <h1 class="sp-title" id="sp-title">${esc(o.title)}</h1>
          <h2 class="sp-label" id="sp-label">${esc(o.label)}</h2>
        </div>
        <div class="sp-viewport" role="group" aria-labelledby="sp-label">
          <ul class="sp-track"></ul>
        </div>
      </section>`;

    root = container.querySelector('.sp');
    viewport = root.querySelector('.sp-viewport');
    track = root.querySelector('.sp-track');

    root.addEventListener('click', onClick, true);
    const overRow = e => { if (e.pointerType === 'mouse') hover = true; };
    viewport.addEventListener('pointerenter', overRow);
    viewport.addEventListener('pointermove', overRow);
    viewport.addEventListener('pointerleave', () => { hover = false; });
    viewport.addEventListener('focusin', onFocus);
    viewport.addEventListener('focusout', () => { byKeyboard = false; });
    viewport.addEventListener('pointerdown', onDown);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('dragstart', e => e.preventDefault());
    // the row is moved with a transform only; undo any scrolling a browser does to reveal a focused cover
    viewport.addEventListener('scroll', () => { if (viewport.scrollLeft) viewport.scrollLeft = 0; });
    viewport.addEventListener('error', onImgError, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    loadShows().then(shows => {
      if (!root || !root.isConnected) return;
      fill(choose(all, shows));
    });
    return api;
  }

  /** Put the chosen covers in the row, measure it, and start it moving. */
  function fill(list) {
    if (!list.length) { viewport.hidden = true; root.querySelector('#sp-label').hidden = true; return; }
    count = list.length;
    track.dataset.ids = list.map(c => c.id).join(' ');
    track.innerHTML = list.map(c => itemHTML(c, false)).join('');
    track._list = list;
    offset = 0;
    // library.js renders while the page is still hidden, so measure whenever the row gets a size
    if (window.ResizeObserver) { sizeWatch = new ResizeObserver(measure); sizeWatch.observe(viewport); }
    else window.addEventListener('resize', measure);
    if (window.IntersectionObserver) {
      viewWatch = new IntersectionObserver(es => { onScreen = es[0].isIntersecting; run(); });
      viewWatch.observe(viewport);
    }
    measure();
    root.classList.add('sp--ready');
    run();
  }

  /**
   * One "set" is the chosen covers once. The row shows a copy before the real set
   * and as many after it as the screen needs, so the loop has no seam and the
   * left edge is never empty. Only the real set is reachable by keyboard.
   */
  function measure() {
    if (!track || !viewport.clientWidth) return;   // not laid out yet
    const first = track.querySelector('.sp-item:not([aria-hidden])');
    if (!first) return;
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    const sets = 2 + Math.ceil(viewport.clientWidth / ((first.getBoundingClientRect().width + gap) * count));
    const title = root.querySelector('.sp-title');
    gutter = Math.max(0, title.getBoundingClientRect().left - viewport.getBoundingClientRect().left);
    if (track.dataset.sets !== String(sets)) {
      const list = track._list;
      const real = list.map(c => itemHTML(c, false)).join('');
      const copy = list.map(c => itemHTML(c, true)).join('');
      const keep = track.querySelector('.sp-item:not([aria-hidden]) a:focus');
      track.innerHTML = copy + real + new Array(sets - 2).fill(copy).join('');
      track.dataset.sets = String(sets);
      if (keep) { const again = track.querySelector(`.sp-item:not([aria-hidden]) a[href="${keep.getAttribute('href')}"]`); if (again) again.focus({ preventScroll: true }); }
    }
    // the exact distance from one set to the next, to the fraction of a pixel, so the loop has no seam
    const newPeriod = track.querySelector('.sp-item:not([aria-hidden])').getBoundingClientRect().left
      - track.firstElementChild.getBoundingClientRect().left;
    if (!(newPeriod > 0)) return;
    if (period && newPeriod !== period) offset = offset / period * newPeriod;   // keep our place when the size changes
    period = newPeriod;
    step = period / count;
    place();
  }

  function place() {
    if (!period) return;
    offset = ((offset % period) + period) % period;
    track.style.transform = `translate3d(${(gutter - period - offset).toFixed(2)}px,0,0)`;
  }

  // ── Movement ───────────────────────────────────

  /** A cover has the keyboard's focus (not merely the focus a click leaves behind). */
  const keyboardOnRow = () => byKeyboard && viewport.contains(document.activeElement);
  /** Is the row free to drift by itself? */
  const free = () => onScreen && !hover && !drag && !reduced() && !keyboardOnRow() && performance.now() > holdUntil;

  function run() {
    if (raf || !root) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function frame(t) {
    raf = 0;
    if (!root || !root.isConnected) return;
    if (!onScreen || root.offsetParent === null) { hover = false; pace = 0; return; }   // off screen or hidden: rest; run() starts it again
    const dt = last ? Math.min(64, t - last) : 0;
    last = t;
    if (period && !drag) {
      // ease towards the drifting speed, or to a stop, so the row never jerks; a flick coasts a little longer
      const target = free() ? o.speed : 0;
      const ease = Math.abs(pace) > o.speed * 1.5 ? 420 : 260;
      pace += (target - pace) * (1 - Math.exp(-dt / ease));
      if (Math.abs(pace - target) < 0.3) pace = target;
      if (pace) { offset += pace * dt / 1000; place(); }
    }
    if (!pace && !drag && reduced()) return;      // nothing will move by itself: rest until the next drag
    raf = requestAnimationFrame(frame);
  }

  // ── Events ─────────────────────────────────────

  function onFocus(e) {
    const item = e.target.closest && e.target.closest('.sp-item');
    if (!item) return;
    // Pressing a cover with the mouse or a finger focuses its link as well. Only focus that
    // arrives from the keyboard stops the row and brings the cover into view.
    byKeyboard = performance.now() - lastPress > 700;
    try { byKeyboard = e.target.matches(':focus-visible'); } catch (err) { /* older browsers: go by the time since the last press */ }
    if (!byKeyboard) return;
    pace = 0;
    const index = Array.prototype.indexOf.call(track.querySelectorAll('.sp-item:not([aria-hidden])'), item);
    if (index < 0 || !period) return;
    const x = index * step;                                   // where it sits within the real set
    const left = gutter - offset + x;
    if (left < 8 || left + item.getBoundingClientRect().width > viewport.clientWidth - 8) { offset = x; place(); }
  }

  function onDown(e) {
    lastPress = performance.now();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from: offset, moved: false, lastX: e.clientX, lastT: lastPress, v: 0 };
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(e.clientY - drag.y)) return;   // a tap, or a vertical scroll
      drag.moved = true;
      pace = 0;
      root.classList.add('sp--dragging');
    }
    const now = performance.now();
    if (now > drag.lastT) {                                   // how fast the hand is going, in pixels a second
      drag.v = 0.6 * ((drag.lastX - e.clientX) / (now - drag.lastT) * 1000) + 0.4 * drag.v;
      drag.lastX = e.clientX;
      drag.lastT = now;
    }
    offset = drag.from - dx;
    place();
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    lastPress = performance.now();
    if (drag.moved) {
      justDragged = true;                         // the click that follows a drag must not open a catalogue
      setTimeout(() => { justDragged = false; }, 0);
      // let go while still moving and the row coasts on for a moment, then rests before drifting again
      const flick = e.type === 'pointerup' && !reduced() && lastPress - drag.lastT < 90 ? drag.v : 0;
      pace = Math.max(-2000, Math.min(2000, flick));
      holdUntil = lastPress + 1800;
      root.classList.remove('sp--dragging');
    }
    drag = null;
    run();
  }

  function onWheel(e) {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;     // vertical: let the page scroll
    e.preventDefault();
    pace = 0;
    offset += e.deltaX;
    holdUntil = performance.now() + 1500;
    place();
    run();
  }

  function onClick(e) {
    const read = e.target.closest && e.target.closest('a[data-read]');
    if (!read) return;
    if (justDragged) { e.preventDefault(); e.stopPropagation(); return; }
    // app.js also listens on document and turns every internal link click into a
    // navigation. Stop the click here so the catalogue opens once, not twice, and
    // so Cmd/Ctrl-click can still open it in a new tab.
    const plain = e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
    if (!plain) { e.stopPropagation(); return; }
    if (!o.navigate || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    o.navigate(read.getAttribute('href'));
  }

  /**
   * A cover that will not load is asked for once more the plain way (in case Google ever stops
   * honouring the JPEG option). If that fails too it leaves its plain titled block, not a broken image.
   */
  function onImgError(e) {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    if (img.dataset.plain && !img.dataset.retried) {
      img.dataset.retried = '1';
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.src = img.dataset.plain;
      return;
    }
    const cover = img.closest('.sp-cover');
    if (cover) cover.classList.add('no-img');
    img.remove();
  }

  function teardown() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('resize', measure);
    if (sizeWatch) { sizeWatch.disconnect(); sizeWatch = null; }
    if (viewWatch) { viewWatch.disconnect(); viewWatch = null; }
    if (raf) cancelAnimationFrame(raf);
    raf = 0; period = 0; offset = 0; pace = 0; drag = null; hover = false; byKeyboard = false; onScreen = true;
    root = null;
  }

  const api = { render, prettyTitle, restart: run };
  return api;
})();
