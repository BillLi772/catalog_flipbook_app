/**
 * Cloudflare Pages Function: Google Drive PDF proxy, served from this site at /api/pdf
 *
 *   GET /api/pdf?id=FILE_ID          the catalogue PDF (Range requests pass through for fast paging)
 *   GET /api/pdf?thumbnail=FILE_ID   a cover image (only for old links; the app loads covers from Google)
 *
 * This replaces the separate "flipbook" Worker (flipbook.liwenruixxx.workers.dev). Living inside
 * the Pages project means it deploys with every push to main and cannot be deleted, switched off
 * or renamed on its own. Same origin as the app, so no CORS is involved.
 * The PDFs must be shared in Drive as "Anyone with the link can view".
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;

function headers(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    ...extra,
  };
}

function text(status, message) {
  return new Response(message, { status, headers: headers({ 'Content-Type': 'text/plain; charset=utf-8' }) });
}

async function thumbnail(id) {
  const resp = await fetch(`https://drive.google.com/thumbnail?id=${id}&sz=w600`, { redirect: 'follow' });
  return new Response(resp.body, {
    status: resp.status,
    headers: headers({
      'Content-Type': resp.headers.get('Content-Type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    }),
  });
}

async function pdf(id, request) {
  const range = request.headers.get('Range');
  let drive;
  try {
    drive = await fetch(`https://drive.google.com/uc?export=download&confirm=t&id=${id}`, {
      method: request.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CatalogProxy/1.0)',
        ...(range ? { Range: range } : {}),
      },
      redirect: 'follow',
    });
  } catch (err) {
    return text(502, `Could not reach Google Drive: ${err.message}`);
  }

  if (!drive.ok && drive.status !== 206) return text(drive.status, `Google Drive returned ${drive.status}`);
  if ((drive.headers.get('Content-Type') || '').includes('text/html')) {
    return text(502, 'Google Drive sent a web page instead of the PDF. Check the file is shared as "Anyone with the link".');
  }

  const out = headers({
    'Content-Type': 'application/pdf',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  });
  for (const h of ['Content-Length', 'Content-Range']) {
    const v = drive.headers.get(h);
    if (v) out[h] = v;
  }
  return new Response(request.method === 'HEAD' ? null : drive.body, { status: drive.status, headers: out });
}

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers() });
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Method not allowed');

  const url = new URL(request.url);
  const thumbId = url.searchParams.get('thumbnail');
  const fileId = url.searchParams.get('id');

  if (thumbId) return ID_PATTERN.test(thumbId) ? thumbnail(thumbId) : text(400, 'Invalid file ID');
  if (!fileId) return text(400, 'Missing required parameter: id');
  if (!ID_PATTERN.test(fileId)) return text(400, 'Invalid file ID');
  return pdf(fileId, request);
}
