# Bundled fonts

The app embeds four typefaces (base64-encoded TTFs in `js/fonts-data.js`) so that
text-to-path conversion works offline and identically everywhere. All are licensed
under the **SIL Open Font License 1.1** — full license texts are in this directory.

| Font | Source file (google/fonts repo) | Modification |
|---|---|---|
| Libre Baskerville | `ofl/librebaskerville/LibreBaskerville[wght].ttf` | none (unmodified variable font, default wght 400) |
| Playfair Display | `ofl/playfairdisplay/PlayfairDisplay[wght].ttf` | none (unmodified variable font, default wght 400) |
| EB Garamond | `ofl/ebgaramond/EBGaramond[wght].ttf` | static instance at `wght=500` via `fonttools varLib.instancer` |
| Montserrat | `ofl/montserrat/Montserrat[wght].ttf` | static instance at `wght=500` via `fonttools varLib.instancer` |

## Bold cuts (`js/fonts-bold-data.js`)

The info box and scale-bar labels use **real bold outlines**, never a
synthesized/faked weight — stacking offset copies of a regular glyph produces
overlapping contours that ghost in xTool Creative Space and double-engrave.

Each family is instanced at `wght=700` and subset to Latin-1 + Latin Extended-A
+ common punctuation (bold is only used for those Latin strings), which keeps
all four bold cuts to ~120 KB combined. If a lake name contains a character
outside that subset, the app falls back to the regular weight for that string
rather than rendering missing glyphs.

```bash
U="U+0020-007E,U+00A0-00FF,U+0100-017F,U+2013-2014,U+2018-201D,U+2032-2033,U+2212,U+00B0"
fonttools varLib.instancer -o Family-bold.ttf Family[wght].ttf wght=700
fonttools subset Family-bold.ttf --unicodes="$U" --layout-features='' \
  --no-hinting --desubroutinize --output-file=Family-bold-sub.ttf
# then base64 -w0 each file into the FONT_DATA_BOLD object
```

Libre Baskerville and Playfair Display declare Reserved Font Names, so the
regular weights are shipped byte-for-byte unmodified. EB Garamond and Montserrat declare no Reserved
Font Name; they were instanced to weight 500 because their variable defaults
(EB Garamond 400, Montserrat **100/Thin**) render too thin for laser engraving —
`opentype.js` reads only a variable font's default instance.

## Regenerating `js/fonts-data.js`

```bash
pip install fonttools
curl -L -o LibreBaskerville.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/librebaskerville/LibreBaskerville%5Bwght%5D.ttf"
curl -L -o PlayfairDisplay.ttf  "https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf"
curl -L -o EBGaramond-var.ttf   "https://raw.githubusercontent.com/google/fonts/main/ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf"
curl -L -o Montserrat-var.ttf   "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/Montserrat%5Bwght%5D.ttf"
fonttools varLib.instancer -o EBGaramond.ttf EBGaramond-var.ttf wght=500
fonttools varLib.instancer -o Montserrat.ttf Montserrat-var.ttf wght=500
# then base64 -w0 each file into the FONT_DATA object in js/fonts-data.js
```
