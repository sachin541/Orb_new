// main.js
import { PRESETS, RUNS, WARMUP, GRID } from "./config.js";

const fileEl = document.getElementById("file");
const imgEl  = document.getElementById("img");
const btn    = document.getElementById("run");
const canvas = document.getElementById("c");
const logEl  = document.getElementById("log");
const log = (s)=> (logEl.textContent += s + "\n");

function waitCvReady(){
  return new Promise(res=>{
    const t = setInterval(()=>{
      if (window.cv && cv.Mat){
        clearInterval(t);
        res();
      }
    }, 50);
  });
}

function resolveScoreType(s){
  if (s === "FAST") return cv.ORB_FAST_SCORE;
  return cv.ORB_HARRIS_SCORE;
}

function featureSpreadGrid(kpVec, w, h, grid){
  const used = new Set();
  for (let i=0;i<kpVec.size();i++){
    const p = kpVec.get(i).pt;
    const gx = Math.min(grid-1, Math.max(0, Math.floor((p.x / w) * grid)));
    const gy = Math.min(grid-1, Math.max(0, Math.floor((p.y / h) * grid)));
    used.add(gy * grid + gx);
  }
  const total = grid * grid;
  const occ = used.size;
  return { occupied: occ, total, ratio: total ? occ / total : 0 };
}

function runOnce(gray, orb){
  const kps = new cv.KeyPointVector();
  const desc = new cv.Mat();

  const t0 = performance.now();
  orb.detectAndCompute(gray, new cv.Mat(), kps, desc, false);
  const t1 = performance.now();

  return { ms: (t1 - t0), kps, desc };
}

async function benchmarkPreset(gray, w, h, preset){
  const p = preset.params.slice();
  p[6] = resolveScoreType(p[6]); // scoreType

  const orb = new cv.ORB(...p);

  for (let i=0;i<WARMUP;i++){
    const r = runOnce(gray, orb);
    r.kps.delete(); r.desc.delete();
  }

  let total = 0;
  let lastKps = null;
  let lastDesc = null;

  for (let i=0;i<RUNS;i++){
    const r = runOnce(gray, orb);
    total += r.ms;

    if (lastKps) lastKps.delete();
    if (lastDesc) lastDesc.delete();
    lastKps = r.kps;
    lastDesc = r.desc;
  }

  const avgMs = total / RUNS;
  const features = lastKps.size();
  const spread = featureSpreadGrid(lastKps, w, h, GRID);

  const densityPerOccupiedCell = spread.occupied ? (features / spread.occupied) : 0;

  lastKps.delete();
  lastDesc.delete();
  orb.delete();

  return {
    name: preset.name,
    avgMs,
    features,
    grid: `${GRID}x${GRID}`,
    spreadOcc: spread.occupied,
    spreadTotal: spread.total,
    spreadRatio: spread.ratio,
    densityPerOccupiedCell
  };
}

function saveResultsXLSX(rows, filename){
  // rows: array of plain objects (each object -> one Excel row)
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "ORB_Benchmark");
  XLSX.writeFile(wb, filename);
}

async function main(){
  await waitCvReady();
  log("OpenCV ready");

  fileEl.onchange = ()=>{
    const f = fileEl.files && fileEl.files[0];
    if (!f) return;
    logEl.textContent = "";

    imgEl.onload = ()=>{
      canvas.width = imgEl.naturalWidth;
      canvas.height = imgEl.naturalHeight;
      canvas.getContext("2d").drawImage(imgEl, 0, 0);
      btn.disabled = false;
      log(`Image: ${imgEl.naturalWidth}x${imgEl.naturalHeight}`);
      log(`Presets: ${PRESETS.length}, runs=${RUNS}, warmup=${WARMUP}, grid=${GRID}x${GRID}`);
    };

    imgEl.src = URL.createObjectURL(f);
  };

  btn.onclick = async ()=>{
    btn.disabled = true;

    const src = cv.imread(imgEl);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    const w = imgEl.naturalWidth;
    const h = imgEl.naturalHeight;

    log("");
    log("name\tavg_ms\tfeatures\tgrid_occ\tdensity");

    const results = [];

    for (const preset of PRESETS){
      const r = await benchmarkPreset(gray, w, h, preset);

      const occText = `${r.spreadOcc}/${r.spreadTotal} (${(r.spreadRatio*100).toFixed(1)}%)`;
      const densText = r.densityPerOccupiedCell.toFixed(2);

      log(`${r.name}\t${r.avgMs.toFixed(2)}\t${r.features}\t${occText}\t${densText}`);

      results.push({
        preset: r.name,
        avg_ms: Number(r.avgMs.toFixed(3)),
        features: r.features,
        grid: r.grid,
        occupied_cells: r.spreadOcc,
        total_cells: r.spreadTotal,
        grid_occupancy_ratio: Number(r.spreadRatio.toFixed(4)),
        grid_occupancy_percent: Number((r.spreadRatio*100).toFixed(2)),
        descriptor_density_per_occupied_cell: Number(r.densityPerOccupiedCell.toFixed(4)),
        image_width: w,
        image_height: h,
        runs: RUNS,
        warmup: WARMUP
      });
    }

    // Save Excel
    saveResultsXLSX(results, "orb_benchmark.xlsx");
    log("\nSaved: orb_benchmark.xlsx");

    gray.delete();
    src.delete();

    btn.disabled = false;
  };
}

main();
