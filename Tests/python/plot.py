from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt

BASE_DIR = Path(__file__).resolve().parent
FILE = BASE_DIR / "benchmarks" / "orb_benchmark1.xlsx"
GRAPH_DIR = BASE_DIR / "graphs"
GRAPH_DIR.mkdir(exist_ok=True)

df = pd.read_excel(FILE)
df["preset"] = df["preset"].astype(str)

harris = df[df["preset"].str.startswith("harris_")].sort_values("features")
fast   = df[df["preset"].str.startswith("fast_")].sort_values("features")

def plot_vs_nfeatures(metric_col, ylabel, filename):
  plt.figure()
  plt.plot(harris["features"], harris[metric_col], marker="o")
  plt.plot(fast["features"], fast[metric_col], marker="o")
  plt.xlabel("nfeatures (cap)")
  plt.ylabel(ylabel)
  plt.title(f"{ylabel} vs nfeatures")
  plt.legend(["HARRIS_SCORE", "FAST_SCORE"])
  plt.grid(True)
  plt.tight_layout()
  out = GRAPH_DIR / filename
  plt.savefig(out, dpi=200)
  print("Saved:", out)
  plt.show()

# nfeatures vs compute time
plot_vs_nfeatures(
  metric_col="avg_ms",
  ylabel="avg_ms (detectAndCompute)",
  filename="time_vs_nfeatures.png"
)

# nfeatures vs grid occupancy %
plot_vs_nfeatures(
  metric_col="grid_occupancy_percent",
  ylabel="Grid occupancy (%)",
  filename="grid_occupancy_vs_nfeatures.png"
)

# nfeatures vs descriptor density per occupied cell
plot_vs_nfeatures(
  metric_col="descriptor_density_per_occupied_cell",
  ylabel="Descriptor density (features per occupied cell)",
  filename="density_vs_nfeatures.png"
)
