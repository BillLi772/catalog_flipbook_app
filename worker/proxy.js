/**
 * Cloudflare Worker — Google Drive PDF Proxy
 *
 * Proxies PDF downloads from Google Drive to add CORS headers,
 * enabling client-side PDF.js to fetch and render the files.
 *
 * Deploy:
 *   wrangler deploy worker/proxy.js
 *
 * Usage:
 *   https://your-worker.workers.dev/?id=DRIVE_FILE_ID
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
  }

  const fileId = url.searchParams.get('id');
  if (!fileId) {
    return new Response('Missing required parameter: id', { status: 400, headers: corsHeaders() });
  }

  // Validate fileId: only allow alphanumeric, hyphens, underscores
  // This prevents SSRF by ensuring we only proxy Drive file IDs
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
        // Forward range header for partial content / seeking
        ...(request.headers.get('Range')
          ? { Range: request.headers.get('Range') }
          : {}),
      },
      redirect: 'follow',
    });
  } catch (err) {
    return new Response(`Upstream fetch failed: ${err.message}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  if (!driveResponse.ok && driveResponse.status !== 206) {
    return new Response(`Upstream returned ${driveResponse.status}`, {
      status: driveResponse.status,
      headers: corsHeaders(),
    });
  }

  // Stream the response body through with added CORS headers
  const responseHeaders = new Headers(corsHeaders());
  responseHeaders.set('Content-Type', driveResponse.headers.get('Content-Type') || 'application/pdf');

  const contentLength = driveResponse.headers.get('Content-Length');
  if (contentLength) responseHeaders.set('Content-Length', contentLength);

  const contentRange = driveResponse.headers.get('Content-Range');
  if (contentRange) responseHeaders.set('Content-Range', contentRange);

  // Cache for 1 hour at the CDN edge (PDFs rarely change)
  responseHeaders.set('Cache-Control', 'public, max-age=3600');

  return new Response(driveResponse.body, {
    status: driveResponse.status,
    headers: responseHeaders,
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };
}
