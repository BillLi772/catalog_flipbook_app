/**
 * Cloudflare Worker — Google Drive PDF Proxy
 * Proxies PDFs from Google Drive to add CORS headers for PDF.js
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    // Thumbnail mode: ?thumbnail=FILE_ID
    const thumbId = url.searchParams.get('thumbnail');
    if (thumbId) {
      if (!/^[A-Za-z0-9_\-]+$/.test(thumbId)) {
        return new Response('Invalid file ID', { status: 400, headers: corsHeaders() });
      }
      const thumbUrl = `https://drive.google.com/thumbnail?id=${thumbId}&sz=w600`;
      const thumbResp = await fetch(thumbUrl, { redirect: 'follow' });
      const headers = new Headers(corsHeaders());
      headers.set('Content-Type', thumbResp.headers.get('Content-Type') || 'image/jpeg');
      headers.set('Cache-Control', 'public, max-age=86400');
      return new Response(thumbResp.body, { status: thumbResp.status, headers });
    }

    // PDF proxy mode: ?id=FILE_ID
    const fileId = url.searchParams.get('id');
    if (!fileId) {
      return new Response('Missing required parameter: id', { status: 400, headers: corsHeaders() });
    }
    if (!/^[A-Za-z0-9_\-]+$/.test(fileId)) {
      return new Response('Invalid file ID', { status: 400, headers: corsHeaders() });
    }

    const driveUrl = `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;

    let driveResponse;
    try {
      driveResponse = await fetch(driveUrl, {
        method: request.method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CatalogProxy/1.0)',
          ...(request.headers.get('Range') ? { Range: request.headers.get('Range') } : {}),
        },
        redirect: 'follow',
      });
    } catch (err) {
      return new Response(`Upstream fetch failed: ${err.message}`, { status: 502, headers: corsHeaders() });
    }

    if (!driveResponse.ok && driveResponse.status !== 206) {
      return new Response(`Upstream returned ${driveResponse.status}`, {
        status: driveResponse.status,
        headers: corsHeaders(),
      });
    }

    const responseHeaders = new Headers(corsHeaders());
    responseHeaders.set('Content-Type', driveResponse.headers.get('Content-Type') || 'application/pdf');
    const contentLength = driveResponse.headers.get('Content-Length');
    if (contentLength) responseHeaders.set('Content-Length', contentLength);
    const contentRange = driveResponse.headers.get('Content-Range');
    if (contentRange) responseHeaders.set('Content-Range', contentRange);
    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('Cache-Control', 'public, max-age=3600');

    return new Response(driveResponse.body, { status: driveResponse.status, headers: responseHeaders });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };
}
