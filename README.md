# Solid embedding explorer

A GitHub Pages adaptation of the verified local 94,200-view, ten-shape embedding explorer.

**[Open the live Shape Explorer](https://fwromano.github.io/solid-embedding-explorer/)**

The dataset contains the original five Platonic solids plus cylinder, five-point star prism, cone, sphere and torus. Its 94,200 measured rows are expanded into 540,000 selectable views using each object's documented heading symmetry. The 12 PLS projections cover all ten shapes; the 16 PCA/semantic projections retain their existing bases. Display filtering does not refit any axes.

## Full-heading symmetry views

Every shape/paint pair has 360 headings at each of the 25 recorded elevations (−60° through +60°), for 9,000 views per pair. A cube's 0° view is repeated at 90°, 180°, and 270° with the same embedding, image, and projection coordinates. Tetrahedra repeat every 120°, octahedra every 90°, dodecahedra and icosahedra every 72°, and the star prism every 180° about world +Z. Cylinder, cone, sphere, and torus reuse their heading-0° representatives on the one-degree heading grid; these ideal continuous aliases approximate the finite rendered meshes.

The heading filters, view map, playback and shared links retain each repeated view's physical heading. The inspector identifies its measured source. Copies overlap in the embedding plot: every visible copy contributes equally to the blended RGB color at its source position. Color mapping evaluates all 540,000 views, including symmetry repeats; filtering blends only the remaining views. The inspector swatch retains the selected view’s individual viewpoint color. Playback moves only the inspection marker unless a heading/elevation filter explicitly follows the request. Picking resolves the shared position to the selected copy or the visible copy nearest the requested heading. Source embeddings are stored once; projections and exact-neighbor calculations retain the measured cohort and do not overweight repeats. No polar-cap views or camera-roll equivalences are inferred, and measured sphere elevations are retained.

“Download full-heading view mapping” exports a CSV with `view_id`, `source_row_id`, `source_index`, shape, paint, heading, elevation, and alias status. Index any original prefix or projection array with `source_index` to materialize the repeated rows in CSV order. Source IDs and source array order remain unchanged; alias view IDs are separate and stable for the same source dataset.

## Coverage and display counts

The coverage panel separates measured embeddings, symmetry repeats, expected sampling coverage, and views matching the current filters for every shape. The plot reports source points with visible pixels, overlapping points, and points outside the frame. “Show all data” restores every shape/paint pair and all available headings/elevations, then fits the camera to those points. The view map keeps every available pose and dims those excluded by the plot filters. Complete coverage refers to the recorded angular grid; it does not imply polar-cap or camera-roll data.

## Static implementation

The browser performs exact selected-prefix cosine neighbors, physical-reference comparisons, reference galleries and native-mask IoU. Vector work runs in a worker so plotting remains interactive. All four original float32 prefix arrays are transported losslessly. Display RGB files use verified pixel-identical lossless WebP; native masks retain their original PNG bytes. Symmetry views reference these exact artifacts; no new encoding is needed.

`docs/TRANSPORT.md` defines the transport and provenance contract. The original working local viewers, source datasets and existing vehicle website are not modified by this project.

The complete static data is stored in the [data-pls-v2 release](https://github.com/fwromano/solid-embedding-explorer/releases/tag/data-pls-v2). `release-data.json` pins its size and SHA256. The Pages workflow restores and verifies the archive, runs the tests, and publishes the site from `main`. The original five-shape PLS remains available in the earlier `data-v1` release.

The image preview supports mouse or touch dragging in both axes: horizontal motion changes heading, and vertical motion changes elevation. It follows an object-grab direction, wraps heading, and clamps elevation to the recorded −60°…+60° range. Arrow keys use the same directions (Shift steps 15°); the image uses the nearest available view.

## Ten-shape PLS

All 94,200 existing normalized embeddings contribute to the refit. Each of the 60 shape/paint pairs receives equal total weight, so denser heading grids do not dominate. Shape, paint, and pose target blocks are separately centered and normalized to equal weighted variance. The three PLS choices are attributes plus pose, attributes only, and pose only, each fitted separately at 128D, 256D, 512D, and 768D.

Pose targets use symmetry-aware heading phase and elevation sin/cos only where observable. Unobservable coordinates have zero centered contrast: cylinder, cone, and torus supply no heading signal; sphere supplies no pose signal. These are exploratory fits on the displayed data, with no held-out performance claim. See [the PLS refit method](docs/PLS-REFIT.md) for reproduction and verification.

Development uses the separate `feat/public-solids-pages` branch.

## Local checks and preview

Install `requirements-dev.txt` in a Python virtual environment, then run:

```sh
node --test tests/*.test.js site/tests/*.test.js
TMPDIR=/var/tmp python -m pytest -p no:cacheprovider -W error tests/test_build_static_data.py tests/test_release_bundle.py tests/test_workflow.py tests/test_refit_pls.py -q
gh release download data-pls-v2 --repo fwromano/solid-embedding-explorer --pattern shape-explorer-data-pls-v2.tar.gz --dir /tmp
python tools/release_bundle.py restore --archive /tmp/shape-explorer-data-pls-v2.tar.gz --manifest release-data.json --frontend site --out /tmp/shape-explorer-preview
python -m http.server 8000 --directory /tmp/shape-explorer-preview
```

The restore destination must not already exist. Open `http://localhost:8000/`. Exact-neighbor diagnostics download the selected vector prefix separately from the plot; the first load can take longer than later interactions.

## Browser verification

The deployed site was checked in Chromium with all 94,200 catalog rows, all ten shapes, source-image selection, projection and palette changes, playback, exact neighbors at 128D and 768D, and native-mask IoU. The same mask comparison failed in Brave with `Mask is not opaque grayscale`, consistent with canvas privacy protection; use Chromium for that comparison if this occurs. The plot and vector diagnostics passed in both browsers.
