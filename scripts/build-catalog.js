#!/usr/bin/env node
/**
 * scripts/build-catalog.js
 *
 * Enumerates all PDFs in a Google Drive folder and writes catalogs.json.
 *
 * Usage:
 *   GOOGLE_API_KEY=your_api_key node scripts/build-catalog.js
 *
 * Optional environment variables:
 *   DRIVE_FOLDER_ID    Override the folder ID (default: from config below)
 *   OUTPUT_FILE        Output path (default: catalogs.json)
 *
 * The script requires only a Google API key (no OAuth) because the
 * target folder is publicly shared. Create one at:
 *   https://console.cloud.google.com → APIs & Services → Credentials
 * Enable the "Google Drive API" for the project.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────────
const FOLDER_ID   = process.env.DRIVE_FOLDER_ID || '1U2_lMcMB8IxVL-1HVIHtF8N9FarJ18aL';
const API_KEY     = process.env.GOOGLE_API_KEY;
const OUTPUT_FILE = process.env.OUTPUT_FILE || path.join(__dirname, '..', 'catalogs.json');
const DRIVE_API   = 'https://www.googleapis.com/drive/v3';

if (!API_KEY) {
  console.error('Error: GOOGLE_API_KEY environment variable is required.');
  console.error('Usage: GOOGLE_API_KEY=your_key node scripts/build-catalog.js');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, '')           // remove extension
    .replace(/[^a-z0-9]+/g, '-')       // non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, '');          // trim hyphens
}

function titleFromFilename(filename) {
  return filename
    .replace(/\.[^.]+$/, '')           // remove extension
    .replace(/[-_]/g, ' ')             // hyphens/underscores → spaces
    .replace(/\b\w/g, c => c.toUpperCase()); // title-case
}

/**
 * Guess a category from the filename/title.
 * Extend this mapping as needed.
 */
function guessCategory(title) {
  const t = title.toLowerCase();
  if (/spring|summer|fall|autumn|winter|seasonal/.test(t)) return 'Seasonal';
  if (/photo|photograph/.test(t)) return 'Photography';
  if (/paint|oil|acrylic|watercolor/.test(t)) return 'Painting';
  if (/design|architect|typograph/.test(t)) return 'Design';
  if (/sculpt/.test(t)) return 'Sculpture';
  if (/craft|textile|weav|fabric/.test(t)) return 'Craft';
  if (/digital|media|tech|new media/.test(t)) return 'Digital Art';
  if (/draw|sketch|print/.test(t)) return 'Drawing';
  if (/collection|annual|survey/.test(t)) return 'Collection';
  return 'Exhibition';
}

/**
 * Guess a date (YYYY-MM) from the filename.
 * Looks for patterns like 2024-03, 2024_03, march-2024, etc.
 */
function guessDate(title) {
  const monthNames = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };

  // YYYY-MM or YYYY_MM
  const ymMatch = title.match(/(\d{4})[-_](\d{2})/);
  if (ymMatch) return `${ymMatch[1]}-${ymMatch[2]}`;

  // Month-YYYY or Month_YYYY
  const myMatch = title.toLowerCase().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*[-_\s]*(\d{4})/);
  if (myMatch) return `${myMatch[2]}-${monthNames[myMatch[1]]}`;

  // Just a year
  const yMatch = title.match(/\b(20\d{2})\b/);
  if (yMatch) return `${yMatch[1]}`;

  return null;
}

// ── Google Drive API calls ─────────────────────────────────────

async function listPDFs(folderId) {
  const files = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      key: API_KEY,
      q: `'${folderId}' in parents and mimeType='application/pdf' and trashed=false`,
      fields: 'nextPageToken,files(id,name,createdTime,modifiedTime,size)',
      pageSize: 100,
      orderBy: 'name',
      ...(pageToken ? { pageToken } : {}),
    });

    const url = `${DRIVE_API}/files?${params}`;
    const resp = await fetch(url);

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Drive API error ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || null;

    console.log(`  Fetched ${files.length} files so far…`);
  } while (pageToken);

  return files;
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log(`\nBuilding catalog manifest for folder: ${FOLDER_ID}\n`);

  // Load existing catalog if present (to preserve manual edits like featured/color)
  let existing = {};
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      (raw.catalogs || []).forEach(c => { existing[c.id] = c; });
      console.log(`Found ${Object.keys(existing).length} existing entries to merge.\n`);
    } catch (_) {}
  }

  console.log('Fetching file list from Google Drive…');
  const files = await listPDFs(FOLDER_ID);
  console.log(`\nFound ${files.length} PDF(s).\n`);

  // Build slug → file map (handle duplicates by appending index)
  const slugCount = {};
  const catalogs = files.map((file, i) => {
    const title = titleFromFilename(file.name);
    let slug = slugify(file.name);

    // De-duplicate slugs
    if (slugCount[slug] !== undefined) {
      slugCount[slug]++;
      slug = `${slug}-${slugCount[slug]}`;
    } else {
      slugCount[slug] = 0;
    }

    const category = guessCategory(title);
    const date = guessDate(file.name) || guessDate(title);

    // Merge with existing entry if present
    const prev = existing[slug] || {};

    return {
      id:           slug,
      title:        prev.title        || title,
      subtitle:     prev.subtitle     || '',
      category:     prev.category     || category,
      date:         prev.date         || date || '',
      driveFileId:  file.id,
      coverImage:   `covers/${slug}.jpg`,
      pageCount:    prev.pageCount    || 0,   // populated by generate-covers.js
      featured:     prev.featured     || (i === 0),
      color:        prev.color        || null,
    };
  });

  const manifest = {
    folderUrl:  `https://drive.google.com/drive/folders/${FOLDER_ID}`,
    generated:  new Date().toISOString(),
    catalogs,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${catalogs.length} entries to: ${OUTPUT_FILE}`);
  console.log('\nNext steps:');
  console.log('  1. Review and edit catalogs.json (titles, categories, featured flag)');
  console.log('  2. Run: node scripts/generate-covers.js   (to render cover thumbnails)');
  console.log('  3. Deploy to Cloudflare Pages\n');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
