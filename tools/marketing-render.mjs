/* Produce annotated product images (for listings, social, etc.) from the real
 * app: renders a coaster design, then draws callout labels with curved arrows
 * pointing at whichever feature each callout names.
 *
 *   node tools/marketing-render.mjs            # all presets -> docs/marketing/
 *   node tools/marketing-render.mjs tahoe      # just one
 *
 * Lake outlines come from Natural Earth (public domain) so the images can be
 * used commercially without attribution; the app itself uses OpenStreetMap,
 * which does require credit. Depth/area figures below are published values —
 * check them before publishing.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8947;
const LAKES = JSON.parse(readFileSync(join(root, 'tools', 'marketing-lakes.json'), 'utf8'));

/* Each callout points at a feature; the label parks just outside the rim, in
 * that feature's direction unless `angle` (deg, 0 = right, -90 = top) sets the
 * composition explicitly. Positions in `infoboxPos` etc. are coaster mm. */
const PRESETS = {
  tahoe: {
    file: 'listing-1-any-lake.png',
    lake: 'tahoe', name: 'Lake Tahoe', region: 'California',
    top: 'California', bottom: 'Lake Tahoe',
    depth: '1,645 ft', area: '191 sq mi',
    wood: true, smoothing: 0.25, mapScale: 0.82, mapPan: [14, 0],
    infobox: { layout: 'stacked', aspect: 1, rot: 0, scale: 0.8 }, infoboxPos: [30, 54],
    callouts: [
      { text: 'Any lake engraved!', target: 'lake', angle: -62, gap: 8 },
      { text: 'Information box', target: 'infobox', angle: 186, gap: 9 }
    ]
  },
  george: {
    file: 'listing-2-narrow-lake.png',
    lake: 'george', name: 'Lake George', region: 'New York',
    top: 'New York', bottom: 'Lake George',
    depth: '187 ft', area: '44 sq mi',
    wood: true, smoothing: 0.25, mapScale: 0.9, mapPan: [16, 0],
    infobox: { layout: 'stacked', aspect: 1, rot: 0, scale: 0.78 }, infoboxPos: [28, 52],
    callouts: [
      { text: 'Any lake engraved!', target: 'lake', angle: -55, gap: 8 },
      { text: 'Information box', target: 'infobox', angle: 184, gap: 9 }
    ]
  },
  seneca: {
    file: 'listing-3-line-art.png',
    lake: 'seneca', name: 'Seneca Lake', region: 'New York',
    top: 'New York', bottom: 'Seneca Lake',
    depth: '618 ft', area: '66.9 sq mi',
    wood: false, smoothing: 0.25, mapScale: 0.88, mapPan: [15, 0],
    infobox: { layout: 'stacked', aspect: 1, rot: 0, scale: 0.8 }, infoboxPos: [29, 52],
    callouts: [
      { text: 'Any lake engraved!', target: 'lake', angle: -58, gap: 8 },
      { text: 'Information box', target: 'infobox', angle: 185, gap: 9 }
    ]
  },
  winni: {
    file: 'listing-4-features.png',
    lake: 'winni', name: 'Lake Winnipesaukee', region: 'New Hampshire',
    top: 'New Hampshire', bottom: 'Winnipesaukee',
    depth: '180 ft', area: '69 sq mi',
    wood: true, smoothing: 0.2, mapScale: 0.68, mapPan: [10, -9],
    compass: true, compassPos: [26, 36],
    scalebar: true, scalebarSize: 0.95, scalebarPos: [29, 68],
    pin: true, pinPos: [0.31, 0.52],
    infobox: { layout: 'wide', aspect: 1, rot: 0, scale: 0.62 }, infoboxPos: [59, 71],
    callouts: [
      { text: 'Any lake engraved!', target: 'lake', angle: -62, gap: 8 },
      { text: 'Compass rose', target: 'compass', angle: -142, gap: 8 },
      { text: 'Mark your spot', target: 'pin', angle: 182, gap: 8 },
      { text: 'True scale bar', target: 'scalebar', angle: 146, gap: 8 },
      { text: 'Information box', target: 'infobox', angle: 74, gap: 9 }
    ]
  }
};

const only = process.argv[2];
const jobs = Object.entries(PRESETS).filter(([k]) => !only || k === only);
if (!jobs.length) {
  console.error(`unknown preset "${only}" — options: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const exe = process.env.CHROMIUM_PATH ||
  (process.env.PLAYWRIGHT_BROWSERS_PATH && `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium`);
let browser;
try { browser = await chromium.launch(); }
catch { browser = await chromium.launch({ executablePath: exe }); }

const outDir = join(root, 'docs', 'marketing');
mkdirSync(outDir, { recursive: true });

try {
  for (const [key, cfg] of jobs) {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 1100 }, deviceScaleFactor: 2
    });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
    await page.evaluate(() => window.__lakeApp.ready);

    await page.evaluate(([cfg, geo]) => {
      const app = window.__lakeApp, st = app.state;
      st.smoothing = cfg.smoothing;
      app.addLakeFromGeoJSON(geo, cfg.name, cfg.region, 'mk');
      app.setTexts(cfg.top, cfg.bottom);
      st.lakes[0].label.visible = false;      // name already reads on the arc
      st.woodPreview = cfg.wood;
      if (cfg.mapScale) st.view.scaleMul = cfg.mapScale;
      if (cfg.mapPan) { st.view.tx = cfg.mapPan[0]; st.view.ty = cfg.mapPan[1]; }
      st.infobox.on = true;
      Object.assign(st.infobox, cfg.infobox);
      st.infobox.depth = cfg.depth;
      st.infobox.area = cfg.area;
      if (cfg.infoboxPos) { st.infobox.x = cfg.infoboxPos[0]; st.infobox.y = cfg.infoboxPos[1]; }
      if (cfg.compass) {
        st.compass.on = true;
        if (cfg.compassPos) { st.compass.x = cfg.compassPos[0]; st.compass.y = cfg.compassPos[1]; }
      }
      if (cfg.scalebar) {
        st.scalebar.on = true;
        st.scalebar.size = cfg.scalebarSize || 1.1;
        if (cfg.scalebarPos) { st.scalebar.x = cfg.scalebarPos[0]; st.scalebar.y = cfg.scalebarPos[1]; }
      }
      if (cfg.pin) {
        const p = app.addPin();
        const f = cfg.pinPos || [0.4, 0.4];
        app.movePinMM(p.id, st.diameter * f[0], st.diameter * f[1]);
      }
      app.autoPlaceAll();
      // drop editing affordances so no selection rings land in the render
      st.selected = null;
      st.selectedPin = null;
      app.renderNow();
    }, [cfg, LAKES[cfg.lake]]);

    // compose the annotated canvas inside the app page (fonts are loaded here)
    await page.evaluate((cfg) => {
      const D = window.__lakeApp.state.diameter;
      const CAN = 170, off = (CAN - D) / 2;
      const C = { x: CAN / 2, y: CAN / 2 }, R = D / 2;
      const pv = document.getElementById('preview');
      const SVGNS = 'http://www.w3.org/2000/svg';
      const FONT = '"Montserrat Preview", "Segoe UI", system-ui, sans-serif';
      const INK = '#2b2118', ACCENT = '#b4682a';
      const SIZE = 5.0, MARGIN = 4;

      const holder = document.createElement('div');
      holder.id = 'marketing';
      holder.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;background:#fff';
      holder.innerHTML = `
        <svg xmlns="${SVGNS}" width="1000" height="1000" viewBox="0 0 ${CAN} ${CAN}">
          <defs>
            <radialGradient id="bg" cx="50%" cy="42%" r="72%">
              <stop offset="0%" stop-color="#fdfbf7"/>
              <stop offset="100%" stop-color="#efe7dc"/>
            </radialGradient>
            <filter id="blur" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="1.7"/>
            </filter>
            <clipPath id="coaster"><circle cx="${C.x}" cy="${C.y}" r="${R}"/></clipPath>
          </defs>
          <rect width="${CAN}" height="${CAN}" fill="url(#bg)"/>
          <circle cx="${C.x}" cy="${C.y + 1.6}" r="${R}" fill="#5b452e"
                  opacity="0.30" filter="url(#blur)"/>
          <g clip-path="url(#coaster)">
            <svg x="${off}" y="${off}" width="${D}" height="${D}"
                 viewBox="0 0 ${D} ${D}">${pv.innerHTML}</svg>
          </g>
          <g id="anno"></g>
        </svg>`;
      document.body.prepend(holder);
      const svg = holder.firstElementChild;
      const anno = svg.querySelector('#anno');

      // ---- feature lookup: the drawn outline of each callout target ----
      const SEL = {
        lake: '#pv-lakes path',
        infobox: '[data-extra="infobox"] path',
        compass: '[data-extra="compass"] path',
        scalebar: '[data-extra="scalebar"] path',
        pin: '[data-pin] path'
      };
      function centerOf(el) {
        const b = el.getBBox();
        return { x: b.x + b.width / 2 + off, y: b.y + b.height / 2 + off };
      }
      // nearest point on the feature's own outline — keeps arrows short and
      // stops them sweeping across the artwork
      function nearestOnOutline(el, from) {
        const L = el.getTotalLength();
        if (!L) return centerOf(el);
        const N = Math.min(600, Math.max(80, Math.round(L)));
        let best = null, bd = Infinity;
        for (let i = 0; i <= N; i++) {
          const p = el.getPointAtLength(L * i / N);
          const x = p.x + off, y = p.y + off;
          const d = Math.hypot(x - from.x, y - from.y);
          if (d < bd) { bd = d; best = { x, y }; }
        }
        return best;
      }

      function mk(tag, attrs) {
        const e = document.createElementNS(SVGNS, tag);
        for (const k in attrs) e.setAttribute(k, attrs[k]);
        return e;
      }

      cfg.callouts.forEach(function (c) {
        const el = pv.querySelector(SEL[c.target]);
        if (!el) return;
        const tc = centerOf(el);

        // park the label outside the rim, in the direction of its feature
        // (or at an explicit angle when the preset needs a tidy composition)
        const ang = c.angle !== undefined
          ? c.angle * Math.PI / 180
          : Math.atan2(tc.y - C.y, tc.x - C.x);
        const ca = Math.cos(ang), sa = Math.sin(ang);

        const text = mk('text', {
          x: 0, y: 0, 'font-family': FONT, 'font-size': SIZE, 'font-weight': 700,
          fill: INK, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'letter-spacing': 0.05
        });
        text.textContent = c.text;
        anno.appendChild(text);

        // push it out far enough that its own box clears the coaster: the
        // support distance of a box along `ang` is hw*|cos| + hh*|sin|
        const bb = text.getBBox();
        const hw = bb.width / 2, hh = bb.height / 2;
        const rad = R + (c.gap === undefined ? 4 : c.gap) +
                    Math.abs(hw * ca) + Math.abs(hh * sa);
        let lx = C.x + ca * rad;
        let ly = C.y + sa * rad;
        // …then keep the whole label on the canvas
        lx = Math.min(Math.max(lx, hw + MARGIN), CAN - hw - MARGIN);
        ly = Math.min(Math.max(ly, hh + MARGIN), CAN - hh - MARGIN);
        text.setAttribute('x', lx);
        text.setAttribute('y', ly);

        // arrow: from the label's edge to the nearest point on the feature
        const tip = nearestOnOutline(el, { x: lx, y: ly });
        let dx = tip.x - lx, dy = tip.y - ly;
        const dl = Math.hypot(dx, dy) || 1;
        const ux = dx / dl, uy = dy / dl;
        const halfW = bb.width / 2 + 1.4, halfH = bb.height / 2 + 1.2;
        // exit point on the label's box in the direction of the feature
        const scale = Math.min(Math.abs(halfW / (ux || 1e-6)), Math.abs(halfH / (uy || 1e-6)));
        const from = { x: lx + ux * scale, y: ly + uy * scale };
        const end = { x: tip.x - ux * 2.4, y: tip.y - uy * 2.4 };

        const bend = c.bend === undefined ? 0.16 : c.bend;
        const mx = (from.x + end.x) / 2, my = (from.y + end.y) / 2;
        const ex = end.x - from.x, ey = end.y - from.y;
        const ctrl = { x: mx - ey * bend, y: my + ex * bend };
        let tx = end.x - ctrl.x, ty = end.y - ctrl.y;
        const tl = Math.hypot(tx, ty) || 1;
        const hx = tx / tl, hy = ty / tl, px = -hy, py = hx;
        const H = 3.2, W = 1.4;
        const base = { x: end.x - hx * H, y: end.y - hy * H };
        anno.appendChild(mk('path', {
          d: `M${from.x} ${from.y}Q${ctrl.x} ${ctrl.y} ${base.x} ${base.y}`,
          fill: 'none', stroke: ACCENT, 'stroke-width': 0.85, 'stroke-linecap': 'round'
        }));
        anno.appendChild(mk('path', {
          d: `M${end.x} ${end.y}L${base.x + px * W} ${base.y + py * W}` +
             `L${base.x - px * W} ${base.y - py * W}Z`,
          fill: ACCENT
        }));
      });
    }, cfg);

    await page.waitForTimeout(250);
    await page.locator('#marketing > svg').screenshot({ path: join(outDir, cfg.file) });
    console.log('wrote docs/marketing/' + cfg.file);
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
