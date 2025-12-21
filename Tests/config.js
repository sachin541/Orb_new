// config.js

const COMMON = {
  scaleFactor: 1.2,
  nlevels: 8,
  edgeThreshold: 10,
  firstLevel: 0,
  WTA_K: 2,
  patchSize: 31,
  fastThreshold: 12
};

// Generate [250, 500, 750, ..., 5000]
const NFEATURES = Array.from(
  { length: Math.floor(5000 / 250) },
  (_, i) => (i + 1) * 250
);

export const PRESETS = [
  // HARRIS_SCORE presets
  ...NFEATURES.map(n => ({
    name: `harris_${n}`,
    params: [
      n,
      COMMON.scaleFactor,
      COMMON.nlevels,
      COMMON.edgeThreshold,
      COMMON.firstLevel,
      COMMON.WTA_K,
      "HARRIS",
      COMMON.patchSize,
      COMMON.fastThreshold
    ]
  })),

  // FAST_SCORE presets
  ...NFEATURES.map(n => ({
    name: `fast_${n}`,
    params: [
      n,
      COMMON.scaleFactor,
      COMMON.nlevels,
      COMMON.edgeThreshold,
      COMMON.firstLevel,
      COMMON.WTA_K,
      "FAST",
      COMMON.patchSize,
      COMMON.fastThreshold
    ]
  }))
];

// Benchmark settings
export const RUNS = 8;     // measured runs per preset
export const WARMUP = 1;   // warmup runs (not counted)
export const GRID = 8;     // 8x8 grid = 64 cells
