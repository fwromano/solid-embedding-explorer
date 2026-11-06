# Static transport v1 (implementation contract)

The accepted Python viewer stays untouched. This project publishes the same 94,200 real rows on GitHub Pages and computes diagnostics in a dedicated browser worker. No server/API backend and no inference.

All published file paths below are safe relative paths resolved against `new URL('.', import.meta.url)` in site/transport.js. Never resolve against domain root or allow traversal/foreign origins. Original virtual URLs `/data/...` and `/dataset/...` remain in row metadata and app protocol, mapped explicitly by transport. No global fetch monkeypatch.

`site/deployment.json`:

    {
      "schema": "solids-static-v1",
      "build_id": "build-81cec6a56ad50b85d5afc982",
      "count": 94200,
      "source_catalog_sha256": "56dd1c2695c1724686d09d1b0312d64b3cd4719e39aa0794a4061f4a0fe85a34",
      "files": {
        "/data/current.json": {"path":"data/current.json","encoding":"identity","sha256":"...","raw_sha256":"...","bytes":123,"raw_bytes":123},
        "/data/build-81cec6a56ad50b85d5afc982/catalog.json": {"path":"data/build-81cec6a56ad50b85d5afc982/catalog.json.gz","encoding":"gzip","sha256":"...","raw_sha256":"...","bytes":123,"raw_bytes":456}
      },
      "vectors": {
        "128": {"dimension":128,"count":94200,"dtype":"<f4","raw_sha256":"...","chunks":[
          {"path":"vectors/128/<gzip-sha256>.bin.gz","start":0,"count":4096,"bytes":123,"raw_bytes":2097152,"sha256":"...","raw_sha256":"..."}
        ]}
      }
    }

Actual chunk count may vary. All 128/256/512/768 prefixes are stored byte-exact, not reconstructed from a lossy or differently rounded prefix. Chunk encoding is gzip of four byte planes: concatenate raw float32 bytes at offsets 0::4, 1::4, 2::4, 3::4. Decode gzip, invert the shuffle, verify raw bytes SHA256, then populate exact Float32Array. Descriptor start/count are row units. Validate contiguous exact coverage and dimensions. One active prefix in worker; dimension change terminates obsolete worker/requests and frees memory. Same-dimension diagnostic requests share loading. Report download progress; initial point cloud must not wait for vectors.

Catalog is a derived public transport catalog with original IDs, poses, source metadata, original source hashes, fits and projection values preserved. Machine-specific source_config/runtime paths are omitted explicitly and bound by original catalog hash. Original row.image and row.mask virtual URLs stay unchanged for strict legacy validation; additional row.image_asset (`media/<encoded-file-sha256>.webp`) and row.mask_asset (`media/<original-PNG-sha256>.png`) map to pixel-identical 512px RGB and exact native mask PNG. Packager verifies every WebP decoded RGB byte against original, and keeps original RGB files untouched. Duplicate files share immutable assets. Only strict relative media/hash paths are accepted. Masks remain lossless native grayscale samples for IoU; source PNG hash remains in metadata.

The files map also includes every projection .f32 and basis JSON, byte-identical to accepted build. Direct downloads use assetURL(virtualURL); gzip catalog may download as .json.gz, accurately label it.

API virtual routes handled by explicit fetchStatic (not real HTTP): status from validated immutable metadata; neighbors/reference/reference-gallery in worker using site/diagnostics.js; IoU from downloaded native masks and exported maskIoU. All responses retain existing JSON fields and selected-prefix meaning. Validate allowed query fields, build, IDs, dimensions, k; no external URLs. Refresh remains unsupported (409 / disabled). For non-API assets return actual Response after hash and optional decompression. Native fetch only receives safe mapped published URLs. Abort signals discard obsolete results; preserve existing panel/selection version guards.

Pure math module supplied independently: `new ExactDiagnostics(rows, float32Values, dimensions)`, `.neighbors(id,k=8)`, `.reference(id)`, `.gallery(id,k=8)`, and `maskIoU(firstUint8Array, secondUint8Array, id, other)`.

The static site must remain under 1 GB (reserve frontend headroom), and the uncompressed deployment tar under 10 GB, per the current official Pages/action limits verified in evidence/official-pages-constraints.json. Individual Release assets must remain under 2 GiB. Verify actual bytes before upload. Large immutable data is distributed as a public GitHub Release asset, not oversized Git blobs. Git source branch is feat/public-solids-pages. Original github.io vehicle repository, local original/expanded data and local server pointers remain unchanged.
