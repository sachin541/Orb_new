// lsh.js - LSH indexing and matching ONLY (NO Kalman, NO Temporal tracking)

import { hamming32, makeBitPositions, lshHash, computeDescriptorStats } from "./helpers.js";

// ---------------- LSH Index Building ----------------
export function buildLSHIndex(refDescU8, refRows, {
  numTables = 10,
  keyBits   = 18,
  seedBase  = 1337
} = {}){
  if (!(refDescU8 instanceof Uint8Array)) {
    throw new Error("refDescU8 must be Uint8Array");
  }
  if (refDescU8.length !== refRows * 32) {
    throw new Error(`refDescU8 length mismatch: expected ${refRows*32}, got ${refDescU8.length}`);
  }

  const tables = [];
  for (let t = 0; t < numTables; t++){
    const bitPos = makeBitPositions(keyBits, seedBase + t * 101);
    const buckets = new Map();

    for (let i = 0; i < refRows; i++){
      const off = i * 32;
      const h = lshHash(refDescU8, off, bitPos);
      let arr = buckets.get(h);
      if (!arr){ arr = []; buckets.set(h, arr); }
      arr.push(i);
    }
    tables.push({ bitPos, buckets });
  }

  const stats = computeDescriptorStats(refDescU8, refRows);
  return { refDescU8, refRows, tables, stats };
}

function addCandidatesFromBucket(buckets, hash, seen, cands, refRows, maxCandidates){
  const arr = buckets.get(hash);
  if (!arr) return;

  for (let k = 0; k < arr.length; k++){
    if (cands.length >= maxCandidates) break;
    const refIdx = arr[k];
    if (refIdx >= refRows) continue;
    if (seen[refIdx]) continue;
    seen[refIdx] = 1;
    cands.push(refIdx);
  }
}

// ---------------- LSH Matching with Ratio Test ----------------
export function lshMatchRatio(index, liveDescU8, liveRows, {
  maxCandidates = 600,
  ratio = 0.75,
  maxHamming = null,
  useMultiProbe = true
} = {}){
  const { refDescU8, refRows, tables, stats } = index;

  if (!(liveDescU8 instanceof Uint8Array)) {
    throw new Error("liveDescU8 must be Uint8Array");
  }
  if (liveDescU8.length !== liveRows * 32) {
    throw new Error(`liveDescU8 length mismatch: expected ${liveRows*32}, got ${liveDescU8.length}`);
  }

  const adaptiveMaxHamming = maxHamming ?? Math.max(48, Math.floor(stats.meanDist * 0.4));

  const matches = [];
  const seen = new Uint8Array(refRows);

  for (let j = 0; j < liveRows; j++){
    const liveOff = j * 32;
    const cands = [];

    for (let t = 0; t < tables.length; t++){
      const { bitPos, buckets } = tables[t];
      const h = lshHash(liveDescU8, liveOff, bitPos);

      addCandidatesFromBucket(buckets, h, seen, cands, refRows, maxCandidates);

      if (useMultiProbe && cands.length < maxCandidates && bitPos.length <= 20){
        for (let b = 0; b < Math.min(3, bitPos.length); b++){
          const hNeighbor = h ^ (1 << b);
          addCandidatesFromBucket(buckets, hNeighbor, seen, cands, refRows, maxCandidates);
          if (cands.length >= maxCandidates) break;
        }
      }

      if (cands.length >= maxCandidates) break;
    }

    // clear seen flags for next live descriptor
    for (let k = 0; k < cands.length; k++) seen[cands[k]] = 0;

    if (cands.length === 0){
      matches.push(null);
      continue;
    }

    let bestIdx = -1;
    let bestD = 1e9;
    let secondBestIdx = -1;
    let secondD = 1e9;

    for (let k = 0; k < cands.length; k++){
      const i = cands[k];
      const d = hamming32(refDescU8, i * 32, liveDescU8, liveOff);

      if (d < bestD){
        secondD = bestD;
        secondBestIdx = bestIdx;
        bestD = d;
        bestIdx = i;
      } else if (d < secondD){
        secondD = d;
        secondBestIdx = i;
      }
    }

    const validRatio = secondD < 1e9 &&
                      secondBestIdx !== bestIdx &&
                      bestD < ratio * secondD;

    const validDistance = bestD <= adaptiveMaxHamming;

    if (bestIdx >= 0 && validRatio && validDistance){
      matches.push({ queryIdx: bestIdx, trainIdx: j, distance: bestD });
    } else {
      matches.push(null);
    }
  }

  return matches;
}
