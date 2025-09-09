#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const publicDir = path.resolve(process.cwd(), 'public');

const targets = [
  { file: 'favicon.png', quality: 70 },
  { file: 'logo-icon.png', quality: 75 },
  { file: 'logo.png', quality: 80 },
];

async function optimizePng(fullPath, quality){
  const buf = await fs.promises.readFile(fullPath);
  const input = sharp(buf, { failOnError: false });
  const meta = await input.metadata();
  // Re-encode PNG with compressionLevel and palette when applicable
  const optimized = await input
    .png({ compressionLevel: 9, palette: meta.channels === 4 ? false : true, quality })
    .toBuffer();
  if (optimized.length < buf.length) {
    await fs.promises.writeFile(fullPath, optimized);
    console.log(`[opt] ${path.basename(fullPath)}: ${formatSize(buf.length)} -> ${formatSize(optimized.length)} (${((1 - optimized.length / buf.length) * 100).toFixed(1)}%)`);
  } else {
    console.log(`[opt] ${path.basename(fullPath)}: no gain (${formatSize(buf.length)})`);
  }
}

function formatSize(n){
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(1)} MB`;
}

async function main(){
  for (const t of targets){
    const p = path.join(publicDir, t.file);
    if (!fs.existsSync(p)) { console.warn(`[skip] ${t.file} not found`); continue; }
    try {
      await optimizePng(p, t.quality);
    } catch (e){
      console.error(`[err] ${t.file}:`, e?.message || e);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
