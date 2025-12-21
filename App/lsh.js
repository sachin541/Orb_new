// lsh.js - Balanced version with temporal tracking and gyro integration
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

// Temporal tracker for stable homography across frames with gyro integration
export class TemporalTracker {
  constructor({
    smoothingFactor = 0.5,
    scaleSmoothing = 0.15,
    minMatchesForUpdate = 4,
    maxFramesWithoutDetection = 12,
    adaptiveRelaxation = true,
    maxScaleChange = 0.15,
    useGyro = true,
    gyroWeight = 0.3
  } = {}){
    this.smoothingFactor = smoothingFactor;
    this.scaleSmoothing = scaleSmoothing;
    this.minMatchesForUpdate = minMatchesForUpdate;
    this.maxFramesWithoutDetection = maxFramesWithoutDetection;
    this.adaptiveRelaxation = adaptiveRelaxation;
    this.maxScaleChange = maxScaleChange;
    this.useGyro = useGyro;
    this.gyroWeight = gyroWeight;
    
    this.prevTransform = null;
    this.framesWithoutDetection = 0;
    this.isTracking = false;
    this.confidenceHistory = [];
    
    // Gyro integration
    this.lastGyroTimestamp = null;
    this.accumulatedRotation = { x: 0, y: 0, z: 0 };
    this.gyroBaseline = null;
  }
  
  updateGyro(gyroData){
    if (!this.useGyro || !gyroData) return;
    
    const now = performance.now();
    
    if (this.lastGyroTimestamp === null){
      this.lastGyroTimestamp = now;
      this.gyroBaseline = { x: gyroData.x, y: gyroData.y, z: gyroData.z };
      return;
    }
    
    const dt = (now - this.lastGyroTimestamp) / 1000; // Convert to seconds
    this.lastGyroTimestamp = now;
    
    // Integrate rotation (gyro gives angular velocity in rad/s)
    // We primarily care about Z-axis rotation (device rotation in plane)
    this.accumulatedRotation.z += gyroData.z * dt;
    this.accumulatedRotation.x += gyroData.x * dt;
    this.accumulatedRotation.y += gyroData.y * dt;
  }
  
  update(corners, matchCount, gyroData = null){
    // Update gyro if provided
    if (gyroData){
      this.updateGyro(gyroData);
    }
    
    if (!corners || matchCount < this.minMatchesForUpdate){
      this.framesWithoutDetection++;
      
      // If we have gyro data and previous transform, predict position
      if (this.prevTransform && this.useGyro && this.accumulatedRotation && 
          this.framesWithoutDetection <= this.maxFramesWithoutDetection){
        const predicted = this._predictWithGyro();
        return { corners: predicted.corners, confidence: 0.3, mode: 'gyro-predicted' };
      }
      
      if (this.framesWithoutDetection > this.maxFramesWithoutDetection){
        this.reset();
      }
      
      return { corners: this.prevTransform?.corners || null, confidence: 0, mode: 'lost' };
    }
    
    this.framesWithoutDetection = 0;
    
    // Extract geometric properties from corners
    const transform = this._extractTransform(corners);
    
    if (!this.prevTransform){
      this.prevTransform = transform;
      this.isTracking = true;
      // Reset gyro baseline when we start tracking
      if (this.useGyro){
        this.accumulatedRotation = { x: 0, y: 0, z: 0 };
      }
      return { corners, confidence: 0.8, mode: 'initial' };
    }
    
    // Apply gyro correction to rotation if available
    let targetRotation = transform.rotation;
    if (this.useGyro && this.accumulatedRotation){
      // Gyro Z-axis rotation corresponds to device rotation in plane
      // Subtract because camera rotation is inverse of device rotation
      const gyroDelta = -this.accumulatedRotation.z;
      targetRotation = transform.rotation + gyroDelta * this.gyroWeight;
    }
    
    // Adaptive smoothing - use more responsive tracking when we have good matches
    const posAlpha = matchCount > 15 ? 0.7 : this.smoothingFactor;
    const rotAlpha = matchCount > 15 ? 0.6 : this.smoothingFactor;
    
    // Much slower smoothing for scale to prevent flickering
    const scaleAlpha = this.scaleSmoothing;
    
    // Clamp scale changes to prevent sudden jumps
    let newScaleX = transform.scaleX;
    let newScaleY = transform.scaleY;
    
    const scaleChangeX = Math.abs(newScaleX - this.prevTransform.scaleX) / this.prevTransform.scaleX;
    const scaleChangeY = Math.abs(newScaleY - this.prevTransform.scaleY) / this.prevTransform.scaleY;
    
    if (scaleChangeX > this.maxScaleChange){
      const maxChange = this.prevTransform.scaleX * this.maxScaleChange;
      newScaleX = this.prevTransform.scaleX + Math.sign(newScaleX - this.prevTransform.scaleX) * maxChange;
    }
    
    if (scaleChangeY > this.maxScaleChange){
      const maxChange = this.prevTransform.scaleY * this.maxScaleChange;
      newScaleY = this.prevTransform.scaleY + Math.sign(newScaleY - this.prevTransform.scaleY) * maxChange;
    }
    
    const smoothedTransform = {
      centerX: (1 - posAlpha) * this.prevTransform.centerX + posAlpha * transform.centerX,
      centerY: (1 - posAlpha) * this.prevTransform.centerY + posAlpha * transform.centerY,
      scaleX: (1 - scaleAlpha) * this.prevTransform.scaleX + scaleAlpha * newScaleX,
      scaleY: (1 - scaleAlpha) * this.prevTransform.scaleY + scaleAlpha * newScaleY,
      rotation: this._smoothAngle(this.prevTransform.rotation, targetRotation, rotAlpha)
    };
    
    // Reconstruct corners from smoothed transform
    const smoothedCorners = this._reconstructCorners(smoothedTransform);
    
    smoothedTransform.corners = smoothedCorners;
    this.prevTransform = smoothedTransform;
    
    // Reset gyro accumulation after successful tracking update
    if (this.useGyro){
      this.accumulatedRotation = { x: 0, y: 0, z: 0 };
    }
    
    const confidence = Math.min(0.95, 0.5 + matchCount / 40);
    this.confidenceHistory.push(confidence);
    if (this.confidenceHistory.length > 10) this.confidenceHistory.shift();
    
    return { corners: smoothedCorners, confidence, mode: 'tracking' };
  }
  
  _predictWithGyro(){
    if (!this.prevTransform || !this.accumulatedRotation) return this.prevTransform;
    
    // Apply accumulated rotation to prediction
    const predictedTransform = {
      ...this.prevTransform,
      rotation: this.prevTransform.rotation - this.accumulatedRotation.z
    };
    
    const corners = this._reconstructCorners(predictedTransform);
    
    return { ...predictedTransform, corners };
  }
  
  _extractTransform(corners){
    // Calculate center
    const centerX = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
    const centerY = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
    
    // Calculate scale using distances between opposite corners
    const width1 = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
    const width2 = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
    const height1 = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
    const height2 = Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y);
    
    const scaleX = (width1 + width2) / 2;
    const scaleY = (height1 + height2) / 2;
    
    // Calculate rotation from top edge
    const dx = corners[1].x - corners[0].x;
    const dy = corners[1].y - corners[0].y;
    const rotation = Math.atan2(dy, dx);
    
    return {
      centerX,
      centerY,
      scaleX,
      scaleY,
      rotation,
      refWidth: scaleX,
      refHeight: scaleY
    };
  }
  
  _reconstructCorners(transform){
    const { centerX, centerY, scaleX, scaleY, rotation } = transform;
    
    // Define corners in local space (centered at origin)
    const localCorners = [
      { x: -scaleX / 2, y: -scaleY / 2 },
      { x: scaleX / 2, y: -scaleY / 2 },
      { x: scaleX / 2, y: scaleY / 2 },
      { x: -scaleX / 2, y: scaleY / 2 }
    ];
    
    // Apply rotation and translation
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    
    return localCorners.map(corner => ({
      x: centerX + corner.x * cos - corner.y * sin,
      y: centerY + corner.x * sin + corner.y * cos
    }));
  }
  
  _smoothAngle(prevAngle, newAngle, alpha){
    // Handle angle wrapping
    let diff = newAngle - prevAngle;
    
    // Normalize to [-π, π]
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    
    return prevAngle + alpha * diff;
  }
  
  reset(){
    this.prevTransform = null;
    this.framesWithoutDetection = 0;
    this.isTracking = false;
    this.confidenceHistory = [];
    this.lastGyroTimestamp = null;
    this.accumulatedRotation = { x: 0, y: 0, z: 0 };
    this.gyroBaseline = null;
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