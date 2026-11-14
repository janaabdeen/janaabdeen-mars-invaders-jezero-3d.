# Mars Invaders: Jezero Crater 3D

Interactive 3D map of Jezero Crater (Mars) built with [CesiumJS](https://cesium.com/platform/cesiumjs/) for the **NASA Space Apps Challenge 2026** (Mars map challenge).

It shows real terrain and imagery, a slope-based hazard layer, the team's vector layers, and a ~2 km walking route (EVA) for an astronaut from the landing site to the ancient delta front.

> Status: working prototype. The viewer and the data pipeline are tested with the real USGS CTX orthomosaic and with synthetic GeoTIFFs. Final results on the real DTM are still to be added (see [Limitations](#limitations)).

## Features

- Mars ellipsoid and a custom terrain provider (CesiumJS assumes Earth by default).
- Orthomosaic draped on the terrain, tinted with a Mars-like colour (toggle).
- **Slope hazard layer** computed from the DTM: green < 10°, yellow 10-20°, red > 20°.
- **2 km astronaut route** (A\* over a slope-cost grid) with: slope per segment, line of sight to the landing site, science stops, and nearby water-related features (inflow channel, delta, clay, carbonates) in distinct colours.
- Click anything for details (coordinates, elevation, slope, hazard class, nearest point of interest, feature properties).
- Surface view (stand on the ground), orbit view (whole planet), zoom buttons.

## Quick start

Requirement: [Node.js](https://nodejs.org) 18 or newer (LTS).

```bash
git clone <your-repo-url>
cd mars-invaders-jezero-3d
npm install
# put the GeoTIFFs in data_raw/ (see data_raw/README.md)
npm run prep      # converts the rasters into web files (public/data)
npm run dev       # http://localhost:5173
```

On Windows you can double-click `START.bat` instead (install, convert, open the browser). On macOS/Linux run `./start.sh`.

Build a static site for the website: `npm run build` (output in `dist/`, works on any static host).

## Data and credits

Raster data is **not** stored in this repository (files can be several GB). Download from USGS Astrogeology (Mars 2020 landing site products), for example:

- Mars 2020 Terrain Relative Navigation CTX DTM Mosaic (elevation) and CTX Orthorectified Image Mosaic (image).
- HiRISE versions of the same products for higher resolution.

Credits: USGS Astrogeology Science Center, NASA/JPL, Mars Reconnaissance Orbiter (CTX, HiRISE). Please check each product page for its usage terms.
The vector layers in `data_raw/` (`.geojson`, `.csv`) were prepared by the team and are simplified (zones are rectangles, not surveyed outlines).

Libraries: CesiumJS (Apache-2.0), geotiff.js, pngjs, Vite.

## How it works

1. `prepare_data.mjs` reads GeoTIFFs in pieces (geographic, equirectangular or orthographic Mars projections), crops the area of interest from `data_raw/config.json`, and writes `public/data/`: `dtm.bin` (Float32 heights), `ortho.png`, `hazard.png`, and `meta.json`. If a file has no georeferencing, or the DTM is only 8-bit, it uses placeholder values and prints a line starting with `!`.
2. `src/main.js` builds the Cesium viewer (Mars ellipsoid, heightmap terrain from `dtm.bin`, overlays, layers, click info, camera modes).
3. `src/route.js` builds a slope-cost grid, runs A\* from the landing site to a point on the delta-front line, and computes route statistics.

## Project structure

```
data_raw/          input rasters (ignored by git) + team vector layers
docs/              notes (problems and solutions log)
src/main.js        viewer, layers, click info, camera modes
src/route.js       EVA route, hazards, panel
prepare_data.mjs   GeoTIFF -> web data converter
START.bat / start.sh   one-click start
```

## Limitations

- Slope, hazard and line-of-sight numbers depend on the DTM resolution (20 m for the CTX DTM, so small slopes and rocks are smoothed out). Sand ripples, boulder fields and soil firmness cannot be detected at this resolution; check HiRISE images before relying on the route.
- The science stops (basaltic regolith, olivine-rich rocks, clay) come from the mission brief, not from the dataset; only clay and carbonates exist in the CRISM layer.
- "Water" means ancient lake and river features and water-formed minerals. There is no liquid water at Jezero today.
- Not yet tested with a multi-GB real DTM from USGS.

## License

Code: MIT (see `LICENSE`). Mars data: see its own terms (USGS / NASA).
