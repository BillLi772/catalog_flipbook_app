/**
 * library.js — Catalog library page rendering, filtering, and search.
 */
const Library = (() => {
  // Module state
  let _allCatalogs = [];
  let _filtered = [];
  let _activeFilter = 'all';
  let _searchQuery = '';
  let _sortOrder = 'date-desc';
  let _imageObserver = null;
  let _initialized = false;

  // DOM refs (populated on init)
  let _heroEl, _gridEl, _noResultsEl, _countEl;

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  async function init() {
    _heroEl = document.getElementById('hero-section');
    _gridEl = document.getElementById('catalog-grid');
    _noResultsEl = document.getElementById('no-results');

    _setupImageObserver();
    await _loadCatalogs();

    _setupSearch();
    _setupSort();
    _setupNavFilter();

    _initialized = true;
  }

  function destroy() {
    if (_imageObserver) {
      _imageObserver.disconnect();
      _imageObserver = null;
    }
    _initialized = false;
  }

  // ──────────────────────────────────────────────
  // Data loading
  // ──────────────────────────────────────────────

  async function _loadCatalogs() {
    try {
      const resp = await fetch('catalogs.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      _allCatalogs = data.catalogs || [];
      _filtered = [..._allCatalogs];
      _sortAndRender();

      document.getElementById('loading-state').hidden = true;
      document.getElementById('library-content').hidden = false;
    } catch (err) {
      document.getElementById('loading-state').innerHTML =
        `<p style="color:#d4002a;font-size:0.875rem">Failed to load catalogs: ${err.message}</p>`;
    }
  }

  // ──────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────

  function _sortAndRender() {
    const sorted = _sortCatalogs([..._filtered], _sortOrder);
    _renderHero(sorted);
    _renderGrid(sorted);
    _updateCount(sorted.length);
  }

  function _sortCatalogs(list, order) {
    switch (order) {
      case 'date-asc':
        return list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      case 'date-desc':
        return list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      case 'alpha':
        return list.sort((a, b) => a.title.localeCompare(b.title));
      case 'category':
        return list.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
      default:
        return list;
    }
  }

  function _renderHero(sorted) {
    const featured = sorted.find(c => c.featured) || sorted[0];
    if (!featured) {
      _heroEl.innerHTML = '';
      return;
    }
    _heroEl.innerHTML = _heroCardHTML(featured);
    const card = _heroEl.querySelector('.hero-card');
    card.addEventListener('click', () => App.navigate(`/catalog/${featured.id}`));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') App.navigate(`/catalog/${featured.id}`);
    });
    // Lazy-load hero image
    const img = _heroEl.querySelector('img[data-src]');
    if (img && _imageObserver) _imageObserver.observe(img);
  }

  function _renderGrid(sorted) {
    // Non-featured items (skip the hero catalog from the grid if it's in the list)
    const heroId = (sorted.find(c => c.featured) || sorted[0])?.id;
    // Show all items in grid (including featured) so filters show correct counts
    // But visually, re-display featured in grid too (matches MoMA behavior)
    const items = sorted;

    if (items.length === 0) {
      _gridEl.innerHTML = '';
      _noResultsEl.hidden = false;
      return;
    }

    _noResultsEl.hidden = true;
    _gridEl.innerHTML = items.map((c, i) => _cardHTML(c, i)).join('');

    // Attach click handlers
    _gridEl.querySelectorAll('.catalog-card').forEach(card => {
      const id = card.dataset.id;
      card.addEventListener('click', () => App.navigate(`/catalog/${id}`));
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') App.navigate(`/catalog/${id}`);
      });
    });

    // Observe lazy images
    if (_imageObserver) {
      _gridEl.querySelectorAll('img[data-src]').forEach(img => _imageObserver.observe(img));
    }
  }

  function _updateCount(n) {
    let el = document.getElementById('library-count');
    if (!el) {
      // Insert library toolbar before catalog grid
      const toolbar = document.createElement('div');
      toolbar.className = 'library-toolbar';
      toolbar.innerHTML = `<p class="library-count" id="library-count"></p>`;
      _gridEl.parentNode.insertBefore(toolbar, _gridEl);
      el = document.getElementById('library-count');
    }
    el.innerHTML = `<strong>${n}</strong> catalog${n === 1 ? '' : 's'}`;
  }

  // ──────────────────────────────────────────────
  // HTML templates
  // ──────────────────────────────────────────────

  function _heroCardHTML(c) {
    const color = c.color || '#e0dbd4';
    const hasImage = c.coverImage && !c.coverImage.startsWith('covers/sample');
    return `
      <article class="hero-card" tabindex="0" role="button" aria-label="Open ${_esc(c.title)}">
        <div class="hero-image-wrap">
          ${hasImage
            ? `<img data-src="${_esc(c.coverImage)}" alt="${_esc(c.title)}" loading="lazy">`
            : `<div class="hero-cover-placeholder" style="background-color:${_esc(color)}">
                 <span class="placeholder-title">${_esc(c.title)}</span>
               </div>`
          }
        </div>
        <div class="hero-info">
          <div class="hero-category">${_esc(c.category)}</div>
          <h2 class="hero-title">${_esc(c.title)}</h2>
          ${c.subtitle ? `<p class="hero-subtitle">${_esc(c.subtitle)}</p>` : ''}
          <p class="hero-meta">
            <span>${_formatDate(c.date)}</span>
            <span>${c.pageCount} pages</span>
          </p>
          <p class="hero-cta">View Catalog →</p>
        </div>
      </article>`;
  }

  function _cardHTML(c, index) {
    const color = c.color || '#e0dbd4';
    const hasImage = c.coverImage && !c.coverImage.startsWith('covers/sample');
    return `
      <article class="catalog-card" data-id="${_esc(c.id)}" tabindex="0"
               role="button" aria-label="Open ${_esc(c.title)}">
        <div class="card-image-wrap">
          ${hasImage
            ? `<img data-src="${_esc(c.coverImage)}" alt="${_esc(c.title)}" loading="lazy">`
            : `<div class="card-cover-placeholder" style="background-color:${_esc(color)}">
                 <span class="placeholder-title">${_esc(c.title)}</span>
               </div>`
          }
        </div>
        <p class="card-category">${_esc(c.category)}</p>
        <h3 class="card-title">${_esc(c.title)}</h3>
        ${c.subtitle ? `<p class="card-subtitle">${_esc(c.subtitle)}</p>` : ''}
        <p class="card-meta">${_formatDate(c.date)} &middot; ${c.pageCount} pp</p>
      </article>`;
  }

  // ──────────────────────────────────────────────
  // Filtering & search
  // ──────────────────────────────────────────────

  function _applyFilters() {
    let results = [..._allCatalogs];

    // Category filter
    if (_activeFilter && _activeFilter !== 'all') {
      results = results.filter(c => c.category === _activeFilter);
    }

    // Search
    if (_searchQuery) {
      const q = _searchQuery.toLowerCase();
      results = results.filter(c =>
        c.title.toLowerCase().includes(q) ||
        (c.subtitle || '').toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q)
      );
    }

    _filtered = results;
    _sortAndRender();
  }

  function _setupSearch() {
    const input = document.getElementById('search-input');
    if (!input) return;

    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        _searchQuery = input.value.trim();
        _applyFilters();
      }, 200);
    });
  }

  function _setupSort() {
    const sel = document.getElementById('sort-select');
    if (!sel) return;
    sel.addEventListener('change', () => {
      _sortOrder = sel.value;
      _sortAndRender();
    });
  }

  function _setupNavFilter() {
    document.querySelectorAll('.nav-link[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-link[data-filter]').forEach(b => {
          b.classList.remove('nav-link--active');
        });
        btn.classList.add('nav-link--active');
        _activeFilter = btn.dataset.filter;
        _applyFilters();
      });
    });
  }

  // ──────────────────────────────────────────────
  // Lazy image loading
  // ──────────────────────────────────────────────

  function _setupImageObserver() {
    if (!('IntersectionObserver' in window)) {
      // Fallback: load all immediately
      _imageObserver = { observe: (img) => _loadImage(img), disconnect: () => {} };
      return;
    }

    _imageObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          _loadImage(entry.target);
          _imageObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: '200px' });
  }

  function _loadImage(img) {
    const src = img.dataset.src;
    if (!src) return;
    img.src = src;
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => {
      // Replace with placeholder on error
      const placeholder = img.parentElement;
      const catalog = _allCatalogs.find(c => c.coverImage === src);
      if (catalog && placeholder) {
        placeholder.innerHTML = `
          <div class="card-cover-placeholder" style="background-color:${catalog.color || '#e0dbd4'}">
            <span class="placeholder-title">${_esc(catalog.title)}</span>
          </div>`;
      }
    }, { once: true });
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  function _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _formatDate(dateStr) {
    if (!dateStr) return '';
    const [year, month] = dateStr.split('-');
    if (!month) return year;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(month, 10) - 1]} ${year}`;
  }

  /** Return catalog by id */
  function getCatalog(id) {
    return _allCatalogs.find(c => c.id === id) || null;
  }

  /** Return catalogs in the same category (excluding self), up to n */
  function getRelated(id, n = 3) {
    const self = getCatalog(id);
    if (!self) return [];
    return _allCatalogs
      .filter(c => c.id !== id && c.category === self.category)
      .slice(0, n);
  }

  return { init, destroy, getCatalog, getRelated };
})();
