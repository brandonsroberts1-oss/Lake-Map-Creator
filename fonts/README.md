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

Libre Baskerville and Playfair Display declare Reserved Font Names, so they are
shipped byte-for-byte unmodified. EB Garamond and Montserrat declare no Reserved
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
