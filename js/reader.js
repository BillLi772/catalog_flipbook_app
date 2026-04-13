/**
 * reader.js — Flipbook reader with Issuu-style 3D page-turn animation.
 *
 * Spread layout (0-based):
 *   Spread 0:   [blank,  page 1]   ← front cover
 *   Spread k:   [page 2k, page 2k+1]   for k ≥ 1
 *   Last spread: right or left may be null (blank) if totalPages is odd
 *
 * Forward flip:  right page "flies" left   → rotateY(0 → -180deg), origin: left center
 * Backward flip: left page "flies" right   → rotateY(0 → +180deg), origin: right center
 */
const Reader = (() => {

  // ── State ──────────────────────────────────────
  let _catalog = null;
  let _renderer = null;
  let _currentSpread = 0;
  let _numSpreads = 0;
  let _isFlipping = false;
  let _zoomScale = 1.0;
  let _showThumbnails = false;
  let _thumbnailsRendered = false;
  let _isMobile = false;
  let _touchStartX = 0;
  let _touchStartY = 0;
  let _pageWidth = 0;  // current render width in px (CSS)
  const _prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ── DOM refs ───────────────────────────────────
  let $viewport, $book, $pageLeft, $pageRight, $canvasLeft, $canvasRight;
  let $blankLeft, $blankRight, $progress, $title, $indicator;
  let $scrubber, $thumbnailsList, $thumbnailsPanel;
  let $relatedSection, $relatedGrid;

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  async function init(catalog, startPage) {
    _catalog = catalog;
    _renderer = new PDFRenderer();
    _zoomScale = 1.0;
    _showThumbnails = false;
    _thumbnailsRendered = false;
    _isMobile = window.innerWidth < 768;

    _cacheDOMRefs();
    _setupEventListeners();

    // Show reader, hide library
    document.getElementById('reader-view').hidden = false;
    document.getElementById('library-view').hidden = true;
    document.getElementById('site-header').hidden = true;

    // Set title
    $title.textContent = catalog.title;
    document.title = `${catalog.title} — Catalog`;

    // Show loading overlay
    const loadingOverlay = _createLoadingOverlay();
    $viewport.appendChild(loadingOverlay);

    try {
      const url = PDFRenderer.buildUrl(catalog.driveFileId);
      _renderer.onProgress(pct => {
        const bar = loadingOverlay.querySelector('.pdf-loading-bar');
        if (bar) bar.style.width = pct + '%';
      });

      const { numPages } = await _renderer.load(url);
      _numSpreads = _calcNumSpreads(numPages);

      // Determine starting spread from page number
      _currentSpread = _pageToSpread(startPage || 1);

      loadingOverlay.remove();

      _sizeBook();
      await _renderSpread(_currentSpread);
      _updateUI();
      _setupScrubber(numPages);
      window.addEventListener('resize', _onResize);

      // Preload adjacent spreads
      _preloadAdjacent(_currentSpread);

    } catch (err) {
      loadingOverlay.innerHTML = `
        <div class="pdf-error">
          <strong>Unable to load PDF</strong>
          <p>The catalog could not be loaded. This may be due to CORS restrictions on direct Google Drive links.</p>
          <p style="margin-top:0.5rem;font-size:0.75rem;opacity:0.6">Configure a Cloudflare Worker proxy in <code>window.APP_CONFIG.workerUrl</code> to enable PDF loading.</p>
          <p style="margin-top:0.75rem;font-size:0.75rem;color:#d4002a">${err.message}</p>
        </div>`;
    }
  }

  function destroy() {
    window.removeEventListener('resize', _onResize);
    _removeEventListeners();

    if (_renderer) {
      _renderer.destroy();
      _renderer = null;
    }

    // Reset DOM
    document.getElementById('reader-view').hidden = true;
    document.getElementById('library-view').hidden = false;
    document.getElementById('site-header').hidden = false;
    document.title = 'Catalog Library';

    // Clear book canvases
    if ($canvasLeft) { $canvasLeft.width = 0; $canvasLeft.height = 0; }
    if ($canvasRight) { $canvasRight.width = 0; $canvasRight.height = 0; }
    if ($thumbnailsList) $thumbnailsList.innerHTML = '';

    // Remove any leftover flip cards
    document.querySelectorAll('.flip-card').forEach(el => el.remove());

    // Hide related
    if ($relatedSection) $relatedSection.hidden = true;

    _catalog = null;
    _isFlipping = false;
    _thumbnailsRendered = false;
  }

  // ──────────────────────────────────────────────
  // Spread / Page math
  // ──────────────────────────────────────────────

  function _calcNumSpreads(totalPages) {
    // Spread 0 = [blank, page 1]
    // Spread k = [page 2k, page 2k+1]
    return 1 + Math.ceil((totalPages - 1) / 2);
  }

  function _getSpreadPages(spreadIndex) {
    const total = _renderer ? _renderer.numPages : 0;
    if (spreadIndex === 0) return { left: null, right: 1 };
    const left = spreadIndex * 2;
    const right = left + 1;
    return {
      left:  left  <= total ? left  : null,
      right: right <= total ? right : null,
    };
  }

  function _pageToSpread(pageNum) {
    if (pageNum <= 1) return 0;
    return Math.floor(pageNum / 2);
  }

  function _spreadToDisplayPage(spreadIndex) {
    const { left, right } = _getSpreadPages(spreadIndex);
    return right || left || 1;
  }

  // ──────────────────────────────────────────────
  // DOM
  // ──────────────────────────────────────────────

  function _cacheDOMRefs() {
    $viewport       = document.getElementById('book-viewport');
    $book           = document.getElementById('reader-book');
    $pageLeft       = document.getElementById('book-page-left');
    $pageRight      = document.getElementById('book-page-right');
    $canvasLeft     = document.getElementById('canvas-left');
    $canvasRight    = document.getElementById('canvas-right');
    $blankLeft      = document.getElementById('page-blank-left');
    $blankRight     = document.getElementById('page-blank-right');
    $progress       = document.getElementById('reading-progress');
    $title          = document.getElementById('reader-title');
    $indicator      = document.getElementById('reader-page-indicator');
    $scrubber       = document.getElementById('page-scrubber');
    $thumbnailsList = document.getElementById('thumbnails-list');
    $thumbnailsPanel= document.getElementById('reader-thumbnails');
    $relatedSection = document.getElementById('related-catalogs');
    $relatedGrid    = document.getElementById('related-grid');
  }

  function _createLoadingOverlay() {
    const div = document.createElement('div');
    div.className = 'pdf-loading-overlay';
    div.innerHTML = `
      <div class="pdf-loading-book" aria-hidden="true">
        <div class="book-spine"></div>
        <div class="book-page"></div>
        <div class="book-page"></div>
        <div class="book-page"></div>
        <div class="book-page"></div>
      </div>
      <div class="pdf-loading-bar-track">
        <div class="pdf-loading-bar"></div>
      </div>
      <span class="pdf-loading-label">Opening catalog…</span>`;
    return div;
  }

  // ──────────────────────────────────────────────
  // Book sizing
  // ──────────────────────────────────────────────

  function _sizeBook() {
    _isMobile = window.innerWidth < 768;

    const ar = _renderer ? _renderer.aspectRatio : 0.707;
    const stageEl = document.getElementById('reader-stage');
    const stageW = stageEl.clientWidth;
    const stageH = stageEl.clientHeight;

    const padding = 32;
    const toolbarH = 0; // already excluded by flex layout
    const availW = stageW - padding * 2;
    const availH = stageH - padding * 2;

    let bookW, bookH;

    if (_isMobile) {
      // Single page: fill stage
      const pageW = Math.min(availW, availH * ar);
      const pageH = pageW / ar;
      bookW = pageW;
      bookH = pageH;
      _pageWidth = pageW;

      $pageLeft.style.display = 'none';
      $pageRight.style.width = '100%';
    } else {
      // Double spread: two pages side by side
      // Total book aspect ratio ≈ 2 * pageAR (two pages wide)
      const spreadAR = ar * 2;
      bookW = Math.min(availW, availH * spreadAR);
      bookH = bookW / spreadAR;
      _pageWidth = bookW / 2;

      $pageLeft.style.display = '';
      $pageRight.style.width = '50%';
    }

    // Apply zoom
    bookW *= _zoomScale;
    bookH *= _zoomScale;

    $book.style.width = bookW + 'px';
    $book.style.height = bookH + 'px';
    $viewport.style.width = bookW + 'px';
    $viewport.style.height = bookH + 'px';
  }

  // ──────────────────────────────────────────────
  // Rendering
  // ──────────────────────────────────────────────

  async function _renderSpread(spreadIndex) {
    const { left, right } = _getSpreadPages(spreadIndex);

    // Left page
    await _renderPageToCanvas($canvasLeft, $blankLeft, left, _pageWidth);

    // Right page
    await _renderPageToCanvas($canvasRight, $blankRight, right, _pageWidth);
  }

  async function _renderPageToCanvas(canvas, blankEl, pageNum, width) {
    if (!pageNum) {
      canvas.style.display = 'none';
      blankEl.style.display = '';
      return;
    }

    blankEl.style.display = 'none';
    canvas.style.display = '';

    const rendered = await _renderer.renderPage(pageNum, Math.round(width));
    if (!rendered) {
      canvas.style.display = 'none';
      blankEl.style.display = '';
      return;
    }

    // Swap the canvas content by drawing rendered into the display canvas
    canvas.width = rendered.width;
    canvas.height = rendered.height;
    // Let CSS control display size — width: 100%, height: auto preserves aspect ratio
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    const ctx = canvas.getContext('2d');
    ctx.drawImage(rendered, 0, 0);
  }

  // ──────────────────────────────────────────────
  // Page flip animation
  // ──────────────────────────────────────────────

  async function flipForward() {
    if (_isFlipping || _currentSpread >= _numSpreads - 1) return;
    _isFlipping = true;

    const nextSpread = _currentSpread + 1;

    if (_prefersReducedMotion.matches) {
      await _crossfadeToSpread(nextSpread);
      return;
    }

    const { right: outgoingPage } = _getSpreadPages(_currentSpread);
    const { left: incomingPage }  = _getSpreadPages(nextSpread);

    // Pre-render both pages needed for flip
    const [outCanvas, inCanvas] = await Promise.all([
      outgoingPage ? _renderer.renderPage(outgoingPage, Math.round(_pageWidth * window.devicePixelRatio)) : null,
      incomingPage ? _renderer.renderPage(incomingPage, Math.round(_pageWidth * window.devicePixelRatio)) : null,
    ]);

    // Build flip card
    const flipCard = _buildFlipCard('forward', outCanvas, inCanvas);
    $book.appendChild(flipCard);

    // Hide static right page (flip card covers it)
    $pageRight.style.visibility = 'hidden';
    $pageRight.style.overflow = 'visible'; // Safari: allow 3D child

    // Double rAF to force layout before starting transition
    requestAnimationFrame(() => requestAnimationFrame(() => {
      flipCard.classList.add('is-flipping');

      flipCard.addEventListener('transitionend', async () => {
        _currentSpread = nextSpread;

        // Update book pages
        await _renderSpread(_currentSpread);

        // Teardown flip card
        flipCard.remove();
        $pageRight.style.visibility = '';
        $pageRight.style.overflow = '';

        _isFlipping = false;
        _updateUI();
        _updateURL();
        _preloadAdjacent(_currentSpread);
        _checkEndOfCatalog();
      }, { once: true });
    }));
  }

  async function flipBackward() {
    if (_isFlipping || _currentSpread <= 0) return;
    _isFlipping = true;

    const prevSpread = _currentSpread - 1;

    if (_prefersReducedMotion.matches) {
      await _crossfadeToSpread(prevSpread);
      return;
    }

    const { left: outgoingPage }  = _getSpreadPages(_currentSpread);
    const { right: incomingPage } = _getSpreadPages(prevSpread);

    const [outCanvas, inCanvas] = await Promise.all([
      outgoingPage ? _renderer.renderPage(outgoingPage, Math.round(_pageWidth * window.devicePixelRatio)) : null,
      incomingPage ? _renderer.renderPage(incomingPage, Math.round(_pageWidth * window.devicePixelRatio)) : null,
    ]);

    const flipCard = _buildFlipCard('backward', outCanvas, inCanvas);
    $book.appendChild(flipCard);

    $pageLeft.style.visibility = 'hidden';
    $pageLeft.style.overflow = 'visible';

    requestAnimationFrame(() => requestAnimationFrame(() => {
      flipCard.classList.add('is-flipping');

      flipCard.addEventListener('transitionend', async () => {
        _currentSpread = prevSpread;

        await _renderSpread(_currentSpread);

        flipCard.remove();
        $pageLeft.style.visibility = '';
        $pageLeft.style.overflow = '';

        _isFlipping = false;
        _updateUI();
        _updateURL();
        _preloadAdjacent(_currentSpread);
      }, { once: true });
    }));
  }

  /** Build the 3D flip card DOM element */
  function _buildFlipCard(dir, frontCanvas, backCanvas) {
    const card = document.createElement('div');
    card.className = 'flip-card';
    card.dataset.dir = dir;

    // Position: forward → covers right half, backward → covers left half
    const halfW = $book.clientWidth / 2;
    card.style.width = halfW + 'px';
    card.style.height = $book.clientHeight + 'px';
    if (dir === 'forward') {
      card.style.right = '0';
      card.style.left = 'auto';
    } else {
      card.style.left = '0';
      card.style.right = 'auto';
    }

    // Front face
    const front = document.createElement('div');
    front.className = 'flip-face flip-face-front';
    if (frontCanvas) {
      const c = _cloneCanvas(frontCanvas);
      front.appendChild(c);
    } else {
      front.style.background = '#f5f2ee';
    }
    const shadowFront = document.createElement('div');
    shadowFront.className = 'flip-shadow flip-shadow-front';
    front.appendChild(shadowFront);

    // Back face (pre-rotated 180deg — becomes visible when card is at ±180deg)
    const back = document.createElement('div');
    back.className = 'flip-face flip-face-back';
    if (backCanvas) {
      const c = _cloneCanvas(backCanvas);
      back.appendChild(c);
    } else {
      back.style.background = '#f5f2ee';
    }
    const shadowBack = document.createElement('div');
    shadowBack.className = 'flip-shadow flip-shadow-back';
    back.appendChild(shadowBack);

    card.appendChild(front);
    card.appendChild(back);
    return card;
  }

  /** Clone a canvas by drawing it into a new one */
  function _cloneCanvas(src) {
    const dst = document.createElement('canvas');
    dst.width = src.width;
    dst.height = src.height;
    dst.style.width = '100%';
    dst.style.height = 'auto';
    const ctx = dst.getContext('2d');
    ctx.drawImage(src, 0, 0);
    return dst;
  }

  /** Reduced-motion fallback: simple crossfade */
  async function _crossfadeToSpread(targetSpread) {
    $book.style.opacity = '0';
    $book.style.transition = 'opacity 200ms ease';
    await new Promise(r => setTimeout(r, 200));

    _currentSpread = targetSpread;
    await _renderSpread(_currentSpread);

    $book.style.opacity = '1';
    await new Promise(r => setTimeout(r, 200));
    $book.style.transition = '';

    _isFlipping = false;
    _updateUI();
    _updateURL();
    _preloadAdjacent(_currentSpread);
    _checkEndOfCatalog();
  }

  // ──────────────────────────────────────────────
  // Preloading
  // ──────────────────────────────────────────────

  function _preloadAdjacent(spreadIndex) {
    const pagesToLoad = [];
    for (let delta = 1; delta <= 2; delta++) {
      const s = spreadIndex + delta;
      if (s < _numSpreads) {
        const { left, right } = _getSpreadPages(s);
        if (left) pagesToLoad.push(left);
        if (right) pagesToLoad.push(right);
      }
      const sp = spreadIndex - delta;
      if (sp >= 0) {
        const { left, right } = _getSpreadPages(sp);
        if (left) pagesToLoad.push(left);
        if (right) pagesToLoad.push(right);
      }
    }
    _renderer.preload(pagesToLoad, Math.round(_pageWidth * window.devicePixelRatio));
  }

  // ──────────────────────────────────────────────
  // UI updates
  // ──────────────────────────────────────────────

  function _updateUI() {
    const { left, right } = _getSpreadPages(_currentSpread);
    const total = _renderer ? _renderer.numPages : 0;

    // Page indicator
    if ($indicator) {
      if (_isMobile) {
        const p = right || left || 1;
        $indicator.textContent = `Page ${p} of ${total}`;
      } else {
        if (left && right) {
          $indicator.textContent = `Pages ${left}–${right} of ${total}`;
        } else if (right) {
          $indicator.textContent = `Page ${right} of ${total}`;
        } else if (left) {
          $indicator.textContent = `Page ${left} of ${total}`;
        }
      }
      $indicator.setAttribute('aria-label', $indicator.textContent);
    }

    // Progress bar
    if ($progress && _numSpreads > 1) {
      const pct = (_currentSpread / (_numSpreads - 1)) * 100;
      $progress.style.width = pct + '%';
      $progress.setAttribute('aria-valuenow', Math.round(pct));
    }

    // Scrubber
    if ($scrubber) {
      const displayPage = _spreadToDisplayPage(_currentSpread);
      $scrubber.value = displayPage;
    }

    // Thumbnail highlight
    if (_showThumbnails && $thumbnailsList) {
      $thumbnailsList.querySelectorAll('.thumbnail-item').forEach(item => {
        const p = parseInt(item.dataset.page, 10);
        const { left: l, right: r } = _getSpreadPages(_currentSpread);
        item.classList.toggle('active', p === l || p === r);
      });
    }

    // Prev/next btn states
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    if (btnPrev) btnPrev.disabled = _currentSpread === 0;
    if (btnNext) btnNext.disabled = _currentSpread >= _numSpreads - 1;
  }

  function _setupScrubber(totalPages) {
    if (!$scrubber) return;
    $scrubber.min = 1;
    $scrubber.max = totalPages;
    $scrubber.value = _spreadToDisplayPage(_currentSpread);

    $scrubber.addEventListener('input', () => {
      const page = parseInt($scrubber.value, 10);
      const targetSpread = _pageToSpread(page);
      if (targetSpread !== _currentSpread && !_isFlipping) {
        _jumpToSpread(targetSpread);
      }
    });
  }

  async function _jumpToSpread(targetSpread) {
    if (_isFlipping) return;
    _currentSpread = Math.max(0, Math.min(targetSpread, _numSpreads - 1));
    await _renderSpread(_currentSpread);
    _updateUI();
    _updateURL();
    _preloadAdjacent(_currentSpread);
    _checkEndOfCatalog();
  }

  function _checkEndOfCatalog() {
    if (!$relatedSection || !$relatedGrid) return;
    if (_currentSpread < _numSpreads - 1) {
      $relatedSection.hidden = true;
      return;
    }
    // Last spread — show related
    const related = Library.getRelated(_catalog.id, 3);
    if (related.length === 0) return;

    $relatedGrid.innerHTML = related.map(c => `
      <div class="related-card" data-id="${c.id}" role="button" tabindex="0" aria-label="Open ${_escHtml(c.title)}">
        <div class="related-card-title">${_escHtml(c.title)}</div>
        <div class="related-card-cat">${_escHtml(c.category)}</div>
      </div>`).join('');

    $relatedGrid.querySelectorAll('.related-card').forEach(card => {
      card.addEventListener('click', () => App.navigate(`/catalog/${card.dataset.id}`));
    });

    $relatedSection.hidden = false;
  }

  function _updateURL() {
    const displayPage = _spreadToDisplayPage(_currentSpread);
    const url = `/catalog/${_catalog.id}/page/${displayPage}`;
    history.replaceState({ catalogId: _catalog.id, page: displayPage }, '', url);
  }

  // ──────────────────────────────────────────────
  // Thumbnails
  // ──────────────────────────────────────────────

  function _toggleThumbnails() {
    _showThumbnails = !_showThumbnails;
    $thumbnailsPanel.hidden = !_showThumbnails;
    const btn = document.getElementById('btn-thumbnails');
    if (btn) btn.setAttribute('aria-pressed', String(_showThumbnails));

    if (_showThumbnails && !_thumbnailsRendered) {
      _renderThumbnails();
    }
  }

  async function _renderThumbnails() {
    _thumbnailsRendered = true;
    const total = _renderer ? _renderer.numPages : 0;
    const thumbW = 128; // CSS pixels

    $thumbnailsList.innerHTML = '';

    for (let p = 1; p <= total; p++) {
      const item = document.createElement('div');
      item.className = 'thumbnail-item';
      item.dataset.page = p;
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-label', `Go to page ${p}`);

      const numLabel = document.createElement('span');
      numLabel.className = 'thumbnail-num';
      numLabel.textContent = p;
      item.appendChild(numLabel);

      $thumbnailsList.appendChild(item);

      item.addEventListener('click', () => {
        const targetSpread = _pageToSpread(p);
        _jumpToSpread(targetSpread);
      });

      // Lazy-render thumbnails with small delay to avoid jank
      const pageNum = p;
      setTimeout(async () => {
        if (!_renderer) return;
        const canvas = await _renderer.renderPage(pageNum, thumbW * (window.devicePixelRatio || 1));
        if (!canvas || !item.isConnected) return;
        const thumb = document.createElement('canvas');
        thumb.width = canvas.width;
        thumb.height = canvas.height;
        thumb.style.width = '100%';
        thumb.style.display = 'block';
        thumb.getContext('2d').drawImage(canvas, 0, 0);
        item.insertBefore(thumb, numLabel);
      }, p * 80); // stagger
    }

    _updateUI(); // highlight current
  }

  // ──────────────────────────────────────────────
  // Zoom
  // ──────────────────────────────────────────────

  function _zoom(delta) {
    _zoomScale = Math.max(0.5, Math.min(3.0, _zoomScale + delta));
    _sizeBook();
  }

  // ──────────────────────────────────────────────
  // Fullscreen
  // ──────────────────────────────────────────────

  function _toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.getElementById('reader-view').requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  function _onFullscreenChange() {
    const enter = document.getElementById('icon-fullscreen-enter');
    const exit  = document.getElementById('icon-fullscreen-exit');
    if (document.fullscreenElement) {
      if (enter) enter.hidden = true;
      if (exit) exit.hidden = false;
    } else {
      if (enter) enter.hidden = false;
      if (exit) exit.hidden = true;
    }
    setTimeout(_sizeBook, 100);
  }

  // ──────────────────────────────────────────────
  // Event listeners
  // ──────────────────────────────────────────────

  function _setupEventListeners() {
    // Back button
    document.getElementById('reader-back')?.addEventListener('click', _onBack);

    // Prev / Next buttons
    document.getElementById('btn-prev')?.addEventListener('click', flipBackward);
    document.getElementById('btn-next')?.addEventListener('click', flipForward);

    // Click zones
    document.getElementById('click-prev')?.addEventListener('click', flipBackward);
    document.getElementById('click-next')?.addEventListener('click', flipForward);

    // Zoom
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => _zoom(0.15));
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => _zoom(-0.15));

    // Thumbnails
    document.getElementById('btn-thumbnails')?.addEventListener('click', _toggleThumbnails);

    // Fullscreen
    document.getElementById('btn-fullscreen')?.addEventListener('click', _toggleFullscreen);
    document.addEventListener('fullscreenchange', _onFullscreenChange);

    // Download
    const dlBtn = document.getElementById('btn-download');
    if (dlBtn && _catalog) {
      dlBtn.href = PDFRenderer.buildUrl(_catalog.driveFileId);
      dlBtn.download = `${_catalog.id}.pdf`;
    }

    // Shortcuts button
    document.getElementById('btn-shortcuts')?.addEventListener('click', _showShortcutsOverlay);

    // Keyboard
    document.addEventListener('keydown', _onKeyDown);

    // Touch
    document.getElementById('reader-stage')?.addEventListener('touchstart', _onTouchStart, { passive: true });
    document.getElementById('reader-stage')?.addEventListener('touchend', _onTouchEnd, { passive: true });

    // Wheel
    document.getElementById('reader-stage')?.addEventListener('wheel', _onWheel, { passive: true });

    // Shortcuts overlay close
    document.getElementById('shortcuts-close')?.addEventListener('click', _hideShortcutsOverlay);
    document.querySelector('.shortcuts-backdrop')?.addEventListener('click', _hideShortcutsOverlay);
  }

  function _removeEventListeners() {
    document.getElementById('reader-back')?.removeEventListener('click', _onBack);
    document.getElementById('btn-prev')?.removeEventListener('click', flipBackward);
    document.getElementById('btn-next')?.removeEventListener('click', flipForward);
    document.getElementById('click-prev')?.removeEventListener('click', flipBackward);
    document.getElementById('click-next')?.removeEventListener('click', flipForward);
    document.getElementById('btn-zoom-in')?.removeEventListener('click', () => _zoom(0.15));
    document.getElementById('btn-zoom-out')?.removeEventListener('click', () => _zoom(-0.15));
    document.getElementById('btn-thumbnails')?.removeEventListener('click', _toggleThumbnails);
    document.getElementById('btn-fullscreen')?.removeEventListener('click', _toggleFullscreen);
    document.removeEventListener('fullscreenchange', _onFullscreenChange);
    document.removeEventListener('keydown', _onKeyDown);
    document.getElementById('reader-stage')?.removeEventListener('touchstart', _onTouchStart);
    document.getElementById('reader-stage')?.removeEventListener('touchend', _onTouchEnd);
    document.getElementById('reader-stage')?.removeEventListener('wheel', _onWheel);
  }

  function _onBack() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    App.navigate('/');
  }

  function _onKeyDown(e) {
    // Don't interfere when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault();
        flipForward();
        break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        flipBackward();
        break;
      case 'Home':
        e.preventDefault();
        _jumpToSpread(0);
        break;
      case 'End':
        e.preventDefault();
        _jumpToSpread(_numSpreads - 1);
        break;
      case 'f':
      case 'F':
        _toggleFullscreen();
        break;
      case 't':
      case 'T':
        _toggleThumbnails();
        break;
      case '+':
      case '=':
        _zoom(0.15);
        break;
      case '-':
        _zoom(-0.15);
        break;
      case 'Escape':
        if (document.getElementById('shortcuts-overlay')?.hidden === false) {
          _hideShortcutsOverlay();
        } else if (_showThumbnails) {
          _toggleThumbnails();
        } else {
          _onBack();
        }
        break;
      case '?':
        _showShortcutsOverlay();
        break;
    }
  }

  function _onTouchStart(e) {
    _touchStartX = e.touches[0].clientX;
    _touchStartY = e.touches[0].clientY;
  }

  function _onTouchEnd(e) {
    const dx = e.changedTouches[0].clientX - _touchStartX;
    const dy = e.changedTouches[0].clientY - _touchStartY;

    // Only trigger if horizontal swipe dominates
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      if (dx < 0) {
        flipForward();
      } else {
        flipBackward();
      }
    }
  }

  function _onWheel(e) {
    if (Math.abs(e.deltaY) < 20) return; // ignore tiny movements
    // Debounce
    if (_isFlipping) return;
    if (e.deltaY > 0) {
      flipForward();
    } else {
      flipBackward();
    }
  }

  function _onResize() {
    _isMobile = window.innerWidth < 768;
    _sizeBook();
  }

  // ──────────────────────────────────────────────
  // Shortcuts overlay
  // ──────────────────────────────────────────────

  function _showShortcutsOverlay() {
    const overlay = document.getElementById('shortcuts-overlay');
    if (overlay) {
      overlay.hidden = false;
      document.getElementById('shortcuts-close')?.focus();
    }
  }

  function _hideShortcutsOverlay() {
    const overlay = document.getElementById('shortcuts-overlay');
    if (overlay) overlay.hidden = true;
  }

  // ──────────────────────────────────────────────
  // Utility
  // ──────────────────────────────────────────────

  function _escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return { init, destroy, flipForward, flipBackward };
})();
