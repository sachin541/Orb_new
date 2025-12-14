// config.js
export const PRESETS = [
  {
    name: "baseline",
    params: [500, 1.2, 8, 31, 0, 2, "HARRIS", 31, 20]
  },
  {
    name: "webar_2k",
    params: [2000, 1.2, 8, 10, 0, 2, "HARRIS", 31, 12]
  },
  {
    name: "fast_score",
    params: [1000, 1.2, 6, 15, 0, 2, "FAST", 31, 20]
  }
];

// Benchmark settings
export const RUNS = 8;       // measured runs per preset
export const WARMUP = 1;     // warmup runs per preset (not counted)
export const GRID = 8;       // grid size for occupancy score (8 => 64 cells)
