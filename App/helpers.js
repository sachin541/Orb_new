// helpers.js - Utility functions for AR tracking
// + Unsharp mask + Richardson–Lucy (line PSF) deblur options

// ---------------- Popcount & Hamming Distance ----------------
const popcnt8 = new Uint8Array(256);
for (let i = 0; i < 256; i++){
  let x = i, c = 0;
  while (x){ x &= x - 1; c++; }
  popcnt8[i] = c;
}

export function hamming32(aU8, aOff, bU8, bOff){
  let d = 0;
  for (let i = 0; i < 32; i++){
    d += popcnt8[aU8[aOff + i] ^ bU8[bOff + i]];
  }
  return d;
}

// ---------------- LSH Bit Position Generation ----------------
export function makeBitPositions(kbits, seed = 1337){
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

export function lshHash(descU8, off, bitPos){
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

// ---------------- Descriptor Statistics ----------------
export function computeDescriptorStats(descU8, rows){
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

// ---------------- Canvas Drawing Utilities ----------------
export function drawHUD(ctx, canvas, lines){
  ctx.save();
  ctx.font = "15px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";

  const pad = 8;
  const lineH = 18;

  let maxW = 0;
  for (const s of lines) maxW = Math.max(maxW, ctx.measureText(s).width);
  const w = Math.ceil(maxW + pad * 2);
  const h = pad * 2 + lines.length * lineH;

  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(10, 10, w, h);

  ctx.fillStyle = "white";
  for (let i = 0; i < lines.length; i++){
    ctx.fillText(lines[i], 10 + pad, 10 + pad + i * lineH);
  }
  ctx.restore();
}

// ---------------- EMA Smoothing (for stats only) ----------------
export function ema(prev, x, a){
  return prev == null ? x : (a * x + (1 - a) * prev);
}

// ---------------- Safety: ensure gray is CV_8UC1 ----------------
export function ensureGray8U(srcGray8){
  // assumes srcGray8 is cv.Mat
  if (srcGray8.type() !== cv.CV_8UC1) {
    throw new Error("Expected CV_8UC1 grayscale Mat");
  }
}

// ---------------- Fast option: Unsharp Mask ----------------
// dst = src*(1+amount) - GaussianBlur(src)*amount
export function applyUnsharpMaskGray(srcGray8, dstGray8, sigma = 1.2, amount = 1.0){
  ensureGray8U(srcGray8);

  const blur = new cv.Mat();
  // ksize (0,0) lets OpenCV derive from sigma
  cv.GaussianBlur(srcGray8, blur, new cv.Size(0, 0), sigma, sigma, cv.BORDER_DEFAULT);

  // dst = src*(1+amount) + blur*(-amount)
  const alpha = 1.0 + amount;
  const beta  = -amount;
  cv.addWeighted(srcGray8, alpha, blur, beta, 0, dstGray8, -1);

  blur.delete();
}

// ---------------- Slower option: Richardson–Lucy deconvolution ----------------
// Assumes motion blur PSF ~ line kernel (lenPx, angleDeg).
// This is "real" deblur but heavier than unsharp.
function makeLinePSF(lenPx, angleDeg){
  const L = Math.max(3, (lenPx | 0));
  const ksize = (L % 2 === 1) ? L : (L + 1);
  const psf = cv.Mat.zeros(ksize, ksize, cv.CV_32F);

  const cx = (ksize - 1) * 0.5;
  const cy = (ksize - 1) * 0.5;

  const theta = angleDeg * Math.PI / 180.0;
  const dx = Math.cos(theta);
  const dy = Math.sin(theta);

  // draw a line of length L centered at (cx,cy)
  const half = (L - 1) * 0.5;
  for (let t = -half; t <= half; t++){
    const x = Math.round(cx + t * dx);
    const y = Math.round(cy + t * dy);
    if (x >= 0 && x < ksize && y >= 0 && y < ksize){
      psf.floatPtr(y, x)[0] = 1.0;
    }
  }

  // normalize
  let sum = 0;
  for (let y = 0; y < ksize; y++){
    for (let x = 0; x < ksize; x++){
      sum += psf.floatAt(y, x);
    }
  }
  if (sum <= 0) sum = 1;
  for (let y = 0; y < ksize; y++){
    for (let x = 0; x < ksize; x++){
      psf.floatPtr(y, x)[0] /= sum;
    }
  }

  return psf;
}

function flipKernel(psf32f){
  const flipped = new cv.Mat();
  cv.flip(psf32f, flipped, -1);
  return flipped;
}

export function richardsonLucyGrayLinePSF(srcGray8, dstGray8, lenPx = 9, angleDeg = 0, iters = 4){
  ensureGray8U(srcGray8);

  const eps = 1e-6;

  const psf = makeLinePSF(lenPx, angleDeg);
  const psfFlip = flipKernel(psf);

  // Convert to float [0,1]
  const y = new cv.Mat();
  srcGray8.convertTo(y, cv.CV_32F, 1.0 / 255.0);

  // init estimate = y (or uniform)
  let x = new cv.Mat();
  y.copyTo(x);

  const conv = new cv.Mat();
  const rel  = new cv.Mat();
  const corr = new cv.Mat();

  // temp mats
  const denom = new cv.Mat();

  for (let i = 0; i < Math.max(1, iters | 0); i++){
    // conv = x * psf
    cv.filter2D(x, conv, cv.CV_32F, psf, new cv.Point(-1, -1), 0, cv.BORDER_REPLICATE);

    // denom = conv + eps
    cv.add(conv, new cv.Scalar(eps), denom);

    // rel = y / denom
    cv.divide(y, denom, rel);

    // corr = rel * psfFlip
    cv.filter2D(rel, corr, cv.CV_32F, psfFlip, new cv.Point(-1, -1), 0, cv.BORDER_REPLICATE);

    // x = x * corr
    cv.multiply(x, corr, x);
  }

  // Clamp to [0,1], back to 8U
  // (OpenCV.js doesn't have a direct clamp, so use threshold)
  cv.threshold(x, x, 1.0, 1.0, cv.THRESH_TRUNC);
  cv.threshold(x, x, 0.0, 0.0, cv.THRESH_TOZERO);

  x.convertTo(dstGray8, cv.CV_8U, 255.0);

  // cleanup
  psf.delete();
  psfFlip.delete();
  y.delete();
  x.delete();
  conv.delete();
  rel.delete();
  corr.delete();
  denom.delete();
}
