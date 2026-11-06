"""Numerical and supervision checks for the ten-shape exploratory refit."""
import importlib.util
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('refit_pls', Path(__file__).parents[1]/'tools/refit_pls.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def nipals(x, y):
    """Independent iterative PLS regression on explicitly replicated rows."""
    e, f = x-x.mean(axis=0), y-y.mean(axis=0)
    rotations, loadings = [], []
    for _ in range(3):
        u = f[:, np.argmax(np.sum(f*f, axis=0))].copy()
        previous = np.zeros(e.shape[1])
        for iteration in range(10000):
            w = e.T @ u; w /= np.linalg.norm(w)
            t = e @ w
            q = f.T @ t / (t @ t)
            u = f @ q / (q @ q)
            if np.linalg.norm(w-previous) < 1e-13:
                break
            previous = w.copy()
        else:
            raise AssertionError('NIPALS did not converge')
        if w[np.argmax(np.abs(w))] < 0:
            w = -w; t = -t; q = -q
        p = e.T @ t / (t @ t)
        r = w.copy()
        for old_r, old_p in zip(rotations, loadings):
            r -= old_r * (old_p @ w)
        rotations.append(r); loadings.append(p)
        e -= np.outer(t, p); f -= np.outer(t, q)
    return np.column_stack(rotations)


class RefitTests(unittest.TestCase):
    def test_weighted_covariance_fit_matches_replicated_nipals(self):
        rng = np.random.default_rng(902)
        x = rng.normal(size=(31, 11))
        y = x @ rng.normal(size=(11, 5)) + rng.normal(size=(31, 5))*.4
        repeats = rng.integers(1, 7, size=len(x))
        weights = repeats/repeats.sum()
        xc, yc = x-weights@x, y-weights@y
        actual = m.fit_pls_covariance(xc.T@(weights[:, None]*xc), xc.T@(weights[:, None]*yc))
        reference = nipals(np.repeat(x, repeats, axis=0), np.repeat(y, repeats, axis=0))
        np.testing.assert_allclose(actual['rotation'], reference, rtol=1e-9, atol=1e-10)
        scores = xc@actual['rotation']
        gram = scores.T@(weights[:, None]*scores)
        np.testing.assert_allclose(gram, np.diag(np.diag(gram)), atol=1e-12)

    def fixture(self):
        shapes = [dict(id='cube', heading_symmetry=dict(kind='discrete', period_deg=90)),
                  dict(id='cylinder', heading_symmetry=dict(kind='continuous'), observable_heading=False, observable_elevation=True),
                  dict(id='sphere', heading_symmetry=dict(kind='continuous'), observable_heading=False, observable_elevation=False)]
        rows = []
        for shape, count in zip(shapes, (12, 4, 3)):
            for paint in ('red', 'blue'):
                for i in range(count):
                    rows.append(dict(id=len(rows), shape=shape['id'], color=paint, heading=i*11, elevation=-40+i*8))
        return rows, shapes, ['red', 'blue']

    def test_balanced_cells_equal_target_blocks_and_unobservable_pose(self):
        rows, shapes, paints = self.fixture()
        weights, targets, blocks, cells = m.targets_and_weights(rows, shapes, paints)
        for cell in cells:
            selected = [i for i,r in enumerate(rows) if (r['shape'],r['color'])==(cell['shape'],cell['paint'])]
            self.assertAlmostEqual(weights[selected].sum(), 1/6)
        for block in targets.values():
            np.testing.assert_allclose(weights@block, 0, atol=1e-14)
            self.assertAlmostEqual(float(np.sum(weights[:,None]*block**2)), 1)
        sphere = [i for i,r in enumerate(rows) if r['shape']=='sphere']
        cylinder = [i for i,r in enumerate(rows) if r['shape']=='cylinder']
        np.testing.assert_array_equal(targets['pose'][sphere], 0)
        np.testing.assert_array_equal(targets['pose'][cylinder,:2], 0)
        changed = [dict(r) for r in rows]
        for r in changed:
            if r['shape'] in ('cylinder', 'sphere'): r['heading']=9999
            if r['shape']=='sphere': r['elevation']=9999
        again = m.targets_and_weights(changed, shapes, paints)
        np.testing.assert_array_equal(again[1]['pose'], targets['pose'])

    def test_more_samples_of_one_identical_cell_do_not_change_fit(self):
        rows, shapes, paints = self.fixture()
        x = np.random.default_rng(89).normal(size=(len(rows), 8))
        def fitting(rr, xx):
            w, y, _, _ = m.targets_and_weights(rr, shapes, paints)
            xx = xx-w@xx
            yy = np.concatenate(list(y.values()), axis=1)
            return m.fit_pls_covariance(xx.T@(w[:,None]*xx), xx.T@(w[:,None]*yy))['rotation']
        expected = fitting(rows, x)
        indices = [i for i,r in enumerate(rows) if r['shape']=='cube' and r['color']=='red']
        added = [dict(rows[i], id=len(rows)+k) for k,i in enumerate(indices)]
        np.testing.assert_allclose(fitting(rows+added, np.concatenate((x,x[indices]))), expected, atol=1e-12)

    def test_missing_cells_and_exhausted_covariance_rejected(self):
        rows, shapes, paints = self.fixture()
        with self.assertRaises(ValueError):
            m.targets_and_weights([r for r in rows if (r['shape'],r['color'])!=('sphere','blue')], shapes, paints)
        with self.assertRaises(ValueError):
            m.fit_pls_covariance(np.eye(5), np.zeros((5,3)))


if __name__ == '__main__':
    unittest.main()
