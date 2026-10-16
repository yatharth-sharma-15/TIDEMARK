import { diffLines, diffWordsWithSpace } from 'diff';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

/** Line diff, with long unchanged stretches collapsed to 2 lines of context. */
export function textDiff(a, b, context = 2) {
  const parts = diffLines(a, b);
  const rows = [];
  let added = 0;
  let removed = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const lines = p.value.replace(/\n$/, '').split('\n');
    if (p.added) { added += lines.length; lines.forEach((t) => rows.push({ t: 'add', text: t })); }
    else if (p.removed) { removed += lines.length; lines.forEach((t) => rows.push({ t: 'del', text: t })); }
    else if (lines.length <= context * 2 + 1) lines.forEach((t) => rows.push({ t: 'same', text: t }));
    else {
      const head = i === 0 ? [] : lines.slice(0, context);
      const tail = i === parts.length - 1 ? [] : lines.slice(-context);
      head.forEach((t) => rows.push({ t: 'same', text: t }));
      rows.push({ t: 'gap', text: `${lines.length - head.length - tail.length} unchanged lines` });
      tail.forEach((t) => rows.push({ t: 'same', text: t }));
    }
  }
  // Pair a removed line with the added line right after it to show word-level edits.
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i].t === 'del' && rows[i + 1].t === 'add') {
      const words = diffWordsWithSpace(rows[i].text, rows[i + 1].text);
      rows[i].words = words.filter((w) => !w.added).map((w) => ({ v: w.value, hl: !!w.removed }));
      rows[i + 1].words = words.filter((w) => !w.removed).map((w) => ({ v: w.value, hl: !!w.added }));
    }
  }
  return { rows, added, removed };
}

function padTo(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

/** Highlighted screenshot diff. Differences are painted red over a faded copy of the new page. */
export function screenshotDiff(bufA, bufB) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  const pa = padTo(a, w, h);
  const pb = padTo(b, w, h);
  const out = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(pa.data, pb.data, out.data, w, h, {
    threshold: 0.12,
    alpha: 0.25,
    diffColor: [220, 38, 38],
    diffColorAlt: [37, 99, 235],
  });
  return { png: PNG.sync.write(out), diffPixels, ratio: diffPixels / (w * h) };
}
