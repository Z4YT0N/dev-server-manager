#!/usr/bin/env node
/**
 * Rasterizes assets/icon.svg into the artifacts electron-builder needs:
 *   build/icon.png   — 512x512, used for Linux + macOS + as repo-visible asset
 *   build/icon.ico   — multi-resolution Windows icon (16/24/32/48/64/128/256)
 *
 * Run once after editing icon.svg:
 *
 *   npm run icon
 *
 * Dependencies are pulled in as devDependencies (sharp + to-ico).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import toIco from 'to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'icon.svg');
const BUILD = path.join(ROOT, 'build');

fs.mkdirSync(BUILD, { recursive: true });

const svg = fs.readFileSync(SVG);

// Multi-size PNG buffers for the .ico
const sizes = [16, 24, 32, 48, 64, 128, 256];

const main = async () => {
  // build/icon.png — single 512x512 source-of-truth raster
  await sharp(svg, { density: 384 })
    .resize(512, 512)
    .png()
    .toFile(path.join(BUILD, 'icon.png'));
  console.log('  +', 'build/icon.png  (512x512)');

  // build/icon.ico — every size embedded
  const buffers = [];
  for (const size of sizes) {
    // Higher density when rasterizing so small sizes stay crisp.
    const density = Math.max(96, Math.round((size / 512) * 384 * 4));
    const buf = await sharp(svg, { density })
      .resize(size, size)
      .png()
      .toBuffer();
    buffers.push(buf);
  }
  const ico = await toIco(buffers);
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico);
  console.log('  +', 'build/icon.ico  (' + sizes.join(', ') + ')');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
