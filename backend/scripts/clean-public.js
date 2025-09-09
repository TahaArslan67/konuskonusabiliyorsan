#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const publicDir = path.resolve(process.cwd(), 'public');
const patterns = [/\.map$/i, /\.old$/i, /\.bak$/i, /^\.DS_Store$/i, /^Thumbs\.db$/i];

async function walk(dir){
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (ent) => {
    const res = path.resolve(dir, ent.name);
    if (ent.isDirectory()) return walk(res);
    return res;
  }));
  return files.flat();
}

function shouldDelete(file){
  const base = path.basename(file);
  return patterns.some((re) => re.test(base));
}

async function main(){
  if (!fs.existsSync(publicDir)) {
    console.log('[clean] public directory not found');
    return;
  }
  const allFiles = await walk(publicDir);
  let removed = 0;
  for (const f of allFiles){
    if (shouldDelete(f)){
      try {
        await fs.promises.unlink(f);
        console.log(`[clean] removed ${path.relative(publicDir, f)}`);
        removed++;
      } catch (e){
        console.warn(`[clean] failed ${f}: ${e?.message || e}`);
      }
    }
  }
  if (removed === 0) console.log('[clean] nothing to remove');
}

main().catch((e) => { console.error(e); process.exit(1); });
