// app.js - Main AR tracking application (NO Kalman, NO smoothing, NO gyro)
// + Optional deblur preprocessing (UNSHARP or Richardson-Lucy)

import { DESCRIPTOR } from "./descriptor.js";
import { buildLSHIndex, lshMatchRatio } from "./lsh.js";
import { ema, drawHUD, ensureGray8U, applyUnsharpMaskGray, richardsonLucyGrayLinePSF } from "./helpers.js";

const video  = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

// ---------------- Deblur settings ----------------
// "none" | "unsharp" | "rl"
const DEBLUR_MODE = "unsharp";

// unsharp params
const UNSHARP_SIGMA = 1.2;
const UNSHARP_AMOUNT = 1.2; // 0.6..2.0 usually

// RL params (motion-blur line PSF)
const RL_ITERS = 4;         // 3..6 (higher = slower)
const RL_LEN_PX = 9;        // 5..15 (depends on how strong blur is)
const RL_ANGLE_DEG = 0;     // you can wire this to a slider if you want

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

// ---------- Init ----------
await waitCV();
await startCamera();

const cap = new cv.VideoCapture(video);

let frameRGBA = null;
let gray8 = null;
let procGray8 = null; // processed (deblurred) gray for ORB
const emptyMask = new cv.Mat();

function ensureMatSizesMatchVideoAttrs(){
  syncVideoAttrsToFrameSize();

  const vw = video.width | 0;
  const vh = video.height | 0;
  if (!vw || !vh) return false;

  if (!frameRGBA || frameRGBA.cols !== vw || frameRGBA.rows !== vh){
    if (frameRGBA) frameRGBA.delete();
    if (gray8) gray8.delete();
    if (procGray8) procGray8.delete();

    frameRGBA = new cv.Mat(vh, vw, cv.CV_8UC4);
    gray8     = new cv.Mat(vh, vw, cv.CV_8UC1);
    procGray8 = new cv.Mat(vh, vw, cv.CV_8UC1);
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

// ---------- Build LSH Index ----------
const lshIndex = buildLSHIndex(refU8, refRows, {
  numTables: 10,
  keyBits: 18,
  seedBase: 1337
});

// ---------- Stats ----------
let fpsEma = null;
let totalMsEma = null;
let lastT = performance.now();

let tCapEma = null;
let tGrayEma = null;
let tDeblurEma = null;
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
  cv.cvtColor(frameRGBA, gray8, cv.COLOR_RGBA2GRAY);
  const tGray1 = performance.now();

  // Deblur / preprocess (optional)
  const tDeb0 = performance.now();
  if (DEBLUR_MODE === "none"){
    gray8.copyTo(procGray8);
  } else if (DEBLUR_MODE === "unsharp"){
    applyUnsharpMaskGray(gray8, procGray8, UNSHARP_SIGMA, UNSHARP_AMOUNT);
  } else if (DEBLUR_MODE === "rl"){
    // Richardson–Lucy assumes a motion blur PSF (line kernel). This is slower.
    richardsonLucyGrayLinePSF(gray8, procGray8, RL_LEN_PX, RL_ANGLE_DEG, RL_ITERS);
  } else {
    gray8.copyTo(procGray8);
  }
  const tDeb1 = performance.now();

  // ORB
  const kps = new cv.KeyPointVector();
  const descU8 = new cv.Mat();

  const tOrb0 = performance.now();
  orb.detectAndCompute(procGray8, emptyMask, kps, descU8, false);
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
  let trackingMode = "none";
  let confidence = 0;

  const srcPts = [];
  const dstPts = [];

  if (!descU8.empty() && descU8.cols === 32){
    const liveRows = descU8.rows;
    const liveU8 = new Uint8Array(descU8.data);

    const tM0 = performance.now();
    const m1 = lshMatchRatio(lshIndex, liveU8, liveRows, {
      maxCandidates: 800,
      ratio: 0.8,
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

      const H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 3.0);

      if (H && !H.empty()){
        trackingMode = "detected";
        confidence = Math.min(0.98, goodMatches / 40);

        const dstCorners = new cv.Mat();
        cv.perspectiveTransform(refCorners, dstCorners, H);

        const rawCorners = [];
        for (let i = 0; i < 4; i++){
          rawCorners.push({
            x: dstCorners.data32F[i * 2],
            y: dstCorners.data32F[i * 2 + 1]
          });
        }

        // Draw raw detection (red)
        ctx.save();
        ctx.strokeStyle = "rgba(255, 0, 0, 0.9)";
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(rawCorners[0].x, rawCorners[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(rawCorners[i].x, rawCorners[i].y);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();

        dstCorners.delete();
      } else {
        trackingMode = "none";
        confidence = 0;
      }

      if (H) H.delete();
      srcMat.delete();
      dstMat.delete();

      const tH1 = performance.now();
      homoMs = tH1 - tH0;
    } else {
      trackingMode = "weak";
      confidence = Math.min(0.6, goodMatches / 20);
    }
  }

  descU8.delete();
  kps.delete();

  const tFrame1 = performance.now();

  const capMs    = tCap1  - tCap0;
  const grayMs   = tGray1 - tGray0;
  const deblurMs = tDeb1  - tDeb0;
  const orbMs    = tOrb1  - tOrb0;
  const imshowMs = tIm1   - tIm0;
  const totalMs  = tFrame1 - tFrame0;

  tCapEma    = ema(tCapEma, capMs, 0.2);
  tGrayEma   = ema(tGrayEma, grayMs, 0.2);
  tDeblurEma = ema(tDeblurEma, deblurMs, 0.2);
  tOrbEma    = ema(tOrbEma, orbMs, 0.2);
  tMatchEma  = ema(tMatchEma, matchMs, 0.2);
  tHomoEma   = ema(tHomoEma, homoMs, 0.2);
  tImshowEma = ema(tImshowEma, imshowMs, 0.2);
  totalMsEma = ema(totalMsEma, totalMs, 0.2);

  const dt = tFrame1 - lastT;
  lastT = tFrame1;
  const fps = dt > 0 ? 1000 / dt : 0;
  fpsEma = ema(fpsEma, fps, 0.2);

  drawHUD(ctx, canvas, [
    `RES: ${video.width}x${video.height} | KPs: ${kpCount} | Matches: ${goodMatches}`,
    `Track: ${trackingMode} (conf: ${(confidence * 100).toFixed(0)}%)`,
    `Pre: ${DEBLUR_MODE}`,
    `cap:    ${capMs.toFixed(2)} (avg ${tCapEma?.toFixed(2) ?? 0}) ms`,
    `gray:   ${grayMs.toFixed(2)} (avg ${tGrayEma?.toFixed(2) ?? 0}) ms`,
    `deblur: ${deblurMs.toFixed(2)} (avg ${tDeblurEma?.toFixed(2) ?? 0}) ms`,
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
  try { gray8?.delete(); } catch {}
  try { procGray8?.delete(); } catch {}
  try { emptyMask.delete(); } catch {}
  try { refCorners.delete(); } catch {}
  try { orb.delete(); } catch {}
});
