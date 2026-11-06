# Solid embedding explorer

A GitHub Pages adaptation of the verified local 94,200-view, ten-shape embedding explorer. Publication is in progress; this repository is not yet a verified live deployment.

The dataset contains the original five Platonic solids plus cylinder, five-point star prism, cone, sphere and torus. All rows are actual rendered and encoded views. The 28 projections retain their original fit/cohort semantics; display filtering does not refit them.

## Static implementation

The browser will perform exact selected-prefix cosine neighbors, physical-reference comparisons, reference galleries and native-mask IoU, rather than depending on a Python web server. Expensive vector work belongs in a worker so plotting remains interactive. All four original float32 prefix arrays are transported losslessly. Display RGB files may use verified pixel-identical lossless WebP; native masks retain their original PNG bytes. No embeddings or views are fabricated or downsampled.

`docs/TRANSPORT.md` defines the transport and provenance contract. The original working local viewers, source datasets and existing vehicle website are not modified by this project.

Large verified static data will be kept in a separate GitHub Release asset, not ordinary Git blobs. A pinned deployment workflow will restore and verify it before publishing. Build/test/deployment instructions and the actual public URL will be added after real end-to-end verification.

Development uses the separate `feat/public-solids-pages` branch. Local acceptance of the Python-backed predecessor does not establish acceptance of this new static transport; its actual-data and public-browser checks are separate gates.
