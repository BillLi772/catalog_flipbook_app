import https from 'https';
import fs from 'fs';

const API_KEY = process.env.GOOGLE_API_KEY;
const FOLDER_ID = '1U2_lMcMB8IxVL-1HVIHtF8N9FarJ18aL';

if (!API_KEY) {
  console.error('Error: GOOGLE_API_KEY is required');
  process.exit(1);
}

console.log('Fetching files from Google Drive...');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function slugify(name) {
  return name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function titleFromFilename(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function main() {
  const files = [];
  let pageToken = '';

  do {
    const url = `https://www.googleapis.com/drive/v3/files?key=${API_KEY}&q=%27${FOLDER_ID}%27+in+parents+and+mimeType%3D%27application/pdf%27+and+trashed%3Dfalse&fields=nextPageToken,files(id,name)&pageSize=100${pageToken ? '&pageToken=' + pageToken : ''}`;
    const data = await get(url);

    if (data.error) {
      console.error('API Error:', data.error.message);
      process.exit(1);
    }

    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
    console.log(`Got ${files.length} files so far...`);
  } while (pageToken);

  console.log(`\nTotal: ${files.length} PDFs found`);

  const catalogs = files.map((file, i) => ({
    id: slugify(file.name),
    title: titleFromFilename(file.name),
    subtitle: '',
    category: 'Exhibition',
    date: '',
    driveFileId: file.id,
    coverImage: `covers/${slugify(file.name)}.jpg`,
    pageCount: 0,
    featured: i === 0,
    color: null,
  }));

  const manifest = {
    folderUrl: `https://drive.google.com/drive/folders/${FOLDER_ID}`,
    generated: new Date().toISOString(),
    catalogs,
  };

  fs.writeFileSync('catalogs.json', JSON.stringify(manifest, null, 2));
  console.log('Done! catalogs.json updated.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
