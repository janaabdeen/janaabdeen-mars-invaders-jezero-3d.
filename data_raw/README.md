# data_raw

Put the raster files here (they are **not** stored in git, see `.gitignore`):

| File | Name must contain | Notes |
|---|---|---|
| Elevation (DTM / DEM) | `DTM` or `DEM` | GeoTIFF, real metres (Float32 or Int16). Not an 8-bit picture. |
| Image mosaic | `ortho` | GeoTIFF, georeferenced. |

Recommended source: USGS Astrogeology, Mars 2020 Terrain Relative Navigation products
(CTX DTM mosaic + CTX orthomosaic, or the HiRISE versions). Download them as GeoTIFF and do not re-export them.

The `.geojson` and `.csv` files in this folder are the team's vector layers and are committed.
`config.json` is optional: it overrides the area of interest and output sizes.

Then run `npm run prep` (or double-click `START.bat`). Files of several GB are fine: they are read in pieces.
