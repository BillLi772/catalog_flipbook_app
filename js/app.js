/**
 * app.js — SPA router using the History API.
 *
 * Routes:
 *   /                          → Library
 *   /catalog/:slug             → Reader (page 1)
 *   /catalog/:slug/page/:n     → Reader (page n)
 */
const App = (() => {

  let _currentView = null; // 'library' | 'reader'

  // ──────────────────────────────────────────────
  // Boot
  // ──────────────────────────────────────────────

  function boot() {
    // Handle browser back/forward
    window.addEventListener('popstate', (e) => {
      _routeTo(location.pathname, false);
    });

    // Intercept anchor clicks for internal routes
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('//') || href.startsWith('#')) return;
      e.preventDefault();
      navigate(href);
    });

    // Route to the current URL on load
    _routeTo(location.pathname, false);
  }

  // ──────────────────────────────────────────────
  // Navigation
  // ──────────────────────────────────────────────

  function navigate(path) {
    history.pushState(null, '', path);
    _routeTo(path, true);
  }

  function _routeTo(path, isPush) {
    const match = _matchRoute(path);

    if (match.view === 'reader') {
      _showReader(match.slug, match.page);
    } else {
      _showLibrary();
    }
  }

  function _matchRoute(path) {
    // /catalog/:slug/page/:n
    const deepMatch = path.match(/^\/catalog\/([^/]+)\/page\/(\d+)\/?$/);
    if (deepMatch) {
      return { view: 'reader', slug: deepMatch[1], page: parseInt(deepMatch[2], 10) };
    }

    // /catalog/:slug
    const catalogMatch = path.match(/^\/catalog\/([^/]+)\/?$/);
    if (catalogMatch) {
      return { view: 'reader', slug: catalogMatch[1], page: 1 };
    }

    // / or anything else
    return { view: 'library' };
  }

  // ──────────────────────────────────────────────
  // View transitions
  // ──────────────────────────────────────────────

  async function _showLibrary() {
    if (_currentView === 'reader') {
      Reader.destroy();
    }
    _currentView = 'library';

    document.getElementById('library-view').hidden = false;
    document.getElementById('reader-view').hidden = true;
    document.getElementById('site-header').hidden = false;

    await Library.init();

    document.title = 'Catalog Library';
  }

  async function _showReader(slug, page) {
    // Ensure library data is loaded (needed for getCatalog + getRelated)
    if (_currentView !== 'library') {
      // Silent init so catalog data is available
      await Library.init().catch(() => {});
    }

    const catalog = Library.getCatalog(slug);
    if (!catalog) {
      // Catalog not found — fall back to library
      navigate('/');
      return;
    }

    if (_currentView === 'reader') {
      Reader.destroy();
    }
    _currentView = 'reader';

    await Reader.init(catalog, page);
  }

  return { boot, navigate };
})();

// ── Start the app ──────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.boot());
