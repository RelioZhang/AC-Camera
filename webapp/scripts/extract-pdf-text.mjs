// 从 PDF 提取文字及坐标（用于把「噪声值 / 测点编号」映射到底图归一化坐标）
// 用法：node scripts/extract-pdf-text.mjs "<pdf路径>"
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/extract-pdf-text.mjs <pdf>');
  process.exit(1);
}

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const data = new Uint8Array(readFileSync(resolve(file)));
const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
console.log('pages:', doc.numPages);

for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale: 1 });
  console.log(`\n=== page ${p} size ${vp.width} x ${vp.height} rotate=${page.rotate} ===`);
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    const txt = (it.str ?? '').trim();
    if (!txt) continue;
    const t = it.transform; // [a,b,c,d,e,f]
    // 文本原点在 PDF 坐标系（左下原点），转成左上原点便于和图片对齐
    const x = t[4];
    const y = vp.height - t[5];
    items.push({ text: txt, x: +x.toFixed(2), y: +y.toFixed(2), w: +(it.width ?? 0).toFixed(2), h: +(it.height ?? 0).toFixed(2) });
  }
  // 按 y 从大到小（视觉从上到下）、x 从左到右
  items.sort((a, b) => (Math.abs(a.y - b.y) < 2 ? a.x - b.x : a.y - b.y));
  console.log('items:', items.length);
  for (const it of items) console.log(`${it.x}\t${it.y}\t${it.text}`);
}
