#!/usr/bin/env node
/**
 * scripts/generate-covers.js
 *
 * Renders the first page of each catalog PDF as a JPEG thumbnail
 * and saves it to the covers/ directory. Also updates pageCount in
 * catalogs.json.
 *
 * Usage:
 *   node scripts/generate-covers.js
 *
 * Prerequisites:
 *   npm install canvas pdfjs-dist node-fetch
 *
 * Environment variables:
 *   WORKER_URL      Cloudflare Worker proxy URL (optional, avoids CORS issues)
 *   COVER_WIDTH     Output width in pixels (default: 800)
 *   COVER_QUALITY   JPEG quality 0-100 (default: 85)
 *   SKIP_EXISTING   Skip PDFs that already have a cover (default: true)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas } from 'canvas';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────────
const CATALOGS_FILE  = path.join(__dirname, '..', 'catalogs.json');
const COVERS_DIR     = path.join(__dirname, '..', 'covers');
const WORKER_URL     = process.env.WORKER_URL || '';
const COVER_WIDTH    = parseInt(process.env.COVER_WIDTH  || '800', 10);
const COVER_QUALITY  = parseInt(process.env.COVER_QUALITY || '85', 10) / 100;
const SKIP_EXISTING  = process.env.SKIP_EXISTING !== 'false';

// ── Node Canvas Factory for PDF.js ─────────────────────────────
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    // no-op
  }
}

// ── Helpers ────────────────────────────────────────────────────

function buildUrl(driveFileId) {
  if (WORKER_URL && !WORKER_URL.includes('your-worker')) {
    return `${WORKER_URL}?id=${encodeURIComponent(driveFileId)}`;
  }
  return `https://drive.google.com/uc?export=download&confirm=t&id=${encodeURIComponent(driveFileId)}`;
}

async function fetchPDF(url) {
  const { default: fetch } = await import('node-fetch');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function renderFirstPage(pdfBuffer, targetWidth) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.js');

  const loadingTask = getDocument({
    data: new Uint8Array(pdfBuffer),
    canvasFactory: new NodeCanvasFactory(),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  });

  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;
  const page = await pdfDoc.getPage(1);

  const naturalVp = page.getViewport({ scale: 1 });
  const scale = targetWidth / naturalVp.width;
  const viewport = page.getViewport({ scale });

  const canvasAndContext = new NodeCanvasFactory().create(
    Math.round(viewport.width),
    Math.round(viewport.height)
  );

  await page.render({
    canvasContext: canvasAndContext.context,
    viewport,
    canvasFactory: new NodeCanvasFactory(),
  }).promise;

  await pdfDoc.destroy();

  return {
    canvas: canvasAndContext.canvas,
    numPages,
  };
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(CATALOGS_FILE)) {
    console.error(`Error: ${CATALOGS_FILE} not found. Run build-catalog.js first.`);
    process.exit(1);
  }

  fs.mkdirSync(COVERS_DIR, { recursive: true });

  const manifest = JSON.parse(fs.readFileSync(CATALOGS_FILE, 'utf8'));
  const catalogs = manifest.catalogs || [];

  console.log(`\nGenerating covers for ${catalogs.length} catalogs…\n`);

  let updated = 0;
  let skipped = 0;
  let failed  = 0;

  for (const [i, catalog] of catalogs.entries()) {
    const coverPath = path.join(COVERS_DIR, `${catalog.id}.jpg`);
    const relPath = `covers/${catalog.id}.jpg`;

    process.stdout.write(`[${i + 1}/${catalogs.length}] ${catalog.id} … `);

    if (SKIP_EXISTING && fs.existsSync(coverPath)) {
      console.log('skipped (cover exists)');
      skipped++;
      continue;
    }

    // Check for placeholder IDs
    if (!catalog.driveFileId || catalog.driveFileId.startsWith('sample_')) {
      console.log('skipped (no real Drive file ID)');
      skipped++;
      continue;
    }

    try {
      const url = buildUrl(catalog.driveFileId);
      const pdfBuffer = await fetchPDF(url);
      const { canvas, numPages } = await renderFirstPage(pdfBuffer, COVER_WIDTH);

      // Save JPEG
      const jpegBuffer = canvas.toBuffer('image/jpeg', { quality: COVER_QUALITY });
      fs.writeFileSync(coverPath, jpegBuffer);

      // Update manifest
      catalog.coverImage = relPath;
      catalog.pageCount  = numPages;
      updated++;

      console.log(`✓  (${numPages} pages, ${Math.round(jpegBuffer.length / 1024)}KB cover)`);
    } catch (err) {
      console.log(`✗  ${err.message}`);
      failed++;
    }
  }

  // Save updated manifest
  manifest.generated = new Date().toISOString();
  fs.writeFileSync(CATALOGS_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`\n─────────────────────────────────`);
  console.log(`  Updated:  ${updated}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Total:    ${catalogs.length}`);
  console.log(`─────────────────────────────────\n`);

  if (failed > 0) {
    console.log('Some covers failed. Re-run to retry failed items (SKIP_EXISTING=false to redo all).\n');
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
