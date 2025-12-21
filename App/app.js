import { DESCRIPTOR } from "./descriptor.js";
import { buildLSHIndex, lshMatchRatio, TemporalTracker } from "./lsh.js";

const video  = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

// ---------- OpenCV ready ----------
function waitCV(){
  return new Promise(res=>{
    const t = setInterval(()=>{
      if (window.cv && cv.Mat){
        clearInterval(t);
        res();
      }
    }, 50);
  });
}

// ---------- Camera ----------
async function startCamera(){
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { 
      facingMode: "environment",
      width: { ideal: 640 },
      height: { ideal: 480 }
    },
    audio: false
  });
  video.srcObject = stream;

  await new Promise(resolve => {
    if (video.readyState >= 1 && video.videoWidth > 0) return resolve();
    video.onloadedmetadata = () => resolve();
  });

  await video.play();
  syncVideoAttrsToFrameSize();
}

function syncVideoAttrsToFrameSize(){
  const vw = video.videoWidth | 0;
  const vh = video.videoHeight | 0;
  if (!vw || !vh) return;

  if (video.width !== vw)  video.width  = vw;
  if (video.height !== vh) video.height = vh;

  if (canvas.width !== vw)  canvas.width  = vw;
  if (canvas.height !== vh) canvas.height = vh;
}

// ---------- HUD ----------
function ema(prev, x, a){ return prev == null ? x : (a * x + (1 - a) * prev); }

function drawHUD(lines){
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

// ---------- Init ----------
await waitCV();
await startCamera();

const cap = new cv.VideoCapture(video);

let frameRGBA = null;
let gray = null;
const emptyMask = new cv.Mat();

function ensureMatSizesMatchVideoAttrs(){
  syncVideoAttrsToFrameSize();

  const vw = video.width | 0;
  const vh = video.height | 0;
  if (!vw || !vh) return false;

  if (!frameRGBA || frameRGBA.cols !== vw || frameRGBA.rows !== vh){
    if (frameRGBA) frameRGBA.delete();
    if (gray) gray.delete();
    frameRGBA = new cv.Mat(vh, vw, cv.CV_8UC4);
    gray      = new cv.Mat(vh, vw, cv.CV_8UC1);
  }
  return true;
}

// ---------- ORB ----------
const orb = new cv.ORB(
  DESCRIPTOR.orbParams.nfeatures,
  DESCRIPTOR.orbParams.scaleFactor,
  DESCRIPTOR.orbParams.nlevels,
  DESCRIPTOR.orbParams.edgeThreshold,
  DESCRIPTOR.orbParams.firstLevel,
  DESCRIPTOR.orbParams.WTA_K,
  cv.ORB_HARRIS_SCORE,
  DESCRIPTOR.orbParams.patchSize,
  DESCRIPTOR.orbParams.fastThreshold
);

// ---------- Reference data ----------
const refU8 = DESCRIPTOR.descriptors.data;
const refRows = DESCRIPTOR.descriptors.rows;
const refKps = DESCRIPTOR.keypoints;
const refW = DESCRIPTOR.image.width;
const refH = DESCRIPTOR.image.height;

const refCorners = cv.matFromArray(4, 1, cv.CV_32FC2, [
  0, 0,
  refW, 0,
  refW, refH,
  0, refH
]);

// ---------- Build LSH Index (faster settings) ----------
const lshIndex = buildLSHIndex(refU8, refRows, {
  numTables: 10,
  keyBits: 18,
  seedBase: 1337
});

// ---------- Temporal Tracker for smooth tracking ----------
const tracker = new TemporalTracker({
  smoothingFactor: 0.25,
  predictionWeight: 0.2,
  minMatchesForUpdate: 6,
  maxFramesWithoutDetection: 12
});

// ---------- Stats ----------
let fpsEma = null;
let totalMsEma = null;
let lastT = performance.now();

let tCapEma = null;
let tGrayEma = null;
let tOrbEma = null;
let tMatchEma = null;
let tHomoEma = null;
let tImshowEma = null;

// ---------- Main loop ----------
function loop(){
  if (video.readyState < 2){
    requestAnimationFrame(loop);
    return;
  }

  if (!ensureMatSizesMatchVideoAttrs()){
    requestAnimationFrame(loop);
    return;
  }

  const tFrame0 = performance.now();

  // Capture
  const tCap0 = performance.now();
  cap.read(frameRGBA);
  const tCap1 = performance.now();

  // Gray
  const tGray0 = performance.now();
  cv.cvtColor(frameRGBA, gray, cv.COLOR_RGBA2GRAY);
  const tGray1 = performance.now();

  // ORB
  const kps = new cv.KeyPointVector();
  const descU8 = new cv.Mat();

  const tOrb0 = performance.now();
  orb.detectAndCompute(gray, emptyMask, kps, descU8, false);
  const tOrb1 = performance.now();

  const kpCount = kps.size();

  // Render frame
  const tIm0 = performance.now();
  cv.imshow(canvas, frameRGBA);
  const tIm1 = performance.now();

  // Matching + Homography
  let goodMatches = 0;
  let matchMs = 0;
  let homoMs  = 0;
  let trackingMode = 'none';
  let confidence = 0;

  const srcPts = [];
  const dstPts = [];

  if (!descU8.empty() && descU8.cols === 32){
    const liveRows = descU8.rows;
    const liveU8 = new Uint8Array(descU8.data);

    // Adaptive thresholds based on tracking state
    const relaxed = tracker.shouldRelaxThresholds();

    const tM0 = performance.now();
    const m1 = lshMatchRatio(lshIndex, liveU8, liveRows, {
      maxCandidates: relaxed ? 800 : 600,
      ratio: relaxed ? 0.8 : 0.75,
      maxHamming: null,
      useMultiProbe: true
    });
    const tM1 = performance.now();
    matchMs = tM1 - tM0;

    for (let j = 0; j < m1.length; j++){
      const m = m1[j];
      if (!m) continue;

      goodMatches++;

      const kpRef = refKps[m.queryIdx];
      const kpCur = kps.get(m.trainIdx).pt;

      srcPts.push(kpRef.x, kpRef.y);
      dstPts.push(kpCur.x, kpCur.y);
    }

    if (srcPts.length >= 8){
      const tH0 = performance.now();

      const srcMat = cv.matFromArray(srcPts.length / 2, 1, cv.CV_32FC2, srcPts);
      const dstMat = cv.matFromArray(dstPts.length / 2, 1, cv.CV_32FC2, dstPts);

      const H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 5);

      if (H && !H.empty()){
        const dstCorners = new cv.Mat();
        cv.perspectiveTransform(refCorners, dstCorners, H);

        // Convert to JS array for tracker
        const rawCorners = [];
        for (let i = 0; i < 4; i++){
          rawCorners.push({
            x: dstCorners.data32F[i * 2],
            y: dstCorners.data32F[i * 2 + 1]
          });
        }

        // Update tracker with detection
        const result = tracker.update(rawCorners, goodMatches);
        trackingMode = result.mode;
        confidence = result.confidence;

        // Draw smoothed/predicted corners
        if (result.corners){
          const smoothCorners = result.corners;
          
          ctx.save();
          
          // Color and style based on tracking mode
          if (trackingMode === 'predicted'){
            ctx.strokeStyle = "orange";
            ctx.setLineDash([5, 5]);
          } else if (trackingMode === 'tracking'){
            ctx.strokeStyle = "lime";
            ctx.setLineDash([]);
          } else {
            ctx.strokeStyle = "cyan";
            ctx.setLineDash([]);
          }
          
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(smoothCorners[0].x, smoothCorners[0].y);
          for (let i = 1; i < 4; i++){
            ctx.lineTo(smoothCorners[i].x, smoothCorners[i].y);
          }
          ctx.closePath();
          ctx.stroke();
          ctx.setLineDash([]);
          
          ctx.restore();
        }

        dstCorners.delete();
      } else {
        // No valid homography
        tracker.update(null, 0);
      }

      if (H) H.delete();
      srcMat.delete();
      dstMat.delete();

      const tH1 = performance.now();
      homoMs = tH1 - tH0;
    } else {
      // Not enough matches
      tracker.update(null, goodMatches);
    }
  } else {
    // No descriptors
    tracker.update(null, 0);
  }

  // cleanup per-frame
  descU8.delete();
  kps.delete();

  const tFrame1 = performance.now();

  // timings
  const capMs    = tCap1  - tCap0;
  const grayMs   = tGray1 - tGray0;
  const orbMs    = tOrb1  - tOrb0;
  const imshowMs = tIm1   - tIm0;
  const totalMs  = tFrame1 - tFrame0;

  // EMA
  tCapEma    = ema(tCapEma, capMs, 0.2);
  tGrayEma   = ema(tGrayEma, grayMs, 0.2);
  tOrbEma    = ema(tOrbEma, orbMs, 0.2);
  tMatchEma  = ema(tMatchEma, matchMs, 0.2);
  tHomoEma   = ema(tHomoEma, homoMs, 0.2);
  tImshowEma = ema(tImshowEma, imshowMs, 0.2);
  totalMsEma = ema(totalMsEma, totalMs, 0.2);

  // FPS
  const dt = tFrame1 - lastT;
  lastT = tFrame1;
  const fps = dt > 0 ? 1000 / dt : 0;
  fpsEma = ema(fpsEma, fps, 0.2);

  drawHUD([
    `RES: ${video.width}x${video.height} | KPs: ${kpCount} | Matches: ${goodMatches}`,
    `Track: ${trackingMode} (conf: ${(confidence * 100).toFixed(0)}%)`,
    `cap:    ${capMs.toFixed(2)} (avg ${tCapEma?.toFixed(2) ?? 0}) ms`,
    `gray:   ${grayMs.toFixed(2)} (avg ${tGrayEma?.toFixed(2) ?? 0}) ms`,
    `orb:    ${orbMs.toFixed(2)} (avg ${tOrbEma?.toFixed(2) ?? 0}) ms`,
    `match:  ${matchMs.toFixed(2)} (avg ${tMatchEma?.toFixed(2) ?? 0}) ms  [LSH]`,
    `homo:   ${homoMs.toFixed(2)} (avg ${tHomoEma?.toFixed(2) ?? 0}) ms`,
    `imshow: ${imshowMs.toFixed(2)} (avg ${tImshowEma?.toFixed(2) ?? 0}) ms`,
    `TOTAL:  ${totalMs.toFixed(2)} (avg ${totalMsEma?.toFixed(2) ?? 0}) ms`,
    `FPS:    ${fps.toFixed(1)} (avg ${fpsEma?.toFixed(1) ?? 0})`
  ]);

  requestAnimationFrame(loop);
}

loop();

// ---------- Cleanup ----------
window.addEventListener("beforeunload", () => {
  try { frameRGBA?.delete(); } catch {}
  try { gray?.delete(); } catch {}
  try { emptyMask.delete(); } catch {}
  try { refCorners.delete(); } catch {}
  try { orb.delete(); } catch {}
});