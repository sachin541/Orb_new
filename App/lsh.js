// lsh.js - Balanced version with temporal tracking and gyro integration
// Pure-JS approximate matcher for ORB (binary 32-byte descriptors)

// ---------------- popcount + hamming ----------------
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

// ---------------- LSH helpers ----------------
function makeBitPositions(kbits, seed = 1337){
  let s = seed >>> 0;
  function rnd(){
    s = (1664525 * s + 1013904223) >>> 0;
    return s;
  }

  const arr = [];
  const bitsPerByte = Math.ceil(kbits / 32);

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

// ---------------- Kalman filters ----------------

// 2D Kalman for center (keeps velocity)
class KalmanFilter2D {
  constructor(processNoise = 0.01, measurementNoise = 0.1){
    this.processNoise = processNoise;
    this.measurementNoise = measurementNoise;

    // State: [x, y, vx, vy]
    this.state = null;

    // Covariance diag-ish
    this.P = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
  }

  predict(dt = 1/30){
    if (!this.state) return null;

    const [x, y, vx, vy] = this.state;
    const predictedState = [ x + vx * dt, y + vy * dt, vx, vy ];

    this.P[0][0] += this.processNoise;
    this.P[1][1] += this.processNoise;
    this.P[2][2] += this.processNoise * 0.1;
    this.P[3][3] += this.processNoise * 0.1;

    return predictedState;
  }

  update(measurement, dt = 1/30){
    const [mx, my] = measurement;

    if (!this.state){
      this.state = [mx, my, 0, 0];
      return this.state;
    }

    const predicted = this.predict(dt);

    const Kx = this.P[0][0] / (this.P[0][0] + this.measurementNoise);
    const Ky = this.P[1][1] / (this.P[1][1] + this.measurementNoise);

    const newX = predicted[0] + Kx * (mx - predicted[0]);
    const newY = predicted[1] + Ky * (my - predicted[1]);

    const vx = (newX - this.state[0]) / dt;
    const vy = (newY - this.state[1]) / dt;

    this.state = [newX, newY, vx, vy];

    this.P[0][0] = (1 - Kx) * this.P[0][0];
    this.P[1][1] = (1 - Ky) * this.P[1][1];

    return this.state;
  }

  reset(){
    this.state = null;
    this.P = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
  }
}

// Rotation Kalman (angle + angVel)
class KalmanFilterRotation {
  constructor(processNoise = 0.01, measurementNoise = 0.1){
    this.processNoise = processNoise;
    this.measurementNoise = measurementNoise;

    // State: [angle, angular_velocity]
    this.state = null;
    this.P = [1, 1];
  }

  predict(dt = 1/30){
    if (!this.state) return null;

    const [angle, angVel] = this.state;
    let predicted = angle + angVel * dt;

    while (predicted > Math.PI) predicted -= 2 * Math.PI;
    while (predicted < -Math.PI) predicted += 2 * Math.PI;

    this.P[0] += this.processNoise;
    this.P[1] += this.processNoise * 0.1;

    return [predicted, angVel];
  }

  update(measurement, dt = 1/30){
    if (!this.state){
      this.state = [measurement, 0];
      return this.state;
    }

    const predicted = this.predict(dt);

    let diff = measurement - predicted[0];
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;

    const K = this.P[0] / (this.P[0] + this.measurementNoise);

    let newAngle = predicted[0] + K * diff;
    while (newAngle > Math.PI) newAngle -= 2 * Math.PI;
    while (newAngle < -Math.PI) newAngle += 2 * Math.PI;

    this.state = [ newAngle, diff / dt ];
    this.P[0] = (1 - K) * this.P[0];

    return this.state;
  }

  reset(){
    this.state = null;
    this.P = [1, 1];
  }
}

// 1D Kalman for scale (NO velocity => no “breathing” drift)
class KalmanFilter1D {
  constructor(processNoise = 0.01, measurementNoise = 0.5){
    this.q = processNoise;
    this.r = measurementNoise;
    this.x = null; // estimate
    this.p = 1;    // covariance
  }

  predict(){
    if (this.x == null) return null;
    this.p = this.p + this.q;
    return this.x;
  }

  update(measurement){
    if (this.x == null){
      this.x = measurement;
      this.p = 1;
      return this.x;
    }
    // predict
    this.predict();
    // update
    const k = this.p / (this.p + this.r);
    this.x = this.x + k * (measurement - this.x);
    this.p = (1 - k) * this.p;
    return this.x;
  }

  reset(){
    this.x = null;
    this.p = 1;
  }
}

// ---------------- Temporal Tracker (Kalman-only) ----------------
export class TemporalTracker {
  constructor({
    minMatchesForUpdate = 4,
    maxFramesWithoutDetection = 12,

    // IMU
    useGyro = true,
    gyroWeight = 0.15,

    // Kalman params
    useKalmanFilter = true,
    kalmanProcessNoise = 0.01,
    kalmanMeasurementNoise = 0.5,

    // scale clamp
    maxScaleChange = 0.30
  } = {}){
    this.minMatchesForUpdate = minMatchesForUpdate;
    this.maxFramesWithoutDetection = maxFramesWithoutDetection;

    this.useGyro = useGyro;
    this.gyroWeight = gyroWeight;

    this.useKalmanFilter = useKalmanFilter;

    this.maxScaleChange = maxScaleChange;

    this.prevTransform = null;
    this.framesWithoutDetection = 0;
    this.isTracking = false;

    // Kalman filters
    this.kalmanCenter = new KalmanFilter2D(kalmanProcessNoise, kalmanMeasurementNoise);
    this.kalmanRotation = new KalmanFilterRotation(kalmanProcessNoise * 0.5, kalmanMeasurementNoise * 0.3);

    // IMPORTANT: scale uses 1D filters (no velocity)
    this.kalmanScaleX = new KalmanFilter1D(kalmanProcessNoise * 0.1, kalmanMeasurementNoise * 2);
    this.kalmanScaleY = new KalmanFilter1D(kalmanProcessNoise * 0.1, kalmanMeasurementNoise * 2);

    this.lastUpdateTime = null;

    // Gyro integration
    this.lastGyroTimestamp = null;
    this.accumulatedRotation = { x: 0, y: 0, z: 0 };
  }

  updateIMU(imuData){
    if (!imuData) return;
    if (imuData.gyro && this.useGyro) this.updateGyro(imuData.gyro);
  }

  updateGyro(gyroData){
    const now = performance.now();
    if (this.lastGyroTimestamp === null){
      this.lastGyroTimestamp = now;
      return;
    }
    const dt = (now - this.lastGyroTimestamp) / 1000;
    this.lastGyroTimestamp = now;

    this.accumulatedRotation.z += gyroData.z * dt;
    this.accumulatedRotation.x += gyroData.x * dt;
    this.accumulatedRotation.y += gyroData.y * dt;
  }

  update(corners, matchCount, imuData = null){
    if (imuData) this.updateIMU(imuData);

    const now = performance.now();
    const dt = this.lastUpdateTime ? (now - this.lastUpdateTime) / 1000 : 1/30;
    this.lastUpdateTime = now;

    // ---------------- no detection ----------------
    if (!corners || matchCount < this.minMatchesForUpdate){
      this.framesWithoutDetection++;

      if (this.useKalmanFilter && this.prevTransform &&
          this.framesWithoutDetection <= this.maxFramesWithoutDetection){

        const predictedCenter = this.kalmanCenter.predict(dt);
        const predictedRot = this.kalmanRotation.predict(dt);

        // scale prediction: HOLD last scale (don’t animate scale during lost frames)
        const scaleX = this.prevTransform.scaleX;
        const scaleY = this.prevTransform.scaleY;

        if (predictedCenter && predictedRot){
          let rot = predictedRot[0];

          // gyro correction to prediction
          if (this.useGyro && this.accumulatedRotation){
            rot = rot - this.accumulatedRotation.z * this.gyroWeight;
          }

          const predictedTransform = {
            centerX: predictedCenter[0],
            centerY: predictedCenter[1],
            scaleX,
            scaleY,
            rotation: rot
          };

          const outCorners = this._reconstructCorners(predictedTransform);

          // reset integrated gyro after using it
          if (this.useGyro) this.accumulatedRotation = { x: 0, y: 0, z: 0 };

          return { corners: outCorners, confidence: 0.25, mode: 'kalman-predicted' };
        }
      }

      if (this.framesWithoutDetection > this.maxFramesWithoutDetection){
        this.reset();
      }

      if (this.useGyro) this.accumulatedRotation = { x: 0, y: 0, z: 0 };
      return { corners: this.prevTransform?.corners || null, confidence: 0, mode: 'lost' };
    }

    // ---------------- detection available ----------------
    this.framesWithoutDetection = 0;

    const meas = this._extractTransform(corners);

    if (!this.prevTransform){
      this.prevTransform = { ...meas, corners };
      this.isTracking = true;

      // init Kalman
      this.kalmanCenter.update([meas.centerX, meas.centerY], dt);
      this.kalmanRotation.update(meas.rotation, dt);
      this.kalmanScaleX.update(meas.scaleX);
      this.kalmanScaleY.update(meas.scaleY);

      if (this.useGyro) this.accumulatedRotation = { x: 0, y: 0, z: 0 };
      return { corners, confidence: 0.8, mode: 'initial' };
    }

    // adaptive measurement noise by match quality
    const measurementNoise = Math.max(0.08, 1.0 - matchCount / 30);
    this.kalmanCenter.measurementNoise = measurementNoise;
    this.kalmanRotation.measurementNoise = measurementNoise * 0.3;

    // Gyro-correct rotation measurement (rotation only!)
    let rotMeas = meas.rotation;
    if (this.useGyro && this.accumulatedRotation){
      const gyroDelta = -this.accumulatedRotation.z; // yaw integrated
      rotMeas = meas.rotation + gyroDelta * this.gyroWeight;
    }

    // Clamp scale change so it can't “breathe” wildly
    const clampedScaleX = this._clampScale(meas.scaleX, this.prevTransform.scaleX);
    const clampedScaleY = this._clampScale(meas.scaleY, this.prevTransform.scaleY);

    // Kalman updates
    const centerState = this.kalmanCenter.update([meas.centerX, meas.centerY], dt);
    const rotState = this.kalmanRotation.update(rotMeas, dt);
    const sx = this.kalmanScaleX.update(clampedScaleX);
    const sy = this.kalmanScaleY.update(clampedScaleY);

    const finalTransform = {
      centerX: centerState[0],
      centerY: centerState[1],
      rotation: rotState[0],
      scaleX: sx,
      scaleY: sy
    };

    const smoothedCorners = this._reconstructCorners(finalTransform);
    finalTransform.corners = smoothedCorners;
    this.prevTransform = finalTransform;

    if (this.useGyro) this.accumulatedRotation = { x: 0, y: 0, z: 0 };

    const confidence = Math.min(0.95, 0.5 + matchCount / 40);
    return { corners: smoothedCorners, confidence, mode: 'tracking' };
  }

  _clampScale(newS, prevS){
    if (!prevS || !isFinite(prevS) || prevS <= 1) return newS;
    const lo = prevS * (1 - this.maxScaleChange);
    const hi = prevS * (1 + this.maxScaleChange);
    return Math.max(lo, Math.min(hi, newS));
  }

  _extractTransform(corners){
    const centerX = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
    const centerY = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;

    const width1 = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
    const width2 = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
    const height1 = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
    const height2 = Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y);

    const scaleX = (width1 + width2) / 2;
    const scaleY = (height1 + height2) / 2;

    const dx = corners[1].x - corners[0].x;
    const dy = corners[1].y - corners[0].y;
    const rotation = Math.atan2(dy, dx);

    return { centerX, centerY, scaleX, scaleY, rotation };
  }

  _reconstructCorners(transform){
    const { centerX, centerY, scaleX, scaleY, rotation } = transform;

    const localCorners = [
      { x: -scaleX / 2, y: -scaleY / 2 },
      { x:  scaleX / 2, y: -scaleY / 2 },
      { x:  scaleX / 2, y:  scaleY / 2 },
      { x: -scaleX / 2, y:  scaleY / 2 }
    ];

    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    return localCorners.map(corner => ({
      x: centerX + corner.x * cos - corner.y * sin,
      y: centerY + corner.x * sin + corner.y * cos
    }));
  }

  reset(){
    this.prevTransform = null;
    this.framesWithoutDetection = 0;
    this.isTracking = false;
    this.lastGyroTimestamp = null;
    this.accumulatedRotation = { x: 0, y: 0, z: 0 };
    this.lastUpdateTime = null;

    this.kalmanCenter.reset();
    this.kalmanRotation.reset();
    this.kalmanScaleX.reset();
    this.kalmanScaleY.reset();
  }
}
