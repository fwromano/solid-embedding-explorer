# Ten-shape exploratory PLS

The original PLS fitted 240 balanced views from five Platonic solids and projected the added shapes onto those axes. The new display uses all 94,200 verified rows, with the same images and independently normalized 128/256/512/768 embedding prefixes.

For a shape/paint cell containing `n` rows, each row has weight `1 / (60*n)`. This balances all ten shapes and six paints while retaining every measured view. No additional embeddings or repeated views are generated.

The targets are shape one-hot, paint one-hot, and a four-coordinate pose contrast. Each included block has weighted squared magnitude one. Heading coordinates use sine/cosine of `2π × heading / symmetry_period` for the six shapes with discrete heading symmetry. Elevation coordinates use sine/cosine of physical elevation for the nine shapes with observable elevation. Each coordinate is centered over its observed labels; unobservable coordinates receive zero centered contrast. This is an explicitly defined display target, not an estimated angle. Sphere rows still contribute to predictor centering and covariance and, in the attribute fits, to shape and paint supervision.

The fitter implements three-component, centered, weighted PLS2 regression without feature standardization. For residual predictor covariance `Cxx` and cross-covariance `Cxy`, each component takes the leading left singular vector `w` of `Cxy`, computes `v=wᵀCxxw`, `p=Cxxw/v`, and `q=Cxyᵀw/v`, then deflates `Cxx -= v ppᵀ` and `Cxy -= v pqᵀ`. The final rotation is `W(PᵀW)⁻¹`. This is the covariance form of X-score deflation in [PLS regression](https://scikit-learn.org/stable/modules/cross_decomposition.html#plsregression), applied to weighted centered data.

Every projection is `(normalized_embedding - weighted_center) @ rotation`. Target labels are used during fitting only. No PCA variance percentage or held-out accuracy is reported. Filtering the display preserves the fitted axes. The old PCA and semantic bases and all image/vector bytes remain unchanged.

`tools/refit_pls.py` verifies the original catalog and vector hashes, binds them to the released static vectors, and creates a separate derived data directory. Example with local source paths supplied explicitly:

```sh
OPENBLAS_NUM_THREADS=4 python tools/refit_pls.py \
  --source-build /path/to/build-81cec6a56ad50b85d5afc982 \
  --static-data /path/to/original-static-data \
  --out /var/tmp/shape-explorer-pls-v2
```

Use NumPy 2.2.6 for the recorded build. The derived catalog records the fitter hash, source catalog hash, row-ID digest, group weights, label availability, and block normalizations. Each downloadable basis records its row IDs, center, rotations, weights and loadings. The release manifest pins the complete archive.

Numerical tests compare weighted covariance PLS against independent iterative NIPALS on explicitly replicated synthetic observations. They also check score orthogonality, equal cell/block weights, invariance to unobservable angle labels, invariance to duplicate sampling within a cell, and rejection of missing cells or exhausted covariance. Real-data validation reconstructs all twelve coordinate arrays from the saved bases and confirms that all sixteen PCA/semantic projections and their bases are byte-identical to the prior release.
