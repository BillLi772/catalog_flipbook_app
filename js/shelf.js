/**
 * shelf.js — the bookshelf at the top of the Publications page.
 *
 * Each catalogue stands on the shelf as a narrow strip cropped from its own
 * cover. Click a strip (or focus it and press Enter) and it widens into the
 * whole cover, with the artist, the title and a Read button beside it. The open
 * cover is itself a link to the reader. The ×, Esc, or opening another book puts
 * it back. ← / → / Home / End move along the shelf, and the name of the strip
 * under the pointer shows just below it.
 *
 * Which part of a cover a strip shows is worked out from a 64px thumbnail: the
 * most colourful, most detailed band, so a spine shows the artwork rather than
 * a blank gallery wall. The result is remembered in the browser. A cover that
 * will not load leaves a plain spine with the artist and title on it.
 *
 * Which books: the catalogue marked "featured": true goes first (the weekly sync,
 * scripts/build-catalog.js, sets that on the first file Google Drive lists), then
 * one catalogue per artist. catalogs.json has no dates, so that selection moves
 * along by a few books each day and the whole archive takes turns; if dates are
 * ever added it becomes newest first. The first book starts open, so the page
 * opens on a cover.
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
    openFirst: true,       // start with the first book open
    onePerArtist: true,    // a sampler of the roster, not five books by one artist
    rotateDaily: true,     // used only while no catalogue has a date
    title: 'Publications',
    intro: '',             // optional sentence under the title
    coverUrl: (c, w) => `https://lh3.googleusercontent.com/d/${encodeURIComponent(c.driveFileId)}=w${w}`,
    readPath: c => `/catalog/${encodeURIComponent(c.id)}`,
    navigate: null,        // App.navigate, so reading stays inside the app
    splitTitle: null,      // Library.splitTitle: raw title -> { artist, catalog }
    artistKey: c => c.title.split(' : ')[0].trim(), // value the #artist-filter options use
    isGroup: () => false,  // true for group shows: their "artist" is not a link
    onArtist: null,        // (key) => void when an artist's name is clicked; default drives #artist-filter
  };

  const CACHE_KEY = 'bdg-shelf-v2';   // { catalogue id: [colour, crop] }
  const SMALL_WORDS = new Set('a an and as at but by de des du en et for from in into la le of on or the to via with'.split(' '));

  let o = DEFAULTS;
  let root, wrap, shelf, foot, label, arrows, caption, prevBtn, nextBtn;
  let books = [], byId = new Map(), counts = new Map();
  let current = null, raf = 0, cache = {}, sizeWatch = null, idleTimer = 0;

  // ── Helpers ────────────────────────────────────

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cssEsc = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
  const bookEl = id => root && root.querySelector(`.bk-book[data-id="${cssEsc(id)}"]`);
  const spineOf = book => book.querySelector('.bk-spine');
  const coverOf = book => book.querySelector('.bk-cover');

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

  /** Strip width in px: from the page count when known, otherwise a stable 30–50. */
  function thickness(c) {
    if (c.pageCount > 0) return Math.round(Math.min(64, Math.max(28, 18 + c.pageCount * 0.3)));
    return 30 + (hash(c.id) % 21);
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

  // ── What each strip shows ──────────────────────

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* storage blocked: worked out again next visit */ }
  }

  /** Black or white type, whichever reads better on a colour. */
  function inkFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.2 ? '#111111' : '#ffffff';
  }

  /**
   * Reads a small thumbnail of a cover and returns [colour, crop].
   * colour: its strongest hue, or the average grey of an installation shot; it
   *         fills the strip until the cover arrives.
   * crop:   where along the cover (0 = left edge, 1 = right edge) the liveliest
   *         vertical band sits, judged by colour and contrast.
   */
  function study(img, frac) {
    const w = 64;
    const h = Math.max(1, Math.round(w * img.naturalHeight / img.naturalWidth));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data;

    const bins = Array.from({ length: 12 }, () => ({ n: 0, s: 0, r: 0, g: 0, b: 0 }));
    const grey = { n: 0, r: 0, g: 0, b: 0 };
    const interest = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let chroma = 0, sum = 0, sum2 = 0;
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 510;
        const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
        chroma += (max - min) / 255;
        sum += l; sum2 += l * l;
        if (s > 0.28 && l > 0.12 && l < 0.88) {
          const c = max - min;
          const hue = max === r ? ((g - b) / c + 6) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
          const bin = bins[Math.floor(hue * 2) % 12];
          bin.n++; bin.s += s; bin.r += r; bin.g += g; bin.b += b;
        } else if (l > 0.05 && l < 0.95) {
          grey.n++; grey.r += r; grey.g += g; grey.b += b;
        }
      }
      const mean = sum / h;
      interest[x] = chroma / h + 0.5 * Math.sqrt(Math.max(0, sum2 / h - mean * mean));
    }

    const total = w * h;
    const best = bins.reduce((a, b) => (b.s > a.s ? b : a));
    const src = best.n / total >= 0.06 ? best : grey.n / total >= 0.04 ? grey : null;
    const hx = v => Math.round(v / src.n).toString(16).padStart(2, '0');
    const hex = src ? '#' + hx(src.r) + hx(src.g) + hx(src.b) : '#ecebe7';

    const win = Math.max(3, Math.round(w * frac));   // the strip's width, in thumbnail pixels
    let top = -Infinity, at = (w - win) / 2;
    for (let x = 1; x + win <= w - 1; x++) {
      let s = 0;
      for (let k = 0; k < win; k++) s += interest[x + k];
      s = s / win - 0.05 * Math.abs((x + win / 2) / w - 0.5);   // on an even cover, stay near the middle
      if (s > top) { top = s; at = x; }
    }
    return [hex, +(at / (w - win)).toFixed(3)];
  }

  function apply(id) {
    const el = bookEl(id);
    const saved = cache[id];
    if (!el || !saved) return;
    const c = byId.get(id);
    const hex = (c && c.color) || saved[0];
    if (/^#[0-9a-f]{6}$/i.test(hex)) {
      el.style.setProperty('--spine', hex);
      el.style.setProperty('--ink', inkFor(hex));
    }
    el.style.setProperty('--f', saved[1]);
  }

  const ready = id => { const el = bookEl(id); if (el) el.setAttribute('data-ready', ''); };

  /** Work out colour and crop for the books not seen before, four at a time. */
  function studyAll(list) {
    const todo = list.filter(c => !cache[c.id] && c.driveFileId);
    list.forEach(c => { if (!cache[c.id] && !c.driveFileId) ready(c.id); });
    let i = 0;
    let running = 0;
    const next = () => {
      const c = todo[i++];
      if (!c) { if (--running === 0) saveCache(); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';   // Google's image server allows it, so the canvas stays readable
      img.onload = () => {
        try { cache[c.id] = study(img, thickness(c) / 440); apply(c.id); } catch (e) { /* keep the centre crop */ }
        ready(c.id);
        next();
      };
      img.onerror = () => { ready(c.id); next(); };
      img.src = o.coverUrl(c, 64);
    };
    for (; running < Math.min(4, todo.length); ) { running++; next(); }
    // never hold a cover back for long waiting on its thumbnail
    setTimeout(() => todo.forEach(c => ready(c.id)), 1800);
  }

  // ── Markup ─────────────────────────────────────

  function infoHTML(c, p) {
    const key = o.artistKey(c);
    const more = counts.get(key) || 0;
    const meta = [year(c), c.pageCount > 0 ? `${c.pageCount} pages` : ''].filter(Boolean).join(' \u00b7 ');
    const artist = !p.artist ? ''
      : more > 1 && !o.isGroup(key)
        ? `<button type="button" class="bk-kicker bk-more" data-key="${esc(key)}" title="All ${more} catalogues by ${esc(p.artist)}"
                   aria-label="${esc(p.artist)}: show all ${more} catalogues">${esc(p.artist)}</button>`
        : `<p class="bk-kicker">${esc(p.artist)}</p>`;
    return `
      ${artist}
      <h3 class="bk-name">${esc(p.title)}</h3>
      <div class="bk-actions">
        ${meta ? `<p class="bk-meta">${esc(meta)}</p>` : ''}
        <a class="bk-read" href="${esc(o.readPath(c))}" data-read>Read catalogue <span aria-hidden="true">&rarr;</span></a>
      </div>
      <button type="button" class="bk-close" aria-label="Put ${esc(p.title)} back on the shelf"><span aria-hidden="true">&times;</span></button>`;
  }

  function bookHTML(c, i) {
    const p = parts(c);
    const name = [p.artist, p.title].filter(Boolean).join(', ');
    const saved = cache[c.id];
    const hex = c.color || (saved && saved[0]);
    const style = `--w:${thickness(c)}px`
      + (hex && /^#[0-9a-f]{6}$/i.test(hex) ? `;--spine:${hex};--ink:${inkFor(hex)}` : '')
      + (saved ? `;--f:${Number(saved[1]) || 0}` : '');
    return `
      <li class="bk-book" data-id="${esc(c.id)}" style="${esc(style)}"${saved ? ' data-ready' : ''}>
        <div class="bk-face">
          <span class="bk-ph" aria-hidden="true">
            <span class="bk-ph-spine"><b>${esc(p.artist)}</b><span>${esc(p.title)}</span></span>
            <span class="bk-ph-cover"><span>${esc(p.artist)}</span><b>${esc(p.title)}</b></span>
          </span>
          <img class="bk-img" alt="" decoding="async">
          <button type="button" class="bk-spine" tabindex="${i === 0 ? 0 : -1}" aria-expanded="false"
                  aria-controls="bk-open-${i}" aria-label="${esc(name)}"></button>
          <a class="bk-cover" href="${esc(o.readPath(c))}" data-read tabindex="-1" aria-label="Read ${esc(name)}" hidden></a>
        </div>
        <div class="bk-open" id="bk-open-${i}" role="group" aria-label="${esc(name)}" inert>
          <div class="bk-info">${infoHTML(c, p)}</div>
        </div>
      </li>`;
  }

  // ── Render ─────────────────────────────────────

  function render(container, catalogs, options) {
    teardown();
    o = Object.assign({}, DEFAULTS, options || {});
    cache = readCache();

    const all = (catalogs || []).filter(c => c && c.id && c.title);
    byId = new Map(all.map(c => [c.id, c]));
    counts = new Map();
    all.forEach(c => { const k = o.artistKey(c); counts.set(k, (counts.get(k) || 0) + 1); });
    const picked = pick(all, o.size);

    container.innerHTML = `
      <section class="bk" aria-labelledby="bk-title">
        <header class="bk-head">
          <h1 class="bk-title" id="bk-title">${esc(o.title)}</h1>
          ${o.intro ? `<p class="bk-intro">${esc(o.intro)}</p>` : ''}
        </header>
        <div class="bk-shelf-wrap">
          <ol class="bk-shelf" aria-label="Catalogues on the shelf">
            ${picked.map(bookHTML).join('')}
          </ol>
        </div>
        <div class="bk-foot">
          <p class="bk-label" aria-hidden="true"></p>
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
    foot = root.querySelector('.bk-foot');
    label = root.querySelector('.bk-label');
    arrows = root.querySelector('.bk-arrows');
    caption = root.querySelector('.bk-caption');
    prevBtn = root.querySelector('.bk-prev');
    nextBtn = root.querySelector('.bk-next');
    books = [...shelf.children];

    root.addEventListener('click', onClick);
    shelf.addEventListener('keydown', onKey);
    shelf.addEventListener('scroll', onScroll, { passive: true });
    shelf.addEventListener('pointerover', onPoint);
    shelf.addEventListener('pointerleave', hideLabel);
    shelf.addEventListener('focusin', onPoint);
    shelf.addEventListener('focusout', hideLabel);
    shelf.addEventListener('transitionend', onTransitionEnd);
    document.addEventListener('keydown', onEsc);
    // library.js renders while the page is still hidden, so measure again whenever the shelf gets a size
    if (window.ResizeObserver) { sizeWatch = new ResizeObserver(onScroll); sizeWatch.observe(shelf); }
    else window.addEventListener('resize', onScroll);

    studyAll(picked);
    if (o.openFirst && books.length) open(books[0], { scroll: false, eager: true });
    refresh();

    // once the page has settled, fetch the strips further along the shelf too (not on phones or data-saver)
    const later = () => {
      idleTimer = setTimeout(() => {
        const saver = navigator.connection && navigator.connection.saveData;
        if (!saver && window.matchMedia('(min-width: 801px)').matches) loadStrips(true);
      }, 2500);
    };
    if (document.readyState === 'complete') later();
    else window.addEventListener('load', later, { once: true });
    return api;
  }

  function teardown() {
    document.removeEventListener('keydown', onEsc);
    window.removeEventListener('resize', onScroll);
    if (sizeWatch) { sizeWatch.disconnect(); sizeWatch = null; }
    clearTimeout(idleTimer);
    current = null;
  }

  // ── Covers ─────────────────────────────────────

  /** Width of an open cover: measured, or (while the page is still hidden) the same sum the CSS does. */
  function coverWidth(book) {
    return (book && book.querySelector('.bk-ph').offsetWidth)
      || Math.round(Math.min(380, Math.max(window.innerWidth < 640 ? 230 : 300, window.innerWidth * 0.29)) * 1.294);
  }

  function widthFor(book) {
    const need = coverWidth(book) * Math.min(2, window.devicePixelRatio || 1);
    return [600, 800, 1200, 1600].find(x => x >= need) || 1600;
  }

  function fail(book) {
    book.dataset.img = 'none';
    book.classList.add('no-img');   // the plain spine with artist and title shows instead
    const img = book.querySelector('.bk-img');
    if (img) img.remove();
  }

  /** Strips use the same 600px file as the list below, so each cover is downloaded once. */
  function loadImg(book, eager) {
    const img = book.querySelector('.bk-img');
    if (!img || book.dataset.img) return;
    const c = byId.get(book.dataset.id);
    if (!c || !c.driveFileId) { fail(book); return; }
    const w = book === current ? widthFor(book) : 600;
    book.dataset.img = 'loading';
    book.dataset.w = String(w);
    if (eager) img.setAttribute('fetchpriority', 'high');
    img.onload = () => { book.dataset.img = 'loaded'; img.classList.add('is-loaded'); };
    img.onerror = () => fail(book);
    img.src = o.coverUrl(c, w);
  }

  /** An open cover is much larger than a strip: swap in a sharper file once it has arrived. */
  function sharpen(book) {
    const img = book.querySelector('.bk-img');
    const c = byId.get(book.dataset.id);
    const w = widthFor(book);
    if (!img || !c || !c.driveFileId || w <= (Number(book.dataset.w) || 0)) return;
    book.dataset.w = String(w);
    const hi = new Image();
    hi.onload = () => { if (img.isConnected) img.src = hi.src; };
    hi.src = o.coverUrl(c, w);
  }

  /** Load the strips in or near view; all of them when asked. */
  function loadStrips(all) {
    if (!shelf || !shelf.clientWidth) return;   // not laid out yet
    const from = shelf.scrollLeft - 200;
    const to = shelf.scrollLeft + shelf.clientWidth + 400;
    books.forEach(b => {
      if (b.dataset.img) return;
      if (all || (b.offsetLeft + b.offsetWidth >= from && b.offsetLeft <= to)) loadImg(b, false);
    });
  }

  // ── Opening and closing ────────────────────────

  function roving(el) {
    books.forEach(b => { spineOf(b).tabIndex = -1; coverOf(b).tabIndex = -1; });
    el.tabIndex = 0;
  }

  function open(book, opts) {
    const { scroll = true, eager = false } = opts || {};
    if (!book || current === book) return;
    if (current) close(false);
    current = book;
    const spine = spineOf(book);
    const cover = coverOf(book);
    const hadFocus = document.activeElement === spine;
    loadImg(book, eager);
    sharpen(book);
    book.classList.add('is-open');
    spine.setAttribute('aria-expanded', 'true');
    cover.hidden = false;
    spine.hidden = true;            // the strip has become the cover; the cover link takes over
    const panel = book.querySelector('.bk-open');
    panel.inert = false;
    panel.removeAttribute('inert');
    roving(cover);
    if (hadFocus) cover.focus({ preventScroll: true });
    hideLabel();
    caption.innerHTML = book.querySelector('.bk-info').innerHTML;   // narrow screens show the details under the shelf
    caption.hidden = false;
    book.dataset.reveal = scroll ? '1' : '';
    if (scroll) reveal(book, false);
  }

  function close(focus) {
    const book = current;
    if (!book) return;
    current = null;
    const spine = spineOf(book);
    book.classList.remove('is-open');
    spine.hidden = false;
    spine.setAttribute('aria-expanded', 'false');
    coverOf(book).hidden = true;
    const panel = book.querySelector('.bk-open');
    panel.inert = true;
    panel.setAttribute('inert', '');
    roving(spine);
    caption.hidden = true;
    caption.innerHTML = '';
    if (focus) spine.focus({ preventScroll: true });
  }

  /** Scroll the shelf so the open book is in view. Runs as it opens and again when it settles. */
  function reveal(book, settled) {
    const info = book.querySelector('.bk-info');
    const full = coverWidth(book) + (info ? info.offsetWidth : 0);
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
    refresh();
    if (e.target === current && current.dataset.reveal) {
      current.dataset.reveal = '';
      reveal(current, true);
    }
  }

  // ── The name under the pointer ─────────────────

  function onPoint(e) {
    const book = e.target.closest && e.target.closest('.bk-book');
    if (!book || book === current) { hideLabel(); return; }   // the open book already shows its name
    const p = parts(byId.get(book.dataset.id));
    label.innerHTML = `${p.artist ? `<b>${esc(p.artist)}</b>` : ''}<span>${esc(p.title)}</span>`;
    // sits under its strip, kept inside the row and clear of the arrows
    const room = foot.clientWidth - label.offsetWidth - (root.classList.contains('bk--overflow') ? arrows.offsetWidth + 12 : 0);
    const x = Math.max(0, Math.min(book.offsetLeft - shelf.scrollLeft, room));
    label.style.transform = `translateX(${Math.round(x)}px)`;
    label.classList.add('is-on');
  }

  function hideLabel() {
    if (label) label.classList.remove('is-on');
  }

  // ── Events ─────────────────────────────────────

  function onClick(e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const read = t.closest('a[data-read]');   // the open cover, or the Read button
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
    if (spine) { open(spine.closest('.bk-book')); return; }
    if (t.closest('.bk-prev')) slide(-1);
    else if (t.closest('.bk-next')) slide(1);
  }

  function onKey(e) {
    const el = e.target.closest && e.target.closest('.bk-spine, .bk-cover');
    if (!el) return;
    const i = books.indexOf(el.closest('.bk-book'));
    let j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: books.length - 1 }[e.key];
    if (j === undefined) return;
    e.preventDefault();
    j = Math.max(0, Math.min(books.length - 1, j));
    const target = books[j] === current ? coverOf(books[j]) : spineOf(books[j]);
    roving(target);
    target.focus();
  }

  function onEsc(e) {
    if (e.key !== 'Escape' || !current || !root || root.offsetParent === null) return;
    const inside = root.contains(document.activeElement);
    if (!inside && document.activeElement !== document.body) return;   // e.g. typing in search
    close(true);
  }

  function onScroll() {
    hideLabel();
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; refresh(); });
  }

  /** Arrow states, edge fades, and any strips that have come into view. */
  function refresh() {
    if (!shelf) return;
    const max = shelf.scrollWidth - shelf.clientWidth;
    const x = shelf.scrollLeft;
    root.classList.toggle('bk--overflow', max > 2);
    prevBtn.disabled = x <= 2;
    nextBtn.disabled = x >= max - 2;
    wrap.classList.toggle('is-left', x > 2);
    wrap.classList.toggle('is-right', x < max - 2);
    loadStrips(false);
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
    if (sel.value !== key) return;   // no such option
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
