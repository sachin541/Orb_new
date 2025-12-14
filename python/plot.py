from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt

# ---------- Paths ----------
BASE_DIR = Path(__file__).resolve().parent
FILE = BASE_DIR / "benchmarks" / "orb_benchmark1.xlsx"
GRAPH_DIR = BASE_DIR / "graphs"
GRAPH_DIR.mkdir(exist_ok=True)   # create graphs/ if missing

print("Reading:", FILE)
print("Saving graphs to:", GRAPH_DIR)

# ---------- Load data ----------
df = pd.read_excel(FILE)
df["preset"] = df["preset"].astype(str)

harris = df[df["preset"].str.startswith("harris_")].sort_values("features").reset_index(drop=True)
fast   = df[df["preset"].str.startswith("fast_")].sort_values("features").reset_index(drop=True)

# ---------- Helper: find taper ----------
def find_taper_point(d, metric_col, cost_col="avg_ms", min_step=3, threshold=0.02):
    m = d[metric_col].astype(float).to_numpy()
    c = d[cost_col].astype(float).to_numpy()

    dm = m[1:] - m[:-1]
    dc = c[1:] - c[:-1]
    gain_per_ms = dm / (dc + 1e-9)

    for i in range(len(gain_per_ms) - min_step + 1):
        if (gain_per_ms[i:i+min_step] < threshold).all():
            return i + 1
    return None

# ---------- Plot helper ----------
def plot_metric(
    d_h, d_f,
    metric_col,
    ylabel,
    filename,
    use_cost_x=False,
    taper_threshold=0.02
):
    plt.figure()

    if use_cost_x:
        xh, xf = d_h["avg_ms"], d_f["avg_ms"]
        xlabel = "avg_ms (detectAndCompute)"
        title = f"{ylabel} vs compute time"
    else:
        xh, xf = d_h["features"], d_f["features"]
        xlabel = "nfeatures (cap)"
        title = f"{ylabel} vs nfeatures"

    plt.plot(xh, d_h[metric_col], marker="o")
    plt.plot(xf, d_f[metric_col], marker="o")

    # taper markers
    th = find_taper_point(d_h, metric_col, threshold=taper_threshold)
    tf = find_taper_point(d_f, metric_col, threshold=taper_threshold)

    if th is not None:
        plt.axvline(xh.iloc[th], linestyle="--")
        plt.text(xh.iloc[th], d_h[metric_col].iloc[th], " taper", va="bottom")
    if tf is not None:
        plt.axvline(xf.iloc[tf], linestyle="--")
        plt.text(xf.iloc[tf], d_f[metric_col].iloc[tf], " taper", va="bottom")

    plt.xlabel(xlabel)
    plt.ylabel(ylabel)
    plt.title(title)
    plt.legend(["HARRIS_SCORE", "FAST_SCORE"])
    plt.grid(True)
    plt.tight_layout()

    out = GRAPH_DIR / filename
    plt.savefig(out, dpi=200)
    print("Saved:", out)
    plt.show()

# ---------- Plots ----------

# Grid occupancy vs features
plot_metric(
    harris, fast,
    metric_col="grid_occupancy_percent",
    ylabel="Grid occupancy (%)",
    filename="grid_occupancy_vs_features.png",
    use_cost_x=False,
    taper_threshold=0.05
)

# Grid occupancy vs time
plot_metric(
    harris, fast,
    metric_col="grid_occupancy_percent",
    ylabel="Grid occupancy (%)",
    filename="grid_occupancy_vs_time.png",
    use_cost_x=True,
    taper_threshold=0.05
)

# Descriptor density vs features
plot_metric(
    harris, fast,
    metric_col="descriptor_density_per_occupied_cell",
    ylabel="Descriptor density (features per occupied cell)",
    filename="density_vs_features.png",
    use_cost_x=False,
    taper_threshold=0.2
)

# Descriptor density vs time
plot_metric(
    harris, fast,
    metric_col="descriptor_density_per_occupied_cell",
    ylabel="Descriptor density (features per occupied cell)",
    filename="density_vs_time.png",
    use_cost_x=True,
    taper_threshold=0.2
)
