#!/usr/bin/env python3
"""Headlight pixel test (Stage B).

Compares the ?headlight=on vs ?headlight=off screenshots (same camera,
same scene, night) and measures the beam's gain on three patches:
  lit_asphalt - road ahead of the car, inside the beam
  lit_roof    - roof of the parked car 45 m ahead, inside the beam
  control     - road behind the car, outside the beam (must stay dark)
Run for both haze variants (fog on / ?haze=off).

Thresholds (from the brief):
  lit asphalt mean gain >= +20, >= 90% of its pixels gain > +10
  lit car roof mean gain >= +20
  unlit control mean gain within 1 (|gain| <= 1)
Usage: python3 checks/headlight.py [shots-b-dir]
"""
import sys
from pathlib import Path

from PIL import Image

# patches: (x0, y0, x1, y1) in the 1280x720 screenshots
PATCHES = {
    "lit_asphalt": (585, 415, 615, 430),
    "lit_roof": (600, 365, 650, 378),
    "control": (60, 630, 180, 690),
}


def patch_stats(img, box):
    x0, y0, x1, y1 = box
    crop = img.crop((x0, y0, x1, y1)).convert("RGB")
    px = list(crop.getdata())
    n = len(px)
    means = [sum(c[i] for c in px) / n for i in range(3)]
    return means, px


def gain_stats(on_img, off_img, box):
    on_means, on_px = patch_stats(on_img, box)
    off_means, off_px = patch_stats(off_img, box)
    gains = [on_means[i] - off_means[i] for i in range(3)]
    mean_gain = sum(gains) / 3
    # per-pixel gain (mean of the 3 channels), fraction > +10
    frac = sum(
        1
        for a, b in zip(on_px, off_px)
        if (sum(a[i] - b[i] for i in range(3)) / 3) > 10
    ) / len(on_px)
    return {
        "on": on_means,
        "off": off_means,
        "gain": gains,
        "mean_gain": mean_gain,
        "frac_gt10": frac,
    }


def run_variant(d, suffix):
    on = Image.open(d / f"headlight-on{suffix}.jpg")
    off = Image.open(d / f"headlight-off{suffix}.jpg")
    print(f"=== haze {'off' if suffix else 'on'} ===")
    ok = True
    for name, box in PATCHES.items():
        s = gain_stats(on, off, box)
        print(
            f"{name:12s} on=({s['on'][0]:.1f},{s['on'][1]:.1f},{s['on'][2]:.1f}) "
            f"off=({s['off'][0]:.1f},{s['off'][1]:.1f},{s['off'][2]:.1f}) "
            f"gain=({s['gain'][0]:+.1f},{s['gain'][1]:+.1f},{s['gain'][2]:+.1f}) "
            f"mean_gain={s['mean_gain']:+.1f} frac>10={s['frac_gt10']:.2f}"
        )
        if name == "lit_asphalt":
            good = s["mean_gain"] >= 20 and s["frac_gt10"] >= 0.90
            print(f"  -> asphalt: {'PASS' if good else 'FAIL'} (need mean>=+20, frac>=0.90)")
            ok = ok and good
        if name == "lit_roof":
            good = s["mean_gain"] >= 20
            print(f"  -> roof: {'PASS' if good else 'FAIL'} (need mean>=+20)")
            ok = ok and good
        if name == "control":
            good = abs(s["mean_gain"]) <= 1
            print(f"  -> control: {'PASS' if good else 'FAIL'} (need |mean|<=1)")
            ok = ok and good
    print(f"variant {'PASS' if ok else 'FAIL'}\n")
    return ok


def main():
    d = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "shots-b"
    ok_on = run_variant(d, "")
    ok_off = run_variant(d, "-nohaze")
    print("OVERALL:", "PASS" if (ok_on and ok_off) else "FAIL")
    return 0 if (ok_on and ok_off) else 1


if __name__ == "__main__":
    raise SystemExit(main())
