# Lake Map Coaster Creator

A small web app that turns **any lake (or group of lakes) on Earth** into a
**laser-ready SVG coaster design** — like the classic engraved Finger Lakes
coaster: real lake shapes in the middle, small labels beside each lake, the
state curved along the top and the title curved along the bottom.

![App screenshot — layout demo with synthetic lake shapes](docs/screenshot.png)

## Features

- **Real lake outlines** — search any lake worldwide via OpenStreetMap
  (Nominatim). Add as many lakes as you want on one coaster; islands inside
  lakes are preserved as un-engraved holes.
- **Curved (arc) text** on top and bottom, with adjustable size and
  letter-spacing, just like the sample coaster.
- **Small labels next to each lake**, auto-placed along each lake's long axis
  (PCA) — then drag to move, click to edit text/size/angle.
- **Four fonts** (bundled, no internet needed for rendering):
  - *Libre Baskerville* — closest to the sample coaster's engraved serif
  - *EB Garamond* (weight 500) — classic old-style serif
  - *Playfair Display* — elegant high-contrast serif
  - *Montserrat* (weight 500) — clean modern sans
- **Laser-first SVG export** (defaults sized for a **3.8″ / 96.52 mm** round
  coaster, diameter adjustable):
  - true physical size: `width/height` in **mm** with a matching viewBox
    (1 SVG unit = 1 mm)
  - **all text converted to vector paths** — no `<text>` elements, so no
    font-substitution surprises in xTool Creative Space
  - flat structure: no transforms, no clip paths, no CSS, no rasters
  - color-separated layers: **black fills = engrave**, **red 0.1 mm stroke
    circle = cut** (easy to select-by-color in XCS/LightBurn)
  - polygons simplified to a configurable tolerance and tiny slivers/islands
    filtered, so files stay clean and engrave crisply
  - lakes use `fill-rule="evenodd"` **and** opposite ring winding, so island
    holes survive both even-odd and non-zero renderers

## Using it

It's a static site — no build step.

```bash
# from the repo root
python3 -m http.server 8000
# then open http://localhost:8000
```

(Or host it on GitHub Pages: Settings → Pages → deploy from branch, root `/`.)

1. **Search** a lake (include the region for better hits: “Keuka Lake New York”),
   click a result to add it. Repeat for each lake you want.
2. The **top text** auto-fills with the state/region; type your own top and
   bottom titles any time.
3. Pick a **font**, tweak arc size/letter-spacing, drag lakes (pan), scroll to
   zoom, drag labels, click a label to edit its text/size/angle.
4. **Download SVG** and import it into xTool Creative Space.

> Lake search calls `nominatim.openstreetmap.org` from your browser, so using
> the app needs internet; fonts and export are fully local.

## Importing into xTool Creative Space (XCS)

1. **File → Import** (or drag the SVG onto the canvas).
2. Check the size: the design should come in at **96.5 × 96.5 mm** (3.8″). If
   your XCS version ignores physical units, set width/height to 96.52 mm —
   everything scales together.
3. Select the **black** artwork → set processing type **Engrave** (fill). For
   crisp small labels use 250–350 DPI (lines-per-cm equivalent) and test power
   on scrap first.
4. Select the **red circle** → set to **Cut** if you're cutting your own
   blanks, or **Ignore/delete** it if you're engraving a pre-made coaster (use
   it as a positioning reference before deleting).
5. Engraving the top face needs **no mirroring**.

Small-text tip: at 3.8″ the lake labels default to ~3 mm — that engraves well
on hardwood at fine DPI. Below ~2 mm caps the app warns you, because char
detail starts to blur into the burn.

## Repo layout

```
index.html          app UI
css/style.css
js/app.js           projection, geometry, arc-text layout, export
js/fonts-data.js    bundled fonts (base64 TTF, generated — see fonts/README.md)
js/vendor/          opentype.js 1.3.4 (MIT)
fonts/              font licenses (SIL OFL 1.1) + regeneration notes
tools/e2e-test.mjs  Playwright smoke test of the whole pipeline
```

### Development / testing

```bash
npm install          # installs playwright (dev only)
npm test             # runs tools/e2e-test.mjs against a local server
```

## Data & attribution

- Lake geometry and search results **© OpenStreetMap contributors**, licensed
  [ODbL](https://www.openstreetmap.org/copyright). If you sell engraved items
  made from these maps, credit “Map data © OpenStreetMap contributors” on the
  listing or packaging.
- Fonts under the SIL Open Font License 1.1 (see `fonts/`).
- `opentype.js` under MIT (see `js/vendor/opentype.LICENSE.txt`).
