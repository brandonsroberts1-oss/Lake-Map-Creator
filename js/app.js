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
  'https://overpass.private.coffee/api/interpreter',
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
  smoothing: 0.6,           // 0..1 slider; see smoothSigma()
  minIsland: 0.5,           // mm^2 smallest kept island / ring
  woodPreview: true,
  selected: null,           // lake id whose label is being edited
  scalebar: { on: false, x: null, y: null },
  compass: { on: false, size: 16, x: null, y: null },
  infobox: { on: false, scale: 1, x: null, y: null, depth: '', area: '' },
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

function ringPerimeter(pts) {
  var p = 0;
  for (var i = 0; i < pts.length; i++) {
    var a = pts[i], b = pts[(i + 1) % pts.length];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

// Resample a closed ring at uniform arc-length spacing.
function resampleClosed(pts, step) {
  var per = ringPerimeter(pts);
  var n = Math.max(12, Math.min(60000, Math.round(per / step)));
  var target = per / n;
  var out = [[pts[0][0], pts[0][1]]];
  var i = 0, a = pts[0];
  var remaining = target;
  var guard = pts.length + n + 8;
  while (out.length < n && guard-- > 0) {
    var b = pts[(i + 1) % pts.length];
    var seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg < 1e-12) { i++; a = b; continue; }
    if (seg >= remaining) {
      var t = remaining / seg;
      a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      out.push(a);
      remaining = target;
    } else {
      remaining -= seg;
      i++;
      a = b;
    }
  }
  return out;
}

// Low-pass smooth a closed ring (circular Gaussian on x/y, sigma in mm,
// assumes uniform spacing `step` between points).
function gaussianClosed(pts, sigma, step) {
  var n = pts.length;
  if (sigma <= 0 || n < 8) return pts;
  var k = Math.min(Math.max(1, Math.ceil(3 * sigma / step)), Math.floor(n / 2) - 1);
  if (k < 1) return pts;
  var w = [], sum = 0;
  for (var j = -k; j <= k; j++) {
    var g = Math.exp(-(j * j * step * step) / (2 * sigma * sigma));
    w.push(g);
    sum += g;
  }
  var out = new Array(n);
  for (var i = 0; i < n; i++) {
    var x = 0, y = 0;
    for (var m = -k; m <= k; m++) {
      var p = pts[(i + m + n) % n];
      var g2 = w[m + k];
      x += p[0] * g2;
      y += p[1] * g2;
    }
    out[i] = [x / sum, y / sum];
  }
  return out;
}

// Full shoreline treatment: resample -> gaussian low-pass -> light DP.
// Slider maps non-linearly so the low end stays subtle and the top end can
// genuinely melt fjord-y noise (sigma up to 2.5 mm on the coaster).
function smoothSigma() {
  var v = state.smoothing;
  return v <= 0 ? 0 : 4.2 * Math.pow(v, 1.4);
}
function smoothRing(ptsMM) {
  var sigma = smoothSigma();
  if (sigma <= 0.02) return simplifyRing(ptsMM, 0.05);
  var per = ringPerimeter(ptsMM);
  if (per < 2) return ptsMM;
  var step = Math.min(0.35, Math.max(0.12, sigma / 3));
  var r = resampleClosed(ptsMM, step);
  r = gaussianClosed(r, sigma, step);
  return simplifyRing(r, 0.03);
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

function pointInPoly(x, y, poly) {
  var inside = false;
  for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointAllowed(x, y, D, bands, keepout) {
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
  if (keepout) {
    for (var k = 0; k < keepout.discs.length; k++) {
      var dsc = keepout.discs[k];
      if (Math.hypot(x - dsc.x, y - dsc.y) < dsc.r) return false;
    }
    for (var p = 0; p < keepout.polys.length; p++) {
      if (pointInPoly(x, y, keepout.polys[p])) return false;
    }
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
             state.smoothing, state.minIsland, state.diameter,
             state.topText.trim() ? 1 : 0, state.bottomText.trim() ? 1 : 0].join('|');
  var hit = geomCache[lake.id];
  if (hit && hit.key === key) return hit.rings;

  var m = viewMatrix(false);
  var polys = [];
  lake.polys.forEach(function (poly) {
    var outer = smoothRing(poly.outer.map(function (p) { return applyM(m, p); }));
    if (outer.length < 3) return;
    var holes = [];
    poly.holes.forEach(function (hr) {
      var h = smoothRing(hr.map(function (p) { return applyM(m, p); }));
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

// Rounded-rect polygon (for boolean clipping), centered at origin, then
// transformed by affine m.
function roundedRectPoly(w, h, r, m) {
  var hw = w / 2, hh = h / 2;
  r = Math.max(0, Math.min(r, hw, hh));
  var segs = 6, pts = [];
  var corners = [
    [hw - r, hh - r, 0], [-hw + r, hh - r, Math.PI / 2],
    [-hw + r, -hh + r, Math.PI], [hw - r, -hh + r, 3 * Math.PI / 2]
  ];
  corners.forEach(function (c) {
    for (var i = 0; i <= segs; i++) {
      var a = c[2] + i / segs * Math.PI / 2;
      pts.push(applyM(m, [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]));
    }
  });
  pts.push(pts[0].slice());
  return pts;
}

function ringsToPathD(mp) {
  var d = '';
  mp.forEach(function (poly) {
    poly.forEach(function (ring) {
      var n = ring.length;
      // skip duplicated closing point
      if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n--;
      for (var i = 0; i < n; i++) {
        d += (i === 0 ? 'M' : 'L') + fmt(ring[i][0]) + ' ' + fmt(ring[i][1]);
      }
      d += 'Z';
    });
  });
  return d;
}

// Lake path with optional knockout windows subtracted via true boolean ops
// (a window that pokes past the shoreline must NOT fill outside the lake).
function lakePathD(lake, windows) {
  var polys = lakeRingsMM(lake);
  var tx = state.view.tx, ty = state.view.ty;
  var mp = polys.map(function (p) {
    return [p.outer.map(function (q) { return [q[0] + tx, q[1] + ty]; })]
      .concat(p.holes.map(function (h) {
        return h.map(function (q) { return [q[0] + tx, q[1] + ty]; });
      }));
  });
  if (windows && windows.length && window.polygonClipping) {
    try {
      var args = [mp].concat(windows.map(function (w) { return [w]; }));
      mp = polygonClipping.difference.apply(null, args);
    } catch (e) { /* keep unclipped geometry on numeric failure */ }
  }
  return ringsToPathD(mp);
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
    minP: minP, maxP: maxP,
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
  var px = -st.ey, py = st.ex; // perpendicular
  var D = state.diameter, c = D / 2;

  // score candidate spots on both sides at increasing offsets, sampling
  // points along the label's length: never sit on the lake fill (black on
  // black), stay inside the disc, stay close
  var font = currentFont();
  var w = font ? font.getAdvanceWidth(lbl.text || 'Lake', size, { kerning: true }) : 12;
  var outer = null, bestA = 0;
  lakeRingsMM(lake).forEach(function (p) {
    if (p.area > bestA) { bestA = p.area; outer = p.outer; }
  });
  var tx = state.view.tx, ty = state.view.ty;
  // sample the label body: 5 points along its length on 2 lines spanning
  // its height, so glyph tops/bottoms are respected too
  function insideCount(qx, qy) {
    if (!outer) return 0;
    var cnt = 0;
    for (var k = -2; k <= 2; k++) {
      for (var h = -1; h <= 1; h += 2) {
        var sx = qx + st.ex * (w / 2) * (k / 2) + px * size * 0.55 * h;
        var sy = qy + st.ey * (w / 2) * (k / 2) + py * size * 0.55 * h;
        if (pointInPoly(sx - tx, sy - ty, outer)) cnt++;
      }
    }
    return cnt;
  }
  var pick = null, bestScore = Infinity;
  [1, -1].forEach(function (side) {
    // measure from the lake's actual extent on that side, not the average
    var base = (side > 0 ? st.maxP : -st.minP) + size * 0.9 + 1.0;
    for (var k = 0; k < 4; k++) {
      [0, -0.3, 0.3].forEach(function (slide) {
        var o = base + k * 2.0;
        var q = [st.cx + px * side * o + st.ex * st.halfLen * slide,
                 st.cy + py * side * o + st.ey * st.halfLen * slide];
        var r = Math.hypot(q[0] - c, q[1] - c);
        var score = insideCount(q[0], q[1]) * 10 + k * 1.5 + Math.abs(slide) * 2 +
          Math.max(0, r - (c - EDGE_MARGIN - 3)) * 12 + r * 0.02;
        if (score < bestScore) { bestScore = score; pick = q; }
      });
    }
  });
  lbl.dx = pick[0] - st.cx;
  lbl.dy = pick[1] - st.cy;
}

/* ------------------------------------------------------------
 * Streets (OpenStreetMap Overpass)
 * ---------------------------------------------------------- */
function streetStatus(msg, isWarn) {
  var el = $('streets-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = isWarn ? 'warn' : 'hint';
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

var streetsLoading = false;
function fetchStreets() {
  if (streetsLoading) return;
  if (!state.lakes.length) { streetStatus('Add a lake first, then load streets.', true); return; }
  var bb = visibleLonLatBBox(1.06);
  var midLat = (bb.n + bb.s) / 2;
  var span = Math.max(bb.n - bb.s, (bb.e - bb.w) * Math.cos(deg2rad(midLat)));
  if (span > 0.7) {
    streetStatus('This view covers too much land for street data (~' +
      Math.round(span * 69) + ' miles across). Streets are for a single small lake — ' +
      'they can’t load for something the size of a Great Lake.', true);
    return;
  }
  streetsLoading = true;
  var re = 'motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|road|service|track|cycleway|footway|path|bridleway|steps';
  var q = '[out:json][timeout:40];way["highway"~"^(' + re + ')(_link)?$"](' +
    [bb.s, bb.w, bb.n, bb.e].join(',') + ');out geom qt;';
  (function tryEndpoint(i) {
    var host = OVERPASS_ENDPOINTS[i].replace(/^https:\/\//, '').split('/')[0];
    streetStatus('Loading streets from OpenStreetMap (' + host +
      (i ? ', mirror ' + (i + 1) : '') + ')… this can take up to a minute.');
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 45000);
    fetch(OVERPASS_ENDPOINTS[i], {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (json) {
      if (timer) clearTimeout(timer);
      streetsLoading = false;
      applyStreetElements(json.elements || [], bb);
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      var why = err && err.name === 'AbortError' ? 'timed out' : String(err.message || err);
      console.warn('Overpass ' + host + ' failed: ' + why);
      if (i + 1 < OVERPASS_ENDPOINTS.length) {
        tryEndpoint(i + 1);
      } else {
        streetsLoading = false;
        streetStatus('Street data failed on all servers (last: ' + why +
          '). Overpass gets busy — wait a minute and press “Load streets” again.', true);
      }
    });
  })(0);
}

// Split a polyline into runs inside the allowed disc (rim margin + arc bands
// + keep-out shapes), with bisection-refined boundary points. Long segments
// are subdivided first.
function clipRuns(pts, D, bands, keepout) {
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
      if (pointAllowed(mid[0], mid[1], D, bands, keepout)) b = mid; else a = mid;
    }
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  var runs = [], cur = null, prev = null, prevOk = false;
  for (var m = 0; m < sub.length; m++) {
    var p = sub[m];
    var ok = pointAllowed(p[0], p[1], D, bands, keepout);
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

// -> [{cat, d}] for currently enabled street categories, clipped & simplified.
// keepout: {polys:[], discs:[]} — text windows, compass, scale bar.
function streetPaths(keepout) {
  var o = state.streetOpts;
  if (!o.enabled || !state.streets.loaded || !state.streets.ways.length) return [];
  var m = viewMatrix(true);
  var D = state.diameter;
  var bands = [arcBand('top'), arcBand('bottom')].filter(Boolean);
  var byCat = {};
  state.streets.ways.forEach(function (w) {
    if (!o[w.cat]) return;
    var mm = w.pts.map(function (p) { return applyM(m, p); });
    clipRuns(mm, D, bands, keepout).forEach(function (run) {
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
 * Map extras: scale bar, compass rose, info box
 * ---------------------------------------------------------- */
function groundMetersPerMM() {
  var s = state.view.baseScale * state.view.scaleMul;
  if (!s || !state.lakes.length) return null;
  var c = state.diameter / 2;
  var ll = unproject(invViewPoint(c, c));
  return Math.cos(deg2rad(ll[1])) / s;
}

// pick a round mile (or feet) length whose bar is ~14–30 mm on the coaster
function niceScaleBar(mPerMM) {
  var MI = 1609.344, FT = 0.3048;
  var mi = [0.1, 0.2, 0.25, 0.5, 1, 2, 3, 5, 10, 15, 20, 25, 40, 50, 100, 150, 200, 300];
  var best = null;
  mi.forEach(function (v) {
    var len = v * MI / mPerMM;
    if (len < 12 || len > 32) return;
    if (!best || Math.abs(len - 20) < Math.abs(best.len - 20)) {
      best = { len: len, label: (v >= 1 ? String(v) : String(v)) + ' mi' };
    }
  });
  if (!best) {
    [100, 200, 250, 500, 1000, 1500, 2000].forEach(function (v) {
      var len = v * FT / mPerMM;
      if (len < 12 || len > 32) return;
      if (!best || Math.abs(len - 20) < Math.abs(best.len - 20)) {
        best = { len: len, label: v + ' ft' };
      }
    });
  }
  return best;
}

function rectD(cx, cy, w, h) {
  return commandsToD(roundedRectCmds(w, h, 0, 1), [1, 0, 0, 1, cx, cy]);
}

function buildScalebarArt(art, font) {
  if (!state.scalebar.on) return;
  var mPerMM = groundMetersPerMM();
  if (!mPerMM) return;
  var bar = niceScaleBar(mPerMM);
  if (!bar) return;
  var D = state.diameter;
  var x = state.scalebar.x == null ? D * 0.30 : state.scalebar.x;
  var y = state.scalebar.y == null ? D * 0.705 : state.scalebar.y;
  var len = bar.len, bh = 0.42, th = 1.9;
  var d = rectD(x, y, len, bh) +
          rectD(x - len / 2 + bh / 2, y - th / 2 + bh / 2, bh, th) +
          rectD(x + len / 2 - bh / 2, y - th / 2 + bh / 2, bh, th) +
          rectD(x, y - th * 0.32 + bh / 2, bh * 0.8, th * 0.64) +
          straightTextD(font, bar.label, 2.3, x, y - th - 1.6, 0);
  art.scalebar = { d: d, x: x, y: y, hitHW: len / 2 + 2.5, hitHH: 5.5 };
}

// 8-point nautical rose: two overlaid 4-point stars + ring + center dot + N
function star4Poly(outerR, innerR, phaseDeg, m) {
  var pts = [];
  for (var i = 0; i < 8; i++) {
    var r = i % 2 === 0 ? outerR : innerR;
    var a = deg2rad(phaseDeg + i * 45 - 90);
    pts.push(applyM(m, [r * Math.cos(a), r * Math.sin(a)]));
  }
  return pts;
}
function polyCmdsD(pts) {
  var d = '';
  for (var i = 0; i < pts.length; i++) {
    d += (i === 0 ? 'M' : 'L') + fmt(pts[i][0]) + ' ' + fmt(pts[i][1]);
  }
  return d + 'Z';
}

function buildCompassArt(art, font) {
  var cp = state.compass;
  if (!cp.on) return;
  var D = state.diameter;
  var x = cp.x == null ? D * 0.76 : cp.x;
  var y = cp.y == null ? D * 0.40 : cp.y;
  var R = cp.size / 2;
  var rot = deg2rad(state.view.rotDeg);
  var m = [Math.cos(rot), Math.sin(rot), -Math.sin(rot), Math.cos(rot), x, y];
  var d = '';
  // ring (band works in either fill rule via opposite winding)
  d += commandsToD(circleCmds(0, 0, R * 0.55, 1), m);
  d += commandsToD(circleCmds(0, 0, R * 0.505, -1), m);
  // ordinal star under cardinal star
  d += polyCmdsD(star4Poly(R * 0.62, R * 0.16, 45, m));
  d += polyCmdsD(star4Poly(R, R * 0.20, 0, m));
  d += commandsToD(circleCmds(0, 0, R * 0.07, 1), m);
  // N above the north point, rotating with the rose (true north)
  var ns = Math.min(4.2, Math.max(1.7, R * 0.32));
  var nPos = applyM(m, [0, -(R + ns * 0.72)]);
  d += straightTextD(font, 'N', ns, nPos[0], nPos[1], state.view.rotDeg);
  art.compass = { d: d, x: x, y: y, hitR: R + ns * 1.6 };
}

/* ---- info box (single-lake) ---- */
function lakeCentroidLL(lake) {
  var sx = 0, sy = 0, n = 0;
  var best = lake.polys.reduce(function (a, p) {
    return !a || Math.abs(signedArea(p.outer)) > Math.abs(signedArea(a.outer)) ? p : a;
  }, null);
  if (!best) return null;
  best.outer.forEach(function (q) { sx += q[0]; sy += q[1]; n++; });
  return unproject([sx / n, sy / n]);
}
function formatLatLon(ll) {
  if (!ll) return '';
  var lat = ll[1], lon = ll[0];
  return Math.abs(lat).toFixed(2) + '° ' + (lat >= 0 ? 'N' : 'S') + ',  ' +
         Math.abs(lon).toFixed(2) + '° ' + (lon >= 0 ? 'E' : 'W');
}
function lakeAreaMi2(lake) {
  var m2 = 0;
  lake.polys.forEach(function (p) {
    m2 += Math.abs(signedArea(p.outer));
    p.holes.forEach(function (h) { m2 -= Math.abs(signedArea(h)); });
  });
  var ll = lakeCentroidLL(lake);
  if (!ll) return null;
  var k = Math.cos(deg2rad(ll[1]));
  return m2 * k * k / 2589988.110336;
}
function formatAreaMi2(a) {
  if (a == null || !isFinite(a)) return '';
  var s;
  if (a >= 1000) s = Math.round(a).toLocaleString('en-US');
  else if (a >= 100) s = String(Math.round(a));
  else if (a >= 10) s = a.toFixed(1);
  else s = a.toFixed(2);
  return s + ' sq mi';
}

// simple anchor silhouette (height h, centered on 0,0), sampled arcs
function anchorD(h, cx, cy) {
  var s = h, d = '';
  var m = [1, 0, 0, 1, cx, cy];
  // ring at top
  d += commandsToD(circleCmds(0, -0.40 * s, 0.105 * s, 1), m);
  d += commandsToD(circleCmds(0, -0.40 * s, 0.058 * s, -1), m);
  // shank + stock
  d += rectD(cx, cy - 0.015 * s, 0.06 * s, 0.60 * s);
  d += rectD(cx, cy - 0.235 * s, 0.40 * s, 0.055 * s);
  // bottom crescent (half-annulus opening upward), sampled polygon
  var rO = 0.30 * s, rI = 0.20 * s, a0 = deg2rad(195), a1 = deg2rad(-15), pts = [];
  for (var i = 0; i <= 16; i++) {
    var a = a0 + (a1 - a0) * i / 16;
    pts.push(applyM(m, [rO * Math.cos(a), 0.12 * s - rO * Math.sin(a)]));
  }
  for (var j = 16; j >= 0; j--) {
    var b = a0 + (a1 - a0) * j / 16;
    pts.push(applyM(m, [rI * Math.cos(b), 0.12 * s - rI * Math.sin(b)]));
  }
  d += polyCmdsD(pts);
  return d;
}

function buildInfoboxArt(art, windowsByLake, font) {
  var ib = state.infobox;
  if (!ib.on || state.lakes.length !== 1) return;
  var lake = state.lakes[0];
  var f = ib.scale;
  var name = (lake.name || 'Lake').toUpperCase();
  var lines = [];
  if (lake.region) lines.push(lake.region);
  var ll = lakeCentroidLL(lake);
  if (ll) lines.push(formatLatLon(ll));
  if (ib.depth.trim()) lines.push('Max Depth: ' + ib.depth.trim());
  if (ib.area.trim()) lines.push('Area: ' + ib.area.trim());

  var sName = 2.9 * f, sLine = 2.05 * f;
  var wMax = font.getAdvanceWidth(name, sName, { kerning: true });
  lines.forEach(function (t) {
    wMax = Math.max(wMax, font.getAdvanceWidth(t, sLine, { kerning: true }));
  });
  var anchorH = 3.1 * f;
  var lineGap = sLine * 1.52;
  var padX = 2.6 * f, padY = 2.0 * f;
  var boxW = wMax + padX * 2;
  var boxH = padY * 2 + anchorH + 1.2 * f + sName + 0.9 * f + lines.length * lineGap;

  var D = state.diameter;
  var x = ib.x, y = ib.y;
  if (x == null || y == null) {
    // default: the quadrant farthest from the lake body
    var st = lakeStatsMM(lake);
    var c = D / 2;
    var cands = [
      [D * 0.30, D * 0.36], [D * 0.70, D * 0.36],
      [D * 0.30, D * 0.66], [D * 0.70, D * 0.66], [c, D * 0.68]
    ];
    var best = cands[4], bestScore = -1;
    cands.forEach(function (q) {
      var score = st ? Math.hypot(q[0] - st.cx, q[1] - st.cy) : Math.hypot(q[0] - c, q[1] - c);
      if (score > bestScore) { bestScore = score; best = q; }
    });
    x = Math.min(Math.max(best[0], boxW / 2 + 5), D - boxW / 2 - 5);
    y = Math.min(Math.max(best[1], boxH / 2 + 13), D - boxH / 2 - 13);
  }

  var m = [1, 0, 0, 1, x, y];
  var d = '';
  // double nautical border
  d += commandsToD(roundedRectCmds(boxW, boxH, 1.8 * f, 1), m);
  d += commandsToD(roundedRectCmds(boxW - 0.5 * f, boxH - 0.5 * f, 1.55 * f, -1), m);
  d += commandsToD(roundedRectCmds(boxW - 1.5 * f, boxH - 1.5 * f, 1.2 * f, 1), m);
  d += commandsToD(roundedRectCmds(boxW - 1.78 * f, boxH - 1.78 * f, 1.06 * f, -1), m);

  var cy = -boxH / 2 + padY + anchorH / 2;
  d += anchorD(anchorH, x, y + cy);
  cy += anchorH / 2 + 1.2 * f + sName / 2;
  d += straightTextD(font, name, sName, x, y + cy, 0);
  cy += sName / 2 + 0.9 * f + lineGap / 2;
  lines.forEach(function (t) {
    d += straightTextD(font, t, sLine, x, y + cy, 0);
    cy += lineGap;
  });

  // knock the box (plus margin) out of the lake fill if they overlap
  var win = roundedRectPoly(boxW + 1.1, boxH + 1.1, 2.1 * f, m);
  (windowsByLake[lake.id] = windowsByLake[lake.id] || []).push(win);

  art.infobox = { d: d, x: x, y: y, hitHW: boxW / 2 + 1, hitHH: boxH / 2 + 1 };
}

/* ------------------------------------------------------------
 * Build all artwork pieces (shared by preview & export)
 * ---------------------------------------------------------- */
function buildArt() {
  var D = state.diameter, c = D / 2;
  var font = currentFont();
  var art = { lakes: [], labels: [], arcs: [], streets: [], pins: [],
              scalebar: null, compass: null, infobox: null, cut: null, warnings: [] };
  if (!font) return art;

  // pass 1: labels (collecting knockout windows per lake)
  var windowsByLake = {};
  var labelKeepouts = [];
  state.lakes.forEach(function (lake) {
    var lbl = lake.label;
    if (!lbl.visible || !lbl.text.trim()) return;
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
          (windowsByLake[lake.id] = windowsByLake[lake.id] || []).push(
            roundedRectPoly((inHW + bandW + gap) * 2, (inHH + bandW + gap) * 2, rIn + bandW + gap, mtx));
        } else {
          entry.hitHW = entry.w / 2 + 1.2;
          entry.hitHH = size * 0.85 + 0.8;
          // streets stay out from under floating labels for readability
          var lr = deg2rad(entry.angle);
          labelKeepouts.push(roundedRectPoly(entry.hitHW * 2, entry.hitHH * 2, 0.8,
            [Math.cos(lr), Math.sin(lr), -Math.sin(lr), Math.cos(lr), cx, cy]));
        }
        art.labels.push(entry);
      }
    }
    var miss = missingChars(font, lbl.text);
    if (miss.length) art.warnings.push('Font has no glyph for: ' + miss.join(' '));
  });

  // info box may add one more window, so build it before the lake fills
  buildInfoboxArt(art, windowsByLake, font);

  // pass 2: lake fills with all windows subtracted
  state.lakes.forEach(function (lake) {
    var d = lakePathD(lake, windowsByLake[lake.id]);
    if (d) art.lakes.push({ id: lake.id, d: d });
  });

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

  buildScalebarArt(art, font);
  buildCompassArt(art, font);

  // streets go last: they clip around text windows, labels, compass, scale bar
  var keepout = { polys: labelKeepouts.slice(), discs: [] };
  Object.keys(windowsByLake).forEach(function (k) {
    windowsByLake[k].forEach(function (w) { keepout.polys.push(w); });
  });
  if (art.scalebar) {
    keepout.polys.push([
      [art.scalebar.x - art.scalebar.hitHW, art.scalebar.y - art.scalebar.hitHH],
      [art.scalebar.x + art.scalebar.hitHW, art.scalebar.y - art.scalebar.hitHH],
      [art.scalebar.x + art.scalebar.hitHW, art.scalebar.y + art.scalebar.hitHH],
      [art.scalebar.x - art.scalebar.hitHW, art.scalebar.y + art.scalebar.hitHH]
    ]);
  }
  if (art.compass) {
    keepout.discs.push({ x: art.compass.x, y: art.compass.y, r: art.compass.hitR });
  }
  art.streets = streetPaths(keepout);

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

var lastArt = null;
function doRender() {
  var svg = $('preview');
  var D = state.diameter, c = D / 2;
  svg.setAttribute('viewBox', '0 0 ' + fmt(D) + ' ' + fmt(D));
  var art = buildArt();
  lastArt = art;
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
  s += '</g><g id="pv-extras">';
  if (art.scalebar) {
    s += '<g class="extra-hit" data-extra="scalebar"><path d="' + art.scalebar.d + '" fill="' + ink + '"/>' +
         '<rect x="' + fmt(art.scalebar.x - art.scalebar.hitHW) + '" y="' + fmt(art.scalebar.y - art.scalebar.hitHH) +
         '" width="' + fmt(art.scalebar.hitHW * 2) + '" height="' + fmt(art.scalebar.hitHH * 2) +
         '" fill="rgba(0,0,0,0)"/></g>';
  }
  if (art.compass) {
    s += '<g class="extra-hit" data-extra="compass"><path d="' + art.compass.d + '" fill="' + ink + '"/>' +
         '<circle cx="' + fmt(art.compass.x) + '" cy="' + fmt(art.compass.y) + '" r="' + fmt(art.compass.hitR) +
         '" fill="rgba(0,0,0,0)"/></g>';
  }
  if (art.infobox) {
    s += '<g class="extra-hit" data-extra="infobox"><path d="' + art.infobox.d + '" fill="' + ink + '"/>' +
         '<rect x="' + fmt(art.infobox.x - art.infobox.hitHW) + '" y="' + fmt(art.infobox.y - art.infobox.hitHH) +
         '" width="' + fmt(art.infobox.hitHW * 2) + '" height="' + fmt(art.infobox.hitHH * 2) +
         '" fill="rgba(0,0,0,0)"/></g>';
  }
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

  if (state.streetOpts.enabled && state.streets.loaded && !streetsLoading && streetsStale()) {
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
  if (art.scalebar) {
    out += '<g id="ENGRAVE_scalebar">\n<path d="' + art.scalebar.d + '" fill="' + ENGRAVE_COLOR +
           '" stroke="none"/>\n</g>\n';
  }
  if (art.compass) {
    out += '<g id="ENGRAVE_compass">\n<path d="' + art.compass.d + '" fill="' + ENGRAVE_COLOR +
           '" stroke="none"/>\n</g>\n';
  }
  if (art.infobox) {
    out += '<g id="ENGRAVE_infobox">\n<path d="' + art.infobox.d + '" fill="' + ENGRAVE_COLOR +
           '" stroke="none"/>\n</g>\n';
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

function addLakeFromGeoJSON(geojson, name, region, uid, extratags) {
  var polys = ringsFromGeoJSON(geojson);
  if (!polys.length) return null;
  var lake = {
    id: 'lk' + (++lakeSeq),
    uid: uid || null,
    name: name || 'Lake',
    region: region || '',
    extratags: extratags || null,
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
  autofillInfobox();
  render();
  return lake;
}

function removeLake(id) {
  state.lakes = state.lakes.filter(function (l) { return l.id !== id; });
  delete geomCache[id];
  if (state.selected === id) closeLabelEditor();
  if (state.lakes.length) { computeFit(true); state.lakes.forEach(autoPlaceLabel); }
  autofillInfobox();
  render();
  renderLakeList();
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
 * Info box data (auto area + depth from OSM tags / Wikidata)
 * ---------------------------------------------------------- */
function infoStatus(msg) {
  var el = $('infobox-status');
  if (el) el.textContent = msg || '';
}
function metersToFeetLabel(mVal) {
  return Math.round(mVal * 3.28084).toLocaleString('en-US') + ' ft';
}
function parseDepthTag(tags) {
  var v = tags.maxdepth || tags.depth || tags.max_depth;
  if (!v) return '';
  var num = parseFloat(String(v).replace(',', '.'));
  if (!isFinite(num) || num <= 0) return '';
  if (/ft|'/i.test(String(v))) return Math.round(num).toLocaleString('en-US') + ' ft';
  return metersToFeetLabel(num); // OSM depth tags default to meters
}

function autofillInfobox() {
  if (!state.infobox.on || state.lakes.length !== 1) return;
  var lake = state.lakes[0];
  if (state.infobox.forLake !== lake.id) {
    state.infobox.depth = '';
    state.infobox.area = '';
    $('info-depth').value = '';
    $('info-area').value = '';
    state.infobox.forLake = lake.id;
  }
  if (!state.infobox.area.trim()) {
    var a = formatAreaMi2(lakeAreaMi2(lake));
    if (a) { state.infobox.area = a; $('info-area').value = a; }
  }
  if (!state.infobox.depth.trim()) {
    var tags = lake.extratags || {};
    var d = parseDepthTag(tags);
    if (d) {
      state.infobox.depth = d;
      $('info-depth').value = d;
      infoStatus('Depth from OpenStreetMap · area measured from the outline. Edit either field freely.');
    } else if (tags.wikidata) {
      infoStatus('Looking up depth on Wikidata…');
      fetchWikidataDepth(tags.wikidata, lake);
    } else {
      infoStatus('Depth not in the map data — type it in if you know it. Area is measured from the outline.');
    }
  }
  render();
}

function fetchWikidataDepth(qid, lake) {
  fetch('https://www.wikidata.org/wiki/Special:EntityData/' + encodeURIComponent(qid) + '.json')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (json) {
      var ent = json.entities && json.entities[qid];
      var claims = ent && ent.claims && ent.claims.P4511; // vertical (max) depth
      var out = '';
      if (claims && claims.length) {
        var dv = claims[0].mainsnak && claims[0].mainsnak.datavalue;
        var val = dv && dv.value && parseFloat(dv.value.amount);
        var unit = (dv && dv.value && dv.value.unit) || '';
        if (isFinite(val) && val > 0) {
          out = /Q3710$/.test(unit) ? Math.round(val).toLocaleString('en-US') + ' ft'
                                    : metersToFeetLabel(val);
        }
      }
      if (out && state.lakes[0] === lake && !state.infobox.depth.trim()) {
        state.infobox.depth = out;
        $('info-depth').value = out;
        infoStatus('Depth from Wikidata · area measured from the outline. Edit either field freely.');
        render();
      } else if (!out) {
        infoStatus('Depth not listed on Wikidata — type it in if you know it.');
      }
    })
    .catch(function () {
      infoStatus('Wikidata lookup failed — type the depth in if you know it.');
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
  // lightweight search (no geometry) — full outline is fetched on click at a
  // resolution matched to the lake's size
  var url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&extratags=1&limit=6&q=' +
    encodeURIComponent(q);
  fetch(url, { headers: { 'Accept': 'application/json' } })
    .then(function (res) {
      if (res.status === 429) throw new Error('Rate limited — wait a few seconds and try again.');
      if (!res.ok) throw new Error('Search failed (HTTP ' + res.status + ').');
      return res.json();
    })
    .then(function (rows) {
      var usable = rows.filter(function (r) {
        return r.osm_type === 'relation' || r.osm_type === 'way';
      });
      if (!usable.length) {
        status.textContent = 'Nothing found with an outline. Try adding the region, e.g. “Keuka Lake New York”.';
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
        li.addEventListener('click', function () { addLakeFromSearchResult(r, li); });
        list.appendChild(li);
      });
    })
    .catch(function (err) {
      status.textContent = String(err.message || err) +
        ' (Search needs internet access to nominatim.openstreetmap.org.)';
    });
}

// Fetch the outline at a tolerance proportional to the lake's extent, so a
// Great Lake arrives as a manageable, still shoreline-accurate polygon and a
// small pond keeps full detail.
function adaptiveThreshold(r) {
  var bb = r.boundingbox; // [minlat, maxlat, minlon, maxlon] as strings
  if (!bb || bb.length !== 4) return 0.00005;
  var dLat = Math.abs(parseFloat(bb[1]) - parseFloat(bb[0]));
  var midLat = (parseFloat(bb[0]) + parseFloat(bb[1])) / 2;
  var dLon = Math.abs(parseFloat(bb[3]) - parseFloat(bb[2])) * Math.cos(deg2rad(midLat));
  var extent = Math.max(dLat, dLon, 0.001);
  return Math.min(0.003, Math.max(0.00002, extent * 0.0004));
}

function addLakeFromSearchResult(r, li) {
  var status = $('search-status');
  var uid = (r.osm_type || '') + (r.osm_id || '');
  if (uid && state.lakes.some(function (l) { return l.uid === uid; })) {
    status.textContent = 'That lake is already on the coaster.';
    return;
  }
  var prefix = { relation: 'R', way: 'W', node: 'N' }[r.osm_type];
  if (!prefix) { status.textContent = 'That result has no outline — pick another.'; return; }
  status.textContent = 'Fetching the outline of “' + shortName(r) + '”…';
  if (li) li.style.opacity = '0.5';
  var url = 'https://nominatim.openstreetmap.org/lookup?format=jsonv2&polygon_geojson=1' +
    '&polygon_threshold=' + adaptiveThreshold(r) +
    '&addressdetails=1&extratags=1&osm_ids=' + prefix + r.osm_id;
  fetch(url, { headers: { 'Accept': 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('Outline fetch failed (HTTP ' + res.status + ').');
      return res.json();
    })
    .then(function (rows) {
      var g = rows && rows[0] && rows[0].geojson;
      if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon' && g.type !== 'GeometryCollection')) {
        throw new Error('No lake outline available for that result — try another.');
      }
      var added = addLakeFromGeoJSON(g, shortName(r),
        regionFromAddress((rows[0].address || r.address)), uid,
        rows[0].extratags || r.extratags || null);
      if (!added) throw new Error('That outline could not be used — try another result.');
      $('search-results').innerHTML = '';
      status.textContent = 'Added “' + shortName(r) + '”.';
    })
    .catch(function (err) {
      if (li) li.style.opacity = '';
      status.textContent = String(err.message || err);
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
    var tx = ev.target.closest ? ev.target.closest('[data-extra]') : null;
    var tp = !tx && ev.target.closest ? ev.target.closest('[data-pin]') : null;
    var t = !tx && !tp && ev.target.closest ? ev.target.closest('[data-lbl]') : null;
    if (tx) {
      var kind = tx.getAttribute('data-extra');
      var piece = lastArt && lastArt[kind];
      if (!piece) return;
      drag = { kind: 'extra', which: kind, x: ev.clientX, y: ev.clientY,
               x0: piece.x, y0: piece.y, moved: false };
    } else if (tp) {
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
    } else if (drag.kind === 'extra') {
      state[drag.which].x = drag.x0 + dx;
      state[drag.which].y = drag.y0 + dy;
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
  slider('smoothing', 'smoothing-val', 'smoothing', function (v) { return Math.round(v * 100) + '%'; },
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

  // extras: scale bar, compass, info box
  $('scalebar-on').addEventListener('change', function () {
    state.scalebar.on = this.checked;
    render();
  });
  $('compass-on').addEventListener('change', function () {
    state.compass.on = this.checked;
    $('compass-size-row').hidden = !this.checked;
    render();
  });
  $('compass-size').addEventListener('input', function () {
    state.compass.size = parseFloat(this.value);
    $('compass-size-val').textContent = state.compass.size.toFixed(0) + ' mm';
    render();
  });
  $('compass-size-val').textContent = '16 mm';
  $('infobox-on').addEventListener('change', function () {
    if (this.checked && state.lakes.length !== 1) {
      this.checked = false;
      infoStatus(state.lakes.length ? 'The info box works with exactly one lake on the coaster.'
                                    : 'Add a lake first.');
      $('infobox-body').hidden = false;
      return;
    }
    state.infobox.on = this.checked;
    $('infobox-body').hidden = !this.checked;
    if (this.checked) autofillInfobox();
    render();
  });
  $('infobox-scale').addEventListener('input', function () {
    state.infobox.scale = parseFloat(this.value);
    $('infobox-scale-val').textContent = '×' + state.infobox.scale.toFixed(2);
    render();
  });
  $('infobox-scale-val').textContent = '×1.00';
  $('info-depth').addEventListener('input', function () {
    state.infobox.depth = this.value;
    render();
  });
  $('info-area').addEventListener('input', function () {
    state.infobox.area = this.value;
    render();
  });
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
  movePinMM: function (id, x, y) {
    var pin = state.pins.find(function (p) { return p.id === id; });
    if (pin) {
      var pr = invViewPoint(x, y);
      pin.px = pr[0];
      pin.py = pr[1];
      render();
    }
  },
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
