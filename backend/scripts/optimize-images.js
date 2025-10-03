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

// Variant plans for responsive assets used in header/footer
const variants = [
  { base: 'logo.png', name: 'logo', heights: [36, 72] },       // desktop header/footer logical height 36px (2x for retina)
  { base: 'logo-icon.png', name: 'logo-icon', heights: [26, 52] } // mobile header logical height 26px (2x for retina)
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

async function generateVariants(plan){
  const { base, name, heights } = plan;
  const inPath = path.join(publicDir, base);
  const exists = fs.existsSync(inPath);
  if (!exists){ console.warn(`[var] skip ${base} (not found)`); return; }
  const buf = await fs.promises.readFile(inPath);
  const meta = await sharp(buf, { failOnError: false }).metadata();
  const metaInfo = `${meta.width || '?'}x${meta.height || '?'} ${meta.format || ''}`;
  for (const h of heights){
    const targetH = Math.min(h, meta.height || h);
    const suffix = `${name}-${h}`;
    const pngOut = path.join(publicDir, `${suffix}.png`);
    const webpOut = path.join(publicDir, `${suffix}.webp`);
    const avifOut = path.join(publicDir, `${suffix}.avif`);

    // PNG (fallback)
    await sharp(buf, { failOnError: false })
      .resize({ height: targetH, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true, quality: 82 })
      .toFile(pngOut);

    // WEBP
    await sharp(buf, { failOnError: false })
      .resize({ height: targetH, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toFile(webpOut);

    // AVIF
    await sharp(buf, { failOnError: false })
      .resize({ height: targetH, fit: 'inside', withoutEnlargement: true })
      .avif({ quality: 45, effort: 4 })
      .toFile(avifOut);

    const [s1, s2, s3] = await Promise.all([
      fs.promises.stat(pngOut).then(s=>s.size).catch(()=>0),
      fs.promises.stat(webpOut).then(s=>s.size).catch(()=>0),
      fs.promises.stat(avifOut).then(s=>s.size).catch(()=>0),
    ]);
    console.log(`[var] ${suffix} (src ${metaInfo} -> h=${targetH}): png=${formatSize(s1)}, webp=${formatSize(s2)}, avif=${formatSize(s3)}`);
  }
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

  // Generate responsive variants for logos
  for (const v of variants){
    try{
      await generateVariants(v);
    } catch (e){
      console.error(`[err] variants for ${v.base}:`, e?.message || e);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
