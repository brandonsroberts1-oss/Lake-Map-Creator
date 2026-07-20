/* ============================================================
 * Lake Map Coaster Creator
 * Search lakes (OpenStreetMap) -> compose round coaster ->
 * export laser-ready SVG (all text as paths, mm-true size).
 * ============================================================ */
(function () {
'use strict';

/* ------------------------------------------------------------
 * Constants & fonts
 * ---------------------------------------------------------- */
var EDGE_MARGIN = 2.4;   // mm between rim and arc-text extents
var ARC_GAP = 2.2;       // mm between arc text band and map safe area
var SIDE_MARGIN = 8.0;   // mm horizontal map margin
var CUT_COLOR = '#FF0000';
var ENGRAVE_COLOR = '#000000';
var STREET_COLOR = '#0000FF'; // separate layer: set to Score in XCS

var OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
var STREET_CATS = [
  { key: 'major', label: 'highways',        re: /^(motorway|trunk|primary)(_link)?$/ },
  { key: 'main',  label: 'main roads',      re: /^(secondary|tertiary)(_link)?$/ },
  { key: 'local', label: 'local streets',   re: /^(residential|unclassified|living_street|pedestrian|road)$/ },
  { key: 'minor', label: 'service & paths', re: /^(service|track|cycleway|footway|path|bridleway|steps)$/ }
];
function streetCatOf(hw) {
  for (var i = 0; i < STREET_CATS.length; i++) {
    if (STREET_CATS[i].re.test(hw)) return STREET_CATS[i].key;
  }
  return null;
}

var FONT_DEFS = [
  { key: 'baskerville', name: 'Libre Baskerville', desc: 'closest to the sample coaster', data: 'LibreBaskerville' },
  { key: 'garamond',    name: 'EB Garamond',       desc: 'classic old-style serif',      data: 'EBGaramond' },
  { key: 'playfair',    name: 'Playfair Display',  desc: 'elegant high-contrast serif',  data: 'PlayfairDisplay' },
  { key: 'montserrat',  name: 'Montserrat',        desc: 'clean modern sans',            data: 'Montserrat' }
];

var fonts = {};       // key -> opentype.Font
var fontMetrics = {}; // key -> { capRatio } (cap height / em)

/* ------------------------------------------------------------
 * App state
 * ---------------------------------------------------------- */
var state = {
  diameter: 96.52,          // mm (3.8")
  lakes: [],                // see addLakeFromGeoJSON
  view: { baseScale: 1, scaleMul: 1, rotDeg: 0, tx: 0, ty: 0, center: [0, 0] },
  topText: '',
  bottomText: '',
  fontKey: 'baskerville',
  arcSize: 7.2,             // mm (em size of arc text)
  arcSpacing: 0.22,         // em letter spacing for arc text
  labelSize: 3.0,           // mm default label em size
  cutCircle: true,
  detailTol: 0.08,          // mm simplify tolerance
  minIsland: 0.5,           // mm^2 smallest kept island / ring
  woodPreview: true,
  selected: null,           // lake id whose label is being edited
  streets: { loaded: false, ways: [], bbox: null }, // ways: {cat, pts[projected]}
  streetOpts: { enabled: false, major: true, main: true, local: true, minor: false, width: 0.2 },
  pins: [],                 // {id, px, py} in projected coords (track the map)
  pinSize: 4.8,             // mm pin height
  selectedPin: null
};
var lakeSeq = 0;
var pinSeq = 0;

/* ------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------- */
function $(id) { return document.getElementById(id); }
function fmt(n) {
  var v = Math.round(n * 1000) / 1000;
  if (Object.is(v, -0)) v = 0;
  return String(v);
}
function deg2rad(d) { return d * Math.PI / 180; }
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function b64ToBuffer(b64) {
  var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/* ------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------- */
// Web-Mercator projection (shape-preserving); y flipped so north = up = -y.
var EARTH_R = 6378137;
function project(lon, lat) {
  var la = Math.max(-85, Math.min(85, lat));
  return [
    EARTH_R * deg2rad(lon),
    -EARTH_R * Math.log(Math.tan(Math.PI / 4 + deg2rad(la) / 2))
  ];
}
function unproject(p) {
  return [
    p[0] / EARTH_R * 180 / Math.PI,
    (2 * Math.atan(Math.exp(-p[1] / EARTH_R)) - Math.PI / 2) * 180 / Math.PI
  ];
}

// coaster mm -> projected coords (inverse of viewMatrix(true))
function invViewPoint(x, y) {
  var v = state.view;
  var s = Math.max(v.baseScale * v.scaleMul, 1e-12);
  var r = deg2rad(v.rotDeg);
  var m = viewMatrix(true);
  var dx = x - m[4], dy = y - m[5];
  var cos = Math.cos(r), sin = Math.sin(r);
  return [(cos * dx + sin * dy) / s, (-sin * dx + cos * dy) / s];
}

// lon/lat bounding box of the visible coaster disc (pad = growth factor)
function visibleLonLatBBox(pad) {
  var D = state.diameter, c = D / 2;
  var w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (var i = 0; i < 12; i++) {
    var a = i / 12 * 2 * Math.PI;
    var ll = unproject(invViewPoint(c + c * Math.cos(a) * (pad || 1), c + c * Math.sin(a) * (pad || 1)));
    if (ll[0] < w) w = ll[0];
    if (ll[0] > e) e = ll[0];
    if (ll[1] < s) s = ll[1];
    if (ll[1] > n) n = ll[1];
  }
  return { s: s, w: w, n: n, e: e };
}

function signedArea(pts) {
  var a = 0;
  for (var i = 0, n = pts.length; i < n; i++) {
    var p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function bboxOfRings(rings) {
  var b = [Infinity, Infinity, -Infinity, -Infinity];
  rings.forEach(function (r) {
    r.forEach(function (p) {
      if (p[0] < b[0]) b[0] = p[0];
      if (p[1] < b[1]) b[1] = p[1];
      if (p[0] > b[2]) b[2] = p[0];
      if (p[1] > b[3]) b[3] = p[1];
    });
  });
  return b;
}

// Douglas-Peucker on an open chain.
function dpChain(pts, tol) {
  var n = pts.length;
  if (n < 3) return pts.slice();
  var keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  var stack = [[0, n - 1]];
  while (stack.length) {
    var seg = stack.pop(), a = seg[0], b = seg[1];
    if (b - a < 2) continue;
    var ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var maxD = -1, maxI = -1;
    for (var i = a + 1; i < b; i++) {
      var px = pts[i][0] - ax, py = pts[i][1] - ay, d;
      if (len2 === 0) d = Math.sqrt(px * px + py * py);
      else {
        var t = (px * dx + py * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        var qx = px - t * dx, qy = py - t * dy;
        d = Math.sqrt(qx * qx + qy * qy);
      }
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tol) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  var out = [];
  for (var j = 0; j < n; j++) if (keep[j]) out.push(pts[j]);
  return out;
}

// Simplify a closed ring: anchor at two mutually distant points.
function simplifyRing(pts, tol) {
  if (tol <= 0 || pts.length < 8) return pts;
  var far = 0, fd = -1;
  for (var i = 1; i < pts.length; i++) {
    var dx = pts[i][0] - pts[0][0], dy = pts[i][1] - pts[0][1];
    var d = dx * dx + dy * dy;
    if (d > fd) { fd = d; far = i; }
  }
  var c1 = dpChain(pts.slice(0, far + 1), tol);
  var c2 = dpChain(pts.slice(far).concat([pts[0]]), tol);
  return c1.slice(0, -1).concat(c2.slice(0, -1));
}

/* ------------------------------------------------------------
 * View transform: projected coords -> coaster mm
 * ---------------------------------------------------------- */
function reserves() {
  var band = state.arcSize * 1.15 + ARC_GAP + EDGE_MARGIN;
  return {
    top: state.topText.trim() ? band : 5,
    bottom: state.bottomText.trim() ? band : 5
  };
}

function viewMatrix(includePan) {
  var v = state.view;
  var s = v.baseScale * v.scaleMul;
  var r = deg2rad(v.rotDeg);
  var cos = Math.cos(r) * s, sin = Math.sin(r) * s;
  var D = state.diameter, res = reserves();
  var cy = res.top + (D - res.top - res.bottom) / 2;
  var cx = D / 2;
  var C = v.center;
  // p' = Rot*s*(p - C) + (cx,cy) [+ pan]
  var e = cx - (cos * C[0] - sin * C[1]);
  var f = cy - (sin * C[0] + cos * C[1]);
  if (includePan !== false) { e += v.tx; f += v.ty; }
  return [cos, sin, -sin, cos, e, f];
}
function applyM(m, p) {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

// Describe an arc-text band (annular sector) for collision testing.
function arcBand(side) {
  var text = (side === 'top' ? state.topText : state.bottomText).trim();
  var font = currentFont();
  if (!text || !font) return null;
  var R = state.diameter / 2;
  var L = arcLayout(font, text, state.arcSize, state.arcSpacing);
  if (!L.glyphs.length || L.total <= 0) return null;
  var rb = side === 'top' ? R - EDGE_MARGIN - L.above : R - EDGE_MARGIN - L.below;
  if (rb < state.arcSize) rb = state.arcSize;
  // radial inner edge of the lettering + clearance gap
  var inner = (side === 'top' ? rb - L.below : rb - L.above) - ARC_GAP;
  var halfAng = Math.min(Math.PI * 0.49, L.total / (2 * rb)) + 0.08;
  return { inner: inner, halfAng: halfAng, centerAng: side === 'top' ? -Math.PI / 2 : Math.PI / 2 };
}

function pointAllowed(x, y, D, bands) {
  var c = D / 2;
  var dx = x - c, dy = y - c;
  var r = Math.hypot(dx, dy);
  if (r > c - EDGE_MARGIN - 0.6) return false;
  for (var i = 0; i < bands.length; i++) {
    var b = bands[i];
    if (r < b.inner) continue;
    var da = Math.abs(Math.atan2(dy, dx) - b.centerAng);
    if (da > Math.PI) da = 2 * Math.PI - da;
    if (da <= b.halfAng) return false;
  }
  return true;
}

function computeFit(resetPan) {
  if (!state.lakes.length) return;
  var all = [];
  state.lakes.forEach(function (lk) {
    lk.polys.forEach(function (poly) { all.push(poly.outer); });
  });
  // centroid of bbox in projected space
  var pb = bboxOfRings(all);
  state.view.center = [(pb[0] + pb[2]) / 2, (pb[1] + pb[3]) / 2];
  // rotate a decimated point set around the center at unit scale
  var r = deg2rad(state.view.rotDeg);
  var cos = Math.cos(r), sin = Math.sin(r);
  var pts = [];
  all.forEach(function (ring) {
    var step = Math.max(1, Math.floor(ring.length / (3000 / all.length + 1)));
    for (var i = 0; i < ring.length; i += step) {
      var x = ring[i][0] - state.view.center[0], y = ring[i][1] - state.view.center[1];
      pts.push([cos * x - sin * y, sin * x + cos * y]);
    }
  });
  var b = bboxOfRings([pts]);
  var w = Math.max(b[2] - b[0], 1e-9), h = Math.max(b[3] - b[1], 1e-9);

  var D = state.diameter, res = reserves();
  var safeH = D - res.top - res.bottom;
  var cx = D / 2, cy = res.top + safeH / 2;
  var sMax = Math.min((D - 2 * SIDE_MARGIN) / w, safeH / h) * 1.6;
  var bands = [arcBand('top'), arcBand('bottom')].filter(Boolean);

  // largest scale at which every lake point stays out of the rim margin
  // and out of the arc-text bands
  function fits(s) {
    for (var i = 0; i < pts.length; i++) {
      if (!pointAllowed(pts[i][0] * s + cx, pts[i][1] * s + cy, D, bands)) return false;
    }
    return true;
  }
  var lo = 0, hi = sMax;
  for (var it = 0; it < 28; it++) {
    var mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  state.view.baseScale = lo > 0 ? lo : Math.min((D - 2 * SIDE_MARGIN) / w, safeH / h);
  if (resetPan) { state.view.tx = 0; state.view.ty = 0; }
  geomCache = {};
}

/* ------------------------------------------------------------
 * Lake geometry -> mm rings (cached, pan-independent)
 * ---------------------------------------------------------- */
var geomCache = {};

function lakeRingsMM(lake) {
  var key = [state.view.baseScale, state.view.scaleMul, state.view.rotDeg,
             state.detailTol, state.minIsland, state.diameter,
             state.topText.trim() ? 1 : 0, state.bottomText.trim() ? 1 : 0].join('|');
  var hit = geomCache[lake.id];
  if (hit && hit.key === key) return hit.rings;

  var m = viewMatrix(false);
  var polys = [];
  lake.polys.forEach(function (poly) {
    var outer = simplifyRing(poly.outer.map(function (p) { return applyM(m, p); }), state.detailTol);
    if (outer.length < 3) return;
    var holes = [];
    poly.holes.forEach(function (hr) {
      var h = simplifyRing(hr.map(function (p) { return applyM(m, p); }), state.detailTol);
      if (h.length >= 3 && Math.abs(signedArea(h)) >= state.minIsland) holes.push(h);
    });
    polys.push({ outer: outer, holes: holes, area: Math.abs(signedArea(outer)) });
  });
  // keep the biggest outer ring even if tiny; drop other sub-threshold slivers
  var maxA = polys.reduce(function (mx, p) { return Math.max(mx, p.area); }, 0);
  polys = polys.filter(function (p) { return p.area >= state.minIsland || p.area === maxA; });

  // enforce opposite orientation (outer positive, holes negative) so both
  // even-odd and non-zero fill rules produce islands
  polys.forEach(function (p) {
    if (signedArea(p.outer) < 0) p.outer.reverse();
    p.holes.forEach(function (h) { if (signedArea(h) > 0) h.reverse(); });
  });

  geomCache[lake.id] = { key: key, rings: polys };
  return polys;
}

function lakePathD(lake) {
  var polys = lakeRingsMM(lake);
  var tx = state.view.tx, ty = state.view.ty;
  var d = '';
  polys.forEach(function (poly) {
    [poly.outer].concat(poly.holes).forEach(function (ring) {
      for (var i = 0; i < ring.length; i++) {
        d += (i === 0 ? 'M' : 'L') + fmt(ring[i][0] + tx) + ' ' + fmt(ring[i][1] + ty);
      }
      d += 'Z';
    });
  });
  return d;
}

// centroid + PCA axis of a lake in current mm space (pan included)
function lakeStatsMM(lake) {
  var polys = lakeRingsMM(lake);
  var pts = [];
  polys.forEach(function (p) { pts = pts.concat(p.outer); });
  if (!pts.length) return null;
  var tx = state.view.tx, ty = state.view.ty;
  var n = pts.length, mx = 0, my = 0;
  pts.forEach(function (p) { mx += p[0]; my += p[1]; });
  mx /= n; my /= n;
  var sxx = 0, sxy = 0, syy = 0;
  pts.forEach(function (p) {
    var dx = p[0] - mx, dy = p[1] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  });
  sxx /= n; sxy /= n; syy /= n;
  var tr = sxx + syy, det = sxx * syy - sxy * sxy;
  var l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
  var l2 = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
  var ex, ey;
  if (Math.abs(sxy) > 1e-12) { ex = l1 - syy; ey = sxy; }
  else if (sxx >= syy) { ex = 1; ey = 0; }
  else { ex = 0; ey = 1; }
  var el = Math.hypot(ex, ey); ex /= el; ey /= el;
  var minA = Infinity, maxA = -Infinity, minP = Infinity, maxP = -Infinity;
  pts.forEach(function (p) {
    var dx = p[0] - mx, dy = p[1] - my;
    var a = dx * ex + dy * ey, q = -dx * ey + dy * ex;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (q < minP) minP = q;
    if (q > maxP) maxP = q;
  });
  return {
    cx: mx + tx, cy: my + ty,
    ex: ex, ey: ey,
    halfLen: (maxA - minA) / 2, halfWid: (maxP - minP) / 2,
    elong: Math.sqrt(Math.max(l1, 1e-12) / Math.max(l2, 1e-12))
  };
}

function autoPlaceLabel(lake) {
  var st = lakeStatsMM(lake);
  if (!st) return;
  var lbl = lake.label;
  var ang = Math.atan2(st.ey, st.ex) * 180 / Math.PI;
  if (ang <= -90) ang += 180;
  if (ang > 90) ang -= 180;
  if (lbl.boxed) {
    // boxed labels sit at the lake's center, along its axis when elongated
    lbl.angle = st.elong < 1.8 ? 0 : Math.round(ang);
    lbl.dx = 0;
    lbl.dy = 0;
    return;
  }
  lbl.angle = st.elong < 1.25 ? 0 : Math.round(ang);
  var size = lbl.size || state.labelSize;
  var off = st.halfWid + size * 0.75 + 1.0;
  var px = -st.ey, py = st.ex; // perpendicular
  var D = state.diameter, c = D / 2;
  var c1 = [st.cx + px * off, st.cy + py * off];
  var c2 = [st.cx - px * off, st.cy - py * off];
  var d1 = Math.hypot(c1[0] - c, c1[1] - c);
  var d2 = Math.hypot(c2[0] - c, c2[1] - c);
  var pick = d1 <= d2 ? c1 : c2;
  lbl.dx = pick[0] - st.cx;
  lbl.dy = pick[1] - st.cy;
}

/* ------------------------------------------------------------
 * Streets (OpenStreetMap Overpass)
 * ---------------------------------------------------------- */
function streetStatus(msg) {
  var el = $('streets-status');
  if (el) el.textContent = msg || '';
}

// Overpass "way" elements (with .tags.highway and .geometry) -> state.streets
function applyStreetElements(elements, bb) {
  var ways = [], totalPts = 0;
  elements.forEach(function (el) {
    if (el.type !== 'way' || !el.geometry || !el.tags || !el.tags.highway) return;
    var cat = streetCatOf(el.tags.highway);
    if (!cat) return;
    var pts = el.geometry.map(function (g) { return project(g.lon, g.lat); });
    if (pts.length < 2) return;
    totalPts += pts.length;
    ways.push({ cat: cat, pts: pts });
  });
  // keep interaction snappy on dense urban areas
  var sc = state.view.baseScale * state.view.scaleMul || 1;
  if (totalPts > 45000) {
    ways.forEach(function (w) { w.pts = dpChain(w.pts, 0.05 / sc); });
  }
  state.streets = { loaded: true, ways: ways, bbox: bb };
  var counts = {};
  ways.forEach(function (w) { counts[w.cat] = (counts[w.cat] || 0) + 1; });
  streetStatus(ways.length ? ways.length + ' street segments loaded.' :
    'No streets found in this area.');
  render();
}

function fetchStreets() {
  if (!state.lakes.length) { streetStatus('Add a lake first, then load streets.'); return; }
  var bb = visibleLonLatBBox(1.06);
  var midLat = (bb.n + bb.s) / 2;
  var span = Math.max(bb.n - bb.s, (bb.e - bb.w) * Math.cos(deg2rad(midLat)));
  if (span > 0.6) {
    streetStatus('This view covers too much area for street data (' + span.toFixed(2) +
      '°). Streets are meant for a single small lake — zoom in first.');
    return;
  }
  streetStatus('Loading streets from OpenStreetMap…');
  var re = 'motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|road|service|track|cycleway|footway|path|bridleway|steps';
  var q = '[out:json][timeout:30];way["highway"~"^(' + re + ')(_link)?$"](' +
    [bb.s, bb.w, bb.n, bb.e].join(',') + ');out geom qt;';
  (function tryEndpoint(i) {
    fetch(OVERPASS_ENDPOINTS[i], {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (json) {
      applyStreetElements(json.elements || [], bb);
    }).catch(function (err) {
      if (i + 1 < OVERPASS_ENDPOINTS.length) tryEndpoint(i + 1);
      else streetStatus('Street data failed to load (' + (err.message || err) +
        '). Overpass may be busy — try again in a minute.');
    });
  })(0);
}

// Split a polyline into runs inside the allowed disc (rim margin + arc bands),
// with bisection-refined boundary points. Long segments are subdivided first.
function clipRuns(pts, D, bands) {
  var sub = [];
  for (var i = 0; i < pts.length; i++) {
    if (i) {
      var a = pts[i - 1], b = pts[i];
      var n = Math.min(48, Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.2));
      for (var k = 1; k <= n; k++) {
        sub.push([a[0] + (b[0] - a[0]) * k / (n + 1), a[1] + (b[1] - a[1]) * k / (n + 1)]);
      }
    }
    sub.push(pts[i]);
  }
  function boundary(out, ins) {
    var a = out, b = ins;
    for (var j = 0; j < 8; j++) {
      var mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (pointAllowed(mid[0], mid[1], D, bands)) b = mid; else a = mid;
    }
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  var runs = [], cur = null, prev = null, prevOk = false;
  for (var m = 0; m < sub.length; m++) {
    var p = sub[m];
    var ok = pointAllowed(p[0], p[1], D, bands);
    if (ok) {
      if (!cur) {
        cur = [];
        if (prev && !prevOk) cur.push(boundary(prev, p));
      }
      cur.push(p);
    } else if (cur) {
      if (prev && prevOk) cur.push(boundary(p, prev));
      runs.push(cur);
      cur = null;
    }
    prev = p; prevOk = ok;
  }
  if (cur) runs.push(cur);
  return runs;
}

// -> [{cat, d}] for currently enabled street categories, clipped & simplified
function streetPaths() {
  var o = state.streetOpts;
  if (!o.enabled || !state.streets.loaded || !state.streets.ways.length) return [];
  var m = viewMatrix(true);
  var D = state.diameter;
  var bands = [arcBand('top'), arcBand('bottom')].filter(Boolean);
  var byCat = {};
  state.streets.ways.forEach(function (w) {
    if (!o[w.cat]) return;
    var mm = w.pts.map(function (p) { return applyM(m, p); });
    clipRuns(mm, D, bands).forEach(function (run) {
      run = dpChain(run, state.detailTol * 0.6);
      if (run.length < 2) return;
      var len = 0;
      for (var i = 1; i < run.length; i++) len += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
      if (len < 1.2) return;
      var d = '';
      run.forEach(function (p, i) { d += (i ? 'L' : 'M') + fmt(p[0]) + ' ' + fmt(p[1]); });
      byCat[w.cat] = (byCat[w.cat] || '') + d;
    });
  });
  return STREET_CATS.filter(function (c) { return byCat[c.key]; })
    .map(function (c) { return { cat: c.key, d: byCat[c.key] }; });
}

// has the view moved away from the area streets were loaded for?
function streetsStale() {
  if (!state.streets.loaded || !state.streets.bbox) return false;
  var cur = visibleLonLatBBox(1);
  var b = state.streets.bbox;
  var margin = 0.02 * Math.max(b.n - b.s, b.e - b.w);
  return cur.s < b.s - margin || cur.w < b.w - margin ||
         cur.n > b.n + margin || cur.e > b.e + margin;
}

/* ------------------------------------------------------------
 * Text -> path (opentype.js)
 * ---------------------------------------------------------- */
function currentFont() { return fonts[state.fontKey]; }

function capHeightMM(font, size) {
  var key = state.fontKey;
  if (!fontMetrics[key]) {
    var p = font.getPath('H', 0, 0, 100).getBoundingBox();
    fontMetrics[key] = { capRatio: Math.max(0.5, (-p.y1) / 100) };
  }
  return fontMetrics[key].capRatio * size;
}

function commandsToD(cmds, m) {
  var d = '';
  cmds.forEach(function (c) {
    var p, p1, p2;
    switch (c.type) {
      case 'M': p = applyM(m, [c.x, c.y]); d += 'M' + fmt(p[0]) + ' ' + fmt(p[1]); break;
      case 'L': p = applyM(m, [c.x, c.y]); d += 'L' + fmt(p[0]) + ' ' + fmt(p[1]); break;
      case 'C':
        p1 = applyM(m, [c.x1, c.y1]); p2 = applyM(m, [c.x2, c.y2]); p = applyM(m, [c.x, c.y]);
        d += 'C' + fmt(p1[0]) + ' ' + fmt(p1[1]) + ' ' + fmt(p2[0]) + ' ' + fmt(p2[1]) + ' ' + fmt(p[0]) + ' ' + fmt(p[1]);
        break;
      case 'Q':
        p1 = applyM(m, [c.x1, c.y1]); p = applyM(m, [c.x, c.y]);
        d += 'Q' + fmt(p1[0]) + ' ' + fmt(p1[1]) + ' ' + fmt(p[0]) + ' ' + fmt(p[1]);
        break;
      case 'Z': d += 'Z'; break;
    }
  });
  return d;
}

/* Shape command builders (M/L/C only, affine-transformable).
 * dir=+1 traverses visually clockwise (positive shoelace area in our y-down
 * screen convention, matching enforced outer-ring winding); dir=-1 reversed. */
var KAPPA = 0.55228475;
function roundedRectCmds(w, h, r, dir) {
  var hw = w / 2, hh = h / 2;
  r = Math.max(0, Math.min(r, hw, hh));
  var k = r * KAPPA;
  var c = [];
  if (dir >= 0) {
    c.push({ type: 'M', x: -hw + r, y: -hh });
    c.push({ type: 'L', x: hw - r, y: -hh });
    c.push({ type: 'C', x1: hw - r + k, y1: -hh, x2: hw, y2: -hh + r - k, x: hw, y: -hh + r });
    c.push({ type: 'L', x: hw, y: hh - r });
    c.push({ type: 'C', x1: hw, y1: hh - r + k, x2: hw - r + k, y2: hh, x: hw - r, y: hh });
    c.push({ type: 'L', x: -hw + r, y: hh });
    c.push({ type: 'C', x1: -hw + r - k, y1: hh, x2: -hw, y2: hh - r + k, x: -hw, y: hh - r });
    c.push({ type: 'L', x: -hw, y: -hh + r });
    c.push({ type: 'C', x1: -hw, y1: -hh + r - k, x2: -hw + r - k, y2: -hh, x: -hw + r, y: -hh });
  } else {
    c.push({ type: 'M', x: hw - r, y: -hh });
    c.push({ type: 'L', x: -hw + r, y: -hh });
    c.push({ type: 'C', x1: -hw + r - k, y1: -hh, x2: -hw, y2: -hh + r - k, x: -hw, y: -hh + r });
    c.push({ type: 'L', x: -hw, y: hh - r });
    c.push({ type: 'C', x1: -hw, y1: hh - r + k, x2: -hw + r - k, y2: hh, x: -hw + r, y: hh });
    c.push({ type: 'L', x: hw - r, y: hh });
    c.push({ type: 'C', x1: hw - r + k, y1: hh, x2: hw, y2: hh - r + k, x: hw, y: hh - r });
    c.push({ type: 'L', x: hw, y: -hh + r });
    c.push({ type: 'C', x1: hw, y1: -hh + r - k, x2: hw - r + k, y2: -hh, x: hw - r, y: -hh });
  }
  c.push({ type: 'Z' });
  return c;
}

function circleCmds(cx, cy, r, dir) {
  var k = r * KAPPA, d = dir >= 0 ? 1 : -1;
  return [
    { type: 'M', x: cx + r, y: cy },
    { type: 'C', x1: cx + r, y1: cy + d * k, x2: cx + k, y2: cy + d * r, x: cx, y: cy + d * r },
    { type: 'C', x1: cx - k, y1: cy + d * r, x2: cx - r, y2: cy + d * k, x: cx - r, y: cy },
    { type: 'C', x1: cx - r, y1: cy - d * k, x2: cx - k, y2: cy - d * r, x: cx, y: cy - d * r },
    { type: 'C', x1: cx + k, y1: cy - d * r, x2: cx + r, y2: cy - d * k, x: cx + r, y: cy },
    { type: 'Z' }
  ];
}

// Map pin, tip at origin pointing to the location, body above (height h mm).
// Outer body + knocked-out center dot (opposite winding => works in any fill rule).
function pinCmds(h) {
  var s = h / 20;
  function t(x, y) { return { x: (x - 12) * s, y: (y - 22) * s }; }
  var base = [
    { type: 'M', p: [12, 2] },
    { type: 'C', p: [8.13, 2, 5, 5.13, 5, 8.5] },
    { type: 'C', p: [5, 13.75, 12, 22, 12, 22] },
    { type: 'C', p: [12, 22, 19, 13.75, 19, 8.5] },
    { type: 'C', p: [19, 5.13, 15.87, 2, 12, 2] },
    { type: 'Z', p: [] }
  ].map(function (c) {
    if (c.type === 'Z') return { type: 'Z' };
    if (c.type === 'M') { var m = t(c.p[0], c.p[1]); return { type: 'M', x: m.x, y: m.y }; }
    var p1 = t(c.p[0], c.p[1]), p2 = t(c.p[2], c.p[3]), p = t(c.p[4], c.p[5]);
    return { type: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y };
  });
  // body traverses counter-clockwise (negative); dot clockwise (positive)
  var dot = t(12, 8.5);
  return base.concat(circleCmds(dot.x, dot.y, 2.6 * s, 1));
}

// Straight label centered at (cx,cy), rotated by angleDeg.
function straightTextD(font, text, size, cx, cy, angleDeg) {
  if (!text) return '';
  var w = font.getAdvanceWidth(text, size, { kerning: true });
  var cap = capHeightMM(font, size);
  var path = font.getPath(text, -w / 2, cap / 2, size, { kerning: true });
  var r = deg2rad(angleDeg);
  var cos = Math.cos(r), sin = Math.sin(r);
  return commandsToD(path.commands, [cos, sin, -sin, cos, cx, cy]);
}

// Layout metrics for a string of glyphs (advances incl. kerning/spacing,
// max extents above/below the baseline).
function arcLayout(font, text, size, spacingEm) {
  var scale = size / font.unitsPerEm;
  var glyphs = font.stringToGlyphs(text);
  var ls = (spacingEm || 0) * size;
  var adv = [], above = 0.001, below = 0.001, total = 0;
  for (var i = 0; i < glyphs.length; i++) {
    var g = glyphs[i];
    var a = (g.advanceWidth || 0) * scale;
    if (i < glyphs.length - 1) {
      a += font.getKerningValue(g, glyphs[i + 1]) * scale + ls;
    }
    adv.push(a);
    total += a;
    var bb = g.getPath(0, 0, size).getBoundingBox();
    if (isFinite(bb.y1)) above = Math.max(above, -bb.y1);
    if (isFinite(bb.y2)) below = Math.max(below, bb.y2);
  }
  return { glyphs: glyphs, adv: adv, total: total, above: above, below: below, scale: scale };
}

// Arc text around (cx,cy). side='top' | 'bottom'.
function arcTextD(font, text, size, cx, cy, rimR, side, spacingEm) {
  if (!text) return '';
  var L = arcLayout(font, text, size, spacingEm);
  var glyphs = L.glyphs, adv = L.adv, total = L.total,
      above = L.above, below = L.below, scale = L.scale;
  if (!glyphs.length) return '';

  // baseline radius: keep the string's outermost extent EDGE_MARGIN inside the rim
  var rb = side === 'top' ? rimR - EDGE_MARGIN - above : rimR - EDGE_MARGIN - below;
  if (rb < size) rb = size;

  var thetaC = side === 'top' ? -Math.PI / 2 : Math.PI / 2;
  var d = '', pen = 0;
  for (var j = 0; j < glyphs.length; j++) {
    var gw = (glyphs[j].advanceWidth || 0) * scale;
    var centerOff = pen + gw / 2 - total / 2;
    pen += adv[j];
    if (!glyphs[j].path || !glyphs[j].path.commands.length) continue;
    var theta = side === 'top' ? thetaC + centerOff / rb : thetaC - centerOff / rb;
    var rho = side === 'top' ? theta + Math.PI / 2 : theta - Math.PI / 2;
    var px = cx + rb * Math.cos(theta);
    var py = cy + rb * Math.sin(theta);
    var cos = Math.cos(rho), sin = Math.sin(rho);
    var cmds = glyphs[j].getPath(-gw / 2, 0, size).commands;
    d += commandsToD(cmds, [cos, sin, -sin, cos, px, py]);
  }
  return d;
}

function missingChars(font, text) {
  var out = [];
  Array.prototype.forEach.call(text, function (ch) {
    if (ch === ' ' || ch === ' ') return;
    if (font.charToGlyphIndex(ch) === 0 && out.indexOf(ch) === -1) out.push(ch);
  });
  return out;
}

/* ------------------------------------------------------------
 * Build all artwork pieces (shared by preview & export)
 * ---------------------------------------------------------- */
function buildArt() {
  var D = state.diameter, c = D / 2;
  var font = currentFont();
  var art = { lakes: [], labels: [], arcs: [], streets: [], pins: [], cut: null, warnings: [] };
  if (!font) return art;

  state.lakes.forEach(function (lake) {
    var d = lakePathD(lake);
    var lbl = lake.label;
    if (lbl.visible && lbl.text.trim()) {
      var st = lakeStatsMM(lake);
      if (st) {
        var size = lbl.size || state.labelSize;
        var cx = st.cx + lbl.dx, cy = st.cy + lbl.dy;
        var ld = straightTextD(font, lbl.text, size, cx, cy, lbl.angle);
        if (ld) {
          var entry = {
            id: lake.id, d: ld, cx: cx, cy: cy,
            angle: lbl.angle, size: size, boxed: !!lbl.boxed,
            w: font.getAdvanceWidth(lbl.text, size, { kerning: true })
          };
          if (lbl.boxed) {
            // rounded text box reversed out of the lake fill:
            // window (hole in lake) > engraved border band > text
            var cap = capHeightMM(font, size);
            var r = deg2rad(lbl.angle);
            var mtx = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), cx, cy];
            var bandW = Math.max(0.28, size * 0.09);
            var gap = Math.max(0.45, size * 0.14);
            var inHW = entry.w / 2 + 0.55 * size + 0.4;
            var inHH = cap / 2 + 0.42 * size + 0.3;
            var rIn = Math.min(1.4, inHH * 0.5);
            entry.d = ld +
              commandsToD(roundedRectCmds((inHW + bandW) * 2, (inHH + bandW) * 2, rIn + bandW, 1), mtx) +
              commandsToD(roundedRectCmds(inHW * 2, inHH * 2, rIn, -1), mtx);
            entry.hitHW = inHW + bandW + gap;
            entry.hitHH = inHH + bandW + gap;
            // knockout window in the lake fill (opposite winding to outer rings)
            d += commandsToD(roundedRectCmds((inHW + bandW + gap) * 2, (inHH + bandW + gap) * 2,
              rIn + bandW + gap, -1), mtx);
          } else {
            entry.hitHW = entry.w / 2 + 1.2;
            entry.hitHH = size * 0.85 + 0.8;
          }
          art.labels.push(entry);
        }
      }
      var miss = missingChars(font, lbl.text);
      if (miss.length) art.warnings.push('Font has no glyph for: ' + miss.join(' '));
    }
    if (d) art.lakes.push({ id: lake.id, d: d });
  });

  art.streets = streetPaths();

  var pm = viewMatrix(true);
  state.pins.forEach(function (pin) {
    var p = applyM(pm, [pin.px, pin.py]);
    var s = state.pinSize / 20;
    art.pins.push({
      id: pin.id,
      d: commandsToD(pinCmds(state.pinSize), [1, 0, 0, 1, p[0], p[1]]),
      x: p[0], y: p[1],
      headY: p[1] - 13.5 * s,
      headR: 7 * s + 0.6
    });
  });

  if (state.topText.trim()) {
    var td = arcTextD(font, state.topText.trim(), state.arcSize, c, c, c, 'top', state.arcSpacing);
    if (td) art.arcs.push({ d: td, which: 'top' });
    var m1 = missingChars(font, state.topText);
    if (m1.length) art.warnings.push('Font has no glyph for: ' + m1.join(' '));
  }
  if (state.bottomText.trim()) {
    var bd = arcTextD(font, state.bottomText.trim(), state.arcSize, c, c, c, 'bottom', state.arcSpacing);
    if (bd) art.arcs.push({ d: bd, which: 'bottom' });
    var m2 = missingChars(font, state.bottomText);
    if (m2.length) art.warnings.push('Font has no glyph for: ' + m2.join(' '));
  }

  if (state.cutCircle) {
    var r = c;
    art.cut = 'M' + fmt(c - r) + ' ' + fmt(c) +
      'A' + fmt(r) + ' ' + fmt(r) + ' 0 1 0 ' + fmt(c + r) + ' ' + fmt(c) +
      'A' + fmt(r) + ' ' + fmt(r) + ' 0 1 0 ' + fmt(c - r) + ' ' + fmt(c) + 'Z';
  }

  var capLbl = capHeightMM(font, state.labelSize);
  if (state.lakes.length && capLbl < 1.6) {
    art.warnings.push('Labels are very small (' + capLbl.toFixed(1) +
      ' mm caps) — they may engrave muddy. Consider a larger label size.');
  }
  return art;
}

/* ------------------------------------------------------------
 * Preview rendering
 * ---------------------------------------------------------- */
var renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(function () { renderQueued = false; doRender(); });
}

function doRender() {
  var svg = $('preview');
  var D = state.diameter, c = D / 2;
  svg.setAttribute('viewBox', '0 0 ' + fmt(D) + ' ' + fmt(D));
  var art = buildArt();
  var wood = state.woodPreview;
  var ink = wood ? '#2f1c0c' : '#000000';
  var s = '';

  s += '<defs><radialGradient id="woodg" cx="42%" cy="38%" r="75%">' +
       '<stop offset="0%" stop-color="#c99a63"/><stop offset="55%" stop-color="#b07f4e"/>' +
       '<stop offset="100%" stop-color="#8f6136"/></radialGradient></defs>';
  s += '<circle cx="' + fmt(c) + '" cy="' + fmt(c) + '" r="' + fmt(c) + '" fill="' +
       (wood ? 'url(#woodg)' : '#ffffff') + '"/>';
  if (wood) {
    for (var i = 1; i <= 4; i++) {
      s += '<circle cx="' + fmt(c * 0.94) + '" cy="' + fmt(c * 0.9) + '" r="' + fmt(c * i / 4.4) +
           '" fill="none" stroke="#7d5530" stroke-opacity="0.18" stroke-width="0.5"/>';
    }
  }

  s += '<g id="pv-streets" fill="none" stroke="' + ink + '" stroke-width="' +
       fmt(state.streetOpts.width) + '" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.85">';
  art.streets.forEach(function (st) { s += '<path d="' + st.d + '"/>'; });
  s += '</g><g id="pv-lakes">';
  art.lakes.forEach(function (l) {
    s += '<path d="' + l.d + '" fill="' + ink + '" fill-rule="evenodd"/>';
  });
  s += '</g><g id="pv-arcs">';
  art.arcs.forEach(function (a) { s += '<path d="' + a.d + '" fill="' + ink + '"/>'; });
  s += '</g><g id="pv-labels">';
  art.labels.forEach(function (l) {
    var sel = state.selected === l.id;
    s += '<g class="lbl-hit" data-lbl="' + l.id + '">';
    s += '<path d="' + l.d + '" fill="' + ink + '"/>';
    s += '<rect x="' + fmt(-l.hitHW) + '" y="' + fmt(-l.hitHH) + '" width="' + fmt(l.hitHW * 2) +
         '" height="' + fmt(l.hitHH * 2) + '" transform="translate(' + fmt(l.cx) + ' ' + fmt(l.cy) +
         ') rotate(' + fmt(l.angle) + ')" fill="rgba(0,0,0,0)" stroke="' +
         (sel ? '#3aa0ff' : 'none') + '" stroke-width="0.35" stroke-dasharray="1.2 0.8"/>';
    s += '</g>';
  });
  s += '</g><g id="pv-pins">';
  art.pins.forEach(function (p) {
    var sel = state.selectedPin === p.id;
    s += '<g class="pin-hit" data-pin="' + p.id + '">';
    s += '<path d="' + p.d + '" fill="' + ink + '"/>';
    s += '<circle cx="' + fmt(p.x) + '" cy="' + fmt(p.headY) + '" r="' + fmt(p.headR + 0.8) +
         '" fill="rgba(0,0,0,0)" stroke="' + (sel ? '#3aa0ff' : 'none') +
         '" stroke-width="0.35" stroke-dasharray="1 0.7"/>';
    s += '</g>';
  });
  s += '</g>';
  if (art.cut) {
    s += '<path d="' + art.cut + '" fill="none" stroke="' + (wood ? '#00000033' : CUT_COLOR) +
         '" stroke-width="0.3"/>';
  }
  svg.innerHTML = s;

  var wEl = $('text-warning');
  if (art.warnings.length) {
    wEl.hidden = false;
    wEl.textContent = art.warnings.join(' ');
  } else wEl.hidden = true;

  if (state.streetOpts.enabled && state.streets.loaded && streetsStale()) {
    streetStatus('Map view moved — click “Load streets for current view” to refresh.');
  }
}

/* ------------------------------------------------------------
 * SVG export (laser-ready)
 * ---------------------------------------------------------- */
function exportSVGString() {
  var D = state.diameter;
  var art = buildArt();
  var out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out += '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="' + fmt(D) +
         'mm" height="' + fmt(D) + 'mm" viewBox="0 0 ' + fmt(D) + ' ' + fmt(D) + '">\n';
  out += '<title>' + esc(state.bottomText || state.topText || 'Lake map coaster') + '</title>\n';
  out += '<desc>Lake map coaster — 1 unit = 1 mm. Black fills = engrave, blue lines = streets ' +
         '(set to score), red stroke = cut. Made with Lake Map Coaster Creator. ' +
         'Lake and street data © OpenStreetMap contributors (ODbL).</desc>\n';

  if (art.streets.length) {
    out += '<g id="SCORE_streets">\n';
    art.streets.forEach(function (st) {
      out += '<path id="streets_' + st.cat + '" d="' + st.d + '" fill="none" stroke="' + STREET_COLOR +
             '" stroke-width="' + fmt(state.streetOpts.width) +
             '" stroke-linecap="round" stroke-linejoin="round"/>\n';
    });
    out += '</g>\n';
  }
  if (art.lakes.length) {
    out += '<g id="ENGRAVE_lakes">\n';
    art.lakes.forEach(function (l) {
      out += '<path d="' + l.d + '" fill="' + ENGRAVE_COLOR + '" fill-rule="evenodd" stroke="none"/>\n';
    });
    out += '</g>\n';
  }
  if (art.labels.length) {
    out += '<g id="ENGRAVE_labels">\n';
    art.labels.forEach(function (l) {
      out += '<path d="' + l.d + '" fill="' + ENGRAVE_COLOR + '" stroke="none"/>\n';
    });
    out += '</g>\n';
  }
  if (art.arcs.length) {
    out += '<g id="ENGRAVE_arc_text">\n';
    art.arcs.forEach(function (a) {
      out += '<path d="' + a.d + '" fill="' + ENGRAVE_COLOR + '" stroke="none"/>\n';
    });
    out += '</g>\n';
  }
  if (art.pins.length) {
    out += '<g id="ENGRAVE_pins">\n';
    art.pins.forEach(function (p) {
      out += '<path d="' + p.d + '" fill="' + ENGRAVE_COLOR + '" stroke="none"/>\n';
    });
    out += '</g>\n';
  }
  if (art.cut) {
    out += '<g id="CUT_outline">\n<path d="' + art.cut + '" fill="none" stroke="' + CUT_COLOR +
           '" stroke-width="0.1"/>\n</g>\n';
  }
  out += '</svg>\n';
  return out;
}

function downloadSVG() {
  var svg = exportSVGString();
  window.__lastExportSVG = svg;
  var name = (state.bottomText || 'lake-map').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'lake-map';
  var blob = new Blob([svg], { type: 'image/svg+xml' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name + '-coaster.svg';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  $('export-status').textContent = 'Saved ' + a.download + ' — ready for xTool Creative Space.';
}

/* ------------------------------------------------------------
 * Lakes: add / remove
 * ---------------------------------------------------------- */
function ringsFromGeoJSON(geo) {
  // -> [ {outer:[[x,y]..], holes:[..]} ] in projected coords
  var polys = [];
  function projRing(r) {
    var out = [];
    for (var i = 0; i < r.length; i++) {
      var p = project(r[i][0], r[i][1]);
      if (i > 0 && p[0] === out[out.length - 1][0] && p[1] === out[out.length - 1][1]) continue;
      out.push(p);
    }
    // drop closing duplicate
    if (out.length > 1) {
      var a = out[0], b = out[out.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) out.pop();
    }
    return out;
  }
  function addPoly(coords) {
    if (!coords.length) return;
    var outer = projRing(coords[0]);
    if (outer.length < 3) return;
    var holes = [];
    for (var i = 1; i < coords.length; i++) {
      var h = projRing(coords[i]);
      if (h.length >= 3) holes.push(h);
    }
    polys.push({ outer: outer, holes: holes });
  }
  if (geo.type === 'Polygon') addPoly(geo.coordinates);
  else if (geo.type === 'MultiPolygon') geo.coordinates.forEach(addPoly);
  else if (geo.type === 'GeometryCollection') {
    (geo.geometries || []).forEach(function (g) {
      if (g.type === 'Polygon') addPoly(g.coordinates);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(addPoly);
    });
  }
  return polys;
}

function addLakeFromGeoJSON(geojson, name, region, uid) {
  var polys = ringsFromGeoJSON(geojson);
  if (!polys.length) return null;
  var lake = {
    id: 'lk' + (++lakeSeq),
    uid: uid || null,
    name: name || 'Lake',
    polys: polys,
    label: { text: name || 'Lake', dx: 0, dy: 0, angle: 0, size: null, visible: true }
  };
  state.lakes.push(lake);
  if (region && !state.topText) {
    state.topText = region;
    $('top-text').value = region;
  }
  if (!state.bottomText && state.lakes.length === 1) {
    state.bottomText = lake.name;
    $('bottom-text').value = lake.name;
  }
  computeFit(true);
  state.lakes.forEach(autoPlaceLabel);
  renderLakeList();
  render();
  return lake;
}

function removeLake(id) {
  state.lakes = state.lakes.filter(function (l) { return l.id !== id; });
  delete geomCache[id];
  if (state.selected === id) closeLabelEditor();
  if (state.lakes.length) { computeFit(true); state.lakes.forEach(autoPlaceLabel); }
  renderLakeList();
  render();
}

function renderLakeList() {
  var ul = $('lake-list');
  ul.innerHTML = '';
  state.lakes.forEach(function (lk) {
    var li = document.createElement('li');
    var span = document.createElement('span');
    span.className = 'lname';
    span.textContent = lk.name;
    var btn = document.createElement('button');
    btn.title = 'Remove';
    btn.textContent = '✕';
    btn.addEventListener('click', function () { removeLake(lk.id); });
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

/* ------------------------------------------------------------
 * Pins
 * ---------------------------------------------------------- */
function addPin() {
  var D = state.diameter;
  // tip lands at the coaster center, nudged so consecutive pins don't stack
  var off = (state.pins.length % 5) * 4;
  var p = invViewPoint(D / 2 + off, D / 2 + off);
  var pin = { id: 'pin' + (++pinSeq), px: p[0], py: p[1] };
  state.pins.push(pin);
  state.selectedPin = pin.id;
  renderPinList();
  render();
  return pin;
}

function removePin(id) {
  state.pins = state.pins.filter(function (p) { return p.id !== id; });
  if (state.selectedPin === id) state.selectedPin = null;
  renderPinList();
  render();
}

function renderPinList() {
  var ul = $('pin-list');
  if (!ul) return;
  ul.innerHTML = '';
  state.pins.forEach(function (pin, i) {
    var li = document.createElement('li');
    var span = document.createElement('span');
    span.className = 'lname';
    span.textContent = 'Pin ' + (i + 1) + ' — drag it onto the spot';
    var btn = document.createElement('button');
    btn.title = 'Remove pin';
    btn.textContent = '✕';
    btn.addEventListener('click', function () { removePin(pin.id); });
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

/* ------------------------------------------------------------
 * Nominatim search
 * ---------------------------------------------------------- */
function regionFromAddress(a) {
  if (!a) return '';
  return a.state || a.province || a.region || a.state_district || a.county || a.country || '';
}

function shortName(r) {
  if (r.name) return r.name;
  var dn = (r.display_name || '').split(',')[0];
  return dn || 'Lake';
}

function doSearch() {
  var q = $('search-input').value.trim();
  if (!q) return;
  var status = $('search-status');
  var list = $('search-results');
  list.innerHTML = '';
  status.textContent = 'Searching…';
  // polygon_threshold trims megabyte geometries server-side (~5.5 m tolerance)
  // while staying far below engraving resolution for small lakes
  var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&polygon_threshold=0.00005&addressdetails=1&limit=6&q=' +
    encodeURIComponent(q);
  fetch(url, { headers: { 'Accept': 'application/json' } })
    .then(function (res) {
      if (res.status === 429) throw new Error('Rate limited — wait a few seconds and try again.');
      if (!res.ok) throw new Error('Search failed (HTTP ' + res.status + ').');
      return res.json();
    })
    .then(function (rows) {
      var usable = rows.filter(function (r) {
        return r.geojson && (r.geojson.type === 'Polygon' || r.geojson.type === 'MultiPolygon');
      });
      if (!usable.length) {
        status.textContent = 'No lake outlines found. Try adding the region, e.g. “Keuka Lake New York”.';
        return;
      }
      status.textContent = 'Click a result to add it:';
      usable.forEach(function (r) {
        var li = document.createElement('li');
        var badge = document.createElement('span');
        badge.className = 'rtype';
        badge.textContent = r.type || r.class || '';
        li.appendChild(badge);
        li.appendChild(document.createTextNode(
          (r.display_name || '').length > 90 ? r.display_name.slice(0, 90) + '…' : (r.display_name || '')));
        li.addEventListener('click', function () {
          var uid = (r.osm_type || '') + (r.osm_id || '');
          if (uid && state.lakes.some(function (l) { return l.uid === uid; })) {
            status.textContent = 'That lake is already on the coaster.';
            return;
          }
          addLakeFromGeoJSON(r.geojson, shortName(r), regionFromAddress(r.address), uid);
          list.innerHTML = '';
          status.textContent = 'Added “' + shortName(r) + '”.';
        });
        list.appendChild(li);
      });
    })
    .catch(function (err) {
      status.textContent = String(err.message || err) +
        ' (Search needs internet access to nominatim.openstreetmap.org.)';
    });
}

/* ------------------------------------------------------------
 * Pointer interaction: pan map, drag labels, zoom
 * ---------------------------------------------------------- */
function setupPointer() {
  var svg = $('preview');
  var drag = null;

  function mmPerPx() {
    var r = svg.getBoundingClientRect();
    return state.diameter / r.width;
  }

  svg.addEventListener('pointerdown', function (ev) {
    var tp = ev.target.closest ? ev.target.closest('[data-pin]') : null;
    var t = !tp && ev.target.closest ? ev.target.closest('[data-lbl]') : null;
    if (tp) {
      var pid = tp.getAttribute('data-pin');
      var pin = state.pins.find(function (p) { return p.id === pid; });
      if (!pin) return;
      var mm0 = applyM(viewMatrix(true), [pin.px, pin.py]);
      drag = { kind: 'pin', id: pid, x: ev.clientX, y: ev.clientY,
               mx0: mm0[0], my0: mm0[1], moved: false };
    } else if (t) {
      var id = t.getAttribute('data-lbl');
      var lake = state.lakes.find(function (l) { return l.id === id; });
      if (!lake) return;
      drag = { kind: 'label', id: id, x: ev.clientX, y: ev.clientY,
               dx0: lake.label.dx, dy0: lake.label.dy, moved: false };
    } else if (state.lakes.length) {
      drag = { kind: 'pan', x: ev.clientX, y: ev.clientY,
               tx0: state.view.tx, ty0: state.view.ty };
    }
    if (drag) svg.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  svg.addEventListener('pointermove', function (ev) {
    if (!drag) return;
    var k = mmPerPx();
    var dx = (ev.clientX - drag.x) * k, dy = (ev.clientY - drag.y) * k;
    if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 3) drag.moved = true;
    if (drag.kind === 'pan') {
      state.view.tx = drag.tx0 + dx;
      state.view.ty = drag.ty0 + dy;
      render();
    } else if (drag.kind === 'pin') {
      var pin = state.pins.find(function (p) { return p.id === drag.id; });
      if (pin) {
        var pr = invViewPoint(drag.mx0 + dx, drag.my0 + dy);
        pin.px = pr[0];
        pin.py = pr[1];
        render();
      }
    } else {
      var lake = state.lakes.find(function (l) { return l.id === drag.id; });
      if (lake) {
        lake.label.dx = drag.dx0 + dx;
        lake.label.dy = drag.dy0 + dy;
        render();
      }
    }
  });

  svg.addEventListener('pointerup', function (ev) {
    if (drag && drag.kind === 'label' && !drag.moved) openLabelEditor(drag.id);
    if (drag && drag.kind === 'pin' && !drag.moved) {
      state.selectedPin = drag.id;
      render();
    }
    drag = null;
  });
  svg.addEventListener('pointercancel', function () { drag = null; });

  svg.addEventListener('wheel', function (ev) {
    if (!state.lakes.length) return;
    ev.preventDefault();
    var f = ev.deltaY < 0 ? 1.06 : 1 / 1.06;
    state.view.scaleMul = Math.min(1.8, Math.max(0.4, state.view.scaleMul * f));
    $('map-scale').value = state.view.scaleMul;
    $('map-scale-val').textContent = '×' + state.view.scaleMul.toFixed(2);
    render();
  }, { passive: false });
}

/* ------------------------------------------------------------
 * Label editor panel
 * ---------------------------------------------------------- */
function openLabelEditor(id) {
  var lake = state.lakes.find(function (l) { return l.id === id; });
  if (!lake) return;
  state.selected = id;
  var ed = $('label-editor');
  ed.hidden = false;
  $('lbl-text').value = lake.label.text;
  var size = lake.label.size || state.labelSize;
  $('lbl-size').value = size;
  $('lbl-size-val').textContent = size.toFixed(1) + ' mm';
  $('lbl-angle').value = lake.label.angle;
  $('lbl-angle-val').textContent = lake.label.angle + '°';
  $('lbl-visible').checked = lake.label.visible;
  $('lbl-boxed').checked = !!lake.label.boxed;
  render();
}
function closeLabelEditor() {
  state.selected = null;
  $('label-editor').hidden = true;
  render();
}
function selectedLake() {
  return state.lakes.find(function (l) { return l.id === state.selected; });
}

/* ------------------------------------------------------------
 * UI wiring
 * ---------------------------------------------------------- */
function bindUI() {
  $('search-btn').addEventListener('click', doSearch);
  $('search-input').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') doSearch();
  });

  $('top-text').addEventListener('input', function () {
    state.topText = this.value;
    computeFit(false);
    render();
  });
  $('bottom-text').addEventListener('input', function () {
    state.bottomText = this.value;
    computeFit(false);
    render();
  });

  function slider(id, valId, key, fmtFn, after) {
    $(id).addEventListener('input', function () {
      var v = parseFloat(this.value);
      state[key] = v;
      $(valId).textContent = fmtFn(v);
      if (after) after(v);
      render();
    });
    $(valId).textContent = fmtFn(parseFloat($(id).value));
  }
  slider('arc-size', 'arc-size-val', 'arcSize', function (v) { return v.toFixed(1) + ' mm'; },
    function () { computeFit(false); });
  slider('arc-spacing', 'arc-spacing-val', 'arcSpacing', function (v) { return v.toFixed(2) + ' em'; });
  slider('label-size', 'label-size-val', 'labelSize', function (v) { return v.toFixed(1) + ' mm'; });
  slider('detail', 'detail-val', 'detailTol', function (v) { return v.toFixed(2) + ' mm'; },
    function () { geomCache = {}; });
  slider('min-island', 'island-val', 'minIsland', function (v) { return v.toFixed(1) + ' mm²'; },
    function () { geomCache = {}; });

  $('map-scale').addEventListener('input', function () {
    state.view.scaleMul = parseFloat(this.value);
    $('map-scale-val').textContent = '×' + state.view.scaleMul.toFixed(2);
    render();
  });
  $('map-scale-val').textContent = '×1.00';
  $('map-rot').addEventListener('input', function () {
    state.view.rotDeg = parseFloat(this.value);
    $('map-rot-val').textContent = state.view.rotDeg + '°';
    computeFit(false);
    render();
  });
  $('map-rot-val').textContent = '0°';

  $('refit-btn').addEventListener('click', function () {
    state.view.scaleMul = 1;
    $('map-scale').value = 1;
    $('map-scale-val').textContent = '×1.00';
    computeFit(true);
    render();
  });
  $('autolabel-btn').addEventListener('click', function () {
    state.lakes.forEach(autoPlaceLabel);
    render();
  });

  $('diameter').addEventListener('input', function () {
    var v = parseFloat(this.value);
    if (!isFinite(v) || v < 20) return;
    state.diameter = v;
    $('diameter-in').textContent = '= ' + (v / 25.4).toFixed(2) + '″';
    $('preview-size-note').textContent = (v / 25.4).toFixed(2) + '″ (' + v.toFixed(2) + ' mm) round coaster';
    computeFit(false);
    render();
  });
  $('cut-circle').addEventListener('change', function () {
    state.cutCircle = this.checked;
    render();
  });
  $('wood-style').addEventListener('change', function () {
    state.woodPreview = this.checked;
    render();
  });

  // label editor
  $('lbl-text').addEventListener('input', function () {
    var lk = selectedLake();
    if (lk) { lk.label.text = this.value; render(); }
  });
  $('lbl-size').addEventListener('input', function () {
    var lk = selectedLake();
    if (lk) {
      lk.label.size = parseFloat(this.value);
      $('lbl-size-val').textContent = lk.label.size.toFixed(1) + ' mm';
      render();
    }
  });
  $('lbl-angle').addEventListener('input', function () {
    var lk = selectedLake();
    if (lk) {
      lk.label.angle = parseFloat(this.value);
      $('lbl-angle-val').textContent = lk.label.angle + '°';
      render();
    }
  });
  $('lbl-visible').addEventListener('change', function () {
    var lk = selectedLake();
    if (lk) { lk.label.visible = this.checked; render(); }
  });
  $('lbl-boxed').addEventListener('change', function () {
    var lk = selectedLake();
    if (lk) {
      lk.label.boxed = this.checked;
      autoPlaceLabel(lk);
      $('lbl-angle').value = lk.label.angle;
      $('lbl-angle-val').textContent = lk.label.angle + '°';
      render();
    }
  });

  // streets
  $('streets-on').addEventListener('change', function () {
    state.streetOpts.enabled = this.checked;
    $('streets-body').hidden = !this.checked;
    if (this.checked && !state.streets.loaded && state.lakes.length) fetchStreets();
    render();
  });
  $('streets-load').addEventListener('click', fetchStreets);
  ['major', 'main', 'local', 'minor'].forEach(function (cat) {
    $('st-' + cat).addEventListener('change', function () {
      state.streetOpts[cat] = this.checked;
      render();
    });
  });
  $('street-width').addEventListener('input', function () {
    state.streetOpts.width = parseFloat(this.value);
    $('street-width-val').textContent = state.streetOpts.width.toFixed(2) + ' mm';
    render();
  });
  $('street-width-val').textContent = '0.20 mm';

  // pins
  $('pin-add').addEventListener('click', addPin);
  $('pin-size').addEventListener('input', function () {
    state.pinSize = parseFloat(this.value);
    $('pin-size-val').textContent = state.pinSize.toFixed(1) + ' mm';
    render();
  });
  $('pin-size-val').textContent = '4.8 mm';
  $('lbl-auto').addEventListener('click', function () {
    var lk = selectedLake();
    if (lk) {
      autoPlaceLabel(lk);
      $('lbl-angle').value = lk.label.angle;
      $('lbl-angle-val').textContent = lk.label.angle + '°';
      render();
    }
  });
  $('lbl-close').addEventListener('click', closeLabelEditor);

  $('export-btn').addEventListener('click', downloadSVG);
}

function buildFontList() {
  var wrap = $('font-list');
  wrap.innerHTML = '';
  FONT_DEFS.forEach(function (fd) {
    var div = document.createElement('div');
    div.className = 'font-option' + (state.fontKey === fd.key ? ' active' : '');
    div.setAttribute('data-font', fd.key);
    var nm = document.createElement('span');
    nm.className = 'fname';
    nm.textContent = fd.name;
    nm.style.fontFamily = '"' + fd.name + ' Preview", serif';
    var ds = document.createElement('span');
    ds.className = 'fdesc';
    ds.textContent = fd.desc;
    div.appendChild(nm);
    div.appendChild(ds);
    div.addEventListener('click', function () {
      state.fontKey = fd.key;
      Array.prototype.forEach.call(wrap.children, function (c) {
        c.classList.toggle('active', c.getAttribute('data-font') === fd.key);
      });
      render();
    });
    wrap.appendChild(div);
  });
}

/* ------------------------------------------------------------
 * Boot
 * ---------------------------------------------------------- */
function loadFonts() {
  var jobs = FONT_DEFS.map(function (fd) {
    return new Promise(function (resolve, reject) {
      try {
        var buf = b64ToBuffer(window.FONT_DATA[fd.data]);
        fonts[fd.key] = opentype.parse(buf);
        // register for the UI font picker preview (not used for export)
        if (window.FontFace && document.fonts) {
          var face = new FontFace(fd.name + ' Preview', buf);
          face.load().then(function (f) { document.fonts.add(f); resolve(); },
                           function () { resolve(); });
        } else resolve();
      } catch (e) { reject(e); }
    });
  });
  return Promise.all(jobs);
}

var readyResolve;
var readyPromise = new Promise(function (res) { readyResolve = res; });

document.addEventListener('DOMContentLoaded', function () {
  loadFonts().then(function () {
    buildFontList();
    bindUI();
    setupPointer();
    render();
    readyResolve(true);
  }).catch(function (e) {
    $('search-status').textContent = 'Failed to load fonts: ' + e.message;
  });
});

/* test / scripting hooks */
window.__lakeApp = {
  ready: readyPromise,
  state: state,
  addLakeFromGeoJSON: addLakeFromGeoJSON,
  removeLake: removeLake,
  setTexts: function (top, bottom) {
    state.topText = top || '';
    state.bottomText = bottom || '';
    $('top-text').value = state.topText;
    $('bottom-text').value = state.bottomText;
    computeFit(false);
    render();
  },
  setFont: function (key) { state.fontKey = key; render(); },
  autoPlaceAll: function () { state.lakes.forEach(autoPlaceLabel); render(); },
  addPin: addPin,
  removePin: removePin,
  // ways: [{highway:'residential', coords:[[lon,lat],...]}] — same pipeline as Overpass
  setStreetsFromWays: function (ways) {
    var elements = (ways || []).map(function (w) {
      return {
        type: 'way',
        tags: { highway: w.highway },
        geometry: w.coords.map(function (c) { return { lon: c[0], lat: c[1] }; })
      };
    });
    applyStreetElements(elements, visibleLonLatBBox(1.06));
  },
  fetchStreets: fetchStreets,
  exportSVGString: exportSVGString,
  renderNow: doRender
};

})();
