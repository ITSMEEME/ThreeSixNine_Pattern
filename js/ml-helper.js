window.App = window.App || {};

App.MLHelper = {
  // -------------------------------------------------------------------------
  // 1. DBSCAN (Density-Based Spatial Clustering of Applications with Noise)
  // -------------------------------------------------------------------------

  /**
   * Runs DBSCAN clustering on normalized data vectors.
   * @param {Array<Array<number>>} points - Array of feature vectors
   * @param {number} eps - Neighborhood distance threshold
   * @param {number} minPts - Minimum points to form a dense region
   * @returns {{ clusters: Array<Array<number>>, noise: Array<number> }} Indices of clustered points and noise
   */
  dbscan(points, eps = 0.15, minPts = 4) {
    if (!points || points.length === 0) return { clusters: [], noise: [] };

    const n = points.length;
    const visited = new Array(n).fill(false);
    const assigned = new Array(n).fill(false);
    const clusters = [];
    const noise = [];

    const euclideanDist = (a, b) => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const diff = a[i] - b[i];
        sum += diff * diff;
      }
      return Math.sqrt(sum);
    };

    const getNeighbors = (pointIdx) => {
      const neighbors = [];
      for (let i = 0; i < n; i++) {
        if (euclideanDist(points[pointIdx], points[i]) <= eps) {
          neighbors.push(i);
        }
      }
      return neighbors;
    };

    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      visited[i] = true;

      const neighbors = getNeighbors(i);
      if (neighbors.length < minPts) {
        noise.push(i);
      } else {
        const currentCluster = [];
        clusters.push(currentCluster);

        // Expand cluster
        const seedQueue = [...neighbors];
        for (let j = 0; j < seedQueue.length; j++) {
          const qIdx = seedQueue[j];

          if (!visited[qIdx]) {
            visited[qIdx] = true;
            const qNeighbors = getNeighbors(qIdx);
            if (qNeighbors.length >= minPts) {
              for (const qn of qNeighbors) {
                if (!seedQueue.includes(qn)) {
                  seedQueue.push(qn);
                }
              }
            }
          }

          if (!assigned[qIdx]) {
            assigned[qIdx] = true;
            currentCluster.push(qIdx);
            // If it was marked as noise before, remove it from noise
            const noiseIdx = noise.indexOf(qIdx);
            if (noiseIdx !== -1) noise.splice(noiseIdx, 1);
          }
        }
      }
    }

    return { clusters, noise };
  },

  // -------------------------------------------------------------------------
  // 2. K-Means Clustering (with K-Means++ Initialization)
  // -------------------------------------------------------------------------

  /**
   * Performs K-Means clustering on data points.
   * @param {Array<Array<number>>} data - Feature vectors
   * @param {number} k - Number of clusters
   * @param {number} maxIter - Maximum iterations
   * @returns {{ centroids: Array<Array<number>>, assignments: Array<number>, iterations: number }}
   */
  kmeans(data, k = 3, maxIter = 100) {
    if (!data || data.length === 0) return { centroids: [], assignments: [], iterations: 0 };
    const n = data.length;
    const d = data[0].length;

    if (n <= k) {
      return {
        centroids: data.map(v => [...v]),
        assignments: data.map((_, i) => i),
        iterations: 1
      };
    }

    const distSq = (a, b) => {
      let sum = 0;
      for (let i = 0; i < d; i++) {
        const diff = a[i] - b[i];
        sum += diff * diff;
      }
      return sum;
    };

    // K-Means++ Initialization
    const centroids = [];
    centroids.push([...data[Math.floor(Math.random() * n)]]);

    while (centroids.length < k) {
      const distances = data.map(pt => {
        let minDist = Infinity;
        for (const c of centroids) {
          const d2 = distSq(pt, c);
          if (d2 < minDist) minDist = d2;
        }
        return minDist;
      });

      const totalDist = distances.reduce((a, b) => a + b, 0);
      let rand = Math.random() * totalDist;
      let selectedIdx = 0;

      for (let i = 0; i < n; i++) {
        rand -= distances[i];
        if (rand <= 0) {
          selectedIdx = i;
          break;
        }
      }
      centroids.push([...data[selectedIdx]]);
    }

    const assignments = new Array(n).fill(0);
    let iterations = 0;
    let changed = true;

    while (changed && iterations < maxIter) {
      iterations++;
      changed = false;

      // Assign points to nearest centroid
      for (let i = 0; i < n; i++) {
        let minDist = Infinity;
        let bestC = 0;
        for (let cIdx = 0; cIdx < k; cIdx++) {
          const d2 = distSq(data[i], centroids[cIdx]);
          if (d2 < minDist) {
            minDist = d2;
            bestC = cIdx;
          }
        }
        if (assignments[i] !== bestC) {
          assignments[i] = bestC;
          changed = true;
        }
      }

      // Update centroids
      const sums = Array.from({ length: k }, () => new Array(d).fill(0));
      const counts = new Array(k).fill(0);

      for (let i = 0; i < n; i++) {
        const c = assignments[i];
        counts[c]++;
        for (let j = 0; j < d; j++) {
          sums[c][j] += data[i][j];
        }
      }

      for (let cIdx = 0; cIdx < k; cIdx++) {
        if (counts[cIdx] > 0) {
          for (let j = 0; j < d; j++) {
            centroids[cIdx][j] = sums[cIdx][j] / counts[cIdx];
          }
        }
      }
    }

    return { centroids, assignments, iterations };
  },

  // -------------------------------------------------------------------------
  // 3. Principal Component Analysis (PCA) with Jacobi Eigenvalue Solver
  // -------------------------------------------------------------------------

  /**
   * Computes PCA reduction for continuous features.
   * @param {Array<Array<number>>} data - Matrix [N x D]
   * @param {number} numComponents - Target dimensions
   * @returns {{ transformed: Array<Array<number>>, eigenvectors: Array<Array<number>>, eigenvalues: Array<number>, means: Array<number>, stds: Array<number>, explainedVarianceRatio: Array<number> }}
   */
  pca(data, numComponents = 3) {
    if (!data || data.length === 0) {
      return { transformed: [], eigenvectors: [], eigenvalues: [], means: [], stds: [], explainedVarianceRatio: [] };
    }

    const n = data.length;
    const d = data[0].length;
    const componentsCount = Math.min(numComponents, d);

    // 1. Z-Score Normalization
    const means = new Array(d).fill(0);
    const stds = new Array(d).fill(0);

    for (let j = 0; j < d; j++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += data[i][j];
      means[j] = sum / n;
    }

    for (let j = 0; j < d; j++) {
      let varianceSum = 0;
      for (let i = 0; i < n; i++) {
        varianceSum += (data[i][j] - means[j]) ** 2;
      }
      stds[j] = Math.sqrt(varianceSum / n) || 1.0;
    }

    const normalizedData = data.map(row => row.map((val, j) => (val - means[j]) / stds[j]));

    // 2. Compute Covariance Matrix (D x D)
    const cov = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < d; i++) {
      for (let j = i; j < d; j++) {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          sum += normalizedData[k][i] * normalizedData[k][j];
        }
        const val = sum / (n - 1 || 1);
        cov[i][j] = val;
        cov[j][i] = val;
      }
    }

    // 3. Jacobi Eigenvalue Algorithm for Symmetric Matrix
    const { eigenvalues, eigenvectors } = this.jacobiEigen(cov, d);

    // 4. Sort Eigenvalues and Eigenvectors in descending order
    const indices = eigenvalues.map((val, idx) => ({ val, idx }));
    indices.sort((a, b) => b.val - a.val);

    const sortedEigenvalues = indices.map(item => item.val);
    const sortedEigenvectors = Array.from({ length: d }, () => new Array(componentsCount).fill(0));

    for (let col = 0; col < componentsCount; col++) {
      const origCol = indices[col].idx;
      for (let row = 0; row < d; row++) {
        sortedEigenvectors[row][col] = eigenvectors[row][origCol];
      }
    }

    // Variance Ratio
    const totalVar = sortedEigenvalues.reduce((a, b) => a + Math.max(0, b), 0) || 1.0;
    const explainedVarianceRatio = sortedEigenvalues.slice(0, componentsCount).map(v => Math.max(0, v) / totalVar);

    // 5. Transform original normalized data
    const transformed = normalizedData.map(row => {
      const proj = new Array(componentsCount).fill(0);
      for (let c = 0; c < componentsCount; c++) {
        let dot = 0;
        for (let j = 0; j < d; j++) {
          dot += row[j] * sortedEigenvectors[j][c];
        }
        proj[c] = dot;
      }
      return proj;
    });

    return {
      transformed,
      eigenvectors: sortedEigenvectors,
      eigenvalues: sortedEigenvalues,
      means,
      stds,
      explainedVarianceRatio
    };
  },

  /**
   * Projects a single feature vector using a trained PCA model.
   * @param {Array<number>} vector - Raw feature vector
   * @param {Object} pcaModel - Model generated by pca()
   * @returns {Array<number>} Reduced feature vector
   */
  projectPCA(vector, pcaModel) {
    if (!pcaModel || !pcaModel.eigenvectors || !pcaModel.means || !pcaModel.stds) {
      return vector;
    }

    const d = vector.length;
    const numComponents = pcaModel.eigenvectors[0].length;
    const normalized = new Array(d);

    for (let j = 0; j < d; j++) {
      normalized[j] = (vector[j] - pcaModel.means[j]) / (pcaModel.stds[j] || 1.0);
    }

    const projected = new Array(numComponents).fill(0);
    for (let c = 0; c < numComponents; c++) {
      let dot = 0;
      for (let j = 0; j < d; j++) {
        dot += normalized[j] * pcaModel.eigenvectors[j][c];
      }
      projected[c] = dot;
    }
    return projected;
  },

  /**
   * Classical Jacobi Eigenvalue Solver for symmetric matrices.
   */
  jacobiEigen(matrix, d, maxIter = 50) {
    const A = matrix.map(r => [...r]);
    const V = Array.from({ length: d }, (_, i) => {
      const r = new Array(d).fill(0);
      r[i] = 1;
      return r;
    });

    for (let iter = 0; iter < maxIter; iter++) {
      // Find max off-diagonal element
      let maxOff = 0;
      let p = 0, q = 1;

      for (let i = 0; i < d - 1; i++) {
        for (let j = i + 1; j < d; j++) {
          if (Math.abs(A[i][j]) > maxOff) {
            maxOff = Math.abs(A[i][j]);
            p = i;
            q = j;
          }
        }
      }

      if (maxOff < 1e-9) break;

      // Jacobi rotation angle
      const diff = A[q][q] - A[p][p];
      let t;
      if (Math.abs(A[p][q]) < 1e-15) {
        t = 0;
      } else {
        const phi = diff / (2 * A[p][q]);
        t = 1 / (Math.abs(phi) + Math.sqrt(phi * phi + 1));
        if (phi < 0) t = -t;
      }

      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      const tau = s / (1 + c);

      const app = A[p][p];
      const aqq = A[q][q];
      const apq = A[p][q];

      A[p][p] = app - t * apq;
      A[q][q] = aqq + t * apq;
      A[p][q] = 0;
      A[q][p] = 0;

      for (let i = 0; i < d; i++) {
        if (i !== p && i !== q) {
          const aip = A[i][p];
          const aiq = A[i][q];
          A[i][p] = aip - s * (aiq + tau * aip);
          A[p][i] = A[i][p];
          A[i][q] = aiq + s * (aip - tau * aiq);
          A[q][i] = A[i][q];
        }

        // Update eigenvectors
        const vip = V[i][p];
        const viq = V[i][q];
        V[i][p] = vip - s * (viq + tau * vip);
        V[i][q] = viq + s * (vip - tau * viq);
      }
    }

    const eigenvalues = new Array(d);
    for (let i = 0; i < d; i++) eigenvalues[i] = A[i][i];

    return { eigenvalues, eigenvectors: V };
  }
};
