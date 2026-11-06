# Solid embedding explorer

A GitHub Pages adaptation of the verified local 94,200-view, ten-shape embedding explorer.

**[Open the live Shape Explorer](https://fwromano.github.io/solid-embedding-explorer/)**

The dataset contains the original five Platonic solids plus cylinder, five-point star prism, cone, sphere and torus. All rows are actual rendered and encoded views. The 12 PLS projections cover all ten shapes; the 16 PCA/semantic projections retain their existing bases. Display filtering does not refit any axes.

## Static implementation

The browser performs exact selected-prefix cosine neighbors, physical-reference comparisons, reference galleries and native-mask IoU. Vector work runs in a worker so plotting remains interactive. All four original float32 prefix arrays are transported losslessly. Display RGB files use verified pixel-identical lossless WebP; native masks retain their original PNG bytes. No embeddings or views are fabricated or downsampled.

`docs/TRANSPORT.md` defines the transport and provenance contract. The original working local viewers, source datasets and existing vehicle website are not modified by this project.

The complete static data is stored in the [data-pls-v2 release](https://github.com/fwromano/solid-embedding-explorer/releases/tag/data-pls-v2). `release-data.json` pins its size and SHA256. The Pages workflow restores and verifies the archive, runs the tests, and publishes the site from `main`. The original five-shape PLS remains available in the earlier `data-v1` release.

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
