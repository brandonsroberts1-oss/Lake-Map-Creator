/* End-to-end smoke test: serves the app, injects synthetic lake geometry,
 * mocks Overpass for the streets UI, and validates exports against
 * laser/xTool compatibility rules.
 *   node tools/e2e-test.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8931;

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${ok || !extra ? '' : ' — ' + extra}`);
  if (!ok) failures++;
}
const groupsOf = svg => [...svg.matchAll(/<g id="([A-Z_a-z]+)"/g)].map(m => m[1]);
function coordStats(svg) {
  let min = Infinity, max = -Infinity, nums = 0, maxDecimals = 0;
  for (const m of svg.matchAll(/ d="([^"]+)"/g)) {
    for (const t of m[1].match(/-?\d+(\.\d+)?/g) || []) {
      const v = parseFloat(t);
      nums++;
      if (v < min) min = v;
      if (v > max) max = v;
      const dec = (t.split('.')[1] || '').length;
      if (dec > maxDecimals) maxDecimals = dec;
    }
  }
  return { min, max, nums, maxDecimals };
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const exe = process.env.CHROMIUM_PATH ||
  (process.env.PLAYWRIGHT_BROWSERS_PATH && `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium`);
let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ executablePath: exe });
}

try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  // Mock Overpass: a street grid around the test lake, incl. one primary
  // and one service way (any mirror hostname).
  const grid = [];
  for (let i = 0; i < 6; i++) {
    grid.push({ highway: 'residential', pts: [[-77.25 + i * 0.07, 42.48], [-77.25 + i * 0.07, 42.83]] });
    grid.push({ highway: 'residential', pts: [[-77.3, 42.5 + i * 0.06], [-76.8, 42.5 + i * 0.06]] });
  }
  grid.push({ highway: 'primary', pts: [[-77.35, 42.45], [-76.75, 42.86]] });
  grid.push({ highway: 'service', pts: [[-77.2, 42.55], [-76.9, 42.78]] });
  const overpassFixture = {
    version: 0.6,
    elements: grid.map((w, i) => ({
      type: 'way', id: i + 1, tags: { highway: w.highway },
      geometry: w.pts.map(p => ({ lon: p[0], lat: p[1] }))
    }))
  };
  let overpassCalls = 0;
  await page.route('**/api/interpreter', route => {
    overpassCalls++;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(overpassFixture) });
  });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.evaluate(() => window.__lakeApp.ready);
  console.log('App loaded, fonts parsed.');

  /* ================= PHASE 1: single lake, all extras ================= */
  await page.evaluate(() => {
    function blob(lon0, lat0, lenKm, widKm, angDeg, seed) {
      const n = 220, pts = [];
      const rot = angDeg * Math.PI / 180;
      let s = seed;
      const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
      const wob = Array.from({ length: 8 }, () => rnd() * 0.5 - 0.25);
      for (let i = 0; i < n; i++) {
        const t = i / n * 2 * Math.PI;
        let r = 1;
        for (let k = 0; k < 8; k++) r += wob[k] * Math.sin((k + 2) * t + k) * 0.35;
        // high-frequency "coastline" jitter that smoothing must tame
        r += 0.06 * Math.sin(41 * t) + 0.04 * Math.sin(83 * t + 1);
        const x = Math.cos(t) * lenKm / 2 * r;
        const y = Math.sin(t) * widKm / 2 * r;
        const rx = x * Math.cos(rot) - y * Math.sin(rot);
        const ry = x * Math.sin(rot) + y * Math.cos(rot);
        const lat = lat0 + ry / 110.574;
        const lon = lon0 + rx / (111.32 * Math.cos(lat0 * Math.PI / 180));
        pts.push([lon, lat]);
      }
      pts.push(pts[0].slice());
      return pts;
    }
    window.__testBlob = blob;
    const west = {
      type: 'Polygon',
      coordinates: [
        blob(-77.05, 42.65, 25, 3.2, 100, 7),
        blob(-77.05, 42.63, 2.2, 0.8, 100, 11).reverse()
      ]
    };
    window.__lakeApp.addLakeFromGeoJSON(west, 'West Lake', 'New York', 'test1',
      { maxdepth: '86' });
    window.__lakeApp.setTexts('New York', 'West Lake');
    window.__lakeApp.autoPlaceAll();
    const pin = window.__lakeApp.addPin();
    window.__lakeApp.movePinMM(pin.id, 38, 33); // on the west shoreline
    window.__lakeApp.renderNow();
  });

  // streets through the real UI toggle (mocked network)
  await page.check('#streets-on');
  await page.waitForFunction(() =>
    document.getElementById('streets-status').textContent.includes('loaded'), null, { timeout: 15000 });
  check('streets load via UI toggle', true);
  check('overpass endpoint was called', overpassCalls === 1, `calls: ${overpassCalls}`);

  // extras through the real UI
  await page.check('#scalebar-on');
  await page.check('#compass-on');
  await page.check('#infobox-on');
  await page.waitForFunction(() => document.getElementById('info-depth').value.length > 0,
    null, { timeout: 5000 });
  const info = await page.evaluate(() => ({
    depth: document.getElementById('info-depth').value,
    area: document.getElementById('info-area').value
  }));
  check('depth auto-filled from OSM tag (86 m)', info.depth === '282 ft', info.depth);
  check('area auto-computed', /sq mi$/.test(info.area) && parseFloat(info.area) > 5, info.area);

  // anchor emblem is a clean unioned silhouette (single outer ring + ring hole)
  const anchor = await page.evaluate(() => {
    const d = window.__lakeApp._anchorD(20, 0, 0);
    return { subpaths: (d.match(/M/g) || []).length, len: d.length };
  });
  check('anchor emblem builds (unioned outline + ring)', anchor.subpaths >= 3 && anchor.len > 200,
    `subpaths ${anchor.subpaths}, len ${anchor.len}`);

  // Bold text must use the real bold cut, NOT stacked copies of the regular
  // glyphs (that ghosted/doubled in xTool and would double-engrave).
  const boldInfo = await page.evaluate(() => {
    const s = 'LAKE GEORGE';
    const reg = window.__lakeApp._textD(s, 3, false);
    const bold = window.__lakeApp._textD(s, 3, true);
    const subs = d => (d.match(/M/g) || []).length;
    return { hasBold: window.__lakeApp._hasBoldFont(), regSubs: subs(reg), boldSubs: subs(bold),
             differs: reg !== bold };
  });
  check('real bold font is bundled', boldInfo.hasBold);
  check('bold text is a different cut, not the same outlines', boldInfo.differs);
  check('bold text has no stacked duplicate contours',
    boldInfo.boldSubs === boldInfo.regSubs,
    `regular ${boldInfo.regSubs} subpaths vs bold ${boldInfo.boldSubs}`);

  // non-Latin names fall back to the regular weight rather than tofu
  const fallback = await page.evaluate(() => {
    const s = 'Байкал';
    return { d: window.__lakeApp._textD(s, 3, true).length,
             same: window.__lakeApp._textD(s, 3, true) === window.__lakeApp._textD(s, 3, false) };
  });
  check('non-Latin text falls back to regular weight', fallback.same && fallback.d > 0);

  await page.evaluate(() => window.__lakeApp.renderNow());
  const svg1 = await page.evaluate(() => window.__lakeApp.exportSVGString());
  writeFileSync(join(root, 'docs', 'sample-export.svg'), svg1);

  for (const g of ['SCORE_streets', 'ENGRAVE_lakes', 'ENGRAVE_labels', 'ENGRAVE_arc_text',
                   'ENGRAVE_pins', 'ENGRAVE_scalebar', 'ENGRAVE_compass', 'ENGRAVE_infobox',
                   'CUT_outline']) {
    check(`phase1 group ${g}`, svg1.includes(`id="${g}"`));
  }

  // scale bar responds to its size slider (bigger => longer path extent)
  const sbSizes = await page.evaluate(() => {
    function ext(svg) {
      const g = svg.match(/<g id="ENGRAVE_scalebar">([\s\S]*?)<\/g>/);
      if (!g) return 0;
      const xs = [...g[1].matchAll(/[ML](-?\d+\.?\d*) /g)].map(m => parseFloat(m[1]));
      return Math.max(...xs) - Math.min(...xs);
    }
    window.__lakeApp.state.scalebar.size = 0.7;
    const small = ext(window.__lakeApp.exportSVGString());
    window.__lakeApp.state.scalebar.size = 2.0;
    const big = ext(window.__lakeApp.exportSVGString());
    window.__lakeApp.state.scalebar.size = 1;
    return { small, big };
  });
  check('scale bar grows with its size slider', sbSizes.big > sbSizes.small * 1.3,
    `small ${sbSizes.small.toFixed(1)} -> big ${sbSizes.big.toFixed(1)}`);

  // "integrate into info box": standalone scalebar group disappears, folded in
  const inbox = await page.evaluate(() => {
    document.getElementById('scalebar-inbox').checked = true;
    document.getElementById('scalebar-inbox').dispatchEvent(new Event('change'));
    return window.__lakeApp.exportSVGString();
  });
  check('scalebar in-box removes standalone group', !inbox.includes('ENGRAVE_scalebar'));
  check('scalebar in-box keeps info box', inbox.includes('ENGRAVE_infobox'));
  await page.evaluate(() => {
    document.getElementById('scalebar-inbox').checked = false;
    document.getElementById('scalebar-inbox').dispatchEvent(new Event('change'));
  });

  // snap grid quantises a dragged extra to grid multiples
  const snapped = await page.evaluate(() => {
    document.getElementById('snap-grid').checked = true;
    document.getElementById('snap-grid').dispatchEvent(new Event('change'));
    return true;
  });
  {
    const pv = await page.locator('#preview').boundingBox();
    const D = 96.52, step = D / 24;
    const cx = await page.evaluate(() => window.__lakeApp.state.compass.x == null ? 96.52 * 0.76 : window.__lakeApp.state.compass.x);
    const cy = await page.evaluate(() => window.__lakeApp.state.compass.y == null ? 96.52 * 0.40 : window.__lakeApp.state.compass.y);
    const sx = pv.x + cx / D * pv.width, sy = pv.y + cy / D * pv.height;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 17, sy - 11, { steps: 5 });
    await page.mouse.up();
    const pos = await page.evaluate(() => ({ x: window.__lakeApp.state.compass.x, y: window.__lakeApp.state.compass.y }));
    const onGrid = Math.abs(pos.x / step - Math.round(pos.x / step)) < 1e-6 &&
                   Math.abs(pos.y / step - Math.round(pos.y / step)) < 1e-6;
    check('snap grid quantises dragged position', onGrid, `x=${pos.x.toFixed(2)} y=${pos.y.toFixed(2)} step=${step.toFixed(2)}`);
  }
  await page.evaluate(() => {
    document.getElementById('snap-grid').checked = false;
    document.getElementById('snap-grid').dispatchEvent(new Event('change'));
    window.__lakeApp.state.compass.x = null;
    window.__lakeApp.state.compass.y = null;
  });

  // smoothing melts high-frequency shoreline noise: total turning angle of
  // the outer ring must drop well below the unsmoothed version
  function outerRingTurning(svgStr) {
    const d = svgStr.match(/<g id="ENGRAVE_lakes">[\s\S]*?d="([^"]+)"/)[1];
    const outerD = d.slice(0, d.indexOf('Z'));
    const p = [...outerD.matchAll(/[ML](-?\d+\.?\d*) (-?\d+\.?\d*)/g)]
      .map(m => [parseFloat(m[1]), parseFloat(m[2])]);
    let turn = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
      const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
      const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
      if (l1 < 1e-9 || l2 < 1e-9) continue;
      const cross = v1[0] * v2[1] - v1[1] * v2[0];
      const dot = v1[0] * v2[0] + v1[1] * v2[1];
      turn += Math.abs(Math.atan2(cross, dot));
    }
    return turn;
  }
  const rawAndMax = await page.evaluate(() => {
    window.__lakeApp.state.smoothing = 0;
    const raw = window.__lakeApp.exportSVGString();
    window.__lakeApp.state.smoothing = 1;
    const max = window.__lakeApp.exportSVGString();
    window.__lakeApp.state.smoothing = 0.6;
    return { raw, max };
  });
  const turnSmooth = outerRingTurning(svg1);
  const turnRaw = outerRingTurning(rawAndMax.raw);
  const turnMax = outerRingTurning(rawAndMax.max);
  check('default smoothing reduces shoreline noise', turnSmooth < turnRaw * 0.55,
    `raw ${turnRaw.toFixed(1)} rad -> smooth ${turnSmooth.toFixed(1)} rad`);
  check('max smoothing melts jagged noise', turnMax < 45,
    `${turnMax.toFixed(1)} rad at slider 100%`);

  const s1 = coordStats(svg1);
  check('phase1 coords inside board', s1.min >= -0.6 && s1.max <= 97.2,
    `range ${s1.min.toFixed(2)}..${s1.max.toFixed(2)}`);

  mkdirSync(join(root, 'docs'), { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(root, 'docs', 'screenshot.png') });

  /* ================= PHASE 2: two lakes ================= */
  await page.evaluate(() => {
    const blob = window.__testBlob;
    const east = { type: 'Polygon', coordinates: [blob(-76.70, 42.72, 30, 4.0, 95, 23)] };
    window.__lakeApp.addLakeFromGeoJSON(east, 'East Lake', null, 'test2');
    window.__lakeApp.setTexts('New York', 'The Finger Lakes');
    window.__lakeApp.state.lakes[1].label.boxed = true;
    window.__lakeApp.autoPlaceAll();
    // replace mocked streets with injected ways (tests the injection hook too)
    window.__lakeApp.setStreetsFromWays([
      { highway: 'residential', coords: [[-77.3, 42.55], [-76.45, 42.55]] },
      { highway: 'residential', coords: [[-77.3, 42.75], [-76.45, 42.75]] },
      { highway: 'primary', coords: [[-77.4, 42.4], [-76.45, 43.0]] },
      { highway: 'service', coords: [[-77.1, 42.5], [-76.8, 42.85]] }
    ]);
    window.__lakeApp.renderNow();
  });

  const svg = await page.evaluate(() => window.__lakeApp.exportSVGString());

  check('xml declaration', svg.startsWith('<?xml version="1.0"'));
  check('mm width/height', /width="96\.52mm" height="96\.52mm"/.test(svg));
  check('matching viewBox', /viewBox="0 0 96\.52 96\.52"/.test(svg));
  check('infobox auto-suppressed with two lakes', !svg.includes('ENGRAVE_infobox'));
  check('scalebar persists', svg.includes('ENGRAVE_scalebar'));
  check('no <text> elements', !/<text[\s>]/.test(svg));
  check('no clipPath', !/clipPath/.test(svg));
  check('no <style> blocks', !/<style/.test(svg));
  check('no transform attributes', !/transform=/.test(svg));
  check('no raster images', !/<image/.test(svg));
  check('engrave color present', svg.includes('fill="#000000"'));
  check('cut color present', svg.includes('stroke="#FF0000"'));
  check('evenodd fill rule on lakes', /ENGRAVE_lakes[\s\S]*?fill-rule="evenodd"/.test(svg));

  const s2 = coordStats(svg);
  check('coords inside board', s2.min >= -0.6 && s2.max <= 97.2,
    `range ${s2.min.toFixed(2)}..${s2.max.toFixed(2)}`);
  check('≤3 decimal places', s2.maxDecimals <= 3, `max ${s2.maxDecimals}`);
  check('reasonable size', svg.length < 1.6e6, `${(svg.length / 1024).toFixed(0)} KB`);

  const lakesGroup = svg.match(/<g id="ENGRAVE_lakes">([\s\S]*?)<\/g>/)[1];
  const lakeSubpaths = [...lakesGroup.matchAll(/ d="([^"]+)"/g)].map(m => (m[1].match(/M/g) || []).length);
  check('island preserved as compound path', lakeSubpaths[0] >= 2, `subpaths ${lakeSubpaths.join(',')}`);
  check('boxed label carves the lake fill', lakeSubpaths[1] >= 2, `subpaths ${lakeSubpaths.join(',')}`);

  const labelsGroup = svg.match(/<g id="ENGRAVE_labels">([\s\S]*?)<\/g>/)[1];
  const labelSubpaths = [...labelsGroup.matchAll(/ d="([^"]+)"/g)].map(m => (m[1].match(/M/g) || []).length);
  check('boxed label has border band', Math.max(...labelSubpaths) >= 10, `subpaths ${labelSubpaths.join(',')}`);

  const streetsGroup = svg.match(/<g id="SCORE_streets">([\s\S]*?)<\/g>/)[1];
  check('streets stroked blue, no fill', /stroke="#0000FF"/.test(streetsGroup) && /fill="none"/.test(streetsGroup));
  const catIds = [...streetsGroup.matchAll(/id="streets_(\w+)"/g)].map(m => m[1]).sort();
  check('street categories: major+local only', catIds.join(',') === 'local,major', catIds.join(','));

  const svgMinor = await page.evaluate(() => {
    window.__lakeApp.state.streetOpts.minor = true;
    const s = window.__lakeApp.exportSVGString();
    window.__lakeApp.state.streetOpts.minor = false;
    return s;
  });
  check('minor toggle adds service ways', /id="streets_minor"/.test(svgMinor));

  const pinsGroup = svg.match(/<g id="ENGRAVE_pins">([\s\S]*?)<\/g>/)[1];
  const pinSubpaths = (pinsGroup.match(/ d="([^"]+)"/)[1].match(/M/g) || []).length;
  check('pin has knockout dot', pinSubpaths === 2, `subpaths ${pinSubpaths}`);

  /* ---- robustness: MultiPolygon + dense ring + font switch ---- */
  const robust = await page.evaluate(() => {
    function densering(lon0, lat0, rKm, n) {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const t = i / n * 2 * Math.PI;
        const r = rKm * (1 + 0.25 * Math.sin(5 * t) + 0.08 * Math.sin(31 * t));
        const lat = lat0 + Math.sin(t) * r / 110.574;
        const lon = lon0 + Math.cos(t) * r / (111.32 * Math.cos(lat0 * Math.PI / 180));
        pts.push([lon, lat]);
      }
      pts.push(pts[0].slice());
      return pts;
    }
    const mp = {
      type: 'MultiPolygon',
      coordinates: [
        [densering(-76.4, 42.9, 6, 9000)],
        [densering(-76.45, 42.8, 2.5, 4000)]
      ]
    };
    const t0 = performance.now();
    const lk = window.__lakeApp.addLakeFromGeoJSON(mp, 'Dense Lake', null, 'test3');
    const addMs = performance.now() - t0;
    const t1 = performance.now();
    const svg2 = window.__lakeApp.exportSVGString();
    const exportMs = performance.now() - t1;
    window.__lakeApp.setFont('garamond');
    const svg3 = window.__lakeApp.exportSVGString();
    window.__lakeApp.setFont('baskerville');
    window.__lakeApp.removeLake(lk.id);
    return {
      added: !!lk, parts: lk ? lk.polys.length : 0, addMs, exportMs,
      size2: svg2.length, fontChanged: svg3 !== svg2
    };
  });
  check('MultiPolygon lake added (2 parts)', robust.added && robust.parts === 2);
  check('13k-vertex lake adds fast', robust.addMs < 4000, `${robust.addMs.toFixed(0)} ms`);
  check('export fast', robust.exportMs < 4000, `${robust.exportMs.toFixed(0)} ms`);
  check('font switch changes exported glyphs', robust.fontChanged);

  /* ---- interactions ---- */
  const pinBefore = await page.evaluate(() => ({ ...window.__lakeApp.state.pins[0] }));
  {
    const pv = await page.locator('#preview').boundingBox();
    const pinMM = await page.evaluate(() => {
      const p = window.__lakeApp.state.pins[0];
      return window.__lakeApp.pinScreenMM ? window.__lakeApp.pinScreenMM(p) : null;
    });
    // head sits 13.5/20*size above the tip; tip position from state via export art
    const D = 96.52;
    const head = await page.evaluate(() => {
      const artPin = document.querySelector('#pv-pins circle');
      return artPin ? { x: +artPin.getAttribute('cx'), y: +artPin.getAttribute('cy') } : null;
    });
    if (head) {
      const px = pv.x + head.x / D * pv.width, py = pv.y + head.y / D * pv.height;
      await page.mouse.move(px, py);
      await page.mouse.down();
      await page.mouse.move(px + 35, py - 20, { steps: 5 });
      await page.mouse.up();
    }
  }
  const pinAfter = await page.evaluate(() => ({ ...window.__lakeApp.state.pins[0] }));
  check('pin drag moves anchor', Math.abs(pinAfter.px - pinBefore.px) > 1 &&
    Math.abs(pinAfter.py - pinBefore.py) > 1);

  const before = await page.evaluate(() => ({ tx: window.__lakeApp.state.view.tx, ty: window.__lakeApp.state.view.ty }));
  {
    const pv = await page.locator('#preview').boundingBox();
    // pan from a point over open water background (upper-left quadrant)
    await page.mouse.move(pv.x + pv.width * 0.32, pv.y + pv.height * 0.30);
    await page.mouse.down();
    await page.mouse.move(pv.x + pv.width * 0.32 + 40, pv.y + pv.height * 0.30 + 25, { steps: 4 });
    await page.mouse.up();
  }
  const after = await page.evaluate(() => ({ tx: window.__lakeApp.state.view.tx, ty: window.__lakeApp.state.view.ty }));
  check('drag pans the map', Math.abs(after.tx - before.tx) > 1 && Math.abs(after.ty - before.ty) > 1);

  // exported file renders standalone (phase-1 rich version)
  await page.setContent(`<!DOCTYPE html><body style="margin:0;background:#ddd">${svg1}</body>`);
  await page.setViewportSize({ width: 800, height: 800 });
  const svgEl = page.locator('svg');
  await svgEl.screenshot({ path: join(root, 'docs', 'export-render.png') });
  check('export renders standalone', await svgEl.count() === 1);

  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 500));

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
} finally {
  await browser.close();
  server.kill();
}
process.exit(failures ? 1 : 0);
