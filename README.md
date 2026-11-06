# Solid embedding explorer

A GitHub Pages adaptation of the verified local 94,200-view, ten-shape embedding explorer.

**[Open the live Shape Explorer](https://fwromano.github.io/solid-embedding-explorer/)**

The dataset contains the original five Platonic solids plus cylinder, five-point star prism, cone, sphere and torus. All rows are actual rendered and encoded views. The 28 projections retain their original fit/cohort semantics; display filtering does not refit them.

## Static implementation

The browser performs exact selected-prefix cosine neighbors, physical-reference comparisons, reference galleries and native-mask IoU. Vector work runs in a worker so plotting remains interactive. All four original float32 prefix arrays are transported losslessly. Display RGB files use verified pixel-identical lossless WebP; native masks retain their original PNG bytes. No embeddings or views are fabricated or downsampled.

`docs/TRANSPORT.md` defines the transport and provenance contract. The original working local viewers, source datasets and existing vehicle website are not modified by this project.

The complete static data is stored in the [data-v1 release](https://github.com/fwromano/solid-embedding-explorer/releases/tag/data-v1). `release-data.json` pins its size and SHA256. The Pages workflow restores and verifies the archive, runs the tests, and publishes the site from `main`.

Development uses the separate `feat/public-solids-pages` branch.

## Local checks and preview

Install `requirements-dev.txt` in a Python virtual environment, then run:

```sh
node --test tests/*.test.js site/tests/*.test.js
TMPDIR=/var/tmp python -m pytest -p no:cacheprovider -W error tests/test_build_static_data.py tests/test_release_bundle.py tests/test_workflow.py -q
gh release download data-v1 --repo fwromano/solid-embedding-explorer --pattern shape-explorer-data-v1.tar.gz --dir /tmp
python tools/release_bundle.py restore --archive /tmp/shape-explorer-data-v1.tar.gz --manifest release-data.json --frontend site --out /tmp/shape-explorer-preview
python -m http.server 8000 --directory /tmp/shape-explorer-preview
```

The restore destination must not already exist. Open `http://localhost:8000/`. Exact-neighbor diagnostics download the selected vector prefix separately from the plot; the first load can take longer than later interactions.

## Browser verification

The deployed site was checked in Chromium with all 94,200 catalog rows, all ten shapes, source-image selection, projection and palette changes, playback, exact neighbors at 128D and 768D, and native-mask IoU. The same mask comparison failed in Brave with `Mask is not opaque grayscale`, consistent with canvas privacy protection; use Chromium for that comparison if this occurs. The plot and vector diagnostics passed in both browsers.
