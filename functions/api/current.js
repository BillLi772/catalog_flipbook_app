/**
 * Cloudflare Pages Function: what is on view at the gallery right now, served from this site at /api/current
 *
 *   GET /api/current   ->   { "shows": [ { "artist": "Van McElwee", "title": "Tetrahedra" }, ... ] }
 *
 * The Publications page uses it to choose its "Selected publications": catalogues by the
 * artists who are on view now come first (see js/selected.js).
 *
 * It reads the "Current exhibitions" part of the gallery's Exhibitions page, so the row follows
 * that page with nothing to maintain here. On that page each show is a heading (the artist or
 * show name) followed by a paragraph that starts with the show's title.
 *
 * If the page cannot be read or its layout changes, this answers with an empty list and the
 * Publications page falls back to a random selection. Browsers keep the answer for an hour, and
 * the page itself remembers it for six, so this runs about once per visitor.
 */

const SOURCE = 'https://www.brunodavidgallery.com/exhibition';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '\u2019', lsquo: '\u2018', ndash: '\u2013', mdash: '\u2014' };

function text(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] || m)
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim();
}

/** Pull { artist, title } pairs out of the Exhibitions page's "current" section. */
function parseShows(html) {
  const start = html.search(/<section\b[^>]*\sid=["']current["']/i);
  if (start < 0) return [];
  const next = html.indexOf('<section', start + 10);
  const part = html.slice(start, next > 0 ? next : undefined);

  const shows = [];
  const seen = new Set();
  const blocks = /<(h[1-6]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  let open = null;   // the heading we are still looking for a title for
  while ((match = blocks.exec(part))) {
    const tag = match[1].toLowerCase();
    const value = text(match[2]);
    if (!value) continue;
    if (tag !== 'p') {
      const artist = value.replace(/\s*:\s*$/, '').replace(/\s*\n\s*/g, ' ');
      open = null;
      if (!artist || seen.has(artist.toLowerCase())) continue;
      seen.add(artist.toLowerCase());
      open = { artist, title: '' };
      shows.push(open);
    } else if (open) {
      // the paragraph after a heading: "Body Language<br>November 13, 2026 - January 16, 2027"
      const first = value.split('\n')[0].trim();
      const isDate = /\b(19|20)\d\d\b/.test(first) && /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(first);
      if (first && !isDate && !/view exhibition/i.test(first)) open.title = first;
      open = null;
    }
  }
  return shows.slice(0, 40);
}

function json(body, maxAge) {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestGet() {
  try {
    const page = await fetch(SOURCE, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BrunoDavidGalleryPublications/1.0)', Accept: 'text/html' },
      redirect: 'follow',
    });
    if (!page.ok) return json({ shows: [], note: `Exhibitions page answered ${page.status}` }, 300);
    const shows = parseShows(await page.text());
    return json({ shows }, shows.length ? 3600 : 300);
  } catch (err) {
    return json({ shows: [], note: 'Exhibitions page could not be reached' }, 300);
  }
}
