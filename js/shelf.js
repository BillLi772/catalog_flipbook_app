/**
 * shelf.js — "On the shelf", the top section of the Publications page.
 *
 * Catalogues stand spine-out on a shelf (the idea comes from Time & Space's
 * Book Corner). Click a spine, or focus it and press Enter, and the book slides
 * out to show its cover, details and a Read button. The spine, the × or Esc
 * puts it back. ← / → / Home / End move along the shelf.
 *
 * Spines are drawn in CSS, so up front the shelf only fetches tiny 64px cover
 * thumbnails to colour them (cached in the browser afterwards; set "color" in
 * catalogs.json to choose a colour yourself). A full cover is fetched only when
 * someone hovers, focuses or opens that book.
 *
 * Which books: the catalogue marked "featured": true goes first (the weekly sync,
 * scripts/build-catalog.js, sets that on the first file Google Drive lists), then
 * one catalogue per artist. catalogs.json has no dates, so that selection moves
 * along by a few books each day and the whole archive takes turns; if dates are
 * ever added it becomes newest first. The first book starts pulled out, so the
 * page opens on a cover.
 *
 * library.js builds it once (see _renderHero there) and hides its container
 * while a search or an artist filter is active:
 *
 *   Shelf.render(containerEl, catalogs, options)  builds the section
 *   Shelf.prettyTitle(text)                       "Off The Wall" -> "Off the Wall"
 */
const Shelf = (() => {
  'use strict';

  const DEFAULTS = {
    size: 24,              // books on the shelf
    openFirst: true,       // start with the first book pulled out
    onePerArtist: true,    // a sampler of the roster, not five books by one artist
    rotateDaily: true,     // used only while no catalogue has a date
    title: 'Publications',
    intro: 'Exhibition catalogues from Bruno David Gallery, St. Louis. Take one off the shelf to read it online, free.',
    imprint: 'BDG',        // small mark at the foot of every spine
    buyUrl: undefined,     // undefined = reuse the header's "Purchase Catalogs" link; null = no button
    coverUrl: (c, w) => `https://lh3.googleusercontent.com/d/${encodeURIComponent(c.driveFileId)}=w${w}`,
    readPath: c => `/catalog/${encodeURIComponent(c.id)}`,
    navigate: null,        // App.navigate, so reading stays inside the app
    splitTitle: null,      // Library.splitTitle: raw title -> { artist, catalog }
    artistKey: c => c.title.split(' : ')[0].trim(), // value the #artist-filter options use
    isGroup: () => false,  // true for group shows, so they aren't counted as artists
    onArtist: null,        // (key) => void for "All n catalogues by …"; default drives #artist-filter
  };

  const COLOR_KEY = 'bdg-shelf-colors-v1';
  const SMALL_WORDS = new Set('a an and as at but by de des du en et for from in into la le of on or the to via with'.split(' '));

  let o = DEFAULTS;
  let root, wrap, shelf, caption, prevBtn, nextBtn;
  let books = [], byId = new Map(), counts = new Map();
  let current = null, raf = 0, colors = {}, buyUrl = null, statusIdle = '', sizeWatch = null;

  // ── Helpers ────────────────────────────────────

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const pad = n => String(n).padStart(2, '0');
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cssEsc = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

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

  const year = c => (String(c.date || '').match(/\d{4}/) || [''])[0];

  /** Spine thickness in px: from the page count when known, otherwise a stable 26–44. */
  function thickness(c) {
    if (c.pageCount > 0) return Math.round(Math.min(60, Math.max(22, 14 + c.pageCount * 0.3)));
    return 26 + (hash(c.id) % 19);
  }

  function pick(list, n) {
    const featured = list.filter(c => c.featured === true);
    let rest = list.filter(c => c.featured !== true);
    const dated = rest.some(c => c.date);
    if (dated) rest.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    if (o.onePerArtist) {
      const seen = new Set(featured.map(o.artistKey));
      rest = rest.filter(c => {
        const k = o.artistKey(c);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    if (!dated && o.rotateDaily && rest.length) {
      const start = (Math.floor(Date.now() / 864e5) * 7) % rest.length;
      rest = rest.slice(start).concat(rest.slice(0, start));
    }
    return featured.concat(rest).slice(0, n);
  }

  // ── Spine colours ──────────────────────────────

  function readColors() {
    try { return JSON.parse(localStorage.getItem(COLOR_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveColors() {
    try { localStorage.setItem(COLOR_KEY, JSON.stringify(colors)); } catch (e) { /* storage blocked: colours are just recomputed */ }
  }

  /** Black or white type, whichever reads better on the spine. */
  function inkFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.2 ? '#111111' : '#ffffff';
  }

  /**
   * The cover's most telling colour: its strongest hue if that covers at least 6%
   * of the cover, otherwise the average of its greys (most covers are installation
   * shots on white walls), ignoring paper-white margins.
   */
  function coverColor(img) {
    const w = 48;
    const h = Math.max(1, Math.round(w * img.naturalHeight / img.naturalWidth));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data;
    const bins = Array.from({ length: 12 }, () => ({ n: 0, s: 0, r: 0, g: 0, b: 0 }));
    const grey = { n: 0, r: 0, g: 0, b: 0 };
    let total = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 510;
      const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
      total++;
      if (s > 0.28 && l > 0.12 && l < 0.88) {
        const c = max - min;
        const hue = max === r ? ((g - b) / c + 6) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
        const bin = bins[Math.floor(hue * 2) % 12];
        bin.n++; bin.s += s; bin.r += r; bin.g += g; bin.b += b;
      } else if (l > 0.05 && l < 0.95) {
        grey.n++; grey.r += r; grey.g += g; grey.b += b;
      }
    }
    const best = bins.reduce((a, b) => (b.s > a.s ? b : a));
    const src = best.n / total >= 0.06 ? best : grey.n / total >= 0.04 ? grey : null;
    if (!src) return '#ecebe7';
    const hx = v => Math.round(v / src.n).toString(16).padStart(2, '0');
    return '#' + hx(src.r) + hx(src.g) + hx(src.b);
  }

  function paint(id, hex) {
    const el = root && root.querySelector(`.bk-book[data-id="${cssEsc(id)}"]`);
    if (!el || !/^#[0-9a-f]{6}$/i.test(hex)) return;
    el.style.setProperty('--spine', hex);
    el.style.setProperty('--ink', inkFor(hex));
  }

  function paintAll(list) {
    const todo = [];
    list.forEach(c => {
      const hex = c.color || colors[c.id];
      if (hex) paint(c.id, hex);
      else if (c.driveFileId) todo.push(c);
    });
    let i = 0;
    let running = 0;
    const next = () => {
      const c = todo[i++];
      if (!c) { if (--running === 0) saveColors(); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous'; // Google's image server allows it, so the canvas stays readable
      img.onload = () => {
        try { colors[c.id] = coverColor(img); paint(c.id, colors[c.id]); } catch (e) { /* keep the neutral spine */ }
        next();
      };
      img.onerror = next;
      img.src = o.coverUrl(c, 64);
    };
    for (; running < Math.min(4, todo.length); ) { running++; next(); }
  }

  // ── Markup ─────────────────────────────────────

  function infoHTML(c, p, i, n) {
    const key = o.artistKey(c);
    const more = counts.get(key) || 0;
    // Year and page count when catalogs.json has them; until then, one plain line
    const rows = [
      year(c) && ['Year', year(c)],
      c.pageCount > 0 && ['Pages', c.pageCount],
    ].filter(Boolean);
    if (!rows.length) rows.push(['Read online', 'Free']);
    return `
      <p class="bk-pos">${pad(i + 1)} / ${pad(n)}</p>
      ${p.artist ? `<p class="bk-kicker">${esc(p.artist)}</p>` : ''}
      <h3 class="bk-name">${esc(p.title)}</h3>
      <dl class="bk-meta">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      <div class="bk-actions">
        <a class="bk-read" href="${esc(o.readPath(c))}" data-read>Read catalogue <span aria-hidden="true">&rarr;</span></a>
      </div>
      <div class="bk-links">
        ${buyUrl ? `<a class="bk-buy" href="${esc(buyUrl)}" target="_blank" rel="noopener">Print editions <span aria-hidden="true">&nearr;</span></a>` : ''}
        ${more > 1 && !o.isGroup(key) ? `<button type="button" class="bk-more" data-key="${esc(key)}">All ${more} catalogues by ${esc(p.artist)}</button>` : ''}
      </div>
      <button type="button" class="bk-close" aria-label="Put ${esc(p.title)} back on the shelf"><span aria-hidden="true">&times;</span></button>`;
  }

  function bookHTML(c, i, n) {
    const p = parts(c);
    const label = [p.artist, p.title].filter(Boolean).join(', ');
    const hex = c.color || colors[c.id];
    const style = `--w:${thickness(c)}px` + (hex ? `;--spine:${hex};--ink:${inkFor(hex)}` : '');
    return `
      <li class="bk-book" data-id="${esc(c.id)}" style="${esc(style)}">
        <button type="button" class="bk-spine" tabindex="${i === 0 ? 0 : -1}" aria-expanded="false"
                aria-controls="bk-open-${i}" aria-label="${esc(label)}">
          <span class="bk-spine-label" aria-hidden="true">
            ${p.artist ? `<span class="bk-spine-artist">${esc(p.artist)}</span>` : ''}
            <span class="bk-spine-title">${esc(p.title)}</span>
          </span>
          <span class="bk-spine-mark" aria-hidden="true">${esc(o.imprint)}</span>
        </button>
        <div class="bk-open" id="bk-open-${i}" role="group" aria-label="${esc(label)}" inert>
          <div class="bk-open-inner">
            <a class="bk-cover" href="${esc(o.readPath(c))}" data-read tabindex="-1" aria-hidden="true">
              <span class="bk-cover-ph"><span>${esc(p.artist)}</span><b>${esc(p.title)}</b></span>
              <img alt="" decoding="async">
            </a>
            <div class="bk-info">${infoHTML(c, p, i, n)}</div>
          </div>
        </div>
      </li>`;
  }

  // ── Render ─────────────────────────────────────

  function render(container, catalogs, options) {
    teardown();
    o = Object.assign({}, DEFAULTS, options || {});
    const headerBuy = document.querySelector('.nav-link--purchase');
    buyUrl = o.buyUrl !== undefined ? o.buyUrl : (headerBuy ? headerBuy.href : null);
    colors = readColors();

    const all = (catalogs || []).filter(c => c && c.id && c.title);
    byId = new Map(all.map(c => [c.id, c]));
    counts = new Map();
    all.forEach(c => { const k = o.artistKey(c); counts.set(k, (counts.get(k) || 0) + 1); });
    const artists = [...counts.keys()].filter(k => !o.isGroup(k)).length;
    const picked = pick(all, o.size);
    statusIdle = `On the shelf <span class="bk-num">(${picked.length})</span>`;

    container.innerHTML = `
      <section class="bk" aria-labelledby="bk-title">
        <header class="bk-head">
          <h1 class="bk-title" id="bk-title">${esc(o.title)}</h1>
          <p class="bk-count">${all.length} catalogues <span aria-hidden="true">&middot;</span> ${artists} artists</p>
        </header>
        <p class="bk-intro">${esc(o.intro)}</p>
        <div class="bk-shelf-wrap">
          <ol class="bk-shelf" aria-label="On the shelf: ${picked.length} catalogues">
            ${picked.map((c, i) => bookHTML(c, i, picked.length)).join('')}
          </ol>
        </div>
        <div class="bk-foot">
          <p class="bk-status">${statusIdle}</p>
          <div class="bk-arrows">
            <button type="button" class="bk-prev" aria-label="Scroll the shelf left">&larr;</button>
            <button type="button" class="bk-next" aria-label="Scroll the shelf right">&rarr;</button>
          </div>
        </div>
        <div class="bk-caption" hidden></div>
        <div class="bk-list-head">
          <h2 class="bk-list-title">All publications <span class="bk-num">(${all.length})</span></h2>
          <p class="bk-list-note">A&ndash;Z by artist</p>
        </div>
      </section>`;

    root = container.querySelector('.bk');
    wrap = root.querySelector('.bk-shelf-wrap');
    shelf = root.querySelector('.bk-shelf');
    caption = root.querySelector('.bk-caption');
    prevBtn = root.querySelector('.bk-prev');
    nextBtn = root.querySelector('.bk-next');
    books = [...shelf.children];

    root.addEventListener('click', onClick);
    shelf.addEventListener('keydown', onKey);
    shelf.addEventListener('scroll', onScroll, { passive: true });
    shelf.addEventListener('pointerover', onPrefetch);
    shelf.addEventListener('focusin', onPrefetch);
    shelf.addEventListener('transitionend', onTransitionEnd);
    document.addEventListener('keydown', onEsc);
    // library.js renders while the page is still hidden, so re-measure whenever the shelf gets a size
    if (window.ResizeObserver) { sizeWatch = new ResizeObserver(onScroll); sizeWatch.observe(shelf); }
    else window.addEventListener('resize', onScroll);

    paintAll(picked);
    if (o.openFirst && books.length) open(books[0], { scroll: false, eager: true });
    updateArrows();
    return api;
  }

  function teardown() {
    document.removeEventListener('keydown', onEsc);
    window.removeEventListener('resize', onScroll);
    if (sizeWatch) { sizeWatch.disconnect(); sizeWatch = null; }
    current = null;
  }

  // ── Opening and closing ────────────────────────

  function loadCover(book, eager) {
    const img = book.querySelector('.bk-cover img');
    if (!img || img.dataset.state) return;
    const c = byId.get(book.dataset.id);
    if (!c || !c.driveFileId) { img.dataset.state = 'none'; return; }
    img.dataset.state = 'loading';
    // Measured cover width, or (while the page is still hidden) the same sum the CSS does
    const box = book.querySelector('.bk-cover').offsetWidth
      || Math.round(Math.min(380, Math.max(window.innerWidth < 640 ? 230 : 300, window.innerWidth * 0.29)) * 1.294);
    const need = box * Math.min(2, window.devicePixelRatio || 1);
    const w = [480, 800, 1200, 1600].find(x => x >= need) || 1600;
    if (eager) img.setAttribute('fetchpriority', 'high');
    img.onload = () => { img.dataset.state = 'loaded'; img.classList.add('is-loaded'); };
    img.onerror = () => { img.dataset.state = 'error'; img.remove(); }; // the typographic cover underneath stays
    img.src = o.coverUrl(c, w);
  }

  function open(book, opts) {
    const { scroll = true, eager = false } = opts || {};
    if (!book || current === book) return;
    if (current) close(false);
    current = book;
    loadCover(book, eager);
    book.classList.add('is-open');
    const spine = book.querySelector('.bk-spine');
    spine.setAttribute('aria-expanded', 'true');
    const panel = book.querySelector('.bk-open');
    panel.inert = false;
    panel.removeAttribute('inert');
    roving(spine);
    caption.innerHTML = book.querySelector('.bk-info').innerHTML; // phones show the details under the shelf
    caption.hidden = false;
    book.dataset.reveal = scroll ? '1' : '';
    if (scroll) reveal(book, false);
  }

  function close(focus) {
    const book = current;
    if (!book) return;
    current = null;
    book.classList.remove('is-open');
    const spine = book.querySelector('.bk-spine');
    spine.setAttribute('aria-expanded', 'false');
    const panel = book.querySelector('.bk-open');
    panel.inert = true;
    panel.setAttribute('inert', '');
    caption.hidden = true;
    caption.innerHTML = '';
    if (focus) spine.focus({ preventScroll: true });
  }

  /** Scroll the shelf so the pulled-out book is in view. Runs as it opens and again when it settles. */
  function reveal(book, settled) {
    const full = book.querySelector('.bk-spine').offsetWidth + book.querySelector('.bk-open-inner').offsetWidth;
    const left = book.offsetLeft;
    const view = shelf.clientWidth;
    const x = shelf.scrollLeft;
    let to = x;
    if (left < x + 8) to = left - 8;
    else if (left + full > x + view - 8) to = Math.min(left - 8, left + full - view + 8);
    const behavior = reduced() ? 'auto' : 'smooth';
    if (Math.abs(to - x) > 1) shelf.scrollTo({ left: Math.max(0, to), behavior });
    if (settled) {
      const r = shelf.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) wrap.scrollIntoView({ block: 'nearest', behavior });
    }
  }

  function onTransitionEnd(e) {
    if (e.propertyName !== 'width' || !e.target.classList.contains('bk-book')) return;
    updateArrows();
    if (e.target === current && current.dataset.reveal) {
      current.dataset.reveal = '';
      reveal(current, true);
    }
  }

  function roving(spine) {
    books.forEach(b => { b.firstElementChild.tabIndex = -1; });
    spine.tabIndex = 0;
  }

  // ── Events ─────────────────────────────────────

  function onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const read = t.closest('a[data-read]');
    if (read) {
      // app.js also listens on document and turns every internal link click into a
      // navigation. Stop the click here so the catalogue opens once, not twice, and
      // so Cmd/Ctrl-click can still open it in a new tab.
      const plain = e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
      if (!plain) { e.stopPropagation(); return; }
      if (!o.navigate || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      o.navigate(read.getAttribute('href'));
      return;
    }
    if (t.closest('.bk-close')) { close(true); return; }
    const more = t.closest('.bk-more');
    if (more) { showArtist(more.dataset.key); return; }
    const spine = t.closest('.bk-spine');
    if (spine) {
      const book = spine.closest('.bk-book');
      if (book === current) close(true); else open(book);
      return;
    }
    if (t.closest('.bk-prev')) slide(-1);
    else if (t.closest('.bk-next')) slide(1);
  }

  function onKey(e) {
    const spine = e.target.closest && e.target.closest('.bk-spine');
    if (!spine) return;
    const spines = books.map(b => b.firstElementChild);
    const i = spines.indexOf(spine);
    let j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: spines.length - 1 }[e.key];
    if (j === undefined) return;
    e.preventDefault();
    j = Math.max(0, Math.min(spines.length - 1, j));
    roving(spines[j]);
    spines[j].focus();
  }

  function onEsc(e) {
    if (e.key !== 'Escape' || !current || !root || root.offsetParent === null) return;
    const inside = root.contains(document.activeElement);
    if (!inside && document.activeElement !== document.body) return; // e.g. typing in search
    close(true);
  }

  function onPrefetch(e) {
    const book = e.target.closest && e.target.closest('.bk-book');
    if (book) loadCover(book, false);
  }

  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; updateArrows(); });
  }

  function updateArrows() {
    if (!shelf) return;
    const max = shelf.scrollWidth - shelf.clientWidth;
    const x = shelf.scrollLeft;
    root.classList.toggle('bk--overflow', max > 2);
    prevBtn.disabled = x <= 2;
    nextBtn.disabled = x >= max - 2;
    wrap.classList.toggle('is-left', x > 2);
    wrap.classList.toggle('is-right', x < max - 2);
  }

  function slide(dir) {
    shelf.scrollBy({ left: dir * Math.max(240, shelf.clientWidth * 0.8), behavior: reduced() ? 'auto' : 'smooth' });
  }

  function showArtist(key) {
    close(false);
    if (o.onArtist) { o.onArtist(key); return; }
    const sel = document.getElementById('artist-filter');
    if (!sel) return;
    sel.value = key;
    if (sel.value !== key) return; // no such option
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
  }

  function setHidden(hidden) {
    if (!root) return;
    if (hidden) close(false);
    root.hidden = Boolean(hidden);
  }

  const api = { render, setHidden, close: () => close(false), prettyTitle };
  return api;
})();
