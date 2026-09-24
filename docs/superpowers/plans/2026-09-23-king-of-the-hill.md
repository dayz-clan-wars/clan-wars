# King of the Hill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin schedules a one-session King of the Hill event at a Livonia town. For that session:
- fresh spawns land at the hill in KotH loadouts
- infected, wolves and bears are concentrated there
- kills whose victim was within 500 m are scored, and the top linked player gets the Plate Carrier award

**Architecture:**
- **Mission content.** The `livonia` repo holds the per-town files (regenerated with a water mask and a hill-only zombie territory) and the flat `custom/koth-*.json` presets. Its deploy workflow copies the default files to `koth/default/`.
- **Restart tick.** In this repo, the restart tick converges six targets level-triggered every slot:
  - two splices: `cfggameplay.json`'s preset list and `events.xml`'s `Infected*` switches, each riding the file's single existing round trip
  - four whole-file copies
- **KotH tick.** A new `koth-tick` does the posts, fails missed openings, and scores and awards in one transaction.

**Tech Stack:**
- this repo: TypeScript, vitest, drizzle-orm over postgres.js, discord.js, pnpm + turbo
- `livonia`: Python 3 (stdlib only for the generator; Pillow only for the one-off mask tool)

**Spec:** `docs/superpowers/specs/2026-09-23-king-of-the-hill-design.md`

## Global Constraints

- Loadout presets are named `./custom/koth-<name>.json`. They sit flat in `custom/`: no subfolder, no other path.
- `KOTH_PRESET_PREFIX = "koth-"`. No non-KotH preset may ever start with it.
- `KOTH_ZONE_RADIUS_M = 500`, measured 2-D, with the **victim's** position.
- `KOTH_REMINDER_LEAD_MS = 30 min`, `KOTH_SCORE_SETTLE_MS = 10 min`.
- `KOTH_AWARD_KEY = "plate-carrier"`.
- `KOTH_INFECTED_EVENTS = ["InfectedCity", "InfectedVillage", "InfectedArmy", "InfectedPolice", "InfectedMedic"]`. The generator's zombie zone names must be a subset of this list.
- Whole-file targets:
  - `cfgplayerspawnpoints.xml` (mission root)
  - `env/wolf_territories.xml`, `env/bear_territories.xml`, `env/zombie_territories.xml`
  - sources `koth/locations/<slug>/<basename>`, defaults `koth/default/<basename>`
- `cfgeventspawns.xml` is **never** touched.
- ⚠️ `cfggameplay.json` gets ONE download and ONE upload per slot (`applyGameplay`), and so does `events.xml` (`applyEvents`). Never add a second round trip to either.
- ⚠️ No Discord call inside `restart-tick.ts`. Every post happens in `koth-tick.ts`.
- ⚠️ A KotH session never opens late. A `scheduled` row whose slot has passed goes `failed`.
- ⚠️ The restore arm runs whether or not `KOTH_TICK` is set.
- KotH kills count everywhere. `scoringKill` is imported from `@factions/roster/internal`, never re-spelled, and never modified.
- Lock order: `koth_events` goes immediately before `award_grants`.
- Every command reply is ephemeral. Every post uses `allowedMentions: { parse: [] }`.
- Comments explain WHY, with `⚠️` on load-bearing lines (house style, `CLAUDE.md`).
- Gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`. Count the tasks (30/30 today), not just the exit code. Never run it twice at once.

## Review Focus

1. **A user edits the default loadout list, or turns an `Infected*` event on for normal play, after a KotH event.** That edit must survive every later slot. Pinned in Task 9 ("a later user edit survives") and Task 6.
2. **The livonia deploy has not yet created `koth/default/` when the first event is scheduled.** The open must touch nothing, the row goes `failed`, and ops is told. Pinned in Task 9 ("missing default refuses").
3. **The bot is down across the opening slot, or the restart was `missed`/`skipped`.** The event goes `failed`, the players are told it's cancelled, and it never runs at a later slot. Pinned in Task 11.
4. **Two scoring passes race after a crash.** Exactly one Plate Carrier is granted. Pinned in Task 10.
5. **The top killer is unlinked.** The prize passes to the next linked player, and the post says so. Pinned in Tasks 4 and 11.

---

## Part A — the `livonia` repo

Work in `/Users/steveharmeyer/Development/dayz-clan-wars/livonia`, on a branch named `koth-mission`.

⚠️ Pushing a published Release is a **production FTP deploy**. Do not publish a Release in this plan; Task 15's runbook does it.

The generator lives at `koth/locations/generator/`, a vendored copy. Its tests run with `cd koth/locations/generator && python3 -m unittest test_generate -v`.

### Task 1: The water mask and the review page

**Files:**
- Create: `koth/locations/generator/tools/build_water_mask.py`
- Create: `koth/locations/generator/water-mask.pbm` (generated, committed)
- Create: `koth/locations/generator/tools/review_page.py` (writes a throwaway HTML to a path you pass it; the HTML is not committed)

**Interfaces:**
- Produces `water-mask.pbm`:
  - binary PBM (P4), 4096 × 4096 px, 1 = water
  - pixel (0,0) is the map's north-west corner
  - world size 12800 m, so 3.125 m per pixel
  - pixel `px = floor(x / 3.125)`, `py = floor((12800 - z) / 3.125)`
- Tiles: `https://dayzclanwars.com/tiles/enoch/topographic/{z}/{x}/{y}.webp`, zoom 4 (16 × 16 tiles of 256 px)
- The water test, measured on the zoom-2 tile 2/1/1: river pixel `(159,204,248)`, land `(210,209,202)`. A pixel is water when `b > r + 25 and b > g + 5 and b > 150`.

- [ ] **Step 1: Write the mask builder**

```python
"""One-off: build water-mask.pbm from the site's topographic tiles.

Not imported by generate.py (which stays stdlib-only). Needs Pillow:
    python3 -m pip install pillow
Run from the generator dir:
    python3 tools/build_water_mask.py --out water-mask.pbm --cache /tmp/koth-tiles

The tiles are the same pyramid dayzclanwars.com/map draws. If the review page
(tools/review_page.py) shows the spawn dots offset from the drawn towns, the
projection below is what is wrong, not the mask.
"""
import argparse
import io
import urllib.request
from pathlib import Path

from PIL import Image

ZOOM = 4
TILES = 2 ** ZOOM          # 16
SIZE = TILES * 256         # 4096 px
URL = "https://dayzclanwars.com/tiles/enoch/topographic/{z}/{x}/{y}.webp"


def is_water(rgb):
    r, g, b = rgb
    # Calibrated on tile 2/1/1: river (159,204,248), land (210,209,202).
    return b > r + 25 and b > g + 5 and b > 150


def fetch(cache, x, y):
    p = cache / f"{ZOOM}-{x}-{y}.webp"
    if not p.exists():
        with urllib.request.urlopen(URL.format(z=ZOOM, x=x, y=y), timeout=30) as r:
            p.write_bytes(r.read())
    return Image.open(io.BytesIO(p.read_bytes())).convert("RGB")


def build(cache):
    bits = bytearray(SIZE * SIZE // 8)
    for ty in range(TILES):
        for tx in range(TILES):
            im = fetch(cache, tx, ty)
            px = im.load()
            for j in range(256):
                for i in range(256):
                    if is_water(px[i, j]):
                        X, Y = tx * 256 + i, ty * 256 + j
                        k = Y * SIZE + X
                        bits[k >> 3] |= 0x80 >> (k & 7)
    return bits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--cache", type=Path, required=True)
    a = ap.parse_args()
    a.cache.mkdir(parents=True, exist_ok=True)
    bits = build(a.cache)
    a.out.write_bytes(f"P4\n{SIZE} {SIZE}\n".encode() + bytes(bits))
    print(f"wrote {a.out} ({sum(bin(b).count('1') for b in bits)} water px)")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Build the mask and check it has plausible water**

```bash
cd koth/locations/generator && python3 -m pip install pillow && \
  python3 tools/build_water_mask.py --out water-mask.pbm --cache /tmp/koth-tiles
```

Expected: `wrote water-mask.pbm (N water px)`, with N somewhere between about 1 % and 15 % of 16,777,216. Zero means the tile URL or the colour test is wrong. Stop and fix that before going on.

- [ ] **Step 3: Write the review page generator**

It plots every town's **current** committed spawn points over the zoom-4 tiles, marking the points the mask calls wet.

```python
"""Throwaway: an HTML page plotting each town's spawn points on the tiles.

    python3 tools/review_page.py --root ../../.. --mask water-mask.pbm --out /tmp/koth-review.html

Red = the mask says water (or within 8 m of it). Green = dry. A human
confirms the red ones are really wet and the green ones really dry.
"""
import argparse
import json
import re
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from generate import load_water_mask, is_wet  # added in Task 2

TILE = "https://dayzclanwars.com/tiles/enoch/topographic/4/{x}/{y}.webp"
MPP = 12800 / 4096


def points(xml):
    return [(float(x), float(z)) for x, z in re.findall(r'<pos x="([0-9.]+)" z="([0-9.]+)"', xml)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, required=True)
    ap.add_argument("--mask", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    mask = load_water_mask(a.mask)
    index = json.loads((a.root / "koth/locations/index.json").read_text())
    cards = []
    for t in index:
        pts = points((a.root / "koth/locations" / t["slug"] / "cfgplayerspawnpoints.xml").read_text())
        cx, cz = t["center_x"], t["center_z"]
        # A 600 m square around the centre, drawn from the zoom-4 tiles.
        half = 300
        left, top = (cx - half) / MPP, (12800 - (cz + half)) / MPP
        span = 2 * half / MPP
        tiles = []
        for ty in range(int(top // 256), int((top + span) // 256) + 1):
            for tx in range(int(left // 256), int((left + span) // 256) + 1):
                tiles.append(f'<img src="{TILE.format(x=tx, y=ty)}" style="position:absolute;left:{(tx*256-left)*2}px;top:{(ty*256-top)*2}px;width:512px;height:512px">')
        dots = []
        wet = 0
        for x, z in pts:
            bad = is_wet(mask, x, z)
            wet += bad
            dots.append(f'<div title="{x:.0f},{z:.0f}" style="position:absolute;left:{((x/MPP)-left)*2-5}px;top:{((12800-z)/MPP-top)*2-5}px;width:10px;height:10px;border-radius:5px;background:{"#e11" if bad else "#1b1"};border:1px solid #000"></div>')
        cards.append(f'<figure><figcaption>{t["name"]} — {wet} wet / {len(pts)}</figcaption>'
                     f'<div style="position:relative;width:{span*2:.0f}px;height:{span*2:.0f}px;overflow:hidden">{"".join(tiles)}{"".join(dots)}</div></figure>')
    a.out.write_text("<!doctype html><meta charset=utf-8><title>KotH spawn review</title>"
                     "<style>body{font:14px sans-serif;display:flex;flex-wrap:wrap;gap:12px}figure{margin:0}</style>"
                     + "".join(cards))
    print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
```

(It imports `load_water_mask`/`is_wet` from Task 2. Write Task 2's Steps 1–4 first if you are running strictly in order, then come back to Step 4 here.)

- [ ] **Step 4: Human gate — the review**

```bash
cd koth/locations/generator && python3 tools/review_page.py --root ../../.. --mask water-mask.pbm --out /tmp/koth-review.html
```

Open `/tmp/koth-review.html`. The controller may publish it as a private Artifact for the user.

**Stop and ask the user** to confirm two things:
- the red dots are really in water
- no dot that is visibly in water is green

If the dots sit offset from the drawn town, the projection is wrong: fix `MPP`/the flip, not the mask. If the colour test misses shallow water, loosen `is_water` in Step 1, rebuild, and re-review. Do not continue until the user confirms.

- [ ] **Step 5: Commit**

```bash
git add koth/locations/generator/tools koth/locations/generator/water-mask.pbm
git commit -m "koth: water mask built from the site's topographic tiles, plus a review page"
```

### Task 2: Generator: dry spawn points, hill-only infected, no event spawns

**Files:**
- Modify: `koth/locations/generator/generate.py`
- Modify: `koth/locations/generator/test_generate.py`
- Modify: `koth/locations/generator/README.md`

**Interfaces:**
- Produces:
  - `load_water_mask(path) -> WaterMask`
  - `is_wet(mask, x, z) -> bool` (wet if the point or any point 8 m N/S/E/W of it is water)
  - `dry_ring(cx, cz, radius, n, mask) -> list[(x, z)]` (raises `ValueError` when fewer than `n` dry candidates exist)
  - `render_zombies(cx, cz) -> str`
  - `ZOMBIE_ZONE_NAMES`
- Per-town outputs:
  - `cfgplayerspawnpoints.xml`
  - `wolf_territories.xml`, `bear_territories.xml`, `zombie_territories.xml`
  - **no** `cfgeventspawns.xml`

- [ ] **Step 1: Write the failing tests** (append to `test_generate.py`)

```python
class FakeMask:
    """Water everywhere with x < 1000; dry elsewhere."""
    def wet_at(self, x, z):
        return x < 1000


class TestWater(unittest.TestCase):
    def test_is_wet_on_water(self):
        self.assertTrue(generate.is_wet(FakeMask(), 900, 5000))

    def test_is_wet_within_buffer(self):
        # 1005 is dry but 8 m west (997) is water.
        self.assertTrue(generate.is_wet(FakeMask(), 1005, 5000))

    def test_dry(self):
        self.assertFalse(generate.is_wet(FakeMask(), 1100, 5000))

    def test_dry_ring_avoids_water(self):
        # Centre 1100: a 110 m ring crosses x < 1000 on its west side.
        ring = generate.dry_ring(1100, 5000, 110, 12, FakeMask())
        self.assertEqual(len(ring), 12)
        for x, z in ring:
            self.assertFalse(generate.is_wet(FakeMask(), x, z))

    def test_dry_ring_fails_loudly(self):
        with self.assertRaises(ValueError):
            generate.dry_ring(500, 5000, 110, 12, FakeMask())  # entirely wet

    def test_load_mask_roundtrip(self):
        import tempfile, pathlib
        size = 8
        bits = bytearray(size * size // 8)
        bits[0] = 0x80  # pixel (0,0) = north-west corner is water
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / "m.pbm"
            p.write_bytes(f"P4\n{size} {size}\n".encode() + bytes(bits))
            m = generate.load_water_mask(p, world=size)  # 1 m per px
            self.assertTrue(m.wet_at(0.5, size - 0.5))
            self.assertFalse(m.wet_at(3.5, 3.5))


class TestZombies(unittest.TestCase):
    def test_zones_within_koth_radius_and_named(self):
        xml = generate.render_zombies(8000, 6000)
        root = ET.fromstring(xml)
        zones = root.findall("./territory/zone")
        self.assertGreaterEqual(len(zones), 7)
        for z in zones:
            self.assertIn(z.get("name"), generate.ZOMBIE_ZONE_NAMES)
            d = math.hypot(float(z.get("x")) - 8000, float(z.get("z")) - 6000) + float(z.get("r"))
            self.assertLessEqual(d, 500)


class TestNoEventSpawns(unittest.TestCase):
    def test_build_town_has_no_event_xml(self):
        town = {"name": "Test", "cat": "Village", "cx": 5000, "cz": 5000}
        r = generate.build_town(town, SPAWN_TEMPLATE, FakeDryMask())
        self.assertNotIn("event_xml", r)
        self.assertIn("zombie_xml", r)


class FakeDryMask:
    def wet_at(self, x, z):
        return False
```

`SPAWN_TEMPLATE` must be a module-level string already used by the existing `TestRenderSpawns`. If it has another name there, use that name. If there is none, add one: a minimal `<playerspawnpoints><fresh><spawn_params><min_dist_player>65</min_dist_player><max_dist_player>150</max_dist_player></spawn_params><generator_posbubbles/></fresh></playerspawnpoints>`. Also delete the existing tests for `render_eventspawns`, `find_heli_positions`, `active_event_names` and the clearance helpers (`TestClearance`, `TestFindHeli`, `TestActiveEvents`, `TestRenderEvents`), since Step 3 removes that code.

- [ ] **Step 2: Run to see them fail**

Run: `cd koth/locations/generator && python3 -m unittest test_generate -v`
Expected: FAIL/ERROR (`AttributeError: module 'generate' has no attribute 'is_wet'`).

- [ ] **Step 3: Implement** (in `generate.py`)

Add near the top:

```python
# --- Water (spec 2026-09-23-king-of-the-hill §2.7) ---------------------------
WORLD_M = 12800.0
WATER_BUFFER_M = 8.0      # a point this close to water counts as wet
RING_STEP_DEG = 5         # candidate spacing on the ring
RING_RADIUS_STEPS = (0, -20, 20, -40, 40)  # tried in this order, metres
DEFAULT_MASK = Path(__file__).resolve().parent / "water-mask.pbm"

# --- Infected (hill-only) ---------------------------------------------------
KOTH_RADIUS_M = 500.0
# ⚠️ Must stay a subset of KOTH_INFECTED_EVENTS in clan-wars'
# packages/domain/src/rules.ts — the bot switches exactly those events on, and a
# zone whose name has no active event spawns nothing. A drift test there reads
# the generated files.
ZOMBIE_ZONE_NAMES = ("InfectedCity", "InfectedVillage", "InfectedArmy", "InfectedPolice", "InfectedMedic")
ZOMBIE_COLOR = "1291845632"   # the live zombie_territories.xml's colour (editor-only)
ZOMBIE_ZONE_R = 80.0
ZOMBIE_RING_M = 280.0
ZOMBIE_RING_COUNT = 6


class WaterMask:
    def __init__(self, bits, size, world):
        self.bits, self.size, self.mpp = bits, size, world / size

    def wet_at(self, x, z):
        px = int(x / self.mpp)
        py = int((self.size * self.mpp - z) / self.mpp)
        if not (0 <= px < self.size and 0 <= py < self.size):
            return True  # off the map is never a spawn
        k = py * self.size + px
        return bool(self.bits[k >> 3] & (0x80 >> (k & 7)))


def load_water_mask(path, world=WORLD_M):
    data = Path(path).read_bytes()
    parts = data.split(b"\n", 2)
    if parts[0] != b"P4":
        raise ValueError(f"{path}: not a binary PBM")
    w, h = (int(v) for v in parts[1].split())
    if w != h:
        raise ValueError(f"{path}: mask must be square")
    return WaterMask(parts[2], w, world)


def is_wet(mask, x, z):
    b = WATER_BUFFER_M
    return any(mask.wet_at(px, pz) for px, pz in ((x, z), (x + b, z), (x - b, z), (x, z + b), (x, z - b)))


def dry_ring(cx, cz, radius, n, mask):
    """n dry points spread around the town, on a ring near `radius`.

    Candidates every RING_STEP_DEG on the nominal ring, then on rings 20 m and
    40 m in and out; the n chosen are spread apart by farthest-point sampling.
    ⚠️ Fails loudly rather than returning fewer than n: a short ring is a town
    whose spawns pile up, and a wet one drowns fresh spawns — neither should
    reach the server quietly.
    """
    cands = []
    for dr in RING_RADIUS_STEPS:
        r = radius + dr
        for deg in range(0, 360, RING_STEP_DEG):
            a = math.radians(deg)
            p = (cx + r * math.cos(a), cz + r * math.sin(a))
            if not is_wet(mask, *p):
                cands.append(p)
        if len(cands) >= n * 2:
            break
    if len(cands) < n:
        raise ValueError(f"only {len(cands)} dry spawn candidates around ({cx}, {cz}); need {n}")
    return farthest_point_sample(cands, n, cands[0])


def render_zombies(cx, cz):
    """Hill-only infected territory: one zone at the centre, a ring around it."""
    zones = [(cx, cz)] + [
        (cx + ZOMBIE_RING_M * math.cos(2 * math.pi * i / ZOMBIE_RING_COUNT),
         cz + ZOMBIE_RING_M * math.sin(2 * math.pi * i / ZOMBIE_RING_COUNT))
        for i in range(ZOMBIE_RING_COUNT)
    ]
    lines = [
        f'        <zone name="{ZOMBIE_ZONE_NAMES[i % len(ZOMBIE_ZONE_NAMES)]}" smin="0" smax="0" dmin="3" dmax="6" '
        f'x="{x:.1f}" z="{z:.1f}" r="{_num(ZOMBIE_ZONE_R)}"/>'
        for i, (x, z) in enumerate(zones)
    ]
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<territory-type>\n'
        f'    <territory color="{ZOMBIE_COLOR}">\n' + "\n".join(lines) + "\n"
        '    </territory>\n</territory-type>\n'
    )
```

Then:
- **Delete** `render_eventspawns`, `find_heli_positions`, `active_event_names`, `is_clear`, `required_clearance`, `large_clearance`, `LARGE_BUILDING_CLEARANCE`, `load_buildings`, and the heli constants. Keep `grid_candidates`/`farthest_point_sample`; `dry_ring` uses the latter.
- **Replace** `build_town` and `run`:

```python
def build_town(town, spawn_template, mask):
    params = CATEGORY_PARAMS[town["cat"]]
    cx, cz = float(town["cx"]), float(town["cz"])
    slug = slugify(town["name"])
    ring = dry_ring(cx, cz, params["radius"], params["points"], mask)
    return {
        "name": town["name"], "slug": slug, "category": town["cat"],
        "center_x": round(cx), "center_z": round(cz),
        "spawn_radius": params["radius"], "spawn_points": params["points"],
        "spawn_xml": render_playerspawnpoints(spawn_template, ring, slug),
        "wolf_xml": render_territory(WOLF_ZONE, WOLF_COLOR, cx, cz, WOLF_RADIUS),
        "bear_xml": render_territory(BEAR_ZONE, BEAR_COLOR, cx, cz, BEAR_RADIUS),
        "zombie_xml": render_zombies(cx, cz),
    }


FILES = (("cfgplayerspawnpoints.xml", "spawn_xml"), ("wolf_territories.xml", "wolf_xml"),
         ("bear_territories.xml", "bear_xml"), ("zombie_territories.xml", "zombie_xml"))


def run(root, out, mask_path=DEFAULT_MASK):
    towns = json.loads((root / "docs" / "town-centers.json").read_text())
    spawn_template = (root / "cfgplayerspawnpoints.xml").read_text()
    mask = load_water_mask(mask_path)
    out.mkdir(parents=True, exist_ok=True)
    index, warnings = [], []
    for town in towns:
        r = build_town(town, spawn_template, mask)
        dest = out / r["slug"]
        dest.mkdir(exist_ok=True)
        # ⚠️ The bot swaps whole files by name; a stale cfgeventspawns.xml left in
        # a town dir is harmless to it but misleading to a human, so remove it.
        (dest / "cfgeventspawns.xml").unlink(missing_ok=True)
        for fname, key in FILES:
            (dest / fname).write_text(r[key])
            ok, detail = _xmllint_ok(dest / fname)
            if not ok:
                warnings.append(f"INVALID XML: {r['slug']}/{fname} :: {detail}")
        index.append({k: r[k] for k in ("name", "slug", "category", "center_x", "center_z", "spawn_radius", "spawn_points")})
    (out / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    print(f"Generated {len(index)} towns.")
    for w in warnings:
        print("  WARN:", w)
```

In `main()`, add `parser.add_argument("--mask", type=Path, default=DEFAULT_MASK)` and pass `args.mask` to `run`. Update the module docstring's first line to "Generate per-town KotH spawn points and animal/infected territories."

- [ ] **Step 4: Run the tests**

Run: `cd koth/locations/generator && python3 -m unittest test_generate -v`
Expected: all PASS.

- [ ] **Step 5: README.** Replace the "Inputs"/"Output" sections:
  - inputs: `docs/town-centers.json`, `cfgplayerspawnpoints.xml`, `water-mask.pbm` (built by `tools/build_water_mask.py`)
  - outputs: the four files per town plus `index.json`, with `{ name, slug, category, center_x, center_z, spawn_radius, spawn_points }`
  - add: "Run from the livonia root: `python3 koth/locations/generator/generate.py --out koth/locations`."

- [ ] **Step 6: Commit**

```bash
git add koth/locations/generator
git commit -m "koth generator: dry spawn rings from the water mask, hill-only infected, no event spawns"
```

### Task 3: Regenerate the towns, flatten the presets, and deploy the defaults

**Files:**
- Create: `docs/town-centers.json` (copied from `/Users/steveharmeyer/Development/the-bloodbag-and-painkiller-show/livonia/docs/town-centers.json`; `docs/**` is already excluded from the FTP deploy)
- Regenerate: `koth/locations/<slug>/*` and `koth/locations/index.json`
- Move: `koth/custom/*.json` → `custom/koth-*.json`
- Modify: `.github/workflows/deploy.yml`, `.gitignore`, `CLAUDE.md`

- [ ] **Step 1: Regenerate**

```bash
mkdir -p docs && cp /Users/steveharmeyer/Development/the-bloodbag-and-painkiller-show/livonia/docs/town-centers.json docs/
python3 koth/locations/generator/generate.py --out koth/locations
ls koth/locations/lembork
```

Expected:
- `Generated 31 towns.` with no `INVALID XML` warnings
- `lembork/` holds exactly `bear_territories.xml cfgplayerspawnpoints.xml wolf_territories.xml zombie_territories.xml`

A `ValueError: only N dry spawn candidates` names a town with too little dry ground. Report it to the user; do not paper over it.

- [ ] **Step 2: Re-run the review page on the new output and confirm zero red dots**

```bash
cd koth/locations/generator && python3 tools/review_page.py --root ../../.. --mask water-mask.pbm --out /tmp/koth-review.html && grep -o '— [0-9]* wet' /tmp/koth-review.html | sort | uniq -c
```

Expected: every line reads `— 0 wet`.

- [ ] **Step 3: Flatten the presets**

```bash
for f in koth/custom/*.json; do git mv "$f" "custom/koth-$(basename "$f")"; done
rmdir koth/custom
ls custom/koth-*.json | wc -l
```

Expected: `44`.

- [ ] **Step 4: Deploy step, ignore and guard.** In `.github/workflows/deploy.yml`, between "Checkout repository" and "Deploy changed files via FTP", insert:

```yaml
      # ⚠️ King of the Hill (clan-wars spec 2026-09-23): the bot restores these
      # four files from koth/default/ after every KotH session. They are COPIED
      # here, never committed, so an edit to the real file can never be undone
      # by a stale mirror. Do not remove this step while the bot's KOTH feature
      # exists — without it the bot refuses to open a KotH session at all.
      - name: Stage the KotH defaults
        run: |
          mkdir -p koth/default
          cp cfgplayerspawnpoints.xml koth/default/
          cp env/wolf_territories.xml env/bear_territories.xml env/zombie_territories.xml koth/default/

      # ⚠️ The repo's cfggameplay.json must always carry the DEFAULT loadout:
      # the bot swaps in the koth- presets for one session only.
      - name: Refuse a KotH preset in the default cfggameplay.json
        run: |
          if grep -q '"./custom/koth-' cfggameplay.json; then
            echo "cfggameplay.json names a koth- preset; the repo must hold the default loadout" >&2
            exit 1
          fi
```

Append `koth/default/` to `.gitignore`. That file has no stow markers here; if it ever does, put the line outside them.

- [ ] **Step 5: `CLAUDE.md`.** Add a "King of the Hill" section covering:
  - the clan-wars bot owns `cfgplayerspawnpoints.xml` and `env/{wolf,bear,zombie}_territories.xml` on the server, and reverts any hand-edit made on the server within two hours; edit them here and release
  - `custom/koth-*.json` are the KotH presets, and the prefix is reserved
  - `koth/default/` is generated by the deploy workflow, never committed
  - to regenerate: `python3 koth/locations/generator/generate.py --out koth/locations`, then re-run the review page

- [ ] **Step 6: Validate and commit**

```bash
for f in koth/locations/*/*.xml; do xmllint --noout "$f" || exit 1; done
for f in custom/koth-*.json; do python3 -m json.tool "$f" > /dev/null || { echo "$f"; exit 1; }; done
git add -A docs koth custom .github .gitignore CLAUDE.md
git commit -m "koth: regenerate 31 towns dry, flatten presets into custom/, stage defaults at deploy"
```

Do **not** push a Release. Push the branch and open a PR per the livonia repo's usual flow, and tell the user it is ready.

---

## Part B — this repo (`clan-wars`, branch `feature/king-of-the-hill`)

### Task 4: Domain rules for KotH

**Files:**
- Modify: `packages/domain/src/rules.ts` (append the KotH block)
- Create: `packages/domain/src/koth.ts`
- Create: `packages/domain/assets/koth-locations.json`, `packages/domain/assets/koth-presets.json`
- Modify: `packages/domain/src/index.ts` (add `export * from "./koth";`)
- Test: `packages/domain/test/koth.test.ts`, `packages/domain/test/koth-drift.test.ts`

**Interfaces:**
- Produces (from `@factions/domain`):
  - constants: `KOTH_ZONE_RADIUS_M`, `KOTH_REMINDER_LEAD_MS`, `KOTH_SCORE_SETTLE_MS`, `KOTH_PRESET_PREFIX`, `KOTH_AWARD_KEY`, `KOTH_INFECTED_EVENTS: readonly string[]`, `KOTH_WHOLE_FILES: readonly { dir: "root" | "env"; name: string }[]`
  - `type KothLocation = { name: string; slug: string; centreX: number; centreZ: number }`
  - `KOTH_LOCATIONS: readonly KothLocation[]`, `kothLocation(slug): KothLocation | null`
  - `KOTH_PRESET_FILES: readonly string[]` (the `./custom/koth-*.json` paths)
  - `type KothRowLike = { slotAt: Date; state: string; announcedAt: Date | null }`
  - `kothWanted<T extends KothRowLike>(slot: Date, rows: T[]): T | null`
  - `inKothZone(pos: { x: number; z: number } | null, centre: { x: number; z: number }): boolean`
  - `type KothKill = { killerDayzId: string; gamertag: string; occurredAt: Date }`
  - `type KothStanding = { dayzId: string; gamertag: string; kills: number; reachedAt: Date }`
  - `kothStandings(kills: KothKill[]): KothStanding[]`
  - `kothWinner(standings: KothStanding[], isLinked: (dayzId: string) => boolean): KothStanding | null`
  - `restoredPresets(current: string[], snapshot: string[] | null): string[] | null` (null = leave the file alone)
  - `isRestartSlot(d: Date): boolean`

- [ ] **Step 1: Assets.** Write `koth-locations.json` from the livonia index, renaming the fields:

```bash
python3 - <<'EOF'
import json
src = json.load(open("/Users/steveharmeyer/Development/dayz-clan-wars/livonia/koth/locations/index.json"))
out = [{"name": t["name"], "slug": t["slug"], "centreX": t["center_x"], "centreZ": t["center_z"]} for t in src]
json.dump(out, open("packages/domain/assets/koth-locations.json", "w"), indent=2, ensure_ascii=False)
import os
names = sorted(f for f in os.listdir("/Users/steveharmeyer/Development/dayz-clan-wars/livonia/custom") if f.startswith("koth-") and f.endswith(".json"))
json.dump([f"./custom/{n}" for n in names], open("packages/domain/assets/koth-presets.json", "w"), indent=2)
print(len(out), len(names))
EOF
```

Expected: `31 44`. This needs Task 3's livonia branch checked out.

- [ ] **Step 2: Failing tests** (`packages/domain/test/koth.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import {
  kothWanted, inKothZone, kothStandings, kothWinner, restoredPresets, isRestartSlot,
  KOTH_LOCATIONS, kothLocation, KOTH_PRESET_FILES, KOTH_PRESET_PREFIX, KOTH_ZONE_RADIUS_M,
} from "../src/index.js";

const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");

describe("kothWanted", () => {
  const row = (over: Partial<{ slotAt: Date; state: string; announcedAt: Date | null }> = {}) =>
    ({ slotAt: SLOT, state: "scheduled", announcedAt: at("2026-10-01T00:00:00Z"), ...over });
  it("returns the scheduled, announced row for this exact slot", () => {
    const r = row();
    expect(kothWanted(SLOT, [r])).toBe(r);
  });
  // ⚠️ Spec §5.1: a session is never opened without its announcement.
  it("ignores an unannounced row", () => expect(kothWanted(SLOT, [row({ announcedAt: null })])).toBeNull());
  // ⚠️ Spec §2.1: never late.
  it("ignores a row for an earlier slot", () => expect(kothWanted(SLOT, [row({ slotAt: at("2026-10-03T18:00:00Z") })])).toBeNull());
  it("ignores cancelled and failed rows", () => {
    expect(kothWanted(SLOT, [row({ state: "cancelled" }), row({ state: "failed" })])).toBeNull();
  });
});

describe("inKothZone", () => {
  const c = { x: 1000, z: 1000 };
  it("counts 499 and 500 m, not 501", () => {
    expect(inKothZone({ x: 1499, z: 1000 }, c)).toBe(true);
    expect(inKothZone({ x: 1000 + KOTH_ZONE_RADIUS_M, z: 1000 }, c)).toBe(true);
    expect(inKothZone({ x: 1501, z: 1000 }, c)).toBe(false);
  });
  it("a kill we cannot place is not on the hill", () => expect(inKothZone(null, c)).toBe(false));
});

describe("kothStandings", () => {
  const k = (id: string, iso: string) => ({ killerDayzId: id, gamertag: id.toUpperCase(), occurredAt: at(iso) });
  it("ranks by kills, then by who reached that count first", () => {
    const s = kothStandings([
      k("a", "2026-10-03T20:10:00Z"), k("b", "2026-10-03T20:05:00Z"),
      k("b", "2026-10-03T20:30:00Z"), k("a", "2026-10-03T20:20:00Z"),
      k("c", "2026-10-03T20:01:00Z"),
    ]);
    expect(s.map((r) => [r.dayzId, r.kills])).toEqual([["a", 2], ["b", 2], ["c", 1]]);
    expect(s[0]!.reachedAt).toEqual(at("2026-10-03T20:20:00Z"));
  });
  it("is order-independent", () => {
    const kills = [k("a", "2026-10-03T20:10:00Z"), k("b", "2026-10-03T20:05:00Z")];
    expect(kothStandings([...kills].reverse())).toEqual(kothStandings(kills));
  });
});

describe("kothWinner", () => {
  const s = [
    { dayzId: "u", gamertag: "U", kills: 9, reachedAt: SLOT },
    { dayzId: "l", gamertag: "L", kills: 4, reachedAt: SLOT },
  ];
  it("passes the prize down past an unlinked top killer", () => {
    expect(kothWinner(s, (id) => id === "l")?.dayzId).toBe("l");
  });
  it("is null when nobody is linked, or nobody scored", () => {
    expect(kothWinner(s, () => false)).toBeNull();
    expect(kothWinner([], () => true)).toBeNull();
  });
});

describe("restoredPresets", () => {
  const koth = [`./custom/${KOTH_PRESET_PREFIX}ak74-svd.json`];
  it("leaves a list with no koth- entry alone, so a user's own edit survives", () => {
    expect(restoredPresets(["./custom/loadout.json", "./custom/extra.json"], ["./custom/loadout.json"])).toBeNull();
  });
  it("puts the snapshot back over a KotH list", () => {
    expect(restoredPresets(koth, ["./custom/loadout.json"])).toEqual(["./custom/loadout.json"]);
  });
  it("with no snapshot, strips the koth- entries", () => {
    expect(restoredPresets([...koth, "./custom/loadout.json"], null)).toEqual(["./custom/loadout.json"]);
  });
  // ⚠️ An empty preset list is a server where fresh spawns get nothing; refuse.
  it("refuses to produce an empty list", () => expect(() => restoredPresets(koth, null)).toThrow(/empty/));
});

describe("catalogue", () => {
  it("has the 31 towns and 44 presets, all flat in ./custom/ with the prefix", () => {
    expect(KOTH_LOCATIONS).toHaveLength(31);
    expect(kothLocation("lembork")?.name).toBe("Lembork");
    expect(kothLocation("narnia")).toBeNull();
    expect(KOTH_PRESET_FILES).toHaveLength(44);
    for (const p of KOTH_PRESET_FILES) expect(p).toMatch(/^\.\/custom\/koth-[a-z0-9-]+\.json$/);
  });
  it("isRestartSlot is true on even UTC hours only", () => {
    expect(isRestartSlot(at("2026-10-03T20:00:00Z"))).toBe(true);
    expect(isRestartSlot(at("2026-10-03T21:00:00Z"))).toBe(false);
    expect(isRestartSlot(at("2026-10-03T20:00:01Z"))).toBe(false);
  });
});
```

Also `packages/domain/test/koth-drift.test.ts`, the cross-repo drift check. It skips when `../livonia` is absent, as in CI:

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KOTH_LOCATIONS, KOTH_PRESET_FILES, KOTH_INFECTED_EVENTS, KOTH_AWARD_KEY } from "../src/index.js";
import { awardsCatalogue } from "../src/awards-catalogue.js";

// ⚠️ Two statements of one fact (CLAUDE.md): the livonia repo holds the towns,
// the presets and the zone names; this package vendors them. Skipped where the
// sibling checkout is absent (CI), enforced wherever it is present.
const LIVONIA = join(__dirname, "../../../../livonia");
const present = existsSync(join(LIVONIA, "koth/locations/index.json"));

describe.skipIf(!present)("KotH catalogue vs the livonia repo", () => {
  it("towns match koth/locations/index.json", () => {
    const src = JSON.parse(readFileSync(join(LIVONIA, "koth/locations/index.json"), "utf8"));
    expect(KOTH_LOCATIONS.map((l) => [l.slug, l.centreX, l.centreZ]))
      .toEqual(src.map((t: { slug: string; center_x: number; center_z: number }) => [t.slug, t.center_x, t.center_z]));
  });
  it("presets match custom/koth-*.json", () => {
    const names = readdirSync(join(LIVONIA, "custom")).filter((f) => f.startsWith("koth-") && f.endsWith(".json")).sort();
    expect([...KOTH_PRESET_FILES].sort()).toEqual(names.map((n) => `./custom/${n}`));
  });
  // ⚠️ A zone named for an event the bot never switches on spawns nothing.
  it("every generated zombie zone names an event the bot switches on", () => {
    for (const l of KOTH_LOCATIONS) {
      const xml = readFileSync(join(LIVONIA, "koth/locations", l.slug, "zombie_territories.xml"), "utf8");
      for (const [, name] of xml.matchAll(/zone name="([^"]+)"/g)) expect(KOTH_INFECTED_EVENTS).toContain(name);
    }
  });
});

describe("KotH award", () => {
  it("names an award the catalogue has", () => expect(awardsCatalogue()[KOTH_AWARD_KEY]).toBeDefined());
});
```

- [ ] **Step 3: Run and see them fail**

Run: `cd packages/domain && npx vitest run test/koth.test.ts test/koth-drift.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 4: Implement.** Append to `rules.ts`:

```ts
// ─── King of the Hill (spec 2026-09-23-king-of-the-hill) ───────────────────
/** A kill scores if its VICTIM was this close to the hill's centre (2-D). */
export const KOTH_ZONE_RADIUS_M = 500;
export const KOTH_REMINDER_LEAD_MS = 30 * 60_000;
/** How long after the closing restart before scoring, for log lag. */
export const KOTH_SCORE_SETTLE_MS = 10 * 60_000;
/** ⚠️ Reserved: the restore arm treats any preset starting with this as KotH's. */
export const KOTH_PRESET_PREFIX = "koth-";
export const KOTH_AWARD_KEY = "plate-carrier";
/**
 * The events.xml infected events a KotH session switches on.
 * ⚠️ The livonia generator's ZOMBIE_ZONE_NAMES must be a subset — a zone with no
 * active event spawns nothing (koth-drift.test.ts).
 */
export const KOTH_INFECTED_EVENTS: readonly string[] = ["InfectedCity", "InfectedVillage", "InfectedArmy", "InfectedPolice", "InfectedMedic"];
/** The whole-file targets, by directory ("root" = the mission root, "env" = its env/). */
export const KOTH_WHOLE_FILES: readonly { dir: "root" | "env"; name: string }[] = [
  { dir: "root", name: "cfgplayerspawnpoints.xml" },
  { dir: "env", name: "wolf_territories.xml" },
  { dir: "env", name: "bear_territories.xml" },
  { dir: "env", name: "zombie_territories.xml" },
];
```

`packages/domain/src/koth.ts`:

```ts
import locations from "../assets/koth-locations.json";
import presets from "../assets/koth-presets.json";
import { KOTH_PRESET_PREFIX, KOTH_ZONE_RADIUS_M, RESTART_PERIOD_MS } from "./rules";
import { distance2d } from "./spacing";

export type KothLocation = { name: string; slug: string; centreX: number; centreZ: number };

/** Vendored from livonia/koth/locations/index.json; koth-drift.test.ts holds them together. */
export const KOTH_LOCATIONS: readonly KothLocation[] = locations as KothLocation[];
/** Vendored from livonia/custom/koth-*.json. */
export const KOTH_PRESET_FILES: readonly string[] = presets as string[];

export function kothLocation(slug: string): KothLocation | null {
  return KOTH_LOCATIONS.find((l) => l.slug === slug) ?? null;
}

/** Slots are aligned to the epoch in RESTART_PERIOD_MS steps (rules.ts). */
export function isRestartSlot(d: Date): boolean {
  return d.getTime() % RESTART_PERIOD_MS === 0;
}

export type KothRowLike = { slotAt: Date; state: string; announcedAt: Date | null };

/**
 * The event the session starting at `slot` belongs to, or null for default.
 * ⚠️ Exact slot only: a row whose slot has passed is never opened late (spec §2.1).
 * ⚠️ `announcedAt` is required: nobody finds an event they were not told about.
 */
export function kothWanted<T extends KothRowLike>(slot: Date, rows: T[]): T | null {
  return rows.find((r) => r.state === "scheduled" && r.announcedAt !== null && r.slotAt.getTime() === slot.getTime()) ?? null;
}

/** ⚠️ A missing position is never on the hill: a kill we cannot place does not score here. */
export function inKothZone(pos: { x: number; z: number } | null, centre: { x: number; z: number }): boolean {
  return pos !== null && distance2d(pos, centre) <= KOTH_ZONE_RADIUS_M;
}

export type KothKill = { killerDayzId: string; gamertag: string; occurredAt: Date };
export type KothStanding = { dayzId: string; gamertag: string; kills: number; reachedAt: Date };

/** Most kills first; on a tie, whoever reached that count first (spec §2.10). */
export function kothStandings(kills: KothKill[]): KothStanding[] {
  const sorted = [...kills].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const by = new Map<string, KothStanding>();
  for (const k of sorted) {
    const s = by.get(k.killerDayzId) ?? { dayzId: k.killerDayzId, gamertag: k.gamertag, kills: 0, reachedAt: k.occurredAt };
    s.kills += 1;
    s.reachedAt = k.occurredAt;
    by.set(k.killerDayzId, s);
  }
  return [...by.values()].sort((a, b) =>
    b.kills - a.kills || a.reachedAt.getTime() - b.reachedAt.getTime() || a.dayzId.localeCompare(b.dayzId));
}

/** The highest-ranked LINKED player — the prize needs a Discord account to land on. */
export function kothWinner(standings: KothStanding[], isLinked: (dayzId: string) => boolean): KothStanding | null {
  return standings.find((s) => isLinked(s.dayzId)) ?? null;
}

/**
 * What `spawnGearPresetFiles` should become outside a session, or null to leave it.
 * ⚠️ Null whenever the list holds no koth- entry: that is how a user's own later
 * edit to the default loadout survives every slot (spec §2.5).
 */
export function restoredPresets(current: string[], snapshot: string[] | null): string[] | null {
  const isKoth = (p: string) => p.includes(`/${KOTH_PRESET_PREFIX}`);
  if (!current.some(isKoth)) return null;
  const next = snapshot ?? current.filter((p) => !isKoth(p));
  if (next.length === 0) throw new Error("restoring spawnGearPresetFiles would leave it empty — refusing");
  return next;
}
```

`packages/domain/tsconfig.json` must already have `resolveJsonModule`, because `awards-catalogue.ts` imports JSON. If `tsc` complains, check that `include` covers `assets/*.json`, as it does for `awards.json`.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd packages/domain && npx vitest run test/koth.test.ts test/koth-drift.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): king of the hill rules, catalogue and scoring functions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: The `koth_events` table

**Files:**
- Modify: `packages/db/src/schema.ts` (add `kothEvents` after `bounties`)
- Create: `packages/db/migrations/0049_<generated>.sql` (+ meta)
- Test: `packages/db/test/koth-events-schema.test.ts`

**Interfaces:**
- Produces: `kothEvents` from `@factions/db`, with columns `id, serverId, slotAt, location, centreX, centreZ, state, scheduledByDiscordId, createdAt, announcedAt, remindedAt, livePostedAt, resultsPostedAt, cancelPostedAt, loadoutSnapshot (string[] | null), infectedSnapshot (Record<string, 0|1> | null), openedAt, restoredAt, results (KothResults | null), winnerDayzId, awardGrantId, detail`
- `export type KothState = "scheduled" | "live" | "awarded" | "no_winner" | "cancelled" | "failed"`
- `export type KothResults = { top: { dayzId: string; gamertag: string; kills: number }[]; topKiller: { dayzId: string; gamertag: string; kills: number } | null; winner: { dayzId: string; gamertag: string; kills: number } | null; droppedNoPosition: number }`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, runMigrations, requireTestDatabaseUrl, kothEvents, servers, type Database } from "../src/index.js";

const URL = requireTestDatabaseUrl();
const SLOT = new Date("2026-10-03T20:00:00Z");

describe("koth_events", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table koth_events, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });
  const row = (over: Record<string, unknown> = {}) => ({
    serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
    state: "scheduled" as const, scheduledByDiscordId: "1", ...over,
  });

  // ⚠️ Spec §2.12: one event at a time — the index is the guard, not the command.
  it("allows only one scheduled-or-live event per server", async () => {
    await db.insert(kothEvents).values(row());
    await expect(db.insert(kothEvents).values(row({ slotAt: new Date("2026-10-04T20:00:00Z") })))
      .rejects.toThrow(/koth_events_one_open/u);
    await db.insert(kothEvents).values(row({ slotAt: new Date("2026-10-05T20:00:00Z"), state: "cancelled" }));
  });
  it("refuses an unknown state", async () => {
    await expect(db.insert(kothEvents).values(row({ state: "late" as never }))).rejects.toThrow(/koth_events_state_valid/u);
  });
  it("ties award_grant_id to the awarded state", async () => {
    await expect(db.insert(kothEvents).values(row({ state: "awarded" }))).rejects.toThrow(/koth_events_awarded_has_grant/u);
  });
});
```

- [ ] **Step 2: Run it to fail**

Run: `cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/koth-events-schema.test.ts`
Expected: FAIL (`kothEvents` is not exported).

- [ ] **Step 3: Schema** (after `bounties` in `schema.ts`, reusing its imports)

```ts
export type KothState = "scheduled" | "live" | "awarded" | "no_winner" | "cancelled" | "failed";
export type KothResultRow = { dayzId: string; gamertag: string; kills: number };
export type KothResults = { top: KothResultRow[]; topKiller: KothResultRow | null; winner: KothResultRow | null; droppedNoPosition: number };

/**
 * One King of the Hill session (spec 2026-09-23-king-of-the-hill).
 *
 * ⚠️ The two snapshots are what the restore puts back, never a hard-coded
 * default: a user's later edit to the loadout list or to an Infected event must
 * survive (spec §2.5). Each is written only from a file holding no KotH state.
 *
 * ⚠️ `results` is frozen when written; nothing re-scores an awarded event,
 * including `rebuild:kills`, which renumbers `kills`.
 *
 * ⚠️ Lock order: `koth_events` immediately before `award_grants`.
 */
export const kothEvents = pgTable("koth_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  slotAt: timestamp("slot_at", { withTimezone: true }).notNull(),
  location: text("location").notNull(),
  centreX: numeric("centre_x", { precision: 12, scale: 2 }).notNull(),
  centreZ: numeric("centre_z", { precision: 12, scale: 2 }).notNull(),
  state: text("state").$type<KothState>().notNull(),
  scheduledByDiscordId: text("scheduled_by_discord_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** ⚠️ A session is never opened without it. */
  announcedAt: timestamp("announced_at", { withTimezone: true }),
  remindedAt: timestamp("reminded_at", { withTimezone: true }),
  livePostedAt: timestamp("live_posted_at", { withTimezone: true }),
  resultsPostedAt: timestamp("results_posted_at", { withTimezone: true }),
  cancelPostedAt: timestamp("cancel_posted_at", { withTimezone: true }),
  loadoutSnapshot: jsonb("loadout_snapshot").$type<string[]>(),
  infectedSnapshot: jsonb("infected_snapshot").$type<Record<string, 0 | 1>>(),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  restoredAt: timestamp("restored_at", { withTimezone: true }),
  results: jsonb("results").$type<KothResults>(),
  winnerDayzId: text("winner_dayz_id"),
  awardGrantId: bigint("award_grant_id", { mode: "number" }).references(() => awardGrants.id, { onDelete: "set null" }),
  detail: jsonb("detail").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
}, (t) => ({
  stateValid: check("koth_events_state_valid", sql`${t.state} IN ('scheduled','live','awarded','no_winner','cancelled','failed')`),
  awardedHasGrant: check("koth_events_awarded_has_grant", sql`(${t.state} <> 'awarded') OR (${t.awardGrantId} IS NOT NULL)`),
  oneOpen: uniqueIndex("koth_events_one_open").on(t.serverId).where(sql`${t.state} IN ('scheduled','live')`),
  oneSlot: uniqueIndex("koth_events_slot_uq").on(t.serverId, t.slotAt),
}));
```

The spec says `award_grant_id` is non-null *iff* awarded. The CHECK only enforces the "awarded ⇒ grant" half, because `ON DELETE set null` could otherwise make a grant deletion fail the CHECK.

- [ ] **Step 4: Generate and read the migration**

Run: `cd packages/db && npx drizzle-kit generate`
Then **read** the new `migrations/0049_*.sql`. It must contain only `CREATE TABLE "koth_events"`, its FKs, the two CHECKs and the two indexes. If it touches any other table, stop: the schema has unrelated drift, and that is not this task's to ship.

- [ ] **Step 5: Run the test**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/koth-events-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): koth_events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Splice helpers for presets and infected

**Files:**
- Modify: `apps/bot/src/cfggameplay.ts` (add two functions)
- Modify: `apps/bot/src/events-xml.ts` (add `readEventActive`)
- Test: `apps/bot/test/cfggameplay.test.ts`, `apps/bot/test/events-xml.test.ts` (append)

**Interfaces:**
- Produces:
  - `readSpawnGearPresets(json: string): string[]` (throws if absent, or not a string array)
  - `setSpawnGearPresets(json: string, wanted: string[]): { json: string; changed: boolean }`
  - `readEventActive(xml: string, eventName: string): ActiveFlag` (throws on missing, duplicate, or no `<active>`)

- [ ] **Step 1: Failing tests.** Append to `apps/bot/test/cfggameplay.test.ts`. It already reads `fixtures/cfggameplay.json`; if that fixture lacks `PlayerData.spawnGearPresetFiles`, add `"spawnGearPresetFiles": [\n\t\t\t"./custom/loadout.json"\n\t\t],` under `PlayerData`, as in the live file.

```ts
describe("spawnGearPresetFiles", () => {
  const KOTH = ["./custom/koth-ak74-svd.json", "./custom/koth-fal-m14.json"];
  it("reads the list", () => expect(readSpawnGearPresets(GAMEPLAY)).toEqual(["./custom/loadout.json"]));
  it("swaps the list and leaves every other byte alone", () => {
    const r = setSpawnGearPresets(GAMEPLAY, KOTH);
    expect(r.changed).toBe(true);
    expect(readSpawnGearPresets(r.json)).toEqual(KOTH);
    const back = setSpawnGearPresets(r.json, ["./custom/loadout.json"]);
    expect(back.json).toBe(GAMEPLAY);
  });
  it("is a no-op when already wanted", () => {
    expect(setSpawnGearPresets(GAMEPLAY, ["./custom/loadout.json"])).toEqual({ json: GAMEPLAY, changed: false });
  });
  // ⚠️ An empty list is a server whose fresh spawns get nothing.
  it("refuses an empty list", () => expect(() => setSpawnGearPresets(GAMEPLAY, [])).toThrow(/empty/));
  it("refuses a file that does not parse", () => expect(() => setSpawnGearPresets("{", KOTH)).toThrow(/did not parse/));
});
```

Add to the imports: `readSpawnGearPresets, setSpawnGearPresets`.

Append to `apps/bot/test/events-xml.test.ts`, using that file's existing XML fixture or constant. It must contain an event with `<active>`; `VehicleTruck01` is used there already, so reuse it:

```ts
describe("readEventActive", () => {
  it("reads the live value, ignoring a commented-out copy", () => {
    const xml = `<events><!-- <event name="X"><active>1</active></event> --><event name="X"><active>0</active></event></events>`;
    expect(readEventActive(xml, "X")).toBe(0);
  });
  it("throws on a missing event", () => expect(() => readEventActive("<events/>", "X")).toThrow(/no <event name="X">/));
});
```

- [ ] **Step 2: Run to fail**

Run: `cd apps/bot && npx vitest run test/cfggameplay.test.ts test/events-xml.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement.** In `cfggameplay.ts`, append:

```ts
/** The array body, bounded by its own brackets. Textual, like SPAWNERS_RE. */
const PRESETS_RE = /("spawnGearPresetFiles"\s*:\s*\[)([^\]]*)(\])/g;

/** The parsed `PlayerData.spawnGearPresetFiles` — the authority, never the regex. */
export function readSpawnGearPresets(json: string): string[] {
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch (err) {
    throw new Error(`cfggameplay.json: input did not parse — refusing to read it (${(err as Error).message})`);
  }
  const list = (input as { PlayerData?: { spawnGearPresetFiles?: unknown } })?.PlayerData?.spawnGearPresetFiles;
  if (!Array.isArray(list) || list.some((e) => typeof e !== "string")) {
    throw new Error("cfggameplay.json: PlayerData.spawnGearPresetFiles is missing or is not an array of strings");
  }
  return list as string[];
}

/**
 * Replace `PlayerData.spawnGearPresetFiles` wholesale (King of the Hill, spec §2.3).
 *
 * ⚠️ A targeted splice of this one array, for `setBaseDamageDisabled`'s reasons:
 * every byte outside the brackets comes back identical, and a file this function
 * breaks is a server that does not boot. So it refuses rather than guesses, and it
 * reads the result back before returning it.
 *
 * ⚠️ Refuses an empty list: fresh spawns would get no gear at all.
 */
export function setSpawnGearPresets(json: string, wanted: string[]): { json: string; changed: boolean } {
  if (wanted.length === 0) throw new Error("cfggameplay.json: refusing to write an empty spawnGearPresetFiles");
  const current = readSpawnGearPresets(json);
  if (current.length === wanted.length && current.every((p, i) => p === wanted[i])) return { json, changed: false };

  const matches = [...json.matchAll(PRESETS_RE)];
  if (matches.length !== 1) {
    throw new Error(`cfggameplay.json: "spawnGearPresetFiles" appears ${matches.length}× — refusing to guess which one the server reads`);
  }
  const m = matches[0]!;
  const [, head, body, tail] = m as unknown as [string, string, string, string];
  const lines = body.split("\n");
  const indent = (lines.find(isEntry) ?? '\t\t\t"').match(/^\s*/)![0];
  const closeIndent = lines[lines.length - 1] ?? "";
  const rebuilt = ["", ...wanted.map((p, i) => `${indent}${JSON.stringify(p)}${i < wanted.length - 1 ? "," : ""}`), closeIndent].join("\n");
  const next = json.slice(0, m.index!) + head + rebuilt + tail + json.slice(m.index! + m[0].length);

  // ⚠️ Guard 2: parsing proves loadable, reading back proves the edit landed on
  // the list the server reads.
  const got = readSpawnGearPresets(next);
  if (got.length !== wanted.length || got.some((p, i) => p !== wanted[i])) {
    throw new Error(`cfggameplay.json: after the edit spawnGearPresetFiles is ${JSON.stringify(got)}, not ${JSON.stringify(wanted)}`);
  }
  return { json: next, changed: true };
}
```

The round-trip test (`back.json` equals `GAMEPLAY`) holds only if the fixture's array is laid out as `[\n\t\t\t"./custom/loadout.json"\n\t\t]`. That is the live layout, which `rebuilt` reproduces (a leading newline, the entries, then the closing indent line). If the test fails on whitespace, fix `rebuilt`, not the test.

In `events-xml.ts`, export a reader that reuses `maskComments`/`escapeRe`:

```ts
/**
 * The live `<active>` of one event — for the King of the Hill snapshot (spec §2.5).
 * Same refusals as `setEventActive`, for the same reason: a guessed value would
 * be restored later as if it were the operator's.
 */
export function readEventActive(xml: string, eventName: string): ActiveFlag {
  const masked = maskComments(xml);
  const block = new RegExp(`<event\\s+name="${escapeRe(eventName)}"[^>]*>([\\s\\S]*?)</event>`, "g");
  const matches = [...masked.matchAll(block)];
  if (matches.length === 0) throw new Error(`events.xml: no <event name="${eventName}"> block found`);
  if (matches.length > 1) throw new Error(`events.xml: <event name="${eventName}"> appears more than once (${matches.length}×) outside comments`);
  const am = /<active>\s*(\d+)\s*<\/active>/.exec(matches[0]![1]!);
  if (!am) throw new Error(`events.xml: <event name="${eventName}"> has no <active> element`);
  return (Number(am[1]) === 1 ? 1 : 0) as ActiveFlag;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/bot && npx vitest run test/cfggameplay.test.ts test/events-xml.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/cfggameplay.ts apps/bot/src/events-xml.ts apps/bot/test/cfggameplay.test.ts apps/bot/test/events-xml.test.ts apps/bot/test/fixtures/cfggameplay.json
git commit -m "feat(bot): splices for the spawn preset list and reading an event's active flag

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Nitrado directory listing

**Files:**
- Modify: `packages/nitrado/src/client.ts` (add `listFiles`)
- Test: that package's client test file (find it with `ls packages/nitrado/test`), mocking `fetchFn` the way its existing `statFile` test does

**Interfaces:**
- Produces: `NitradoClient.listFiles(remoteDir: string): Promise<string[]>`, returning file names only. A missing directory returns `[]`.

- [ ] **Step 1: Failing test.** Copy the existing `statFile` test's setup, which mocks `getJson`'s fetch for `file_server/list`, and assert:

```ts
it("listFiles returns the file names in a directory, and [] for a missing one", async () => {
  // listing: { data: { entries: [{ name: "koth-a.json", type: "file" }, { name: "sub", type: "dir" }] } }
  expect(await client.listFiles("/m/custom")).toEqual(["koth-a.json"]);
  // listing with no entries
  expect(await client.listFiles("/m/nope")).toEqual([]);
});
```

- [ ] **Step 2: Run to fail.** `cd packages/nitrado && npx vitest run`. Expected: FAIL.

- [ ] **Step 3: Implement** (beside `statFile`)

```ts
  /**
   * The file names in one directory (King of the Hill checks its 44 presets are
   * on the server in one call rather than 44 `statFile`s).
   * ⚠️ A missing directory is `[]`, the same "no entry" reading `statFile` gives.
   */
  async listFiles(remoteDir: string): Promise<string[]> {
    const listing = await this.getJson(
      `/services/${this.serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(remoteDir)}`,
    );
    const entries: any[] = listing?.data?.entries ?? [];
    return entries.filter((e) => e?.type === "file" && typeof e?.name === "string").map((e) => e.name as string);
  }
```

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "feat(nitrado): listFiles" …` (add the Co-Authored-By trailer).

### Task 8: `applyEvents` and `applyGameplay` carry KotH's splices

**Files:**
- Modify: `apps/bot/src/restart-tick.ts`
- Test: `apps/bot/test/restart-tick.test.ts` (append a `describe("applyEvents / applyGameplay with KotH")`)

**Interfaces:**
- Consumes: `setSpawnGearPresets`, `readSpawnGearPresets` (Task 6), `setEventActive`
- Produces:
  - `RestartTarget` gains `listFiles(dir: string): Promise<string[]>`
  - `export type EventsEdits = { truckWipe?: TruckWipe; infected?: Record<string, 0 | 1> }`
  - `export type EventsResult = { uploaded: boolean; truckWipeError?: Error; infectedError?: Error }`
  - `export async function applyEvents(nitrado: RestartTarget, slot: Date, edits: EventsEdits): Promise<EventsResult>`
  - `GameplayEdits.koth?: { presets: string[] }`, `GameplayResult.kothError?: Error`, `GameplayResult.koth?: { changed: boolean }`

- [ ] **Step 1: Failing tests** (reuse `fakeGameplayHost`, generalised so it serves several paths)

```ts
/** A Nitrado serving several files by path; records uploads by `${dir}/${name}`. */
function fakeFiles(files: Record<string, string>) {
  const store = new Map(Object.entries(files));
  const downloadFile = vi.fn(async (p: string) => {
    const v = store.get(p);
    if (v === undefined) throw new Error(`Nitrado download 404 ${p}`);
    return v;
  });
  const uploadFile = vi.fn(async (dir: string, name: string, body: string) => { store.set(`${dir}/${name}`, body); });
  const target = {
    status: vi.fn(async () => "started"), restart: vi.fn(async () => {}),
    missionDbDir: vi.fn(async () => "/mission/db"), missionRootDir: vi.fn(async () => "/mission"),
    listFiles: vi.fn(async (dir: string) => [...store.keys()].filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)).filter((n) => !n.includes("/"))),
    downloadFile, uploadFile,
  } as unknown as RestartTarget;
  return { target, downloadFile, uploadFile, read: (p: string) => store.get(p) };
}

const EVENTS = `<events>
<event name="VehicleTruck01"><active>1</active></event>
<event name="InfectedCity"><active>0</active></event>
<event name="InfectedVillage"><active>0</active></event>
</events>`;

describe("applyEvents", () => {
  // ⚠️ The reason applyEvents exists: two features, ONE round trip. Two
  // download/upload pairs silently lose whichever edit uploads first.
  it("does the truck wipe and the infected splice in one download and one upload", async () => {
    const h = fakeFiles({ "/mission/db/events.xml": EVENTS });
    const r = await applyEvents(h.target, at("2026-09-12T08:00:00Z"), {
      truckWipe: { events: ["VehicleTruck01"], offHour: 8, onHour: 10, rotation: false },
      infected: { InfectedCity: 1, InfectedVillage: 1 },
    });
    expect(r.uploaded).toBe(true);
    expect(h.downloadFile).toHaveBeenCalledTimes(1);
    expect(h.uploadFile).toHaveBeenCalledTimes(1);
    const out = h.read("/mission/db/events.xml")!;
    expect(out).toContain(`<event name="VehicleTruck01"><active>0</active>`);
    expect(out).toContain(`<event name="InfectedCity"><active>1</active>`);
  });
  it("a refused infected splice does not cost the truck wipe", async () => {
    const h = fakeFiles({ "/mission/db/events.xml": EVENTS });
    const r = await applyEvents(h.target, at("2026-09-12T08:00:00Z"), {
      truckWipe: { events: ["VehicleTruck01"], offHour: 8, onHour: 10, rotation: false },
      infected: { InfectedNope: 1 },
    });
    expect(r.infectedError?.message).toMatch(/InfectedNope/);
    expect(h.read("/mission/db/events.xml")).toContain(`<event name="VehicleTruck01"><active>0</active>`);
  });
  it("uploads nothing when nothing changes", async () => {
    const h = fakeFiles({ "/mission/db/events.xml": EVENTS });
    const r = await applyEvents(h.target, at("2026-09-12T12:00:00Z"), { infected: { InfectedCity: 0 } });
    expect(r.uploaded).toBe(false);
    expect(h.uploadFile).not.toHaveBeenCalled();
  });
});

describe("applyGameplay with KotH", () => {
  it("swaps the preset list in the same single round trip as the raid window", async () => {
    const h = fakeGameplayHost();
    const r = await applyGameplay(h.target, at("2026-09-12T14:00:00Z"), {
      raidWindow: { skips: [] }, koth: { presets: ["./custom/koth-ak74-svd.json"] },
    });
    expect(r.koth?.changed).toBe(true);
    expect(h.downloadFile).toHaveBeenCalledTimes(1);
    expect(h.uploadFile).toHaveBeenCalledTimes(1);
    expect(h.read()).toContain('"./custom/koth-ak74-svd.json"');
  });
});
```

Add `applyEvents` to the test's import from `../src/restart-tick.js`. The existing `fakeNitrado`/`fakeGameplayHost` casts need no `listFiles`, because the cast is `as unknown as RestartTarget`.

- [ ] **Step 2: Run to fail.** `cd apps/bot && npx vitest run test/restart-tick.test.ts`. Expected: FAIL (`applyEvents` is not exported).

- [ ] **Step 3: Implement.** In `restart-tick.ts`:
  1. Add `listFiles(dir: string): Promise<string[]>;` to `RestartTarget`, with the comment `/** Only reached for King of the Hill: one listing of custom/ proves every preset is on the server. */`. `NitradoClient` already satisfies it after Task 7.
  2. Replace `applyTruckWipe` with `applyEvents`:

```ts
export type EventsEdits = {
  truckWipe?: TruckWipe;
  /** King of the Hill's wanted `<active>` per infected event, or undefined to leave them. */
  infected?: Record<string, 0 | 1>;
};
export type EventsResult = { uploaded: boolean; truckWipeError?: Error; infectedError?: Error };

/**
 * Bring one server's events.xml to the state `slot` wants — the truck wipe, the
 * weekly rotation and King of the Hill's infected — immediately before its restart.
 *
 * ⚠️ ONE download and ONE upload for every feature, exactly as `applyGameplay` is
 * for cfggameplay.json: two round trips silently lose whichever edit uploads first.
 *
 * ⚠️ Level-triggered — see `truckWipeActive`. A file already in the wanted state
 * is never re-uploaded.
 *
 * ⚠️ Each feature's splices run in their own try/catch and are RETURNED, never
 * thrown: KotH naming a missing event must not cost the truck wipe, or vice versa.
 * A feature whose splice throws contributes NONE of its edits (`let next = xml`
 * then commit), so a half-applied infected set never uploads.
 */
export async function applyEvents(nitrado: RestartTarget, slot: Date, edits: EventsEdits): Promise<EventsResult> {
  const dir = await nitrado.missionDbDir();
  const original = await nitrado.downloadFile(`${dir}/${EVENTS_FILE}`);
  let xml = original;
  const out: Omit<EventsResult, "uploaded"> = {};

  const wipe = edits.truckWipe;
  if (wipe && (wipe.events.length > 0 || wipe.rotation)) {
    try {
      let next = xml;
      const daily = truckWipeActive(slot, wipe.offHour, wipe.onHour);
      for (const name of wipe.events) next = setEventActive(next, name, daily).xml;
      // ⚠️ ALL five every slot, not just this week's. A bot down across a Monday 10:00
      // leaves that week's vehicle at 0, and by the time it returns the rotation has moved
      // on — nothing else would ever put it back.
      if (wipe.rotation) {
        for (const v of WEEKLY_WIPE_VEHICLES) {
          next = setEventActive(next, v.event, rotationActiveFor(slot, wipe.offHour, wipe.onHour, v.event)).xml;
        }
      }
      xml = next;
    } catch (err) {
      out.truckWipeError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (edits.infected) {
    try {
      let next = xml;
      for (const [name, active] of Object.entries(edits.infected)) next = setEventActive(next, name, active).xml;
      xml = next;
    } catch (err) {
      out.infectedError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const uploaded = xml !== original;
  if (uploaded) await nitrado.uploadFile(dir, EVENTS_FILE, xml);
  return { ...out, uploaded };
}
```

  3. In `applyGameplay`:
     - change the early return to `if (!edits.raidWindow && !edits.airdrop && !edits.koth) return {};`
     - add `koth?: { presets: string[] }` to `GameplayEdits`, and `koth?: { changed: boolean }; kothError?: Error;` to `GameplayResult`
     - after the airdrop block, add:

```ts
  if (edits.koth) {
    try {
      const r = setSpawnGearPresets(json, edits.koth.presets);
      json = r.json;
      out.koth = { changed: r.changed };
    } catch (err) {
      out.kothError = err instanceof Error ? err : new Error(String(err));
    }
  }
```

  4. In `restartTick`, replace the truck-wipe call site with:

```ts
      if (opts.truckWipe && (opts.truckWipe.events.length > 0 || opts.truckWipe.rotation)) {
        try {
          const r = await applyEvents(nitrado, slot.start, { truckWipe: opts.truckWipe });
          if (r.truckWipeError) console.error(`restart: server ${s.id} truck wipe refused for slot ${slot.start.toISOString()} — restarting anyway`, r.truckWipeError);
          if (r.uploaded) console.log(`restart: server ${s.id} wrote events.xml for ${slot.start.toISOString()}`);
        } catch (err) {
          console.error(`restart: server ${s.id} truck wipe failed for slot ${slot.start.toISOString()} — restarting anyway`, err);
        }
      }
```

  (Task 9 moves KotH's `infected` into this same call.) Import `setSpawnGearPresets` from `./cfggameplay.js`.

- [ ] **Step 4: Run the whole restart-tick suite.** The existing truck-wipe tests must still pass unchanged.

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/restart-tick.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/restart-tick.ts apps/bot/test/restart-tick.test.ts
git commit -m "refactor(bot): applyEvents — one events.xml round trip for the truck wipe and KotH

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: KotH convergence in the restart tick

**Files:**
- Create: `apps/bot/src/koth-converge.ts`
- Modify: `apps/bot/src/restart-tick.ts` (wire it in, and `restartMessage`)
- Test: `apps/bot/test/koth-converge.test.ts`

**Interfaces:**
- Consumes: `kothWanted`, `restoredPresets`, `KOTH_*` (Task 4); `kothEvents` (Task 5); `readSpawnGearPresets`, `readEventActive` (Task 6); `applyEvents`/`applyGameplay` (Task 8)
- Produces:
  - `export type KothPlan = { opening: KothRow | null; presets: string[] | null; infected: Record<string, 0 | 1> | null; infectedRestoreRowId: number | null; files: { dir: string; name: string; content: string }[]; failure: string | null }`
  - `export async function planKoth(db: Database, nitrado: RestartTarget, serverId: number, slot: Date): Promise<KothPlan | null>`: null when no KotH row has ever existed (the restore arm's gate)
  - `export async function convergeKothFiles(nitrado: RestartTarget, files: KothPlan["files"]): Promise<{ uploaded: number; errors: string[] }>`
  - `restartMessage(airdrop: string | null, koth?: string | null): string`

**Behaviour** (spec §5):

**Opening** (`kothWanted` returns a row):
1. List `<root>/custom` and require every `KOTH_PRESET_FILES` basename.
2. Download the four `<root>/koth/locations/<slug>/<name>` sources and the four `<root>/koth/default/<name>` files; each must be non-empty.
3. Download `cfggameplay.json` and `events.xml` read-only for the snapshots. Write `loadoutSnapshot` (if null and the current list has no `koth-` entry) and `infectedSnapshot` (if null) to the row **before** returning a plan.
4. On any failure: `failure` is set, the row goes `failed` with `detail.failure`, and the plan is otherwise the **restore** plan, so a half-open is reversed.

**Restore** (no opening):
- `presets` = `restoredPresets(current, latestSnapshot)`
- `infected` = the snapshot of the latest row with `infectedSnapshot` set and `restoredAt` null
- `files` = each default whose target differs, skipping a missing default with `detail.restoreError` on the latest row

- [ ] **Step 1: Failing tests** (`apps/bot/test/koth-converge.test.ts`)

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, kothEvents, servers, type Database } from "@factions/db";
import { KOTH_PRESET_FILES, KOTH_WHOLE_FILES } from "@factions/domain";
import { eq, sql } from "drizzle-orm";
import { planKoth, convergeKothFiles } from "../src/koth-converge.js";
import type { RestartTarget } from "../src/restart-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");
const NEXT = at("2026-10-03T22:00:00Z");

const GAMEPLAY = `{\n\t"PlayerData": {\n\t\t"spawnGearPresetFiles": [\n\t\t\t"./custom/loadout.json"\n\t\t]\n\t}\n}`;
const EVENTS = `<events>${["InfectedCity", "InfectedVillage", "InfectedArmy", "InfectedPolice", "InfectedMedic"]
  .map((n, i) => `<event name="${n}"><active>${i === 0 ? 1 : 0}</active></event>`).join("")}</events>`;

function mission(over: Record<string, string | undefined> = {}) {
  const files: Record<string, string> = {
    "/m/cfggameplay.json": GAMEPLAY,
    "/m/db/events.xml": EVENTS,
    ...Object.fromEntries(KOTH_PRESET_FILES.map((p) => [`/m/custom/${p.slice("./custom/".length)}`, "{}"])),
  };
  for (const f of KOTH_WHOLE_FILES) {
    const live = f.dir === "root" ? `/m/${f.name}` : `/m/env/${f.name}`;
    files[live] = `default ${f.name}`;
    files[`/m/koth/default/${f.name}`] = `default ${f.name}`;
    files[`/m/koth/locations/lembork/${f.name}`] = `lembork ${f.name}`;
  }
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete files[k]; else files[k] = v; }
  const store = new Map(Object.entries(files));
  const uploadFile = vi.fn(async (dir: string, name: string, body: string) => { store.set(`${dir}/${name}`, body); });
  const target = {
    missionRootDir: async () => "/m", missionDbDir: async () => "/m/db",
    downloadFile: async (p: string) => { const v = store.get(p); if (v === undefined) throw new Error(`404 ${p}`); return v; },
    listFiles: async (d: string) => [...store.keys()].filter((k) => k.startsWith(d + "/") && !k.slice(d.length + 1).includes("/")).map((k) => k.slice(d.length + 1)),
    uploadFile,
  } as unknown as RestartTarget;
  return { target, uploadFile, read: (p: string) => store.get(p) };
}

describe("planKoth", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table koth_events, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
  });
  const schedule = (over: Record<string, unknown> = {}) => db.insert(kothEvents).values({
    serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635", state: "scheduled",
    scheduledByDiscordId: "1", announcedAt: at("2026-10-01T00:00:00Z"), ...over,
  }).returning().then((r) => r[0]!);

  it("is null when no KotH event has ever existed — nothing to open or restore", async () => {
    expect(await planKoth(db, mission().target, serverId, SLOT)).toBeNull();
  });

  it("opens: the presets, all five infected on, the four town files, and snapshots first", async () => {
    const row = await schedule();
    const p = (await planKoth(db, mission().target, serverId, SLOT))!;
    expect(p.failure).toBeNull();
    expect(p.opening?.id).toBe(row.id);
    expect(p.presets).toEqual([...KOTH_PRESET_FILES]);
    expect(p.infected).toEqual({ InfectedCity: 1, InfectedVillage: 1, InfectedArmy: 1, InfectedPolice: 1, InfectedMedic: 1 });
    expect(p.files.map((f) => f.content)).toEqual(KOTH_WHOLE_FILES.map((f) => `lembork ${f.name}`));
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.loadoutSnapshot).toEqual(["./custom/loadout.json"]);
    expect(saved!.infectedSnapshot).toEqual({ InfectedCity: 1, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 });
  });

  // ⚠️ Spec §5.1: a KotH we could not reverse is worse than one that never starts.
  it("missing default refuses: failed, restore plan, nothing KotH in it", async () => {
    const row = await schedule();
    const m = mission({ "/m/koth/default/zombie_territories.xml": undefined });
    const p = (await planKoth(db, m.target, serverId, SLOT))!;
    expect(p.failure).toMatch(/koth\/default\/zombie_territories\.xml/);
    expect(p.opening).toBeNull();
    expect(p.presets).toBeNull();
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("failed");
  });

  it("a missing preset on the server refuses too", async () => {
    await schedule();
    const p = (await planKoth(db, mission({ [`/m/custom/${KOTH_PRESET_FILES[0]!.slice(9)}`]: undefined }).target, serverId, SLOT))!;
    expect(p.failure).toMatch(/preset/);
  });

  // ⚠️ Spec §2.5: a retried open must never snapshot KotH's own state as the default.
  it("never snapshots a list that already holds koth- entries", async () => {
    const row = await schedule();
    const kothGameplay = GAMEPLAY.replace("./custom/loadout.json", "./custom/koth-ak74-svd.json");
    await planKoth(db, mission({ "/m/cfggameplay.json": kothGameplay }).target, serverId, SLOT);
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.loadoutSnapshot).toBeNull();
  });

  it("restores at the next slot: snapshot presets, snapshot infected, default files", async () => {
    await schedule({
      state: "live", openedAt: SLOT, loadoutSnapshot: ["./custom/loadout.json"],
      infectedSnapshot: { InfectedCity: 1, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 },
    });
    const live = Object.fromEntries(KOTH_WHOLE_FILES.map((f) => [f.dir === "root" ? `/m/${f.name}` : `/m/env/${f.name}`, `lembork ${f.name}`]));
    const m = mission({ ...live, "/m/cfggameplay.json": GAMEPLAY.replace("./custom/loadout.json", "./custom/koth-ak74-svd.json") });
    const p = (await planKoth(db, m.target, serverId, NEXT))!;
    expect(p.opening).toBeNull();
    expect(p.presets).toEqual(["./custom/loadout.json"]);
    expect(p.infected).toEqual({ InfectedCity: 1, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 });
    expect(p.files.map((f) => f.content)).toEqual(KOTH_WHOLE_FILES.map((f) => `default ${f.name}`));
  });

  // ⚠️ Review focus #1: the operator's own later edits must survive.
  it("a later user edit survives: no koth- entry, restored_at set → nothing touched", async () => {
    await schedule({ state: "no_winner", openedAt: SLOT, restoredAt: NEXT, loadoutSnapshot: ["./custom/loadout.json"],
      infectedSnapshot: { InfectedCity: 0, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 } });
    const edited = GAMEPLAY.replace('"./custom/loadout.json"', '"./custom/loadout.json",\n\t\t\t"./custom/extra.json"');
    const p = (await planKoth(db, mission({ "/m/cfggameplay.json": edited }).target, serverId, at("2026-10-04T10:00:00Z")))!;
    expect(p.presets).toBeNull();
    expect(p.infected).toBeNull();
    expect(p.files).toEqual([]);
  });
});

describe("convergeKothFiles", () => {
  it("uploads only the files that differ, to root or env", async () => {
    const m = mission();
    const r = await convergeKothFiles(m.target, [
      { dir: "/m", name: "cfgplayerspawnpoints.xml", content: "lembork cfgplayerspawnpoints.xml" },
      { dir: "/m/env", name: "wolf_territories.xml", content: "default wolf_territories.xml" },
    ]);
    expect(r.uploaded).toBe(1);
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe("lembork cfgplayerspawnpoints.xml");
  });
});
```

- [ ] **Step 2: Run to fail.** `cd apps/bot && TEST_DATABASE_URL=… npx vitest run test/koth-converge.test.ts`. Expected: FAIL (the module is missing).

- [ ] **Step 3: Implement `apps/bot/src/koth-converge.ts`**

```ts
import { kothEvents, type Database } from "@factions/db";
import {
  KOTH_INFECTED_EVENTS, KOTH_PRESET_FILES, KOTH_PRESET_PREFIX, KOTH_WHOLE_FILES,
  kothWanted, restoredPresets,
} from "@factions/domain";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { readSpawnGearPresets } from "./cfggameplay.js";
import { readEventActive } from "./events-xml.js";
import type { RestartTarget } from "./restart-tick.js";

type KothRow = typeof kothEvents.$inferSelect;
type FileEdit = { dir: string; name: string; content: string };

export type KothPlan = {
  /** The row this slot opens, or null for the default. */
  opening: KothRow | null;
  /** The wanted preset list, or null to leave cfggameplay.json's list alone. */
  presets: string[] | null;
  /** The wanted infected `<active>` values, or null to leave events.xml alone. */
  infected: Record<string, 0 | 1> | null;
  /** The row whose `restored_at` to stamp once `infected` has uploaded. */
  infectedRestoreRowId: number | null;
  /** Whole files to converge (only the ones that differ from the target). */
  files: FileEdit[];
  /** Why an opening was refused (already recorded on the row), or null. */
  failure: string | null;
};

const GAMEPLAY = "cfggameplay.json";
const EVENTS = "events.xml";
const isKoth = (p: string) => p.includes(`/${KOTH_PRESET_PREFIX}`);

function targetDir(root: string, dir: "root" | "env"): string {
  return dir === "root" ? root : `${root}/env`;
}

async function readNonEmpty(nitrado: RestartTarget, path: string): Promise<string> {
  const body = await nitrado.downloadFile(path);
  // ⚠️ An empty download is a missing file with a friendlier face; uploading it
  // over a live spawn file would leave a server nobody can spawn on.
  if (body.trim() === "") throw new Error(`${path} is empty`);
  return body;
}

/**
 * What King of the Hill wants from this slot (spec §5). Null when no KotH row
 * has EVER existed — the only case the restore arm may skip entirely.
 *
 * ⚠️ Not gated on KOTH_TICK by the caller: switching the feature off
 * mid-event must still put the server back (spec §5.3).
 *
 * ⚠️ The opening is verified BEFORE anything is written, and a refusal returns
 * the RESTORE plan: a KotH we could not reverse is worse than one that never
 * starts (§5.1), and a half-written open from an earlier failed attempt is
 * undone the same way.
 */
export async function planKoth(db: Database, nitrado: RestartTarget, serverId: number, slot: Date): Promise<KothPlan | null> {
  const [any] = await db.select({ id: kothEvents.id }).from(kothEvents).where(eq(kothEvents.serverId, serverId)).limit(1);
  if (!any) return null;

  const root = await nitrado.missionRootDir();
  const dbDir = await nitrado.missionDbDir();
  const candidates = await db.select().from(kothEvents)
    .where(and(eq(kothEvents.serverId, serverId), eq(kothEvents.state, "scheduled")));
  const opening = kothWanted(slot, candidates);

  let failure: string | null = null;
  if (opening) {
    try {
      const custom = new Set(await nitrado.listFiles(`${root}/custom`));
      const missing = KOTH_PRESET_FILES.filter((p) => !custom.has(p.slice("./custom/".length)));
      if (missing.length > 0) throw new Error(`KotH preset(s) missing on the server: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}`);
      const town: FileEdit[] = [];
      for (const f of KOTH_WHOLE_FILES) {
        await readNonEmpty(nitrado, `${root}/koth/default/${f.name}`);
        town.push({ dir: targetDir(root, f.dir), name: f.name, content: await readNonEmpty(nitrado, `${root}/koth/locations/${opening.location}/${f.name}`) });
      }
      // Snapshots, BEFORE any upload (spec §2.5). Read-only downloads here; the
      // single upload of each file stays in applyGameplay/applyEvents.
      const presetsNow = readSpawnGearPresets(await nitrado.downloadFile(`${root}/${GAMEPLAY}`));
      const eventsNow = await nitrado.downloadFile(`${dbDir}/${EVENTS}`);
      const infectedNow = Object.fromEntries(KOTH_INFECTED_EVENTS.map((n) => [n, readEventActive(eventsNow, n)])) as Record<string, 0 | 1>;
      await db.update(kothEvents).set({
        // ⚠️ Only from a list with no koth- entry: a retried open after a partial
        // upload would otherwise record KotH's own list as the default.
        ...(opening.loadoutSnapshot === null && !presetsNow.some(isKoth) ? { loadoutSnapshot: presetsNow } : {}),
        ...(opening.infectedSnapshot === null ? { infectedSnapshot: infectedNow } : {}),
      }).where(eq(kothEvents.id, opening.id));
      return {
        opening, presets: [...KOTH_PRESET_FILES],
        infected: Object.fromEntries(KOTH_INFECTED_EVENTS.map((n) => [n, 1])) as Record<string, 0 | 1>,
        infectedRestoreRowId: null, files: await differing(nitrado, town), failure: null,
      };
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      await db.update(kothEvents).set({
        state: "failed",
        detail: sql`${kothEvents.detail} || ${JSON.stringify({ failure })}::jsonb`,
      }).where(and(eq(kothEvents.id, opening.id), eq(kothEvents.state, "scheduled")));
      console.error(`koth: server ${serverId} REFUSED to open ${opening.location} for ${slot.toISOString()} — ${failure}`);
    }
  }

  // ── Restore ──────────────────────────────────────────────────────────────
  const [latest] = await db.select().from(kothEvents)
    .where(and(eq(kothEvents.serverId, serverId), isNotNull(kothEvents.loadoutSnapshot)))
    .orderBy(desc(kothEvents.slotAt)).limit(1);
  const presetsNow = readSpawnGearPresets(await nitrado.downloadFile(`${root}/${GAMEPLAY}`));
  const presets = restoredPresets(presetsNow, latest?.loadoutSnapshot ?? null);

  const [unrestored] = await db.select().from(kothEvents).where(and(
    eq(kothEvents.serverId, serverId), isNotNull(kothEvents.infectedSnapshot), isNull(kothEvents.restoredAt),
  )).orderBy(desc(kothEvents.slotAt)).limit(1);

  const defaults: FileEdit[] = [];
  const problems: string[] = [];
  for (const f of KOTH_WHOLE_FILES) {
    try {
      defaults.push({ dir: targetDir(root, f.dir), name: f.name, content: await readNonEmpty(nitrado, `${root}/koth/default/${f.name}`) });
    } catch (err) {
      // ⚠️ Skip, never blank: a missing default must not become an empty spawn file.
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (problems.length > 0) {
    const [newest] = await db.select({ id: kothEvents.id }).from(kothEvents).where(eq(kothEvents.serverId, serverId)).orderBy(desc(kothEvents.slotAt)).limit(1);
    if (newest) await db.update(kothEvents).set({ detail: sql`${kothEvents.detail} || ${JSON.stringify({ restoreError: problems.join("; ") })}::jsonb` }).where(eq(kothEvents.id, newest.id));
    console.error(`koth: server ${serverId} could not restore every default — ${problems.join("; ")}`);
  }

  return {
    opening: null, presets,
    infected: unrestored?.infectedSnapshot ?? null,
    infectedRestoreRowId: unrestored?.id ?? null,
    files: await differing(nitrado, defaults), failure,
  };
}

/** Only the edits whose target currently differs. A missing target counts as differing. */
async function differing(nitrado: RestartTarget, edits: FileEdit[]): Promise<FileEdit[]> {
  const out: FileEdit[] = [];
  for (const e of edits) {
    const now = await nitrado.downloadFile(`${e.dir}/${e.name}`).catch(() => null);
    if (now !== e.content) out.push(e);
  }
  return out;
}

/** Upload each edit. Each is independent: one failed upload does not stop the rest. */
export async function convergeKothFiles(nitrado: RestartTarget, files: FileEdit[]): Promise<{ uploaded: number; errors: string[] }> {
  let uploaded = 0;
  const errors: string[] = [];
  for (const f of await differing(nitrado, files)) {
    try {
      await nitrado.uploadFile(f.dir, f.name, f.content);
      uploaded += 1;
    } catch (err) {
      errors.push(`${f.dir}/${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { uploaded, errors };
}
```

Remove the unused `inArray` import if `tsc` flags it.

- [ ] **Step 4: Wire it into `restartTick`**, for a server being restarted, before the truck-wipe block:

```ts
      // ⚠️ King of the Hill (spec §5). Planned for EVERY server being restarted
      // whenever any KotH row exists, whether or not KOTH_TICK is set — the
      // restore must still run if the feature is switched off mid-event.
      // Its own try/catch: KotH must never cost the restart.
      let koth: KothPlan | null = null;
      try {
        koth = await planKoth(db, nitrado, s.id, slot.start);
      } catch (err) {
        console.error(`koth: server ${s.id} could not plan slot ${slot.start.toISOString()} — restarting anyway`, err);
      }
```

Then change the `applyEvents` call to pass `infected: koth?.infected ?? undefined`. Make the condition `(opts.truckWipe && (…)) || koth?.infected`. After a successful upload, when `koth?.infectedRestoreRowId` is set and there was no `infectedError`, stamp `restoredAt`:

```ts
          if (koth?.infectedRestoreRowId && !r.infectedError) {
            await db.update(kothEvents).set({ restoredAt: opts.now })
              .where(eq(kothEvents.id, koth.infectedRestoreRowId)).catch(() => undefined);
          }
```

In the gameplay block, add `if (koth?.presets) edits.koth = { presets: koth.presets };`. After `applyGameplay`, if `gameplay.kothError` is set and `koth.opening` exists, mark the row failed:

```ts
        if (gameplay.kothError) {
          console.error(`koth: server ${s.id} REFUSED the preset splice for slot ${slot.start.toISOString()}`, gameplay.kothError);
          if (koth?.opening) await db.update(kothEvents).set({ state: "failed", detail: sql`${kothEvents.detail} || ${JSON.stringify({ failure: gameplay.kothError.message })}::jsonb` })
            .where(and(eq(kothEvents.id, koth.opening.id), eq(kothEvents.state, "scheduled"))).catch(() => undefined);
        }
```

Do the same for an `infectedError` on an opening, recording `failure` from that error. Then, before the restart POST:

```ts
      if (koth && koth.files.length > 0) {
        try {
          const f = await convergeKothFiles(nitrado, koth.files);
          if (f.errors.length > 0 && koth.opening) {
            await db.update(kothEvents).set({ state: "failed", detail: sql`${kothEvents.detail} || ${JSON.stringify({ failure: f.errors.join("; ") })}::jsonb` })
              .where(and(eq(kothEvents.id, koth.opening.id), eq(kothEvents.state, "scheduled")));
          }
        } catch (err) {
          console.error(`koth: server ${s.id} file convergence failed for slot ${slot.start.toISOString()}`, err);
        }
      }
```

Replace the restart call with `await nitrado.restart(restartMessage(airdropLocation, koth?.opening?.location ?? null));`. After the POST, beside the airdrop `live` flip:

```ts
      if (koth?.opening) {
        // ⚠️ Only after the POST, and only from `scheduled`: a row a failed splice
        // above already moved to `failed` must stay failed, and a session is only
        // live once the server has actually loaded it (the airdrop's rule).
        await db.update(kothEvents).set({ state: "live", openedAt: opts.now })
          .where(and(eq(kothEvents.id, koth.opening.id), eq(kothEvents.state, "scheduled")))
          .catch(() => undefined);
      }
```

Extend `restartMessage`:

```ts
export function restartMessage(location: string | null, koth: string | null = null): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const parts = [RESTART_MESSAGE];
  if (location) parts.push(`Airdrop at ${cap(location)} next session.`);
  if (koth) parts.push(`King of the Hill at ${cap(koth)} next session.`);
  return parts.length === 1 ? RESTART_MESSAGE : `${parts[0]}. ${parts.slice(1).join(" ")}`;
}
```

That keeps the existing airdrop-only output identical: `"Scheduled restart. Airdrop at X next session."`.

- [ ] **Step 5: An end-to-end restart-tick test** (append to `koth-converge.test.ts`, importing `restartTick` and `serverRestarts`)

```ts
describe("restartTick with KotH", () => {
  it("opens at the slot and goes live only after the restart POST; restores at the next slot", async () => {
    const row = await schedule();
    const m = mission();
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map() });
    expect(restart).toHaveBeenCalledWith(expect.stringContaining("King of the Hill at Lembork"));
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe("lembork cfgplayerspawnpoints.xml");
    expect(m.read("/m/cfggameplay.json")).toContain("./custom/koth-");
    let [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("live");

    await restartTick(db, () => target, { now: at("2026-10-03T22:00:05Z"), lastError: new Map() });
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe("default cfgplayerspawnpoints.xml");
    expect(m.read("/m/cfggameplay.json")).toBe(GAMEPLAY);
    expect(m.read("/m/db/events.xml")).toBe(EVENTS);
    [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.restoredAt).not.toBeNull();
  });

  it("a failed restart POST leaves the row scheduled, not live", async () => {
    const row = await schedule();
    const target = { ...mission().target, status: async () => "started", restart: async () => { throw new Error("503"); } } as unknown as RestartTarget;
    await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map() });
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("scheduled");
  });
});
```

The `beforeEach` must also truncate `server_restarts`: `truncate table koth_events, server_restarts, servers restart identity cascade`. The servers row needs `nitradoServiceId: 1`.

- [ ] **Step 6: Run the tests**

Run: `cd apps/bot && TEST_DATABASE_URL=… npx vitest run test/koth-converge.test.ts test/restart-tick.test.ts && npx tsc --noEmit`
Expected: PASS. `restart-tick.test.ts` must pass untouched. `planKoth` returns null there because no KotH row exists, so `fakeNitrado`'s throwing file methods are never reached.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/koth-converge.ts apps/bot/src/restart-tick.ts apps/bot/test/koth-converge.test.ts
git commit -m "feat(bot): open and restore King of the Hill at the restart slots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Scoring and the award transaction

**Files:**
- Modify: `packages/roster/src/internal/award-admin.ts` (extract `grantAwardTx`)
- Modify: `packages/roster/src/internal/index.ts` (export it)
- Create: `apps/bot/src/koth-score.ts`
- Test: `apps/bot/test/koth-score.test.ts`, plus `packages/roster/test/`'s existing award test must stay green

**Interfaces:**
- Produces:
  - `grantAwardTx(tx: Tx, a: { awardKey: string; winnerDiscordId: string; grantedByDiscordId: string; reason: string; siteBaseUrl: string; now: Date; serverId: number }): Promise<GrantAwardOutcome>`
  - `kothWindow(db, row): Promise<{ from: Date; to: Date }>`
  - `scoringReady(db, row, now): Promise<boolean>`
  - `kothKills(db, row, window): Promise<{ kills: KothKill[]; dropped: number }>`
  - `scoreAndAward(db, rowId, opts: { now: Date; siteBaseUrl: string }): Promise<"awarded" | "no_winner" | "skipped">`

- [ ] **Step 1: Extract `grantAwardTx`.** In `award-admin.ts`, move the body inside `db.transaction(async (tx) => …)` into:

```ts
/**
 * The grant and its DM, inside a caller's transaction — for King of the Hill,
 * which must lock its own row first so a retry cannot grant twice (lock order:
 * koth_events → award_grants → clan_notices).
 */
export async function grantAwardTx(tx: Tx, a: {
  awardKey: string; winnerDiscordId: string; grantedByDiscordId: string; reason: string; siteBaseUrl: string; now: Date; serverId: number;
}): Promise<GrantAwardOutcome> {
  const def = awardsCatalogue()[a.awardKey];
  if (!def) return { ok: false, reason: "unknown-award" };
  const reason = a.reason.trim();
  if (!reason) return { ok: false, reason: "no-reason" };
  const placeBy = new Date(a.now.getTime() + AWARD_PLACE_BY_MS);
  const [row] = await tx.insert(awardGrants).values({
    awardKey: def.key, discordId: a.winnerDiscordId, grantedByDiscordId: a.grantedByDiscordId,
    reason, grantedAt: a.now, placeBy, updatedAt: a.now,
  }).returning({ id: awardGrants.id });
  await appendClanNoticeTx(tx, {
    serverId: a.serverId, factionId: null, target: "dm", discordTargetId: a.winnerDiscordId,
    kind: "award_granted", occurredAt: a.now,
    payload: { grantId: row!.id, awardKey: def.key, label: def.label, reason, placeBy: placeBy.toISOString(), awardUrl: `${a.siteBaseUrl}/awards/${row!.id}` },
  });
  return { ok: true, grantId: row!.id, placeBy };
}
```

`grantAwardDb` keeps its validation and server lookup, then does `return db.transaction((tx) => grantAwardTx(tx, { ...a, serverId: server.id }));`. Export `grantAwardTx` from `internal/index.ts` beside `grantAwardDb`. Run `cd packages/roster && TEST_DATABASE_URL=… npx vitest run` and expect PASS (a pure refactor). Commit it on its own: `refactor(roster): grantAwardTx for callers that hold their own lock`.

- [ ] **Step 2: Failing scoring tests** (`apps/bot/test/koth-score.test.ts`)

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, kothEvents, servers, serverRestarts, events, kills,
  identityLinks, players, admFiles, awardGrants, type Database,
} from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { writeCursor } from "@factions/event-log";
import { KILLS_CONSUMER } from "../src/kills-tick.js";
import { kothWindow, scoringReady, kothKills, scoreAndAward } from "../src/koth-score.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");
const END = at("2026-10-03T22:00:00Z");
const HILL = { x: 8675, z: 6635 };

describe("koth scoring", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0; let rowId = 0;
  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table koth_events, award_grants, clan_notices, kills, events, adm_files, identity_links, players, server_restarts, consumer_cursors, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    // adm_files' required columns: copy the insert used by apps/bot/test/kills-tick.test.ts.
    const [f] = await db.insert(admFiles).values({ serverId, remotePath: "/x.ADM", firstSeenAt: SLOT } as never).returning();
    fileId = f!.id; line = 0;
    await db.insert(serverRestarts).values([
      { serverId, scheduledFor: SLOT, issuedAt: at("2026-10-03T20:00:04Z"), outcome: "restarted" },
      { serverId, scheduledFor: END, issuedAt: at("2026-10-03T22:00:04Z"), outcome: "restarted" },
    ]);
    const [r] = await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "lembork", centreX: String(HILL.x), centreZ: String(HILL.z),
      state: "live", scheduledByDiscordId: "admin", announcedAt: SLOT, openedAt: SLOT,
    }).returning();
    rowId = r!.id;
  });

  /** One player.killed event + its kills row, as the kills consumer would write it. */
  async function kill(killer: string, victim: string, iso: string, victimPos: { x: number; z: number } | null, over: Partial<typeof kills.$inferInsert> = {}) {
    const payload = { killerDayzId: killer, victimDayzId: victim, ...(victimPos ? { victimPos: { x: victimPos.x, y: 100, z: victimPos.z } } : {}) };
    const [e] = await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.killed", occurredAt: at(iso), payload }).returning();
    await db.insert(kills).values({ serverId, eventId: e!.id, occurredAt: at(iso), victimDayzId: victim, killerDayzId: killer, cause: "killed", ...over });
    return e!.id;
  }
  const row = async () => (await db.select().from(kothEvents).where(eq(kothEvents.id, rowId)))[0]!;
  const ready = async () => {
    // An event past the window end, and the kills cursor past it: ingest has caught up.
    const id = await kill("z", "y", "2026-10-03T22:20:00Z", null);
    await writeCursor(db, KILLS_CONSUMER, id);
  };

  it("the window runs from the opening restart to the closing one", async () => {
    expect(await kothWindow(db, await row())).toEqual({ from: at("2026-10-03T20:00:04Z"), to: at("2026-10-03T22:00:04Z") });
  });

  // ⚠️ Spec §6: a catching-up bot must not score a half-ingested window.
  it("is not ready before the settle time, nor before the kills cursor passes the end", async () => {
    expect(await scoringReady(db, await row(), at("2026-10-03T22:05:00Z"))).toBe(false);
    expect(await scoringReady(db, await row(), at("2026-10-03T22:30:00Z"))).toBe(false); // no cursor yet
    await ready();
    expect(await scoringReady(db, await row(), at("2026-10-03T22:30:00Z"))).toBe(true);
  });

  it("counts victim-in-zone kills by out-of-zone killers; drops friendly fire, Hub and unplaced kills", async () => {
    await kill("a", "v1", "2026-10-03T20:10:00Z", { x: HILL.x + 499, z: HILL.z });
    await kill("a", "v2", "2026-10-03T20:11:00Z", { x: HILL.x + 501, z: HILL.z });
    await kill("b", "v3", "2026-10-03T20:12:00Z", HILL, { friendlyFire: true });
    await kill("b", "v4", "2026-10-03T20:13:00Z", HILL, { atHub: true });
    await kill("c", "v5", "2026-10-03T20:14:00Z", null);
    await kill("d", "v6", "2026-10-03T19:59:00Z", HILL); // before the window
    const r = await kothKills(db, await row(), await kothWindow(db, await row()));
    expect(r.kills.map((k) => k.killerDayzId)).toEqual(["a"]);
    expect(r.dropped).toBe(1);
  });

  it("awards the top LINKED player once, even when run twice", async () => {
    await db.insert(players).values([
      { dayzId: "u", gamertag: "Unlinked", firstSeenAt: SLOT, lastSeenAt: SLOT },
      { dayzId: "l", gamertag: "Linked", firstSeenAt: SLOT, lastSeenAt: SLOT },
    ]);
    await db.insert(identityLinks).values({ discordId: "555", dayzId: "l", gamertag: "Linked", verifiedAt: SLOT });
    await kill("u", "v1", "2026-10-03T20:10:00Z", HILL);
    await kill("u", "v2", "2026-10-03T20:11:00Z", HILL);
    await kill("l", "v3", "2026-10-03T20:12:00Z", HILL);
    await ready();
    const opts = { now: at("2026-10-03T22:30:00Z"), siteBaseUrl: "https://x" };
    const [a, b] = await Promise.all([scoreAndAward(db, rowId, opts), scoreAndAward(db, rowId, opts)]);
    expect([a, b].sort()).toEqual(["awarded", "skipped"]);
    const grants = await db.select().from(awardGrants);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ discordId: "555", awardKey: "plate-carrier", grantedByDiscordId: "admin" });
    const saved = await row();
    expect(saved.state).toBe("awarded");
    expect(saved.results?.topKiller?.gamertag).toBe("Unlinked");
    expect(saved.results?.winner?.gamertag).toBe("Linked");
  });

  it("no counting kills → no_winner, no grant", async () => {
    await ready();
    expect(await scoreAndAward(db, rowId, { now: at("2026-10-03T22:30:00Z"), siteBaseUrl: "https://x" })).toBe("no_winner");
    expect(await db.select().from(awardGrants)).toHaveLength(0);
  });
});
```

If `adm_files` needs other NOT NULL columns, copy the insert that `apps/bot/test/kills-tick.test.ts` uses, and drop the `as never`.

- [ ] **Step 3: Run to fail.** `cd apps/bot && TEST_DATABASE_URL=… npx vitest run test/koth-score.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement `apps/bot/src/koth-score.ts`**

```ts
import { events, identityLinks, kills, kothEvents, players, serverRestarts, type Database, type KothResults } from "@factions/db";
import {
  KOTH_AWARD_KEY, KOTH_SCORE_SETTLE_MS, RESTART_PERIOD_MS, inKothZone, kothLocation, kothStandings, kothWinner,
  readVec3, type KothKill,
} from "@factions/domain";
import { grantAwardTx, scoringKill } from "@factions/roster/internal";
import { readCursor } from "@factions/event-log";
import { and, eq, gt, gte, lt, max, sql } from "drizzle-orm";
import { KILLS_CONSUMER } from "./kills-tick.js";

type KothRow = typeof kothEvents.$inferSelect;

/** The opening and closing restarts' actual issue times (spec §2.9). */
export async function kothWindow(db: Database, row: KothRow): Promise<{ from: Date; to: Date }> {
  const end = new Date(row.slotAt.getTime() + RESTART_PERIOD_MS);
  const at = async (slot: Date) => (await db.select({ issuedAt: serverRestarts.issuedAt }).from(serverRestarts).where(and(
    eq(serverRestarts.serverId, row.serverId), eq(serverRestarts.scheduledFor, slot), eq(serverRestarts.outcome, "restarted"),
  )).limit(1))[0]?.issuedAt;
  return { from: (await at(row.slotAt)) ?? row.slotAt, to: (await at(end)) ?? end };
}

/**
 * ⚠️ Both conditions, never one (spec §6): the settle time covers log lag, and the
 * cursor test covers a bot that is catching up — without it a restart after
 * downtime scores a half-ingested window and crowns the wrong player, for good.
 */
export async function scoringReady(db: Database, row: KothRow, now: Date): Promise<boolean> {
  const { to } = await kothWindow(db, row);
  if (now.getTime() < to.getTime() + KOTH_SCORE_SETTLE_MS) return false;
  const [past] = await db.select({ id: events.id }).from(events)
    .where(and(eq(events.serverId, row.serverId), gt(events.occurredAt, to))).limit(1);
  if (!past) return false;               // ingest has not yet seen anything after the window
  const [last] = await db.select({ id: max(events.id) }).from(events)
    .where(and(eq(events.serverId, row.serverId), lt(events.occurredAt, to)));
  return (last?.id ?? 0) <= await readCursor(db, KILLS_CONSUMER);
}

/** The window's scoring kills whose victim was on the hill, and how many could not be placed. */
export async function kothKills(db: Database, row: KothRow, w: { from: Date; to: Date }): Promise<{ kills: KothKill[]; dropped: number }> {
  const rows = await db.select({
    killer: kills.killerDayzId, occurredAt: kills.occurredAt, payload: events.payload,
    gamertag: sql<string>`coalesce(${players.gamertag}, ${kills.killerDayzId})`,
  }).from(kills)
    .innerJoin(events, eq(events.id, kills.eventId))
    .leftJoin(players, eq(players.dayzId, kills.killerDayzId))
    .where(and(eq(kills.serverId, row.serverId), scoringKill, gte(kills.occurredAt, w.from), lt(kills.occurredAt, w.to)));
  const centre = { x: Number(row.centreX), z: Number(row.centreZ) };
  const out: KothKill[] = [];
  let dropped = 0;
  for (const r of rows) {
    const pos = readVec3((r.payload as Record<string, unknown>)?.victimPos);
    if (pos === null) { dropped += 1; continue; }
    if (inKothZone(pos, centre)) out.push({ killerDayzId: r.killer!, gamertag: r.gamertag, occurredAt: r.occurredAt });
  }
  return { kills: out, dropped };
}

/**
 * Score a live row and grant the Plate Carrier, in ONE transaction that locks
 * the row first — that lock is the whole idempotency guard: two passes racing
 * after a crash grant exactly one award (lock order koth_events → award_grants
 * → clan_notices). The results are frozen here and never recomputed.
 */
export async function scoreAndAward(db: Database, rowId: number, opts: { now: Date; siteBaseUrl: string }): Promise<"awarded" | "no_winner" | "skipped"> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(kothEvents).where(eq(kothEvents.id, rowId)).for("update");
    if (!row || row.state !== "live") return "skipped";
    const w = await kothWindow(tx as unknown as Database, row);
    const { kills: ks, dropped } = await kothKills(tx as unknown as Database, row, w);
    const standings = kothStandings(ks);
    const linked = new Map((await tx.select({ dayzId: identityLinks.dayzId, discordId: identityLinks.discordId }).from(identityLinks))
      .map((l) => [l.dayzId, l.discordId]));
    const winner = kothWinner(standings, (id) => linked.has(id));
    const slim = (s: { dayzId: string; gamertag: string; kills: number }) => ({ dayzId: s.dayzId, gamertag: s.gamertag, kills: s.kills });
    const results: KothResults = {
      top: standings.slice(0, 5).map(slim), topKiller: standings[0] ? slim(standings[0]) : null,
      winner: winner ? slim(winner) : null, droppedNoPosition: dropped,
    };
    if (!winner) {
      await tx.update(kothEvents).set({ state: "no_winner", results }).where(eq(kothEvents.id, row.id));
      return "no_winner";
    }
    const town = kothLocation(row.location)?.name ?? row.location;
    const g = await grantAwardTx(tx, {
      awardKey: KOTH_AWARD_KEY, winnerDiscordId: linked.get(winner.dayzId)!, grantedByDiscordId: row.scheduledByDiscordId,
      reason: `King of the Hill — ${town}, ${row.slotAt.toISOString().slice(0, 10)}`, siteBaseUrl: opts.siteBaseUrl,
      now: opts.now, serverId: row.serverId,
    });
    // ⚠️ Throw, never "succeed" without a grant: the rollback leaves the row live and the next tick retries.
    if (!g.ok) throw new Error(`koth: award grant refused (${g.reason})`);
    await tx.update(kothEvents).set({ state: "awarded", results, winnerDayzId: winner.dayzId, awardGrantId: g.grantId })
      .where(eq(kothEvents.id, row.id));
    return "awarded";
  });
}
```

The identity lookup reads every link, which is fine at this server's scale. If the concurrent test deadlocks or double-grants, the `FOR UPDATE` is not taking effect: check that drizzle's `.for("update")` is emitted in the SQL.

- [ ] **Step 5: Run the tests.** Expected: PASS. Then `npx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add packages/roster apps/bot/src/koth-score.ts apps/bot/test/koth-score.test.ts
git commit -m "feat(bot): score a King of the Hill window and grant the Plate Carrier once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Posts and the KotH tick

**Files:**
- Create: `apps/bot/src/koth-text.ts`, `apps/bot/src/koth-tick.ts`
- Test: `apps/bot/test/koth-text.test.ts`, `apps/bot/test/koth-tick.test.ts`

**Interfaces:**
- Produces:
  - `scheduledText(town: string, slotAt: Date): string`
  - `reminderText(town: string, slotAt: Date): string`
  - `liveText(town: string): string`
  - `resultsText(town: string, r: KothResults): string`
  - `cancelledText(town: string, slotAt: Date): string`
  - `kothTick(db, posters: { announce: (c: string) => Promise<void>; ops: (c: string) => Promise<void> }, opts: { now: Date; siteBaseUrl: string }): Promise<{ posted: number; failed: number; scored: number }>`

The tick's steps, in order, per active server:
1. Fail missed openings: `scheduled` with `slot_at < restartSlot(now).start`, or `slot_at == current slot` where that slot's `server_restarts` row is `missed`/`skipped`. The row goes `failed` with `detail.failure = "missed opening"`.
2. Reminder: `scheduled`, `announced_at` set, `reminded_at` null, `now >= slot_at − KOTH_REMINDER_LEAD_MS`, `now < slot_at`.
3. Live post: `live`, `live_posted_at` null.
4. Score: `live` and `scoringReady` → `scoreAndAward`.
5. Results post: `awarded`/`no_winner`, `results_posted_at` null.
6. Cancel post: `cancelled`/`failed`, `announced_at` set, `cancel_posted_at` null.
7. Ops alerts:
   - `failed` with `detail.failure` and no `detail.opsAlerted`
   - any row whose `detail.restoreError` differs from `detail.restoreErrorAlerted`

Each post happens first and its stamp second. A failed post is logged and retried next tick.

- [ ] **Step 1: Failing text tests**

```ts
import { describe, it, expect } from "vitest";
import { scheduledText, reminderText, liveText, resultsText, cancelledText } from "../src/koth-text.js";
import { KOTH_ZONE_RADIUS_M } from "@factions/domain";

const SLOT = new Date("2026-10-03T20:00:00Z");

describe("koth text", () => {
  it("scheduled and reminder name the town, the radius from rules.ts, and the prize", () => {
    for (const t of [scheduledText("Lembork", SLOT), reminderText("Lembork", SLOT)]) {
      expect(t).toContain("LEMBORK");
      expect(t).toContain(`${KOTH_ZONE_RADIUS_M} m`);
      expect(t).toMatch(/Plate Carrier/);
      expect(t).toContain("<t:");
    }
  });
  it("results list the top five, the winner, and a passed-down prize", () => {
    const t = resultsText("Lembork", {
      top: [{ dayzId: "u", gamertag: "Unlinked", kills: 9 }, { dayzId: "l", gamertag: "Linked", kills: 4 }],
      topKiller: { dayzId: "u", gamertag: "Unlinked", kills: 9 },
      winner: { dayzId: "l", gamertag: "Linked", kills: 4 }, droppedNoPosition: 2,
    });
    expect(t).toMatch(/1\. Unlinked — 9/);
    expect(t).toMatch(/Linked/);
    expect(t).toMatch(/not linked/i);
    expect(t).toMatch(/2 kills/);
  });
  // ⚠️ A gamertag is player-controlled text; markdown in it must not restyle the post.
  it("escapes markdown in gamertags", () => {
    const t = resultsText("Lembork", { top: [{ dayzId: "x", gamertag: "**boss**", kills: 1 }], topKiller: null, winner: null, droppedNoPosition: 0 });
    expect(t).toContain("\\*\\*boss\\*\\*");
  });
  it("no winner and cancelled read plainly", () => {
    expect(resultsText("Lembork", { top: [], topKiller: null, winner: null, droppedNoPosition: 0 })).toMatch(/nobody/i);
    expect(cancelledText("Lembork", SLOT)).toMatch(/CANCELLED/);
    expect(liveText("Lembork")).toMatch(/LIVE/);
  });
});
```

- [ ] **Step 2: Implement `koth-text.ts`**

```ts
import { atRel } from "@factions/copy";
import type { KothResults } from "@factions/db";
import { KOTH_ZONE_RADIUS_M } from "@factions/domain";

const esc = (s: string) => s.replace(/([\\*_~`|>])/g, "\\$1");
const rules = `Fresh spawns start on the hill with a KotH kit. A kill counts when the victim is within ${KOTH_ZONE_RADIUS_M} m of the centre. Most kills wins a week of the Plate Carrier.`;

export function scheduledText(town: string, slotAt: Date): string {
  return [`**KING OF THE HILL: ${town.toUpperCase()}**`, `Starts at the restart ${atRel(slotAt) ?? ""}.`, rules].join("\n");
}
export function reminderText(town: string, slotAt: Date): string {
  return [`**KING OF THE HILL IN 30 MINUTES: ${town.toUpperCase()}**`, `Starts ${atRel(slotAt) ?? "at the next restart"}.`, rules].join("\n");
}
export function liveText(town: string): string {
  return [`**KING OF THE HILL IS LIVE: ${town.toUpperCase()}**`, rules, "It ends at the next restart."].join("\n");
}
export function resultsText(town: string, r: KothResults): string {
  if (r.top.length === 0) return `**KING OF THE HILL: ${town.toUpperCase()} — RESULTS**\nNobody scored a kill on the hill. No Plate Carrier this time.`;
  const lines = [`**KING OF THE HILL: ${town.toUpperCase()} — RESULTS**`, ...r.top.map((t, i) => `${i + 1}. ${esc(t.gamertag)} — ${t.kills}`)];
  if (r.winner) {
    lines.push(`🏆 The Plate Carrier goes to **${esc(r.winner.gamertag)}**.`);
    if (r.topKiller && r.topKiller.dayzId !== r.winner.dayzId) lines.push(`${esc(r.topKiller.gamertag)} topped the board but is not linked on Discord, so the prize passed down.`);
  } else {
    lines.push("Nobody on the board is linked on Discord, so no Plate Carrier this time.");
  }
  if (r.droppedNoPosition > 0) lines.push(`(${r.droppedNoPosition} kills had no position in the log and could not be counted.)`);
  return lines.join("\n");
}
export function cancelledText(town: string, slotAt: Date): string {
  return `**KING OF THE HILL CANCELLED: ${town.toUpperCase()}**\nThe session planned for ${atRel(slotAt) ?? "the restart"} will not run.`;
}
```

- [ ] **Step 3: Failing tick tests** (`koth-tick.test.ts`). Use the same DB setup as Task 10, with `vi.fn` posters. Cases:
  - a `scheduled` row whose slot passed → `failed`, then a cancel post; `announce` is called once with `/CANCELLED/`
  - a reminder posts once in `[slot − 30 min, slot)` and never before
  - a `live` row posts `/IS LIVE/` once
  - scoring happens only when `scoringReady` (reuse the `ready()` helper), then the results post and the `results_posted_at` stamp
  - a post that throws leaves the stamp null, and the next tick posts it
  - a `failed` row with `detail.failure` sends exactly one ops alert, even across two ticks

```ts
it("fails a missed opening and posts a cancellation once", async () => {
  await db.insert(kothEvents).values({ serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635",
    state: "scheduled", scheduledByDiscordId: "a", announcedAt: at("2026-10-01T00:00:00Z") });
  const announce = vi.fn(async () => {}); const ops = vi.fn(async () => {});
  await kothTick(db, { announce, ops }, { now: at("2026-10-03T22:01:00Z"), siteBaseUrl: "https://x" });
  await kothTick(db, { announce, ops }, { now: at("2026-10-03T22:02:00Z"), siteBaseUrl: "https://x" });
  expect(announce).toHaveBeenCalledTimes(1);
  expect(announce.mock.calls[0]![0]).toMatch(/CANCELLED/);
  expect((await db.select().from(kothEvents))[0]!.state).toBe("failed");
});
```

Write the other five in the same shape.

- [ ] **Step 4: Implement `koth-tick.ts`**

```ts
import { kothEvents, servers, serverRestarts, type Database } from "@factions/db";
import { KOTH_REMINDER_LEAD_MS, kothLocation, restartSlot } from "@factions/domain";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { cancelledText, liveText, reminderText, resultsText } from "./koth-text.js";
import { scoreAndAward, scoringReady } from "./koth-score.js";

export type KothPosters = { announce: (c: string) => Promise<void>; ops: (c: string) => Promise<void> };
type Row = typeof kothEvents.$inferSelect;
const town = (r: Row) => kothLocation(r.location)?.name ?? r.location;

/** Post, THEN stamp — a stamp first silences a post that never went out. */
async function postThen(post: (c: string) => Promise<void>, content: string, stamp: () => Promise<unknown>, what: string): Promise<boolean> {
  try { await post(content); } catch (err) { console.warn(`koth: ${what} failed to post — retrying next tick`, err); return false; }
  await stamp();
  return true;
}

/**
 * Everything King of the Hill says, and the scoring (spec §6, §8).
 *
 * ⚠️ Runs AFTER the restart tick in discord.ts: a slow Discord call must never
 * delay a due restart, which is why none of this lives in restart-tick.ts.
 */
export async function kothTick(db: Database, posters: KothPosters, opts: { now: Date; siteBaseUrl: string }) {
  const out = { posted: 0, failed: 0, scored: 0 };
  const slot = restartSlot(opts.now);
  const targets = await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true));
  for (const s of targets) {
    try {
      // 1. ⚠️ Never late (spec §2.1): an opening the restart tick did not reach is over.
      const [cur] = await db.select({ outcome: serverRestarts.outcome }).from(serverRestarts)
        .where(and(eq(serverRestarts.serverId, s.id), eq(serverRestarts.scheduledFor, slot.start))).limit(1);
      const missed = await db.update(kothEvents).set({ state: "failed", detail: sql`${kothEvents.detail} || '{"failure":"missed opening"}'::jsonb` })
        .where(and(eq(kothEvents.serverId, s.id), eq(kothEvents.state, "scheduled"),
          cur && cur.outcome !== "restarted"
            ? sql`${kothEvents.slotAt} <= ${slot.start.toISOString()}::timestamptz`
            : lt(kothEvents.slotAt, slot.start)))
        .returning({ id: kothEvents.id });
      out.failed += missed.length;

      const rows = await db.select().from(kothEvents).where(eq(kothEvents.serverId, s.id));
      for (const r of rows) {
        const set = (v: Partial<Row>) => db.update(kothEvents).set(v).where(eq(kothEvents.id, r.id));
        // 2. Reminder.
        if (r.state === "scheduled" && r.announcedAt && !r.remindedAt
            && opts.now.getTime() >= r.slotAt.getTime() - KOTH_REMINDER_LEAD_MS && opts.now < r.slotAt) {
          if (await postThen(posters.announce, reminderText(town(r), r.slotAt), () => set({ remindedAt: opts.now }), "reminder")) out.posted += 1;
        }
        // 3. Live.
        if (r.state === "live" && !r.livePostedAt) {
          if (await postThen(posters.announce, liveText(town(r)), () => set({ livePostedAt: opts.now }), "live post")) out.posted += 1;
        }
        // 4. Score.
        if (r.state === "live" && await scoringReady(db, r, opts.now)) {
          const res = await scoreAndAward(db, r.id, { now: opts.now, siteBaseUrl: opts.siteBaseUrl });
          if (res !== "skipped") out.scored += 1;
        }
      }
      // 5–7 re-read, so a row scored above posts its results this same tick.
      for (const r of await db.select().from(kothEvents).where(eq(kothEvents.serverId, s.id))) {
        const set = (v: Partial<Row>) => db.update(kothEvents).set(v).where(eq(kothEvents.id, r.id));
        if ((r.state === "awarded" || r.state === "no_winner") && r.results && !r.resultsPostedAt) {
          if (await postThen(posters.announce, resultsText(town(r), r.results), () => set({ resultsPostedAt: opts.now }), "results")) out.posted += 1;
        }
        // ⚠️ Only an event players were TOLD about gets a cancellation.
        if ((r.state === "cancelled" || r.state === "failed") && r.announcedAt && !r.cancelPostedAt) {
          if (await postThen(posters.announce, cancelledText(town(r), r.slotAt), () => set({ cancelPostedAt: opts.now }), "cancellation")) out.posted += 1;
        }
        const d = r.detail as Record<string, unknown>;
        if (r.state === "failed" && d.failure && !d.opsAlerted) {
          await postThen(posters.ops, `⚠️ King of the Hill at ${town(r)} (${r.slotAt.toISOString()}) failed: ${d.failure}`,
            () => db.update(kothEvents).set({ detail: sql`${kothEvents.detail} || '{"opsAlerted":true}'::jsonb` }).where(eq(kothEvents.id, r.id)), "ops alert");
        }
        if (typeof d.restoreError === "string" && d.restoreError !== d.restoreErrorAlerted) {
          await postThen(posters.ops, `⚠️ King of the Hill could not restore every default file: ${d.restoreError}`,
            () => db.update(kothEvents).set({ detail: sql`${kothEvents.detail} || ${JSON.stringify({ restoreErrorAlerted: d.restoreError })}::jsonb` }).where(eq(kothEvents.id, r.id)), "restore alert");
        }
      }
    } catch (err) {
      console.error(`koth: server ${s.id} tick failed`, err);
    }
  }
  return out;
}
```

Remove any unused imports (`inArray`, `isNotNull`, `isNull`) that `tsc` flags.

- [ ] **Step 5: Run the tests.** `cd apps/bot && TEST_DATABASE_URL=… npx vitest run test/koth-text.test.ts test/koth-tick.test.ts && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 6: Commit.** Commit `feat(bot): King of the Hill posts, missed-opening failure and scoring tick`, with the trailer.

### Task 12: `/koth` and the airdrop clash

**Files:**
- Create: `apps/bot/src/commands/koth.ts`
- Modify: `apps/bot/src/commands/index.ts` (add `kothGroup` to `GROUPS`)
- Modify: `apps/bot/src/commands/types.ts` (`Ctx` gains `koth: ((content: string) => Promise<void>) | null`)
- Modify: `apps/bot/src/commands/airdrop.ts`, `apps/bot/src/airdrop-tick.ts` (refuse a KotH slot)
- Modify: every test that builds a `Ctx` literal (`grep -rln "bountiesEnabled" apps/bot/test`): add `koth: null`
- Test: `apps/bot/test/koth-command.test.ts`, plus additions to `airdrop-command.test.ts` and `airdrop-tick.test.ts`

**Interfaces:**
- `/koth schedule location:<slug, autocomplete> at:<ISO slot, autocomplete>`, `/koth cancel`, `/koth status`
- `Ctx.koth` is the `SERVER_EVENTS_CHANNEL_ID` poster with mentions off, or null when `KOTH_TICK` is off

- [ ] **Step 1: Failing command tests** (model on `airdrop-command.test.ts`'s setup, with `ctx` including `koth: post`)

```ts
const SLOT = at("2026-10-03T20:00:00Z");
const NOW = at("2026-10-03T12:00:00Z");
// input.string: "location" → "lembork", "at" → SLOT.toISOString()

it("schedules, announces, and stamps announced_at", async () => {
  const post = vi.fn(async () => {});
  const reply = await schedule(ctx(post), input());
  expect(reply.content).toMatch(/Lembork/);
  const [row] = await db.select().from(kothEvents);
  expect(row).toMatchObject({ slotAt: SLOT, location: "lembork", state: "scheduled", scheduledByDiscordId: "99" });
  expect(row!.announcedAt).not.toBeNull();
  expect(post).toHaveBeenCalledWith(expect.stringContaining("LEMBORK"));
});
it("refuses a non-admin", async () => { /* isAdmin:false → /admin/i, no rows */ });
it("refuses with KOTH_TICK off", async () => { /* ctx(null) → /KOTH_TICK/ */ });
it("refuses an unknown town, a non-slot time, and a slot under 30 minutes away", async () => {
  // "narnia" → /not one of/; "2026-10-03T21:00:00Z" → /restart slot/; now 19:45 with slot 20:00 → /30 minutes/
});
// ⚠️ Spec §2.12.
it("refuses while another event is scheduled or live", async () => { /* insert a scheduled row → /already/ */ });
it("refuses a slot an airdrop holds", async () => {
  // insert airdrop_events { slotAt: SLOT, state: "announced", announcedAt: NOW, … } → /airdrop/i
});
it("marks the row failed and says so when the announcement cannot post", async () => { /* post throws → state failed */ });
it("cancel moves a scheduled event to cancelled and refuses a live one", async () => { /* … */ });
it("autocompletes towns by prefix and the next 7 days of slots", async () => {
  const towns = await kothGroup.specs.find((s) => s.path === "koth schedule")!.autocomplete!.location!(ctx(), { actorDiscordId: "99", value: "le" });
  expect(towns.map((t) => t.value)).toContain("lembork");
  const slots = await kothGroup.specs.find((s) => s.path === "koth schedule")!.autocomplete!.at!(ctx(), { actorDiscordId: "99", value: "" });
  expect(slots.length).toBeLessThanOrEqual(25);
  expect(slots[0]!.value).toBe("2026-10-03T14:00:00.000Z");
});
```

Write out each commented body fully, following the first test's pattern.

- [ ] **Step 2: Run to fail.** Expected: FAIL.

- [ ] **Step 3: Implement `commands/koth.ts`**

```ts
import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { airdropEvents, kothEvents, servers } from "@factions/db";
import {
  KOTH_LOCATIONS, KOTH_REMINDER_LEAD_MS, RESTART_PERIOD_MS, isRestartSlot, kothLocation, nextRestartAt,
} from "@factions/domain";
import { and, eq, inArray } from "drizzle-orm";
import { scheduledText } from "../koth-text.js";
import type { AutocompleteSource, CommandGroup, Ctx, CommandInput, Reply } from "./types.js";

const reply = (content: string): Reply => ({ content, ephemeral: true });

async function activeServer(ctx: Ctx) {
  return (await ctx.db.select({ id: servers.id }).from(servers).where(eq(servers.active, true)).limit(1))[0] ?? null;
}

/**
 * ⚠️ Row first, post second, and FAILED if the post throws — `/airdrop place`'s
 * shape, for its reason: an event nobody was told about is one nobody comes to,
 * and `kothWanted` refuses to open a row with no `announced_at`.
 */
async function schedule(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return reply("Only an admin can schedule King of the Hill.");
  if (!ctx.koth) return reply("KOTH_TICK is off, so nothing would ever run this event. Turn it on first.");
  const loc = kothLocation((input.string("location") ?? "").toLowerCase());
  if (!loc) return reply(`That is not one of the ${KOTH_LOCATIONS.length} KotH towns.`);
  const slot = new Date(input.string("at") ?? "");
  if (Number.isNaN(slot.getTime()) || !isRestartSlot(slot)) return reply("Pick a restart slot from the list.");
  if (slot.getTime() - ctx.now.getTime() < KOTH_REMINDER_LEAD_MS) return reply("That slot is under 30 minutes away. Pick a later one, so players get the reminder.");

  const server = await activeServer(ctx);
  if (!server) return reply("No active server.");
  const open = await ctx.db.select({ id: kothEvents.id }).from(kothEvents)
    .where(and(eq(kothEvents.serverId, server.id), inArray(kothEvents.state, ["scheduled", "live"])));
  if (open.length > 0) return reply("A King of the Hill event is already scheduled or live. Only one at a time.");
  // ⚠️ Spec §2.12: one session cannot hold both. The airdrop side refuses too.
  const drop = await ctx.db.select({ slotAt: airdropEvents.slotAt }).from(airdropEvents).where(and(
    eq(airdropEvents.serverId, server.id), eq(airdropEvents.slotAt, slot), inArray(airdropEvents.state, ["announced", "live"]),
  ));
  if (drop.length > 0) return reply("An airdrop is already set for that session. Pick another slot.");

  const [row] = await ctx.db.insert(kothEvents).values({
    serverId: server.id, slotAt: slot, location: loc.slug, centreX: String(loc.centreX), centreZ: String(loc.centreZ),
    state: "scheduled", scheduledByDiscordId: input.actorDiscordId,
  }).returning({ id: kothEvents.id });
  try {
    await ctx.koth(scheduledText(loc.name, slot));
  } catch (err) {
    await ctx.db.update(kothEvents).set({ state: "failed", detail: { failure: "never announced" } }).where(eq(kothEvents.id, row!.id));
    console.error("koth: scheduled announcement failed to post — nothing scheduled", err);
    return reply("I could not post the announcement, so I have not scheduled it. Check SERVER_EVENTS_CHANNEL_ID.");
  }
  await ctx.db.update(kothEvents).set({ announcedAt: ctx.now }).where(eq(kothEvents.id, row!.id));
  return reply(`Scheduled: **${loc.name}**, opening at the ${slot.toISOString()} restart and ending at the next one.`);
}

async function cancel(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return reply("Only an admin can cancel King of the Hill.");
  const server = await activeServer(ctx);
  if (!server) return reply("No active server.");
  const [row] = await ctx.db.select().from(kothEvents)
    .where(and(eq(kothEvents.serverId, server.id), inArray(kothEvents.state, ["scheduled", "live"])));
  if (!row) return reply("Nothing is scheduled.");
  // ⚠️ A live session is already on the server; the next restart ends it anyway.
  if (row.state === "live") return reply("It is already live. It ends at the next restart.");
  await ctx.db.update(kothEvents).set({ state: "cancelled" }).where(and(eq(kothEvents.id, row.id), eq(kothEvents.state, "scheduled")));
  return reply(`Cancelled ${kothLocation(row.location)?.name ?? row.location}. The channel will be told.`);
}

async function status(ctx: Ctx, _input: CommandInput): Promise<Reply> {
  const server = await activeServer(ctx);
  if (!server) return reply("No active server.");
  const [row] = await ctx.db.select().from(kothEvents)
    .where(and(eq(kothEvents.serverId, server.id), inArray(kothEvents.state, ["scheduled", "live"])));
  if (!row) return reply("No King of the Hill event is scheduled.");
  return reply(`${kothLocation(row.location)?.name ?? row.location}: ${row.state}, slot ${row.slotAt.toISOString()}.`);
}

const towns: AutocompleteSource = async (_ctx, a) => KOTH_LOCATIONS
  .filter((l) => l.name.toLowerCase().startsWith(a.value.toLowerCase()) || l.slug.startsWith(a.value.toLowerCase()))
  .slice(0, 25).map((l) => ({ name: l.name, value: l.slug }));

/** The next 7 days of slots, capped at Discord's 25 choices, skipping any under the reminder lead. */
const slots: AutocompleteSource = async (ctx, a) => {
  const out: { name: string; value: string }[] = [];
  for (let t = nextRestartAt(ctx.now).getTime(); out.length < 25 && t < ctx.now.getTime() + 7 * 86_400_000; t += RESTART_PERIOD_MS) {
    if (t - ctx.now.getTime() < KOTH_REMINDER_LEAD_MS) continue;
    const iso = new Date(t).toISOString();
    const name = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
    if (name.includes(a.value)) out.push({ name, value: iso });
  }
  return out;
};

export const kothGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("koth").setDescription("King of the Hill")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((c) => c.setName("schedule").setDescription("Schedule a one-session King of the Hill")
      .addStringOption((o) => o.setName("location").setDescription("The town").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("at").setDescription("The restart that opens it").setRequired(true).setAutocomplete(true)))
    .addSubcommand((c) => c.setName("cancel").setDescription("Cancel the scheduled event"))
    .addSubcommand((c) => c.setName("status").setDescription("Show the scheduled or live event")),
  specs: [
    { path: "koth schedule", handler: schedule, autocomplete: { location: towns, at: slots } },
    { path: "koth cancel", handler: cancel },
    { path: "koth status", handler: status },
  ],
};
```

In the autocomplete test, `NOW` is `12:00`. With the 30-minute lead, the first offered slot is `14:00`, because `nextRestartAt(12:00)` is 14:00.

- [ ] **Step 4: The airdrop side.**
  - In `placeAirdrop`, after the `open.length` check, refuse when a `kothEvents` row for `slot` is `scheduled`: reply `"King of the Hill holds that session. No airdrop on top of it."`.
  - In `airdropTick`'s branch 2, after `if (already) continue;`, do the same lookup and `continue` when a KotH event is `scheduled` for `slot`. Carry a `⚠️` comment citing spec §2.12.
  - Add one test to each of `airdrop-command.test.ts` and `airdrop-tick.test.ts` that inserts a scheduled KotH row for the slot and asserts no `airdrop_events` row is written.

- [ ] **Step 5: `Ctx`, registration and tests.**
  - Add to `Ctx` in `types.ts`: `/** The KotH announcement poster (mentions off), or null when KOTH_TICK is off. */ koth: ((content: string) => Promise<void>) | null;`
  - Add `kothGroup` to `GROUPS`.
  - Add `koth: null` to every test `Ctx` literal.
  - Check `command-registration.test.ts` and `parity.test.ts`. If either enumerates admin groups (as it may for `airdrop`/`award`/`bounty`), add `koth` beside them the same way.

- [ ] **Step 6: Run the bot suite.** `cd apps/bot && TEST_DATABASE_URL=… npx vitest run && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 7: Commit.** Commit `feat(bot): /koth schedule, cancel, status; airdrops refuse a KotH session`, with the trailer.

### Task 13: Config and wiring

**Files:**
- Modify: `apps/bot/src/config.ts`, `apps/bot/src/discord.ts`
- Modify: `apps/bot/README.md` (env table)
- Test: `apps/bot/test/config.test.ts`

**Interfaces:**
- `config.koth: { enabled: boolean }` from `KOTH_TICK`. It is fatal without `RESTART_SCHEDULE` or `SERVER_EVENTS_CHANNEL_ID`.

- [ ] **Step 1: Failing config tests** (model them on the existing `AIRDROP_TICK` cases in `config.test.ts`)

```ts
it("KOTH_TICK needs RESTART_SCHEDULE", () => {
  expect(() => loadConfig({ ...base, KOTH_TICK: "true", SERVER_EVENTS_CHANNEL_ID: "123456789012345678" })).toThrow(/KOTH_TICK is on but RESTART_SCHEDULE/);
});
it("KOTH_TICK needs SERVER_EVENTS_CHANNEL_ID", () => {
  expect(() => loadConfig({ ...base, KOTH_TICK: "true", RESTART_SCHEDULE: "true", NITRADO_TOKEN: "t" })).toThrow(/KOTH_TICK is on but SERVER_EVENTS_CHANNEL_ID/);
});
it("KOTH_TICK defaults off", () => expect(loadConfig(base).koth.enabled).toBe(false));
```

Use whatever the file calls its base env and loader. Copy the names from the airdrop tests.

- [ ] **Step 2: Implement.**
  - In the config type, add `/** Gates King of the Hill's scheduling and posts (spec 2026-09-23). The restart tick's RESTORE arm runs regardless. */ koth: { enabled: boolean };`.
  - In the loader: `koth: { enabled: ["1", "true"].includes((env.KOTH_TICK ?? "").trim().toLowerCase()) },`.
  - Add two fatal checks after the airdrop ones, in the same wording style: "a session only opens at a restart" and "an unannounced event is one nobody comes to".

In `discord.ts`:
- Build `const kothPoster = cfg.koth.enabled && cfg.serverEventsChannelId ? createChannelPoster(client, cfg.serverEventsChannelId, { allowedMentions: { parse: [] } }) : null;` beside `bountyPoster`, with the same comment about gamertags.
- Add `koth: kothPoster` to `ctxNow()`.
- After the airdrop tick block (so it runs after the restart tick), add:

```ts
    // ⚠️ AFTER the restart tick, like every server-events poster: a slow Discord
    // call must never delay a due restart. Its own try/catch.
    // ⚠️ Gated on the flag alone — config load refuses KOTH_TICK without
    // SERVER_EVENTS_CHANNEL_ID, so kothPoster is non-null here.
    if (cfg.koth.enabled) {
      try {
        const opsPoster = opsChannelPoster ?? (async (content: string) => { console.error(content); });
        const k = await kothTick(db, { announce: kothPoster!, ops: opsPoster }, { now: new Date(), siteBaseUrl: cfg.siteBaseUrl });
        if (k.posted + k.failed + k.scored > 0) console.log(`koth: ${k.posted} posted, ${k.failed} failed, ${k.scored} scored`);
      } catch (err) {
        console.error("koth tick failed", err);
      }
    }
```

Add a startup log line beside the airdrop one: `if (cfg.koth.enabled) console.log("king of the hill on"); else console.warn("KOTH_TICK is off: /koth refuses; any unfinished KotH session is still restored at the next restart.");`.

Add `KOTH_TICK` to the README env table: "Enables `/koth` and the KotH posts and scoring. Requires `RESTART_SCHEDULE` and `SERVER_EVENTS_CHANNEL_ID`. The restore runs regardless."

Also add `"KOTH_TICK"` to the `env` list of turbo.json's `test` task **only if** other bot flags such as `AIRDROP_TICK` are listed there. Otherwise leave it.

- [ ] **Step 3: Run the tests.** `cd apps/bot && TEST_DATABASE_URL=… npx vitest run test/config.test.ts && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 4: Commit.** Commit `feat(bot): KOTH_TICK and the tick's wiring`, with the trailer.

### Task 14: Documentation and the full gate

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/deploy/2026-09-23-king-of-the-hill.md`
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Modify: `docs/superpowers/specs/2026-09-23-king-of-the-hill-design.md` (amendments)

- [ ] **Step 1: Spec amendments.** Edit the spec in place:
  - "31 towns", not 32
  - §2.9 and §6: `server_restarts.issued_at`, not `restarted_at`
  - §4: drop the guide section. Airdrops have none either, and the Discord posts carry the numbers from `rules.ts`.
  - §5.1: the preset-presence check (one `listFiles` of `custom/`)
  - §3: the CHECK enforces "awarded ⇒ grant" only, and why

- [ ] **Step 2: `CLAUDE.md`.**
  - Add a "Where things live" row for King of the Hill, pointing at `packages/domain/src/koth.ts`, `apps/bot/src/koth-converge.ts`, `koth-score.ts`, `koth-tick.ts`, `koth-text.ts`, `commands/koth.ts`, `koth_events` (migration 0049), the spec and the runbook. It carries these ⚠️ notes:
    - the bot owns the four whole files on the server and reverts hand-edits within a slot
    - `applyEvents` and `applyGameplay` are the only round trips for their files
    - the restore arm ignores `KOTH_TICK`
    - a session never opens late
    - the `koth-` prefix is reserved
  - Add `koth_events` to the lock-order sentence immediately before `award_grants`, with one line: "`koth_events` is written by the restart tick, `/koth` and `koth-tick`; the award transaction takes `koth_events` → `award_grants` → `clan_notices`."

- [ ] **Step 3: Runbook** `docs/deploy/2026-09-23-king-of-the-hill.md`, in the house style of `docs/deploy/2026-09-21-airdrops.md` (read it first). Order:
  1. Merge and publish the `livonia` Release (Part A). Then verify on the server, through the Nitrado file browser or a read-only `listFiles`:
     - `koth/default/` holds four non-empty files
     - `custom/` holds 44 `koth-*.json`
     - `koth/locations/lembork/` holds four files
  2. The release deploy applies migration 0049. Confirm with `select count(*) from koth_events` → 0.
  3. Set `KOTH_TICK=true` in `.env`, then `sudo systemctl restart clan-wars-bot`, and check the startup log line.
  4. Rehearsal on a quiet slot. Run `/koth schedule` for a slot at least 2 h out, then check:
     - after the opening restart: a fresh character spawns at the hill in a KotH kit, infected are present there and absent at a normal town, and the `live` post appeared
     - after the closing restart: the four files equal `koth/default/`, `cfggameplay.json` lists `./custom/loadout.json`, and the `Infected*` values match `infected_snapshot`
     - the results post appeared, and the `award_grants` row plus the DM landed
  5. Rollback: `KOTH_TICK=false` and restart the bot. The restore arm still runs at the next slot.

- [ ] **Step 4: `CHANGELOG.md`.** Under `## [Unreleased]` → `### Added`: "King of the Hill: `/koth schedule` turns one restart window into a KotH session at a Livonia town — hill spawns, KotH loadouts, infected and predators on the hill — and grants the Plate Carrier to the top linked killer within 500 m."

- [ ] **Step 5: The full gate** (nothing else running against 5434's test databases)

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: every task succeeds, with the count equal to today's 30/30. Read the count, not the exit code. If `factions_test_bot` or `factions_test_db` predates migration 0049's final shape (for example, you regenerated it), rerun that package's vitest with `TEST_DATABASE_FRESH=1`. Never touch `factions_live`.

- [ ] **Step 6: Commit.** Commit `docs: King of the Hill runbook, CLAUDE.md, changelog, spec amendments`, with the trailer.

### Task 15: Hand-off

- [ ] **Step 1:** Push `feature/king-of-the-hill` and open the PR via `keel:finish-work`. The livonia branch from Part A is its own PR in that repo, and the runbook orders the two.
- [ ] **Step 2:** Tell the user:
  - the livonia Release must go first
  - the rehearsal in runbook step 4 is theirs to run
  - nothing has been deployed
