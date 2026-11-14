// Reads whatever GeoTIFFs are in data_raw/ and writes public/data/ for the viewer.
// Handles real georeferenced rasters (geographic, equirectangular, orthographic, Mars sphere);
// falls back to config.json bbox for un-georeferenced placeholder files.
import fs from 'node:fs';
import path from 'node:path';
import { fromFile } from 'geotiff';
import { PNG } from 'pngjs';

const RAW = process.env.RAW || 'data_raw', OUT = process.env.OUT || 'public/data';
fs.mkdirSync(OUT, { recursive: true });
// built-in defaults; data_raw/config.json is optional and only overrides them
const cfg = {
  bbox: { west: 77.25, south: 18.38, east: 77.55, north: 18.52 },
  dtmMaxWidth: 2048, orthoMaxWidth: 4096, radius: 3396190,
  projection: 'auto', lon0: 0, lat0: 0, latTs: 0, elevFallback: [-2700, -1800],
};
try { Object.assign(cfg, JSON.parse(fs.readFileSync(`${RAW}/config.json`, 'utf8'))); } catch {}
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const log = (...a) => console.log(...a);
if (!fs.existsSync(RAW)) { console.log('Folder data_raw/ not found. Put your .tif files in it.'); process.exit(1); }
const t0 = Date.now();
const fingerprint = fs.readdirSync(RAW).sort().map((f) => `${f}:${fs.statSync(path.join(RAW, f)).size}`).join('|');
try {
  const prev = JSON.parse(fs.readFileSync(`${OUT}/meta.json`, 'utf8'));
  if (!process.argv.includes('--force') && prev.inputs === fingerprint) {
    log('Data in data_raw/ has not changed since the last run -> nothing to do. (Use "npm run prep:force" to redo.)');
    process.exit(0);
  }
} catch {}

// ---------- projections (sphere) ----------
function makeProj(type, p) {
  const R = p.R, l0 = p.lon0 * D2R, f0 = p.lat0 * D2R, fts = p.latTs * D2R, FE = p.fe || 0, FN = p.fn || 0;
  if (type === 'geographic') return { fwd: (lo, la) => [lo, la], inv: (x, y) => [x, y] };
  if (type === 'eqc') return {
    fwd: (lo, la) => [R * (lo * D2R - l0) * Math.cos(fts) + FE, R * la * D2R + FN],
    inv: (x, y) => [((x - FE) / (R * Math.cos(fts)) + l0) * R2D, ((y - FN) / R) * R2D] };
  if (type === 'ortho') return {
    fwd: (lo, la) => { const f = la * D2R, dl = lo * D2R - l0;
      return [R * Math.cos(f) * Math.sin(dl) + FE, R * (Math.cos(f0) * Math.sin(f) - Math.sin(f0) * Math.cos(f) * Math.cos(dl)) + FN]; },
    inv: (x0, y0) => { const x = x0 - FE, y = y0 - FN, rho = Math.hypot(x, y); if (rho === 0) return [p.lon0, p.lat0];
      const c = Math.asin(Math.min(1, rho / R));
      const f = Math.asin(Math.cos(c) * Math.sin(f0) + (y * Math.sin(c) * Math.cos(f0)) / rho);
      const l = l0 + Math.atan2(x * Math.sin(c), rho * Math.cos(f0) * Math.cos(c) - y * Math.sin(f0) * Math.sin(c));
      return [l * R2D, f * R2D]; } };
  throw new Error('unknown projection ' + type);
}

function detect(img) {
  const fd = img.getFileDirectory();
  const gk = (() => { try { return img.getGeoKeys() || {}; } catch { return {}; } })();
  const hasGeo = !!(fd.ModelTiepoint && fd.ModelPixelScale) || !!fd.ModelTransformation;
  if (!hasGeo) return null;
  const txt = String(gk.GeoAsciiParams || '');
  const num = (re, d) => { const m = txt.match(re); return m ? parseFloat(m[1]) : d; };
  let type = cfg.projection, p = { R: cfg.radius, lon0: cfg.lon0, lat0: cfg.lat0, latTs: cfg.latTs, fe: 0, fn: 0 };
  if (type === 'auto') {
    if (gk.GTModelTypeGeoKey === 2) type = 'geographic';
    else if (gk.ProjCoordTransGeoKey === 21 || /orthographic/i.test(txt)) type = 'ortho';
    else type = 'eqc';
    if (type !== 'geographic') {
      p.lon0 = gk.ProjCenterLongGeoKey ?? gk.ProjNatOriginLongGeoKey ?? num(/(?:central_meridian|longitude_of_(?:center|origin))["',\s]+(-?[\d.]+)/i, cfg.lon0);
      p.lat0 = gk.ProjCenterLatGeoKey ?? gk.ProjNatOriginLatGeoKey ?? num(/latitude_of_(?:center|origin)["',\s]+(-?[\d.]+)/i, cfg.lat0);
      p.latTs = gk.ProjStdParallel1GeoKey ?? num(/standard_parallel_1["',\s]+(-?[\d.]+)/i, cfg.latTs);
      p.fe = gk.ProjFalseEastingGeoKey ?? 0; p.fn = gk.ProjFalseNorthingGeoKey ?? 0;
      const a = num(/(?:SPHEROID|semi_major)[^\d]*([\d.]{7,})/i, 0); if (a > 3e6) p.R = a;
    }
  }
  return { type, p, proj: makeProj(type, p) };
}

// pixel <-> map coords (north-up)
function affine(img) {
  const fd = img.getFileDirectory();
  if (fd.ModelTransformation) { const m = fd.ModelTransformation; return { x0: m[3], y0: m[7], sx: m[0], sy: -m[5] }; }
  const [i, j, , X, Y] = fd.ModelTiepoint, [sx, sy] = fd.ModelPixelScale;
  return { x0: X - i * sx, y0: Y + j * sy, sx, sy };
}

async function resample(file, maxW, bboxWanted, label) {
  const tiff = await fromFile(file), img = await tiff.getImage();
  const W = img.getWidth(), H = img.getHeight(), bands = img.getSamplesPerPixel();
  const nodata = img.getFileDirectory().GDAL_NODATA != null ? parseFloat(img.getFileDirectory().GDAL_NODATA) : null;
  const g = detect(img);
  let win, bbox;
  if (!g) {
    log(`  ! ${label}: file has NO georeferencing -> using bbox from config.json (placeholder data?)`);
    win = [0, 0, W, H]; bbox = { ...bboxWanted };
  } else {
    const a = affine(img), xs = [], ys = [];
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const [x, y] = g.proj.fwd(bboxWanted.west + (bboxWanted.east - bboxWanted.west) * i / 8, bboxWanted.south + (bboxWanted.north - bboxWanted.south) * j / 8);
      xs.push((x - a.x0) / a.sx); ys.push((a.y0 - y) / a.sy);
    }
    win = [Math.max(0, Math.floor(Math.min(...xs))), Math.max(0, Math.floor(Math.min(...ys))),
           Math.min(W, Math.ceil(Math.max(...xs))), Math.min(H, Math.ceil(Math.max(...ys)))];
    if (win[2] - win[0] < 2 || win[3] - win[1] < 2) throw new Error(`${label}: requested bbox is outside this file's extent`);
    const cs = [[win[0], win[1]], [win[2], win[1]], [win[0], win[3]], [win[2], win[3]]].map(([px, py]) => g.proj.inv(a.x0 + px * a.sx, a.y0 - py * a.sy));
    bbox = { west: Math.min(...cs.map((c) => c[0])), east: Math.max(...cs.map((c) => c[0])), south: Math.min(...cs.map((c) => c[1])), north: Math.max(...cs.map((c) => c[1])) };
    log(`  ${label}: ${g.type} projection, source ${W}x${H}, window ${win[2] - win[0]}x${win[3] - win[1]}px, lon ${bbox.west.toFixed(4)}..${bbox.east.toFixed(4)} lat ${bbox.south.toFixed(4)}..${bbox.north.toFixed(4)}`);
  }
  const sw = win[2] - win[0], sh = win[3] - win[1];
  const ow = Math.min(maxW, sw), oh = Math.max(2, Math.round(sh * (ow / sw)));
  const outBands = Math.min(bands, 3);
  const out = Array.from({ length: outBands }, () => new Float32Array(ow * oh));
  const CH = 1024; let orow = 0;
  for (let r = win[1]; r < win[3]; r += CH) {
    process.stdout.write(`\r  ${label}: reading rows ${Math.round(((r - win[1]) / sh) * 100)}%   `);
    const r1 = Math.min(win[3], r + CH), orow1 = Math.round((r1 - win[1]) * (oh / sh)), h = orow1 - orow;
    if (h > 0) {
      const ras = await img.readRasters({ window: [win[0], r, win[2], r1], width: ow, height: h, samples: [...Array(outBands).keys()], resampleMethod: 'bilinear' });
      for (let b = 0; b < outBands; b++) out[b].set(ras[b], orow * ow);
    }
    orow = orow1;
  }
  process.stdout.write(`\r  ${label}: reading rows 100%   \n`);
  return { out, ow, oh, bbox, nodata, bands: outBands, isFloatOrWide: img.getBytesPerPixel() / bands > 1 || img.getSampleFormat?.()?.[0] === 3, georef: !!g };
}

// ---------- pick input files ----------
const tifs = fs.readdirSync(RAW).filter((f) => /\.tiff?$/i.test(f)).map((f) => ({ f, size: fs.statSync(path.join(RAW, f)).size }));
const pick = (re, not) => tifs.filter((t) => re.test(t.f) && !(not && not.test(t.f))).sort((a, b) => b.size - a.size)[0]?.f;
const orthoF = pick(/ortho|mosaic_?(?:25|image)|image/i), dtmF = pick(/dtm|dem|elev|height/i, /ortho|mola/i);
if (!dtmF && !orthoF) throw new Error('No .tif files found in data_raw/ (names must contain DTM or DEM for elevation, ortho for the image)');
log('DTM  :', dtmF); log('Ortho:', orthoF || '(none)');

// ---------- DTM -> dtm.bin + hazard.png ----------
const flat = () => { log('  ! No DTM in data_raw/ -> FLAT placeholder terrain and no hazard layer until a DTM is added'); const mid = (cfg.elevFallback[0] + cfg.elevFallback[1]) / 2; return { out: [new Float32Array(4).fill(mid)], ow: 2, oh: 2, bbox: { ...cfg.bbox }, nodata: null, isFloatOrWide: true }; };
const d = dtmF ? await resample(path.join(RAW, dtmF), cfg.dtmMaxWidth, cfg.bbox, 'DTM') : flat();
let elev = d.out[0];
if (d.nodata != null) { let mn = Infinity; for (const v of elev) if (v !== d.nodata && v < mn) mn = v; for (let i = 0; i < elev.length; i++) if (elev[i] === d.nodata) elev[i] = mn; }
let mn = Infinity, mx = -Infinity; for (const v of elev) { if (v < mn) mn = v; if (v > mx) mx = v; }
if (!d.isFloatOrWide && mx <= 255 && mn >= 0) {
  const [a, b] = cfg.elevFallback;
  log(`  ! DTM is 8-bit (0-255), not real metres -> mapped to ${a}..${b} m as a PLACEHOLDER`);
  for (let i = 0; i < elev.length; i++) elev[i] = a + (elev[i] / 255) * (b - a);
  mn = a; mx = b;
}
log(`  elevation ${mn.toFixed(1)} .. ${mx.toFixed(1)} m`);
fs.writeFileSync(`${OUT}/dtm.bin`, Buffer.from(new Float32Array(elev).buffer));

if (dtmF) {
const bb = d.bbox, lat0 = ((bb.south + bb.north) / 2) * D2R;
const dx = ((bb.east - bb.west) * D2R * cfg.radius * Math.cos(lat0)) / d.ow, dy = ((bb.north - bb.south) * D2R * cfg.radius) / d.oh;
const hz = new PNG({ width: d.ow, height: d.oh }); let red = 0;
for (let y = 0; y < d.oh; y++) for (let x = 0; x < d.ow; x++) {
  const i = y * d.ow + x, e = (xx, yy) => elev[Math.min(d.oh - 1, Math.max(0, yy)) * d.ow + Math.min(d.ow - 1, Math.max(0, xx))];
  const gx = (e(x + 1, y) - e(x - 1, y)) / (2 * dx), gy = (e(x, y + 1) - e(x, y - 1)) / (2 * dy);
  const s = Math.atan(Math.hypot(gx, gy)) * R2D;
  const c = s < 10 ? [46, 204, 113, 120] : s < 20 ? [241, 196, 15, 150] : (red++, [231, 76, 60, 170]);
  hz.data.set(c, i * 4);
}
fs.writeFileSync(`${OUT}/hazard.png`, PNG.sync.write(hz));
log(`  hazard: ${(red / (d.ow * d.oh) * 100).toFixed(1)}% of pixels > 20 deg`);
} else {
  fs.writeFileSync(`${OUT}/hazard.png`, PNG.sync.write(new PNG({ width: 2, height: 2 })));
}

// ---------- ortho -> ortho.png ----------
let orthoMeta = null;
if (orthoF) {
  const o = await resample(path.join(RAW, orthoF), cfg.orthoMaxWidth, cfg.bbox, 'Ortho');
  const lo = [], hi = [];
  for (let b = 0; b < o.bands; b++) {
    const vals = Array.from(o.out[b].filter((v) => v !== o.nodata && Number.isFinite(v)));
    const step = Math.max(1, Math.floor(vals.length / 50000)), s = vals.filter((_, i) => i % step === 0).sort((a, c) => a - c);
    lo.push(s[Math.floor(s.length * 0.02)] ?? 0); hi.push(s[Math.floor(s.length * 0.98)] ?? 255);
  }
  const png = new PNG({ width: o.ow, height: o.oh });
  for (let i = 0; i < o.ow * o.oh; i++) {
    const v = (b) => { const bb2 = Math.min(b, o.bands - 1); return Math.max(0, Math.min(255, ((o.out[bb2][i] - lo[bb2]) / (hi[bb2] - lo[bb2] || 1)) * 255)); };
    png.data[i * 4] = v(0); png.data[i * 4 + 1] = v(1); png.data[i * 4 + 2] = v(2);
    png.data[i * 4 + 3] = o.nodata != null && o.out[0][i] === o.nodata ? 0 : 255;
  }
  fs.writeFileSync(`${OUT}/ortho.png`, PNG.sync.write(png));
  orthoMeta = { ...o.bbox, width: o.ow, height: o.oh };
}

// ---------- vectors + meta ----------
for (const f of fs.readdirSync(RAW).filter((f) => /\.geojson$/i.test(f))) fs.copyFileSync(`${RAW}/${f}`, `${OUT}/${f}`);
const csvF = fs.readdirSync(RAW).find((f) => /\.csv$/i.test(f));
if (csvF) {
  const [h, ...rows] = fs.readFileSync(`${RAW}/${csvF}`, 'utf8').trim().split(/\r?\n/); const keys = h.split(',');
  fs.writeFileSync(`${OUT}/coordinates.json`, JSON.stringify(rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [keys[i], v]))), null, 1));
}
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({
  dtm: { ...d.bbox, width: d.ow, height: d.oh, elevMin: mn, elevMax: mx },
  ortho: orthoMeta || { ...d.bbox, width: d.ow, height: d.oh },
  hasOrtho: !!orthoMeta,
  inputs: fingerprint,
}));
log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
