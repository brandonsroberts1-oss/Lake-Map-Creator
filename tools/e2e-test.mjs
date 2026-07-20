/* End-to-end smoke test: serves the app, injects synthetic lake geometry,
 * exports the SVG and validates it against laser/xTool compatibility rules.
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

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

// Use the environment's Chromium if the exact Playwright build isn't present
// (e.g. remote containers with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).
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

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.evaluate(() => window.__lakeApp.ready);
  console.log('App loaded, fonts parsed.');

  // Inject two synthetic elongated lakes (one with an island) + arc texts.
  await page.evaluate(() => {
    function blob(lon0, lat0, lenKm, widKm, angDeg, seed) {
      const n = 160, pts = [];
      const rot = angDeg * Math.PI / 180;
      let s = seed;
      const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
      const wob = Array.from({ length: 8 }, () => rnd() * 0.5 - 0.25);
      for (let i = 0; i < n; i++) {
        const t = i / n * 2 * Math.PI;
        let r = 1;
        for (let k = 0; k < 8; k++) r += wob[k] * Math.sin((k + 2) * t + k) * 0.35;
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
    const west = {
      type: 'Polygon',
      coordinates: [
        blob(-77.05, 42.65, 25, 3.2, 100, 7),
        blob(-77.05, 42.63, 2.2, 0.8, 100, 11).reverse() // island
      ]
    };
    const east = { type: 'Polygon', coordinates: [blob(-76.70, 42.72, 30, 4.0, 95, 23)] };
    window.__lakeApp.addLakeFromGeoJSON(west, 'West Lake', 'New York', 'test1');
    window.__lakeApp.addLakeFromGeoJSON(east, 'East Lake', null, 'test2');
    window.__lakeApp.setTexts('New York', 'The Finger Lakes');

    // boxed label inside the wider east lake
    window.__lakeApp.state.lakes[1].label.boxed = true;
    window.__lakeApp.autoPlaceAll();

    // synthetic street grid: residential + one primary + one service way
    const ways = [];
    for (let i = 0; i < 6; i++) {
      ways.push({ highway: 'residential', coords: [[-77.15 + i * 0.08, 42.45], [-77.15 + i * 0.08, 42.95]] });
      ways.push({ highway: 'residential', coords: [[-77.3, 42.48 + i * 0.07], [-76.45, 42.48 + i * 0.07]] });
    }
    ways.push({ highway: 'primary', coords: [[-77.4, 42.4], [-76.45, 43.0]] });
    ways.push({ highway: 'service', coords: [[-77.1, 42.55], [-76.8, 42.8]] });
    window.__lakeApp.state.streetOpts.enabled = true;
    document.getElementById('streets-on').checked = true;
    document.getElementById('streets-body').hidden = false;
    window.__lakeApp.setStreetsFromWays(ways);

    window.__lakeApp.addPin();
    window.__lakeApp.renderNow();
  });

  const stateInfo = await page.evaluate(() => ({
    lakes: window.__lakeApp.state.lakes.length,
    baseScale: window.__lakeApp.state.view.baseScale,
    previewPaths: document.querySelectorAll('#preview path').length
  }));
  check('two lakes registered', stateInfo.lakes === 2);
  check('view fitted (finite scale)', isFinite(stateInfo.baseScale) && stateInfo.baseScale > 0);
  check('preview rendered paths', stateInfo.previewPaths >= 5, `got ${stateInfo.previewPaths}`);

  mkdirSync(join(root, 'docs'), { recursive: true });
  await page.screenshot({ path: join(root, 'docs', 'screenshot.png') });

  // ---- export & validate ----
  const svg = await page.evaluate(() => window.__lakeApp.exportSVGString());
  writeFileSync(join(root, 'docs', 'sample-export.svg'), svg);

  check('xml declaration', svg.startsWith('<?xml version="1.0"'));
  check('mm width/height', /width="96\.52mm" height="96\.52mm"/.test(svg));
  check('matching viewBox', /viewBox="0 0 96\.52 96\.52"/.test(svg));
  for (const g of ['ENGRAVE_lakes', 'ENGRAVE_labels', 'ENGRAVE_arc_text',
                   'ENGRAVE_pins', 'SCORE_streets', 'CUT_outline']) {
    check(`group ${g}`, svg.includes(`id="${g}"`));
  }
  check('no <text> elements', !/<text[\s>]/.test(svg));
  check('no clipPath', !/clipPath/.test(svg));
  check('no <style> blocks', !/<style/.test(svg));
  check('no transform attributes', !/transform=/.test(svg));
  check('no raster images', !/<image/.test(svg));
  check('engrave color present', svg.includes('fill="#000000"'));
  check('cut color present', svg.includes('stroke="#FF0000"'));
  check('evenodd fill rule on lakes', /ENGRAVE_lakes[\s\S]*?fill-rule="evenodd"/.test(svg));

  const dMatches = [...svg.matchAll(/ d="([^"]+)"/g)].map(m => m[1]);
  check('has paths', dMatches.length >= 6, `got ${dMatches.length}`);
  let min = Infinity, max = -Infinity, nums = 0, maxDecimals = 0;
  for (const d of dMatches) {
    for (const t of d.match(/-?\d+(\.\d+)?/g) || []) {
      const v = parseFloat(t);
      nums++;
      if (v < min) min = v;
      if (v > max) max = v;
      const dec = (t.split('.')[1] || '').length;
      if (dec > maxDecimals) maxDecimals = dec;
    }
  }
  check('coordinates inside board', min >= -0.6 && max <= 97.2, `range ${min.toFixed(2)}..${max.toFixed(2)}`);
  check('≤3 decimal places', maxDecimals <= 3, `max ${maxDecimals}`);
  check('reasonable size', svg.length < 1.5e6, `${(svg.length / 1024).toFixed(0)} KB, ${nums} coords`);

  // island survived as a hole: lakes group should contain a compound path (≥2 subpaths)
  const lakesGroup = svg.match(/<g id="ENGRAVE_lakes">([\s\S]*?)<\/g>/)[1];
  const lakeSubpaths = [...lakesGroup.matchAll(/ d="([^"]+)"/g)].map(m => (m[1].match(/M/g) || []).length);
  check('island preserved as compound path', lakeSubpaths[0] >= 2, `subpaths ${lakeSubpaths.join(',')}`);
  check('boxed label knocks window out of lake', lakeSubpaths[1] >= 2, `subpaths ${lakeSubpaths.join(',')}`);

  // boxed label carries its rounded border band (text contours + 2 rect rings)
  const labelsGroup = svg.match(/<g id="ENGRAVE_labels">([\s\S]*?)<\/g>/)[1];
  const labelSubpaths = [...labelsGroup.matchAll(/ d="([^"]+)"/g)].map(m => (m[1].match(/M/g) || []).length);
  check('boxed label has border band', Math.max(...labelSubpaths) >= 10, `subpaths ${labelSubpaths.join(',')}`);

  // streets: blue score lines, service/paths excluded by default
  const streetsGroup = svg.match(/<g id="SCORE_streets">([\s\S]*?)<\/g>/)[1];
  check('streets stroked blue, no fill', /stroke="#0000FF"/.test(streetsGroup) && /fill="none"/.test(streetsGroup));
  const catIds = [...streetsGroup.matchAll(/id="streets_(\w+)"/g)].map(m => m[1]).sort();
  check('street categories: major+local only', catIds.join(',') === 'local,major', catIds.join(','));

  // enabling "service & paths" adds the minor category
  const svgMinor = await page.evaluate(() => {
    window.__lakeApp.state.streetOpts.minor = true;
    const s = window.__lakeApp.exportSVGString();
    window.__lakeApp.state.streetOpts.minor = false;
    return s;
  });
  check('minor toggle adds service ways', /id="streets_minor"/.test(svgMinor));

  // pin: compound path (body + knocked-out dot)
  const pinsGroup = svg.match(/<g id="ENGRAVE_pins">([\s\S]*?)<\/g>/)[1];
  const pinSubpaths = (pinsGroup.match(/ d="([^"]+)"/)[1].match(/M/g) || []).length;
  check('pin has knockout dot', pinSubpaths === 2, `subpaths ${pinSubpaths}`);

  // dragging the pin moves its geographic anchor
  const pinBefore = await page.evaluate(() => ({ ...window.__lakeApp.state.pins[0] }));
  {
    const pv2 = await page.locator('#preview').boundingBox();
    const D = 96.52, s = 4.8 / 20;
    const headMMy = D / 2 - 13.5 * s;
    const px = pv2.x + pv2.width / 2, py = pv2.y + (headMMy / D) * pv2.height;
    await page.mouse.move(px, py);
    await page.mouse.down();
    await page.mouse.move(px + 35, py - 20, { steps: 5 });
    await page.mouse.up();
  }
  const pinAfter = await page.evaluate(() => ({ ...window.__lakeApp.state.pins[0] }));
  check('pin drag moves anchor', Math.abs(pinAfter.px - pinBefore.px) > 1 &&
    Math.abs(pinAfter.py - pinBefore.py) > 1);

  // ---- robustness: MultiPolygon + dense ring + font switch + pan ----
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
      size2: svg2.length, fontChanged: svg3 !== svg2,
      coords2: (svg2.match(/-?\d+\.\d+/g) || []).length
    };
  });
  check('MultiPolygon lake added (2 parts)', robust.added && robust.parts === 2);
  check('13k-vertex lake adds fast', robust.addMs < 3000, `${robust.addMs.toFixed(0)} ms`);
  check('export fast', robust.exportMs < 3000, `${robust.exportMs.toFixed(0)} ms`);
  check('dense ring simplified in export', robust.coords2 < 26000, `${robust.coords2} coords`);
  check('font switch changes exported glyphs', robust.fontChanged);

  // pan interaction moves the map
  const before = await page.evaluate(() => ({ tx: window.__lakeApp.state.view.tx, ty: window.__lakeApp.state.view.ty }));
  const pv = await page.locator('#preview').boundingBox();
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  await page.mouse.down();
  await page.mouse.move(pv.x + pv.width / 2 + 40, pv.y + pv.height / 2 + 25, { steps: 4 });
  await page.mouse.up();
  const after = await page.evaluate(() => ({ tx: window.__lakeApp.state.view.tx, ty: window.__lakeApp.state.view.ty }));
  check('drag pans the map', Math.abs(after.tx - before.tx) > 1 && Math.abs(after.ty - before.ty) > 1);

  // The exported file itself renders cleanly in a fresh page
  await page.setContent(`<!DOCTYPE html><body style="margin:0;background:#ddd">${svg}</body>`);
  await page.setViewportSize({ width: 800, height: 800 });
  const svgEl = page.locator('svg');
  await svgEl.screenshot({ path: join(root, 'docs', 'export-render.png') });
  check('export renders standalone', await svgEl.count() === 1);

  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 400));

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
} finally {
  await browser.close();
  server.kill();
}
process.exit(failures ? 1 : 0);
