/**
 * PDFRenderer — wraps PDF.js for lazy page rendering with canvas pool.
 *
 * Usage:
 *   const renderer = new PDFRenderer();
 *   const { numPages, aspectRatio } = await renderer.load(url);
 *   const canvas = await renderer.renderPage(3, 900);
 */
class PDFRenderer {
  constructor() {
    this.pdfDoc = null;
    this.numPages = 0;
    this.aspectRatio = 0.707; // default A4 portrait

    // Canvas pool: Map<pageNum, canvas>
    this._cache = new Map();
    this._renderQueue = new Map(); // pageNum → Promise<canvas>
    this._maxCache = 20;
    this._currentScale = 1.5;
  }

  /**
   * Load a PDF from a URL.
   * @param {string} url
   * @returns {Promise<{numPages: number, aspectRatio: number}>}
   */
  async load(url) {
    this.destroy();

    const loadingTask = pdfjsLib.getDocument({
      url,
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
      cMapPacked: true,
      enableXfa: false,
    });

    // Progress callback
    loadingTask.onProgress = (progress) => {
      if (progress.total > 0) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        this._onProgress && this._onProgress(pct);
      }
    };

    this.pdfDoc = await loadingTask.promise;
    this.numPages = this.pdfDoc.numPages;

    // Determine aspect ratio from page 1
    try {
      const page1 = await this.pdfDoc.getPage(1);
      const vp = page1.getViewport({ scale: 1 });
      this.aspectRatio = vp.width / vp.height;
    } catch (_) {
      // fallback to A4
    }

    return { numPages: this.numPages, aspectRatio: this.aspectRatio };
  }

  /**
   * Render a page to an off-screen canvas.
   * @param {number} pageNum  1-indexed
   * @param {number} targetWidth  pixel width for rendering (CSS pixels)
   * @returns {Promise<HTMLCanvasElement>}
   */
  async renderPage(pageNum, targetWidth = 900) {
    if (pageNum < 1 || pageNum > this.numPages) return null;

    // Cache hit
    if (this._cache.has(pageNum)) {
      return this._cache.get(pageNum);
    }

    // Already rendering
    if (this._renderQueue.has(pageNum)) {
      return this._renderQueue.get(pageNum);
    }

    const promise = this._doRender(pageNum, targetWidth);
    this._renderQueue.set(pageNum, promise);

    let canvas;
    try {
      canvas = await promise;
    } finally {
      this._renderQueue.delete(pageNum);
    }

    // Evict oldest if cache is full (LRU-ish via Map insertion order)
    if (this._cache.size >= this._maxCache) {
      const oldestKey = this._cache.keys().next().value;
      this._cache.delete(oldestKey);
    }

    if (canvas) {
      this._cache.set(pageNum, canvas);
    }

    return canvas;
  }

  /** Internal render implementation */
  async _doRender(pageNum, targetWidth) {
    const page = await this.pdfDoc.getPage(pageNum);
    const dpr = window.devicePixelRatio || 1;

    // Calculate scale so that the rendered canvas fills targetWidth CSS pixels
    const naturalVp = page.getViewport({ scale: 1 });
    const scale = (targetWidth / naturalVp.width) * dpr;

    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    // CSS dimensions (display size = physical / dpr)
    canvas.style.width = (viewport.width / dpr) + 'px';
    canvas.style.height = (viewport.height / dpr) + 'px';

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    return canvas;
  }

  /**
   * Pre-render a set of pages in the background (fire-and-forget).
   * @param {number[]} pageNums
   * @param {number} targetWidth
   */
  preload(pageNums, targetWidth = 900) {
    for (const n of pageNums) {
      if (n >= 1 && n <= this.numPages && !this._cache.has(n)) {
        this.renderPage(n, targetWidth).catch(() => {});
      }
    }
  }

  /** Set a progress callback: fn(percent: 0-100) */
  onProgress(fn) {
    this._onProgress = fn;
    return this;
  }

  /** Clear cache and destroy PDF document */
  destroy() {
    this._cache.clear();
    this._renderQueue.clear();
    if (this.pdfDoc) {
      this.pdfDoc.destroy().catch(() => {});
      this.pdfDoc = null;
    }
    this.numPages = 0;
  }

  /**
   * Build the PDF URL for a catalog item.
   * Tries the Cloudflare Worker proxy first.
   */
  static buildUrl(driveFileId) {
    const cfg = window.APP_CONFIG || {};
    const workerUrl = cfg.workerUrl || '';

    // If a real worker URL is configured (not placeholder), use it
    if (workerUrl && !workerUrl.includes('your-worker')) {
      return `${workerUrl}?id=${encodeURIComponent(driveFileId)}`;
    }

    // Fallback: direct Google Drive download URL
    return `https://drive.google.com/uc?export=download&confirm=t&id=${encodeURIComponent(driveFileId)}`;
  }
}
