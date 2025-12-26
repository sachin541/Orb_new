// app.js 

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

function drawGyroHUD(imuData, accumulatedRotation, gyroSupported, gyroPermissionGranted, tracker){
  ctx.save();
  ctx.font = "15px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";

  const pad = 8;
  const lineH = 18;

  const lines = [];

  lines.push("🔄 IMU SENSORS");
  lines.push("───────────────");

  if (gyroSupported || imuData.orientation){
    if (imuData.gyro){
      lines.push("Gyro (°/s):");
      lines.push(`  γ: ${(imuData.gyro.z * 180 / Math.PI).toFixed(1)}`);
    }

    if (imuData.orientation){
      lines.push("Orientation:");
      lines.push(`  γ: ${imuData.orientation.gamma.toFixed(1)}°`);
    }

    if (accumulatedRotation && tracker.isTracking){
      lines.push("");
      lines.push("Accum rot (rad):");
      lines.push(`  z: ${accumulatedRotation.z.toFixed(3)}`);
    }
  } else {
    if (typeof DeviceMotionEvent !== "undefined" &&
        typeof DeviceMotionEvent.requestPermission === "function" &&
        !gyroPermissionGranted){
      lines.push("Tap screen to");
      lines.push("enable IMU");
    } else if (!gyroPermissionGranted) {
      lines.push("Checking...");
    } else {
      lines.push("Not available");
    }
  }

  let maxW = 0;
  for (const s of lines) maxW = Math.max(maxW, ctx.measureText(s).width);
  const w = Math.ceil(maxW + pad * 2);
  const h = pad * 2 + lines.length * lineH;

  const x = canvas.width - w - 10;
  const y = 10;

  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(x, y, w, h);

  ctx.fillStyle = "white";
  for (let i = 0; i < lines.length; i++){
    ctx.fillText(lines[i], x + pad, y + pad + i * lineH);
  }
  ctx.restore();
}

// ---------- Temporal Tracker (NO smoothing, Kalman + gyro only) ----------
const tracker = new TemporalTracker({
  minMatchesForUpdate: 4,
  maxFramesWithoutDetection: 12,
  useGyro: true,
  gyroWeight: 0.15,
  useKalmanFilter: true,
  kalmanProcessNoise: 0.01,
  kalmanMeasurementNoise: 0.5,
  maxScaleChange: 0.25
});


// ---------- IMU sensors setup ----------
let imuData = {
  gyro: null,
  accel: null,
  orientation: null
};
let gyroSupported = false;
let gyroPermissionGranted = false;

async function requestGyroPermission(){
  if (!window.DeviceMotionEvent){
    console.log("Gyroscope not supported on this device");
    return false;
  }

  try {
    if (typeof DeviceMotionEvent.requestPermission === "function"){
      const permission = await DeviceMotionEvent.requestPermission();
      if (permission !== "granted"){
        console.log("Gyroscope permission denied");
        return false;
      }
    }

    gyroPermissionGranted = true;
    setupGyroscopeListener();
    return true;
  } catch (error) {
    console.error("Error requesting gyroscope permission:", error);
    return false;
  }
}

function setupGyroscopeListener(){
  window.addEventListener("devicemotion", (event) => {
    if (event.rotationRate){
      imuData.gyro = {
        x: (event.rotationRate.alpha || 0) * (Math.PI / 180),
        y: (event.rotationRate.beta  || 0) * (Math.PI / 180),
        z: (event.rotationRate.gamma || 0) * (Math.PI / 180)
      };
      gyroSupported = true;
    }

    if (event.acceleration){
      imuData.accel = {
        x: event.acceleration.x || 0,
        y: event.acceleration.y || 0,
        z: event.acceleration.z || 0
      };
    }
  });

  window.addEventListener("deviceorientation", (event) => {
    imuData.orientation = {
      alpha: event.alpha || 0,
      beta: event.beta || 0,
      gamma: event.gamma || 0
    };
  });

  console.log("IMU sensors enabled");
}

async function setupGyroscope(){
  if (!window.DeviceMotionEvent){
    console.log("Gyroscope not supported");
    return;
  }

  if (typeof DeviceMotionEvent.requestPermission !== "function"){
    setupGyroscopeListener();
    gyroPermissionGranted = true;
  }
}

// ---------- Init ----------
await waitCV();
await startCamera();
await setupGyroscope();

canvas.addEventListener("click", async () => {
  if (!gyroSupported && !gyroPermissionGranted &&
      typeof DeviceMotionEvent !== "undefined" &&
      typeof DeviceMotionEvent.requestPermission === "function"){
    console.log("Requesting gyroscope permission...");
    await requestGyroPermission();
  }
});

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
        const dstCorners = new cv.Mat();
        cv.perspectiveTransform(refCorners, dstCorners, H);

        const rawCorners = [];
        for (let i = 0; i < 4; i++){
          rawCorners.push({
            x: dstCorners.data32F[i * 2],
            y: dstCorners.data32F[i * 2 + 1]
          });
        }

        const result = tracker.update(rawCorners, goodMatches, imuData);
        trackingMode = result.mode;
        confidence = result.confidence;

        // Draw corners (Kalman output) in lime
        if (result.corners){
          const c = result.corners;

          ctx.save();
          ctx.strokeStyle = "lime";
          ctx.lineWidth = 3;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(c[0].x, c[0].y);
          for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
          ctx.closePath();
          ctx.stroke();
          ctx.restore();
        }

        // Draw raw detection in red (dashed)
        ctx.save();
        ctx.strokeStyle = "rgba(255, 0, 0, 0.5)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(rawCorners[0].x, rawCorners[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(rawCorners[i].x, rawCorners[i].y);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();

        dstCorners.delete();
      } else {
        tracker.update(null, 0, imuData);
      }

      if (H) H.delete();
      srcMat.delete();
      dstMat.delete();

      const tH1 = performance.now();
      homoMs = tH1 - tH0;
    } else {
      tracker.update(null, goodMatches, imuData);
    }
  } else {
    tracker.update(null, 0, imuData);
  }

  descU8.delete();
  kps.delete();

  const tFrame1 = performance.now();

  const capMs    = tCap1  - tCap0;
  const grayMs   = tGray1 - tGray0;
  const orbMs    = tOrb1  - tOrb0;
  const imshowMs = tIm1   - tIm0;
  const totalMs  = tFrame1 - tFrame0;

  tCapEma    = ema(tCapEma, capMs, 0.2);
  tGrayEma   = ema(tGrayEma, grayMs, 0.2);
  tOrbEma    = ema(tOrbEma, orbMs, 0.2);
  tMatchEma  = ema(tMatchEma, matchMs, 0.2);
  tHomoEma   = ema(tHomoEma, homoMs, 0.2);
  tImshowEma = ema(tImshowEma, imshowMs, 0.2);
  totalMsEma = ema(totalMsEma, totalMs, 0.2);

  const dt = tFrame1 - lastT;
  lastT = tFrame1;
  const fps = dt > 0 ? 1000 / dt : 0;
  fpsEma = ema(fpsEma, fps, 0.2);

  drawHUD([
    `RES: ${video.width}x${video.height} | KPs: ${kpCount} | Matches: ${goodMatches}`,
    `Track: ${trackingMode} (conf: ${(confidence * 100).toFixed(0)}%) ${gyroSupported ? "🔄" : ""}`,
    `🟢 Lime = Kalman+Gyro | 🔴 Red = Raw detection`,
    `cap:    ${capMs.toFixed(2)} (avg ${tCapEma?.toFixed(2) ?? 0}) ms`,
    `gray:   ${grayMs.toFixed(2)} (avg ${tGrayEma?.toFixed(2) ?? 0}) ms`,
    `orb:    ${orbMs.toFixed(2)} (avg ${tOrbEma?.toFixed(2) ?? 0}) ms`,
    `match:  ${matchMs.toFixed(2)} (avg ${tMatchEma?.toFixed(2) ?? 0}) ms  [LSH]`,
    `homo:   ${homoMs.toFixed(2)} (avg ${tHomoEma?.toFixed(2) ?? 0}) ms`,
    `imshow: ${imshowMs.toFixed(2)} (avg ${tImshowEma?.toFixed(2) ?? 0}) ms`,
    `TOTAL:  ${totalMs.toFixed(2)} (avg ${totalMsEma?.toFixed(2) ?? 0}) ms`,
    `FPS:    ${fps.toFixed(1)} (avg ${fpsEma?.toFixed(1) ?? 0})`
  ]);

  drawGyroHUD(imuData, tracker.accumulatedRotation, gyroSupported, gyroPermissionGranted, tracker);

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
