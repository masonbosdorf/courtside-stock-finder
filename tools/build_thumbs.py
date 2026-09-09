#!/usr/bin/env python3
"""Build 192x192 WebP thumbnails for the CourtSide Stock Finder web app.

Reads the parent (style-colour) codes out of stock-seed.json, finds the best
hero image for each one in the CourtSide image bank, and writes a small WebP
thumbnail into img/.

OUTPUT FILENAME RULE  (the web page must apply the *same* rule in JavaScript):

    filename = parent.replace(/[^A-Za-z0-9._-]/g, "_") + ".webp"

i.e. take the parent code exactly as it appears in stock-seed.json, replace
every character outside the set [A-Za-z0-9._-] with an underscore "_", keep the
original letter case, and append ".webp".  The file lives in  img/.
Examples:  "HF2881-303" -> "HF2881-303.webp"
           "5167/NBL/IND/2" -> "5167_NBL_IND_2.webp"
           "NB1-53MJYE62-CNSWAA" -> "NB1-53MJYE62-CNSWAA.webp"

IMAGE BANK LAYOUT
  Assets/<Brand>/...            one top level folder per brand (skip "_*" and
                                "Design System")
  Nike + Jordan                 Assets/Nike/<STYLE>/<COLOUR>/  e.g. HF2881/303
                                files AURORA_<STYLE>-<COLOUR>_<VIEWCODE>-2000.jpeg
  other brands                  Assets/<Brand>/<parent>/<anything>
  some brands (and Nike)        Assets/<Brand>/Hero/<parent>.<ext>  - a single
                                pre-picked hero per style

HERO SELECTION
  Nike/Jordan AURORA files: first view code present out of
      PHSLH000, PHSLH001, PHSFH001, PHCFH001, PHSFM001, PHSBM001, PHSRH000,
      PHSYM001, then any other view code EXCEPT PHSYD* (detail crops).
  Everything else: first image file by natural sort, de-prioritising "-L"
  (lifestyle) stems.  A Hero/<parent>.<ext> file wins outright for non-Nike
  brands, and is the fallback for Nike when the style/colour folder is missing.

USAGE
  python3 tools/build_thumbs.py                     # in-stock parents only
  python3 tools/build_thumbs.py --all               # every style in the bank
  python3 tools/build_thumbs.py --force             # regenerate existing
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import re
import sys
import collections
from pathlib import Path

from PIL import Image, ImageOps

REPO = Path(__file__).resolve().parent.parent
DEFAULT_SEED = REPO / "stock-seed.json"
DEFAULT_ASSETS = Path("/Users/mason/Cowork/Courtside/Assets")
DEFAULT_OUT = REPO / "img"

THUMB = 192
WEBP_QUALITY = 72
WEBP_METHOD = 6

IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}

# brand (as it appears in the seed, upper case) -> asset bank folder name
BRAND_FOLDER = {
    "NIKE": "Nike",
    "JORDAN": "Nike",
    "ADIDAS": "Adidas",
    "NEW ERA": "New Era",
    "NEW BALANCE": "New Balance",
    "PUMA": "Puma",
    "REEBOK": "Reebok",
    "CONVERSE": "Converse",
    "CROCS": "Crocs",
    "FIRST EVER": "First Ever",
    "LI-NING": "Li-Ning",
    "WAY OF WADE": "Way of Wade",
    "MITCHELL & NESS": "Mitchell & Ness",
    "VOUSETI": "Vouseti",
    "RYOKO RAIN": "Ryoko Rain",
    "OUTERSTUFF": "Outerstuff",
    "SNEAKER LAB": "Sneaker Lab",
    "GLOBETROTTERS": "Globetrotters",
    "BUCKETSQUAD": "Bucketsquad",
    "STANCE": "Stance",
    "SPALDING": "Spalding",
    "MELIN": "Melin",
    "WILSON": "Wilson",
    "ANTA": "Anta",
    "FRANK GREEN": "Frank Green",
    "MUTIMER": "Mutimer",
    "SOUTH ST": "South St",
}

NIKE_FOLDERS = {"Nike"}

VIEW_PRIORITY = [
    "PHSLH000",  # side hero (footwear)
    "PHSLH001",
    "PHSFH001",  # item-only front
    "PHCFH001",
    "PHSFM001",  # on-model front (most apparel only has this)
    "PHSBM001",
    "PHSRH000",
    "PHSYM001",
]

AURORA_RE = re.compile(r"^AURORA_.+_([A-Z]{5}\d{3})-\d+$", re.IGNORECASE)


# ---------------------------------------------------------------- helpers


def out_name(parent: str) -> str:
    """The one and only output filename rule (mirror this in JS)."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", parent) + ".webp"


def norm(s: str) -> str:
    """Loose key: lower case, alnum only, leading zeros and trailing 'misc' dropped."""
    k = re.sub(r"[^a-z0-9]", "", s.lower()).lstrip("0")
    if k.endswith("misc") and len(k) > 4:
        k = k[:-4]
    return k


_natural_re = re.compile(r"(\d+)")


def natural_key(s: str):
    return [int(p) if p.isdigit() else p.lower() for p in _natural_re.split(s)]


def is_img(p: Path) -> bool:
    return p.suffix.lower() in IMG_EXT


def listdir(p: Path):
    try:
        return list(os.scandir(p))
    except OSError:
        return []


# ---------------------------------------------------------------- index


class BrandIndex:
    """Lazy per-brand-folder index of style folders + Hero files."""

    def __init__(self, root: Path):
        self.root = root
        self.dir_lower: dict[str, Path] = {}
        self.dir_norm: dict[str, Path] = {}
        self.hero_lower: dict[str, Path] = {}
        self.hero_norm: dict[str, Path] = {}
        hero_dir = None
        for e in listdir(root):
            name = e.name
            if name.startswith((".", "_")):
                continue
            if not e.is_dir():
                continue
            if name.lower() == "hero":
                hero_dir = Path(e.path)
                continue
            self.dir_lower.setdefault(name.lower(), Path(e.path))
            self.dir_norm.setdefault(norm(name), Path(e.path))
        if hero_dir is not None:
            for e in listdir(hero_dir):
                p = Path(e.path)
                if not e.is_file() or not is_img(p):
                    continue
                stem = p.stem
                self.hero_lower.setdefault(stem.lower(), p)
                self.hero_norm.setdefault(norm(stem), p)

    def styles(self):
        return self.dir_lower.items()


_index_cache: dict[str, BrandIndex] = {}


def get_index(assets: Path, folder: str) -> BrandIndex | None:
    if folder in _index_cache:
        return _index_cache[folder]
    root = assets / folder
    if not root.is_dir():
        return None
    idx = BrandIndex(root)
    _index_cache[folder] = idx
    return idx


# ---------------------------------------------------------------- picking


def pick_from_dir(d: Path, nike: bool):
    """Return (path, viewcode|None) for the best image in directory d."""
    files = [Path(e.path) for e in listdir(d) if e.is_file() and is_img(Path(e.path))]
    if not files:
        # one level down (rare nested folders)
        for e in listdir(d):
            if e.is_dir() and not e.name.startswith((".", "_")):
                files += [
                    Path(x.path)
                    for x in listdir(Path(e.path))
                    if x.is_file() and is_img(Path(x.path))
                ]
        if not files:
            return None, None

    if nike:
        aurora = {}
        for f in files:
            m = AURORA_RE.match(f.stem)
            if m:
                aurora.setdefault(m.group(1).upper(), f)
        if aurora:
            for vc in VIEW_PRIORITY:
                if vc in aurora:
                    return aurora[vc], vc
            rest = sorted(
                (vc for vc in aurora if not vc.startswith("PHSYD")), key=natural_key
            )
            if rest:
                return aurora[rest[0]], rest[0]
            # only detail crops exist - fall through to generic pick below

    non_l = [f for f in files if not f.stem.upper().endswith("-L")]
    pool = non_l or files
    pool.sort(key=lambda f: natural_key(f.name))
    return pool[0], None


def resolve(assets: Path, brand: str, parent: str):
    """Return (src_path, viewcode|None, how) or (None, None, reason)."""
    folder = BRAND_FOLDER.get(brand.upper())
    if not folder:
        # case-insensitive folder name match as a fallback
        for e in listdir(assets):
            if e.is_dir() and e.name.lower() == brand.lower():
                folder = e.name
                break
    if not folder:
        return None, None, "no-brand-folder"
    idx = get_index(assets, folder)
    if idx is None:
        return None, None, "no-brand-folder"
    nike = folder in NIKE_FOLDERS

    if not nike:
        # a Hero file named exactly after the parent wins outright
        p = idx.hero_lower.get(parent.lower())
        if p:
            return p, None, "hero"

    if nike and "-" in parent:
        style, _, colour = parent.partition("-")
        sd = idx.dir_lower.get(style.lower())
        if sd:
            cd = None
            for e in listdir(sd):
                if e.is_dir() and e.name.lower() == colour.lower():
                    cd = Path(e.path)
                    break
            if cd is not None:
                src, vc = pick_from_dir(cd, True)
                if src:
                    return src, vc, "style/colour"

    d = idx.dir_lower.get(parent.lower())
    if d:
        src, vc = pick_from_dir(d, nike)
        if src:
            return src, vc, "folder"

    p = idx.hero_lower.get(parent.lower())
    if p:
        return p, None, "hero"

    key = norm(parent)
    p = idx.hero_norm.get(key)
    if p:
        return p, None, "hero-norm"
    d = idx.dir_norm.get(key)
    if d:
        src, vc = pick_from_dir(d, nike)
        if src:
            return src, vc, "folder-norm"

    return None, None, "no-image"


# ---------------------------------------------------------------- thumbing


def make_thumb(job):
    src, dst = job
    try:
        with Image.open(src) as im:
            if im.format == "JPEG":
                im.draft("RGB", (400, 400))
            im = ImageOps.exif_transpose(im)
            if im.mode in ("RGBA", "LA", "P", "PA"):
                im = im.convert("RGBA")
                bg = Image.new("RGB", im.size, (255, 255, 255))
                bg.paste(im, mask=im.split()[-1])
                im = bg
            elif im.mode != "RGB":
                im = im.convert("RGB")
            im.thumbnail((THUMB, THUMB), Image.LANCZOS)
            im.save(dst, "WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)
        return dst, None
    except Exception as exc:  # noqa: BLE001
        return dst, f"{type(exc).__name__}: {exc}"


# ---------------------------------------------------------------- bank walk


def bank_parents(assets: Path):
    """Every style in the bank as (brand_folder, parent)."""
    out = []
    for e in listdir(assets):
        if not e.is_dir() or e.name.startswith((".", "_")):
            continue
        if e.name == "Design System":
            continue
        folder = e.name
        idx = get_index(assets, folder)
        if idx is None:
            continue
        if folder in NIKE_FOLDERS:
            for _lower, sd in idx.styles():
                style = sd.name
                subs = [
                    x
                    for x in listdir(sd)
                    if x.is_dir() and not x.name.startswith((".", "_"))
                ]
                if subs:
                    for x in subs:
                        out.append((folder, f"{style}-{x.name}"))
                else:
                    out.append((folder, style))
        else:
            for _lower, sd in idx.styles():
                out.append((folder, sd.name))
        for stem_lower, p in idx.hero_lower.items():
            out.append((folder, p.stem))
    return out


# ---------------------------------------------------------------- report


def write_report(path: Path, seed_rows, results, out_dir: Path, errors, mode):
    per_brand = collections.defaultdict(lambda: [0, 0])
    missing = []
    view_counts = collections.Counter()
    how_counts = collections.Counter()
    for brand, parent in seed_rows:
        r = results.get((brand, parent))
        per_brand[brand][0] += 1
        if r and r[0]:
            per_brand[brand][1] += 1
            how_counts[r[2]] += 1
            if brand in ("NIKE", "JORDAN"):
                view_counts[r[1] or "(non-AURORA file)"] += 1
        else:
            missing.append((parent, brand, r[2] if r else "?"))

    files = sorted(out_dir.glob("*.webp"))
    total_bytes = sum(f.stat().st_size for f in files)

    tot = sum(v[0] for v in per_brand.values())
    hit = sum(v[1] for v in per_brand.values())

    L = []
    L.append("# Stock Finder thumbnail coverage\n")
    L.append(f"_Generated by `tools/build_thumbs.py` (last run mode: {mode})._\n")
    L.append(
        "Filename rule: `parent.replace(/[^A-Za-z0-9._-]/g, \"_\") + \".webp\"` in `img/`.\n"
    )
    L.append("## Coverage by brand (in-stock parents only)\n")
    L.append("| Brand | Styles | With thumb | % |")
    L.append("|---|---:|---:|---:|")
    for brand in sorted(per_brand, key=lambda b: -per_brand[b][0]):
        t, h = per_brand[brand]
        L.append(f"| {brand or '(blank)'} | {t} | {h} | {100*h/t:.0f}% |")
    L.append(f"| **TOTAL** | **{tot}** | **{hit}** | **{100*hit/tot:.1f}%** |")
    L.append("")
    L.append("## img/ directory\n")
    L.append(f"- files: **{len(files)}**")
    L.append(f"- size: **{total_bytes/1048576:.1f} MB**")
    if files:
        L.append(f"- average thumb: **{total_bytes/len(files)/1024:.2f} KB**")
    L.append("")
    L.append("## How the in-stock hero was found\n")
    for how, n in how_counts.most_common():
        L.append(f"- `{how}`: {n}")
    L.append("")
    L.append("## Nike / Jordan view code used (in-stock)\n")
    L.append("| View code | Count |")
    L.append("|---|---:|")
    for vc, n in view_counts.most_common():
        L.append(f"| {vc} | {n} |")
    L.append("")
    L.append(f"## In-stock parents with no image ({len(missing)})\n")
    if missing:
        by_brand = collections.Counter(b for _p, b, _w in missing)
        L.append("Missing by brand: " + ", ".join(f"{b} {n}" for b, n in by_brand.most_common()))
        L.append("")
    L.append("First 20:\n")
    if missing:
        L.append("| Parent | Brand | Reason |")
        L.append("|---|---|---|")
        for parent, brand, why in missing[:20]:
            L.append(f"| `{parent}` | {brand} | {why} |")
    else:
        L.append("_none_")
    L.append("")
    L.append(f"## Errors ({len(errors)})\n")
    if errors:
        for dst, err in errors[:40]:
            L.append(f"- `{Path(dst).name}`: {err}")
        if len(errors) > 40:
            L.append(f"- ... and {len(errors)-40} more")
    else:
        L.append("_none_")
    L.append("")
    path.write_text("\n".join(L))


# ---------------------------------------------------------------- main


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seed", default=str(DEFAULT_SEED))
    ap.add_argument("--assets", default=str(DEFAULT_ASSETS))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument(
        "--all",
        action="store_true",
        help="also generate a thumb for every style folder in the bank",
    )
    ap.add_argument("--force", action="store_true", help="regenerate existing thumbs")
    ap.add_argument("--jobs", type=int, default=max(2, (os.cpu_count() or 4)))
    ap.add_argument(
        "--report",
        default=str(REPO / "tools" / "thumbs-report.md"),
        help="path of the coverage report (empty string = skip)",
    )
    args = ap.parse_args(argv)

    assets = Path(args.assets)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    seed = json.loads(Path(args.seed).read_text())
    seed_pairs = []
    seen = set()
    for row in seed["items"]:
        brand, parent = (row[2] or "").strip(), (row[4] or "").strip()
        if not parent or not brand:
            continue
        if (brand, parent) in seen:
            continue
        seen.add((brand, parent))
        seed_pairs.append((brand, parent))
    print(f"seed: {len(seed_pairs)} in-stock parents")

    # resolve in-stock parents (always, so the report is accurate)
    results = {}
    for brand, parent in seed_pairs:
        results[(brand, parent)] = resolve(assets, brand, parent)

    todo = {}  # out filename -> (src, dst)
    for (brand, parent), (src, _vc, _how) in results.items():
        if src:
            todo.setdefault(out_name(parent), (src, out_dir / out_name(parent)))

    if args.all:
        print("scanning the image bank for every style ...")
        pairs = bank_parents(assets)
        print(f"bank: {len(pairs)} style candidates")
        for folder, parent in pairs:
            name = out_name(parent)
            if name in todo:
                continue
            nike = folder in NIKE_FOLDERS
            idx = get_index(assets, folder)
            src = None
            if nike and "-" in parent:
                style, _, colour = parent.partition("-")
                sd = idx.dir_lower.get(style.lower())
                if sd:
                    for e in listdir(sd):
                        if e.is_dir() and e.name.lower() == colour.lower():
                            src, _vc = pick_from_dir(Path(e.path), True)
                            break
            if src is None:
                d = idx.dir_lower.get(parent.lower())
                if d:
                    src, _vc = pick_from_dir(d, nike)
            if src is None:
                src = idx.hero_lower.get(parent.lower())
            if src is not None:
                todo[name] = (src, out_dir / name)

    jobs = [
        (str(s), str(d))
        for s, d in todo.values()
        if args.force or not d.exists()
    ]
    print(f"{len(todo)} thumbs wanted, {len(jobs)} to generate")

    errors = []
    done = 0
    if jobs:
        with cf.ProcessPoolExecutor(max_workers=args.jobs) as ex:
            for dst, err in ex.map(make_thumb, jobs, chunksize=16):
                done += 1
                if err:
                    errors.append((dst, err))
                if done % 500 == 0:
                    print(f"  {done}/{len(jobs)} ... ({len(errors)} errors)", flush=True)
    print(f"generated {done - len(errors)}, errors {len(errors)}")

    if args.report:
        write_report(
            Path(args.report),
            seed_pairs,
            results,
            out_dir,
            errors,
            "--all" if args.all else "in-stock",
        )
        print(f"report: {args.report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
