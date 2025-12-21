// lsh.js - Balanced version with temporal tracking (faster matching)
// Pure-JS approximate matcher for ORB (binary 32-byte descriptors)

const popcnt8 = new Uint8Array(256);
for (let i = 0; i < 256; i++){
  let x = i, c = 0;
  while (x){ x &= x - 1; c++; }
  popcnt8[i] = c;
}

function hamming32(aU8, aOff, bU8, bOff){
  let d = 0;
  for (let i = 0; i < 32; i++){
    d += popcnt8[aU8[aOff + i] ^ bU8[bOff + i]];
  }
  return d;
}

// Improved bit position selection using stratified sampling
function makeBitPositions(kbits, seed = 1337){
  let s = seed >>> 0;
  function rnd(){
    s = (1664525 * s + 1013904223) >>> 0;
    return s;
  }
  
  const arr = [];
  const bitsPerByte = Math.ceil(kbits / 32);
  
  // Sample evenly from each byte to maximize entropy
  for (let byteIdx = 0; byteIdx < 32 && arr.length < kbits; byteIdx++){
    const used = new Set();
    for (let b = 0; b < bitsPerByte && arr.length < kbits; b++){
      let bitInByte = rnd() % 8;
      let attempts = 0;
      while (used.has(bitInByte) && attempts < 20){
        bitInByte = rnd() % 8;
        attempts++;
      }
      used.add(bitInByte);
      arr.push(byteIdx * 8 + bitInByte);
    }
  }
  
  return arr;
}

function lshHash(descU8, off, bitPos){
  let h = 0;
  for (let i = 0; i < bitPos.length; i++){
    const p = bitPos[i];
    const byte = p >> 3;
    const bit  = p & 7;
    const v = (descU8[off + byte] >> bit) & 1;
    h |= (v << i);
  }
  return h >>> 0;
}

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

function computeDescriptorStats(descU8, rows){
  if (rows < 2) return { meanDist: 128, stdDist: 32 };
  
  const sampleSize = Math.min(500, Math.floor(rows * rows / 2));
  let sumDist = 0;
  let count = 0;
  
  const step = Math.max(1, Math.floor(rows * rows / (2 * sampleSize)));
  
  for (let i = 0; i < rows && count < sampleSize; i += Math.max(1, Math.floor(Math.sqrt(step)))){
    for (let j = i + 1; j < rows && count < sampleSize; j += step){
      const d = hamming32(descU8, i * 32, descU8, j * 32);
      sumDist += d;
      count++;
    }
  }
  
  const meanDist = count > 0 ? sumDist / count : 128;
  return { meanDist, stdDist: 32 };
}

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

    let candCount = 0;
    const cands = [];

    for (let t = 0; t < tables.length; t++){
      const { bitPos, buckets } = tables[t];
      const h = lshHash(liveDescU8, liveOff, bitPos);
      
      addCandidatesFromBucket(buckets, h, seen, cands, refRows, maxCandidates);
      candCount = cands.length;
      
      if (useMultiProbe && candCount < maxCandidates && bitPos.length <= 20){
        for (let b = 0; b < Math.min(3, bitPos.length); b++){
          const hNeighbor = h ^ (1 << b);
          addCandidatesFromBucket(buckets, hNeighbor, seen, cands, refRows, maxCandidates);
          if (cands.length >= maxCandidates) break;
        }
      }
      
      if (cands.length >= maxCandidates) break;
    }

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

export function getMatchingStats(matches){
  const valid = matches.filter(m => m !== null);
  const distances = valid.map(m => m.distance);
  
  if (distances.length === 0){
    return { count: 0, meanDist: 0, minDist: 0, maxDist: 0 };
  }
  
  distances.sort((a, b) => a - b);
  
  return {
    count: valid.length,
    meanDist: distances.reduce((a, b) => a + b, 0) / distances.length,
    minDist: distances[0],
    maxDist: distances[distances.length - 1],
    medianDist: distances[Math.floor(distances.length / 2)]
  };
}

// Temporal tracker for stable homography across frames
export class TemporalTracker {
  constructor({
    smoothingFactor = 0.25,
    predictionWeight = 0.2,
    minMatchesForUpdate = 6,
    maxFramesWithoutDetection = 12,
    adaptiveRelaxation = true
  } = {}){
    this.smoothingFactor = smoothingFactor;
    this.predictionWeight = predictionWeight;
    this.minMatchesForUpdate = minMatchesForUpdate;
    this.maxFramesWithoutDetection = maxFramesWithoutDetection;
    this.adaptiveRelaxation = adaptiveRelaxation;
    
    this.prevCorners = null;
    this.prevPrevCorners = null;
    this.velocity = null;
    this.framesWithoutDetection = 0;
    this.isTracking = false;
    this.confidenceHistory = [];
  }
  
  update(corners, matchCount){
    if (!corners || matchCount < this.minMatchesForUpdate){
      this.framesWithoutDetection++;
      
      if (this.isTracking && this.prevCorners && this.velocity && 
          this.framesWithoutDetection <= this.maxFramesWithoutDetection){
        const predicted = this._predictCorners();
        return { corners: predicted, confidence: 0.3, mode: 'predicted' };
      }
      
      if (this.framesWithoutDetection > this.maxFramesWithoutDetection){
        this.reset();
      }
      
      return { corners: null, confidence: 0, mode: 'lost' };
    }
    
    this.framesWithoutDetection = 0;
    
    if (!this.prevCorners){
      this.prevCorners = this._cloneCorners(corners);
      this.isTracking = true;
      return { corners, confidence: 0.8, mode: 'initial' };
    }
    
    if (this.prevPrevCorners){
      this.velocity = [];
      for (let i = 0; i < 4; i++){
        this.velocity.push({
          x: this.prevCorners[i].x - this.prevPrevCorners[i].x,
          y: this.prevCorners[i].y - this.prevPrevCorners[i].y
        });
      }
    }
    
    const smoothed = [];
    const alpha = this.smoothingFactor;
    
    for (let i = 0; i < 4; i++){
      let x = (1 - alpha) * this.prevCorners[i].x + alpha * corners[i].x;
      let y = (1 - alpha) * this.prevCorners[i].y + alpha * corners[i].y;
      
      if (this.velocity && this.predictionWeight > 0){
        x += this.predictionWeight * this.velocity[i].x;
        y += this.predictionWeight * this.velocity[i].y;
      }
      
      smoothed.push({ x, y });
    }
    
    this.prevPrevCorners = this.prevCorners;
    this.prevCorners = smoothed;
    
    const confidence = Math.min(0.95, 0.5 + matchCount / 40);
    this.confidenceHistory.push(confidence);
    if (this.confidenceHistory.length > 10) this.confidenceHistory.shift();
    
    return { corners: smoothed, confidence, mode: 'tracking' };
  }
  
  _predictCorners(){
    if (!this.prevCorners || !this.velocity) return this.prevCorners;
    
    const predicted = [];
    for (let i = 0; i < 4; i++){
      predicted.push({
        x: this.prevCorners[i].x + this.velocity[i].x,
        y: this.prevCorners[i].y + this.velocity[i].y
      });
    }
    return predicted;
  }
  
  _cloneCorners(corners){
    return corners.map(c => ({ x: c.x, y: c.y }));
  }
  
  reset(){
    this.prevCorners = null;
    this.prevPrevCorners = null;
    this.velocity = null;
    this.framesWithoutDetection = 0;
    this.isTracking = false;
    this.confidenceHistory = [];
  }
  
  shouldRelaxThresholds(){
    return this.adaptiveRelaxation && 
           this.framesWithoutDetection > 3 && 
           this.framesWithoutDetection <= this.maxFramesWithoutDetection;
  }
  
  getAvgConfidence(){
    if (this.confidenceHistory.length === 0) return 0;
    return this.confidenceHistory.reduce((a, b) => a + b, 0) / this.confidenceHistory.length;
  }
}