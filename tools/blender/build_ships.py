"""
Player ships sold at the station shipyard, built procedurally in Blender:

    hauler  Грузовик «Тягач»: bridge, a spine of twelve cargo containers, a four-nozzle drive
    miner   Шахтёр «Крот»: squat hull, two boom-mounted mining lasers, ore hopper, side tanks

    python tools/blender/build_ships.py [hauler|miner ...] [--render docs/screenshots]
    # or: blender -b -P tools/blender/build_ships.py -- [...]

Writes src/client/assets/<ship>.glb (Y up, forward = -Z like every ship in the game), and with
--render a Cycles studio shot <dir>/<ship>-blender.png (SHIP_SAMPLES samples).

The game tints three materials per pilot (src/client/entities/glb-ship.ts): Hull (main plating,
Blueprint.hull), Paint (pilot colour, Blueprint.hull2) and Accent (Blueprint.accent); EngineGlow
takes Blueprint.glow. Empties named Thruster_<n> mark the nozzle exits (custom property r = flame
radius). The origin is the ship's centre; the landing pads touch the ground LAND metres below it.
Numbers the game relies on (gun muzzles, radius, land height) live in src/shared/ships/hulls.ts
and src/shared/sim/weapons.ts (GUN_OFFSETS) and must match. Blender is Z up / +Y forward; the
glTF exporter turns that into Y up / -Z forward, so a game offset (x, y, z) is Blender (x, -z, y).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

from build_rover import Part, empty, material, parent_to, reset  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
ASSETS = os.path.join(ROOT, 'src', 'client', 'assets')

M = {}


def make_materials(paint):
    M['hull'] = material('Hull', '#ece6da', 0.08, 0.45)
    M['paint'] = material('Paint', paint, 0.15, 0.4)
    M['accent'] = material('Accent', '#e0661c', 0.1, 0.38)
    M['frame'] = material('Frame', '#3b3f45', 0.85, 0.42)
    M['alu'] = material('Aluminium', '#c3c7cc', 1.0, 0.3)
    M['dark'] = material('DarkPlastic', '#1d1f23', 0.0, 0.6)
    M['chrome'] = material('Chrome', '#e8ecef', 1.0, 0.12)
    M['glass'] = material('Glass', '#1a3c4a', 0.6, 0.05, '#2a6a80', 0.6)
    M['nozzle'] = material('Nozzle', '#2a2c30', 0.9, 0.35)
    M['glow'] = material('EngineGlow', '#8ff8ff', 0.0, 0.2, '#8ff8ff', 2.5)
    M['lamp'] = material('Lamp', '#fff6e0', 0.0, 0.1, '#fff2d6', 6.0)
    M['red'] = material('NavRed', '#ff3040', 0.0, 0.2, '#ff2030', 5.0)
    M['green'] = material('NavGreen', '#30ff70', 0.0, 0.2, '#20ff60', 5.0)
    M['beacon'] = material('Beacon', '#ffb020', 0.0, 0.2, '#ff9a10', 4.0)
    M['warn'] = material('Warning', '#e8b818', 0.1, 0.45)
    M['radiator'] = material('Radiator', '#9a6a48', 0.9, 0.35)
    M['laser'] = material('LaserLens', '#ff5a2a', 0.0, 0.1, '#ff4a20', 9.0)
    M['ore'] = material('Ore', '#6a5446', 0.2, 0.85)
    M['crystal'] = material('OreCrystal', '#7ad8ff', 0.1, 0.1, '#3ab8ff', 1.5)
    M['cargo'] = [material('CargoBlue', '#3e6c8c', 0.3, 0.5), material('CargoRust', '#9a4e2e', 0.3, 0.55),
                  material('CargoGreen', '#5c7a3c', 0.3, 0.5), material('CargoGrey', '#8a8d90', 0.4, 0.45)]


def rot_x(a):
    return Matrix.Rotation(a, 3, 'X')


def slab(p, a, b, width, thick, mat, x=0.0, out=0.0, bevel=0.02):
    """A plate lying along the (y, z) segment a→b, `out` metres off it along its outward normal."""
    a, b = Vector((x, *a)), Vector((x, *b))
    d = b - a
    ang = math.atan2(d.z, d.y)
    n = Vector((0, d.z, -d.y)).normalized()  # right-hand normal in the (y, z) plane
    c = (a + b) / 2 + n * out
    p.box(c, (width, d.length, thick), mat, rot_x(ang), bevel=bevel)


def gear_leg(p, top, foot_z, pad_r):
    """Landing leg: strut, chrome piston, knee and a round pad touching z = foot_z."""
    top = Vector(top)
    knee = Vector((top.x * 1.08, top.y, (top.z + foot_z) / 2 + 0.2))
    foot = Vector((top.x * 1.1, top.y, foot_z + 0.22))
    p.cyl(top, knee, 0.2, M['frame'], 12)
    p.sphere(knee, 0.24, M['frame'], 12, 8)
    p.cyl(knee, foot + Vector((0, 0, 0.25)), 0.14, M['chrome'], 12)
    p.cyl(knee + Vector((0, 0.35, 0)), top + Vector((0, 0.8, 0)), 0.07, M['alu'], 8)
    p.sphere(foot + Vector((0, 0, 0.12)), 0.18, M['frame'], 10, 6)
    p.cyl(Vector((foot.x, foot.y, foot_z)), Vector((foot.x, foot.y, foot_z + 0.18)), pad_r, M['dark'], 18)
    p.cyl(Vector((foot.x, foot.y, foot_z + 0.18)), Vector((foot.x, foot.y, foot_z + 0.26)), pad_r * 0.7, M['frame'], 18)


def nozzle(p, c, r, length, root, idx):
    """Engine bell along -Y from c, with a glowing throat and the thruster marker at its exit."""
    c = Vector(c)
    exit_ = c + Vector((0, -length, 0))
    p.cyl(c + Vector((0, 0.4, 0)), c, r * 0.8, M['frame'], 20)
    p.cyl(c, exit_, r * 0.72, M['nozzle'], 24, r2=r, cap=False)
    p.cyl(c + Vector((0, -length * 0.15, 0)), c + Vector((0, -length * 0.2, 0)), r * 0.8, M['alu'], 24)
    p.cyl(exit_ + Vector((0, length * 0.75, 0)), exit_ + Vector((0, length * 0.7, 0)), r * 0.66, M['glow'], 20)
    for k in range(6):
        a = 2 * math.pi * k / 6
        p.box(c + Vector((math.cos(a) * r * 0.85, -length * 0.35, math.sin(a) * r * 0.85)), (0.08, length * 0.5, 0.08), M['alu'], bevel=0.0)
    t = empty(f'Thruster_{idx}', exit_ + Vector((0, -0.05, 0)), root)
    t['r'] = round(r * 0.9, 3)


def nav_lights(p, left, right):
    p.sphere(left, 0.14, M['red'], 10, 6)
    p.sphere(right, 0.14, M['green'], 10, 6)


def rcs(p, c, sx):
    """Four-way attitude thruster block."""
    c = Vector(c)
    p.box(c, (0.5, 0.5, 0.5), M['frame'], bevel=0.06)
    for d in ((sx, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1)):
        dv = Vector(d)
        p.cyl(c + dv * 0.25, c + dv * 0.42, 0.08, M['nozzle'], 8, r2=0.12, cap=False)


# ================================================================== hauler
HAULER_LAND = 4.2


def container(p, c, mat, door_y):
    """A ribbed 3.4 x 3.8 x 3.2 cargo container; doors face -Y (door_y = -1) or +Y."""
    c = Vector(c)
    w, ln, h = 3.4, 3.8, 3.2
    p.box(c, (w, ln, h), mat, bevel=0.06)
    for k in range(7):  # corrugation on the long sides
        y = c.y - ln / 2 + 0.35 + k * (ln - 0.7) / 6
        for sx in (-1, 1):
            p.box((c.x + sx * (w / 2 + 0.03), y, c.z), (0.06, 0.16, h - 0.4), mat, bevel=0.0)
        p.box((c.x, y, c.z + h / 2 + 0.03), (w - 0.4, 0.16, 0.06), mat, bevel=0.0)
    for sx in (-1, 1):  # corner castings
        for sz in (-1, 1):
            for sy in (-1, 1):
                p.box((c.x + sx * (w / 2 - 0.1), c.y + sy * (ln / 2 - 0.1), c.z + sz * (h / 2 - 0.1)), (0.26, 0.26, 0.26), M['frame'], bevel=0.0)
    fy = c.y + door_y * (ln / 2 + 0.02)
    for x in (-0.5, 0.5):  # door locking bars
        p.box((c.x + x, fy, c.z), (0.07, 0.07, h - 0.5), M['alu'], bevel=0.0)
    p.box((c.x, fy, c.z + h / 2 - 0.45), (w - 0.6, 0.05, 0.3), M['warn'], bevel=0.0)


def build_hauler():
    reset()
    make_materials('#2f6fb0')
    root = empty('Hauler', (0, 0, 0))
    p = Part('HaulerHull')

    # --- bridge (y 6..12): side profile extruded across x
    bridge = [(6.0, -1.7), (11.0, -1.7), (12.1, -0.4), (12.1, 0.5), (11.0, 2.3), (7.2, 2.7), (6.0, 2.7)]
    p.prism(bridge, -3.0, 3.0, M['hull'], 0.12)
    p.prism([(6.2, 1.0), (11.6, 1.0), (11.75, 1.3), (6.2, 1.3)], -3.08, 3.08, M['paint'], 0.02)  # colour band
    slab(p, (12.1, 0.55), (11.05, 2.3), 5.0, 0.1, M['glass'], out=0.03)  # windscreen
    for x in (-1.25, 0.0, 1.25):
        slab(p, (12.12, 0.5), (11.03, 2.33), 0.12, 0.16, M['frame'], x=x, out=0.06, bevel=0.0)
    for sx in (-1, 1):
        p.box((sx * 3.03, 10.0, 1.55), (0.08, 1.8, 0.6), M['glass'], bevel=0.02)  # side windows
        p.box((sx * 3.03, 7.7, 1.55), (0.08, 1.6, 0.6), M['glass'], bevel=0.02)
        p.box((sx * 1.9, 11.9, -1.0), (0.7, 0.25, 0.32), M['lamp'], bevel=0.04)  # headlamps
        rcs(p, (sx * 3.15, 11.0, 2.0), sx)
    p.box((0, 12.0, -1.05), (2.4, 0.4, 0.5), M['frame'], bevel=0.08)  # chin sensor bar
    p.sphere((0, 11.4, -1.85), 0.45, M['dark'], 16, 10, (1, 1, 0.6))  # ventral sensor
    # roof: dorsal turret (muzzles at Blender (±0.5, 10.6, 3.8) = game (±0.5, 3.8, -10.6))
    p.cyl((0, 8.2, 2.55), (0, 8.2, 3.25), 1.0, M['frame'], 24)
    p.box((0, 8.4, 3.75), (2.0, 1.9, 1.0), M['paint'], bevel=0.18)
    p.box((0, 9.3, 3.85), (1.2, 0.3, 0.5), M['frame'], bevel=0.05)
    for sx in (-1, 1):
        p.cyl((sx * 0.5, 9.3, 3.8), (sx * 0.5, 10.6, 3.8), 0.12, M['frame'], 12)
        p.cyl((sx * 0.5, 10.25, 3.8), (sx * 0.5, 10.6, 3.8), 0.16, M['chrome'], 12)
    # antenna mast and beacon behind the turret
    p.cyl((1.6, 6.7, 2.7), (1.6, 6.7, 5.4), 0.06, M['alu'], 8)
    p.cyl((1.6, 6.7, 4.6), (2.4, 6.7, 4.6), 0.04, M['alu'], 6)
    p.sphere((1.6, 6.7, 5.5), 0.12, M['lamp'], 10, 6)
    p.cyl((-1.4, 6.8, 2.7), (-1.4, 6.8, 3.0), 0.25, M['dark'], 14)
    p.sphere((-1.4, 6.8, 3.12), 0.2, M['beacon'], 12, 8)
    p.box((0, 6.3, 2.85), (3.6, 0.8, 0.3), M['frame'], bevel=0.05)  # airlock collar
    nav_lights(p, (-3.1, 8.8, -0.2), (3.1, 8.8, -0.2))

    # --- spine truss (y -7.5..6)
    p.box((0, -0.8, 0.2), (2.2, 13.6, 2.2), M['frame'], bevel=0.1)
    for sx in (-1, 1):
        for sz in (-1, 1):
            p.cyl((sx * 1.15, -7.6, 0.2 + sz * 1.15), (sx * 1.15, 6.0, 0.2 + sz * 1.15), 0.12, M['alu'], 8)
    for k in range(9):
        y = -7.0 + k * 1.5
        for sx in (-1, 1):
            p.cyl((sx * 1.16, y, -0.95), (sx * 1.16, y + 1.5, 1.35), 0.06, M['alu'], 6)
    # pipes and cables along the spine top
    for x, r, mat in ((-0.6, 0.16, M['chrome']), (0.0, 0.12, M['accent']), (0.55, 0.14, M['alu'])):
        p.cyl((x, -7.5, 1.45), (x, 6.2, 1.45), r, mat, 10)

    # --- twelve containers in clamp frames, two tiers each side
    colors = [0, 1, 2, 3, 0, 2, 1, 0, 3, 1, 2, 0]
    i = 0
    for sx in (-1, 1):
        for zc in (-1.45, 1.85):
            for yc in (3.6, -0.5, -4.6):
                mat = M['cargo'][colors[i] % 4] if colors[i] != 3 or sx < 0 else M['paint']
                container(p, (sx * 2.95, yc, zc), mat, -1)
                i += 1
    for yf in (5.65, 1.55, -2.55, -6.65):
        for sx in (-1, 1):
            p.box((sx * 2.95, yf, 3.6), (3.8, 0.35, 0.3), M['frame'], bevel=0.04)
            p.box((sx * 2.95, yf, -3.2), (3.8, 0.35, 0.3), M['frame'], bevel=0.04)
            p.box((sx * 4.8, yf, 0.2), (0.3, 0.35, 7.1), M['frame'], bevel=0.04)
            p.box((sx * 4.8, yf, 0.2), (0.34, 0.12, 6.4), M['warn'], bevel=0.0)
            p.box((sx * 1.2, yf, 0.2), (0.3, 0.35, 7.1), M['frame'], bevel=0.04)

    # --- drive section (y -12..-7)
    drive = [(-12.0, -2.2), (-7.2, -2.6), (-6.8, -1.6), (-6.8, 2.4), (-7.2, 3.0), (-12.0, 2.6)]
    p.prism(drive, -4.1, 4.1, M['hull'], 0.18)
    for sx in (-1, 1):
        p.prism([(-11.6, -0.4), (-7.4, -0.4), (-7.4, 0.5), (-11.6, 0.5)], sx * 4.12, sx * 4.18, M['paint'], 0.0)
        p.box((sx * 4.2, -9.4, 1.6), (0.25, 3.4, 0.5), M['frame'], bevel=0.05)  # vents
        for k in range(5):
            p.box((sx * 4.3, -10.8 + k * 0.7, 1.6), (0.06, 0.12, 0.42), M['dark'], bevel=0.0)
        # radiator wing
        p.box((sx * 5.6, -9.4, 0.3), (3.0, 3.2, 0.14), M['radiator'], bevel=0.03)
        for k in range(8):
            p.box((sx * (4.3 + k * 0.37), -9.4, 0.3), (0.06, 3.3, 0.24), M['frame'], bevel=0.0)
        p.box((sx * 7.1, -9.4, 0.3), (0.2, 3.4, 0.4), M['frame'], bevel=0.05)
        rcs(p, (sx * 4.3, -7.4, 2.8), sx)
        rcs(p, (sx * 4.3, -11.6, -1.8), sx)
    p.sphere((-7.25, -9.4, 0.3), 0.13, M['red'], 10, 6)
    p.sphere((7.25, -9.4, 0.3), 0.13, M['green'], 10, 6)
    p.box((0, -9.6, 3.1), (5.0, 3.4, 0.5), M['frame'], bevel=0.1)  # reactor cap
    for k in range(4):
        p.cyl((-1.8 + k * 1.2, -11.0, 3.35), (-1.8 + k * 1.2, -8.2, 3.35), 0.18, M['chrome'], 10)
    p.box((0, -12.1, 0.2), (7.6, 0.3, 4.4), M['frame'], bevel=0.08)  # aft bulkhead
    n = 0
    for x in (-1.9, 1.9):
        for z in (-0.95, 1.45):
            nozzle(p, (x, -12.2, z), 1.05, 1.5, root, n)
            n += 1
    p.box((0, -12.25, 3.0), (1.4, 0.2, 0.3), M['red'], bevel=0.0)  # tail light

    # --- landing gear: pads at z = -LAND
    for sx in (-1, 1):
        gear_leg(p, (sx * 2.6, 9.0, -1.6), -HAULER_LAND, 0.75)
        gear_leg(p, (sx * 3.4, -9.6, -2.2), -HAULER_LAND, 0.75)
        p.box((sx * 2.6, 9.0, -1.75), (1.0, 1.4, 0.3), M['frame'], bevel=0.06)
        p.box((sx * 3.4, -9.6, -2.35), (1.0, 1.4, 0.3), M['frame'], bevel=0.06)

    ob = p.build()
    parent_to(ob, root)
    return root


# ================================================================== miner
MINER_LAND = 2.7


def mining_boom(p, sx):
    """Boom with a hydraulic ram and the laser emitter (lens at Blender (±2.9, 9.65, -0.75))."""
    base = Vector((sx * 2.45, 2.6, -0.4))
    tip = Vector((sx * 2.9, 8.0, -0.75))
    d = tip - base
    ang_z = math.atan2(d.x, d.y)
    ang_x = math.atan2(d.z, math.hypot(d.x, d.y))
    rot = Matrix.Rotation(-ang_z, 3, 'Z') @ Matrix.Rotation(ang_x, 3, 'X')
    p.box((base + tip) / 2, (0.75, d.length, 0.75), M['paint'], rot, bevel=0.1)
    for k in range(5):  # hazard stripes at the root
        c = base + d * (0.08 + k * 0.035)
        p.box(c, (0.8, d.length * 0.03, 0.8), M['warn'] if k % 2 == 0 else M['dark'], rot, bevel=0.0)
    p.sphere(base, 0.55, M['frame'], 16, 10)  # shoulder joint
    ram0 = base + Vector((0, 0.6, -0.65))
    ram1 = base + d * 0.6 + Vector((0, 0, -0.42))
    p.cyl(ram0, ram0.lerp(ram1, 0.55), 0.16, M['frame'], 12)
    p.cyl(ram0.lerp(ram1, 0.45), ram1, 0.1, M['chrome'], 12)
    # emitter head
    h0 = tip
    h1 = Vector((tip.x, 9.0, tip.z))
    p.cyl(h0 + Vector((0, -0.3, 0)), h1, 0.55, M['frame'], 20)
    for k in range(4):  # cooling rings
        p.torus((tip.x, 8.1 + k * 0.25, tip.z), (0, 1, 0), 0.58, 0.06, M['alu'], 24, 6)
    p.cyl(h1, (tip.x, 9.45, tip.z), 0.45, M['chrome'], 20, r2=0.22)
    p.sphere((tip.x, 9.5, tip.z), 0.2, M['laser'], 14, 10)
    p.torus((tip.x, 9.3, tip.z), (0, 1, 0), 0.36, 0.04, M['laser'], 20, 6)
    p.box((tip.x + sx * 0.55, 8.6, tip.z + 0.35), (0.2, 0.45, 0.25), M['lamp'], bevel=0.03)  # work lamp
    p.cyl((tip.x - sx * 0.2, 7.0, tip.z + 0.4), (tip.x - sx * 0.2, 8.5, tip.z + 0.4), 0.05, M['accent'], 6)  # power line


def ore_lumps(p, c, n, seed):
    import random
    rnd = random.Random(seed)
    for _ in range(n):
        o = Vector((rnd.uniform(-1.3, 1.3), rnd.uniform(-1.2, 1.2), rnd.uniform(-0.1, 0.35)))
        r = rnd.uniform(0.22, 0.42)
        mat = M['crystal'] if rnd.random() < 0.18 else M['ore']
        p.sphere(Vector(c) + o, r, mat, 6, 4, (rnd.uniform(0.8, 1.3), rnd.uniform(0.8, 1.3), rnd.uniform(0.6, 1.0)))


def build_miner():
    reset()
    make_materials('#d89a1c')
    root = empty('Miner', (0, 0, 0))
    p = Part('MinerHull')

    # --- main hull: a chunky wedge, side profile extruded across x
    body = [(-4.6, -1.7), (3.0, -1.9), (5.4, -1.2), (6.3, 0.2), (5.5, 1.5), (2.6, 1.9), (-4.0, 1.9), (-4.9, 0.6)]
    p.prism(body, -2.3, 2.3, M['hull'], 0.16)
    p.prism([(-4.6, -0.9), (5.6, -0.9), (5.85, -0.5), (-4.75, -0.5)], -2.36, 2.36, M['paint'], 0.02)
    p.prism([(-3.8, 1.9), (2.0, 1.9), (1.6, 2.4), (-3.4, 2.4)], -1.9, 1.9, M['paint'], 0.08)  # dorsal hump
    # cockpit canopy on the nose
    slab(p, (6.32, 0.25), (5.5, 1.52), 3.4, 0.1, M['glass'], out=0.03)
    for x in (-0.9, 0.9):
        slab(p, (6.34, 0.2), (5.48, 1.55), 0.12, 0.14, M['frame'], x=x, out=0.06, bevel=0.0)
    for sx in (-1, 1):
        p.box((sx * 2.33, 4.6, 0.9), (0.08, 1.3, 0.55), M['glass'], bevel=0.02)
        p.box((sx * 1.3, 6.0, -1.15), (0.5, 0.25, 0.28), M['lamp'], bevel=0.04)
        rcs(p, (sx * 2.45, 5.2, 1.6), sx)
        rcs(p, (sx * 2.45, -4.2, 1.6), sx)
    p.sphere((0, 4.0, -1.95), 0.4, M['dark'], 14, 8, (1.3, 1, 0.5))  # survey scanner
    p.cyl((0, 4.0, -2.05), (0, 4.0, -2.3), 0.12, M['laser'], 10)

    # --- ore hopper behind the cockpit, heaped with ore
    hc = Vector((0, -0.8, 2.75))
    p.box(hc + Vector((0, 0, -0.15)), (3.2, 3.4, 0.5), M['frame'], bevel=0.05)
    for sx in (-1, 1):
        p.box(hc + Vector((sx * 1.55, 0, 0.2)), (0.14, 3.4, 0.9), M['frame'], bevel=0.03)
        p.box(hc + Vector((0, sx * 1.65, 0.2)), (3.2, 0.14, 0.9), M['frame'], bevel=0.03)
    p.box(hc + Vector((0, 1.72, 0.45)), (3.3, 0.06, 0.25), M['warn'], bevel=0.0)
    ore_lumps(p, hc, 16, 7)
    # crane arm over the hopper
    p.cyl((1.2, 1.3, 2.4), (1.2, 1.3, 4.0), 0.12, M['frame'], 10)
    p.cyl((1.2, 1.3, 4.0), (0.0, -0.6, 4.3), 0.09, M['paint'], 10)
    p.cyl((0.0, -0.6, 4.3), (0.0, -0.6, 3.6), 0.02, M['alu'], 6)
    p.box((0.0, -0.6, 3.5), (0.3, 0.3, 0.2), M['frame'], bevel=0.03)

    # --- side ore tanks
    for sx in (-1, 1):
        a, b = Vector((sx * 3.25, -4.0, -0.5)), Vector((sx * 3.25, 2.2, -0.5))
        p.cyl(a, b, 1.05, M['paint'], 24)
        p.sphere(b, 1.05, M['paint'], 24, 12, (1, 0.45, 1))
        p.sphere(a, 1.05, M['paint'], 24, 12, (1, 0.45, 1))
        for y in (-3.0, -1.0, 1.0):
            p.torus((sx * 3.25, y, -0.5), (0, 1, 0), 1.07, 0.07, M['frame'], 28, 6)
        p.box((sx * 2.55, -0.9, -0.5), (0.6, 4.4, 0.5), M['frame'], bevel=0.05)  # pylon
        p.cyl((sx * 3.25, -1.9, 0.55), (sx * 3.25, -1.9, 0.75), 0.25, M['frame'], 12)  # filler cap
        p.sphere((sx * 4.32, -0.9, -0.5), 0.12, M['red'] if sx < 0 else M['green'], 10, 6)
        mining_boom(p, sx)

    # --- drive
    p.box((0, -4.95, 0.1), (4.2, 0.4, 2.8), M['frame'], bevel=0.08)
    n = 0
    for x in (-1.25, 1.25):
        nozzle(p, (x, -5.1, 0.1), 0.85, 1.3, root, n)
        n += 1
    nozzle(p, (0, -5.1, 1.55), 0.45, 0.8, root, n)
    # beacon and antenna on the hump
    p.cyl((-1.2, -3.0, 2.4), (-1.2, -3.0, 2.7), 0.2, M['dark'], 12)
    p.sphere((-1.2, -3.0, 2.8), 0.16, M['beacon'], 12, 8)
    p.cyl((1.3, -3.4, 2.4), (1.3, -3.4, 4.2), 0.05, M['alu'], 6)
    p.sphere((1.3, -3.4, 4.25), 0.08, M['lamp'], 8, 6)

    # --- landing gear: pads at z = -LAND
    for sx in (-1, 1):
        gear_leg(p, (sx * 1.7, 3.6, -1.5), -MINER_LAND, 0.55)
        gear_leg(p, (sx * 1.7, -3.4, -1.4), -MINER_LAND, 0.55)

    ob = p.build()
    parent_to(ob, root)
    return root


SHIPS = {'hauler': build_hauler, 'miner': build_miner}
LAND = {'hauler': HAULER_LAND, 'miner': MINER_LAND}
CAMS = {'hauler': (24.0, 27.0, 11.0), 'miner': (14.5, 16.5, 7.0)}


def export(name):
    path = os.path.join(ASSETS, f'{name}.glb')
    os.makedirs(ASSETS, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', export_yup=True, export_apply=True,
        export_extras=True, export_cameras=False, export_lights=False, export_animations=False,
    )
    tris = 0
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
            for v in o.data.vertices:
                w = o.matrix_world @ v.co
                lo = Vector(map(min, lo, w))
                hi = Vector(map(max, hi, w))
    print(f'{name}: {tris} triangles, bounds {tuple(round(x, 2) for x in lo)} .. {tuple(round(x, 2) for x in hi)} -> {path} ({os.path.getsize(path) // 1024} KB)')


def render(name, out_dir):
    """Studio shot on a landing pad (Cycles, CPU)."""
    sc = bpy.context.scene
    world = bpy.data.worlds.new('World')
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.02, 0.022, 0.03, 1)
    sc.world = world
    ground = Part('Ground')
    ground.box((0, 0, -LAND[name] - 0.25), (80, 80, 0.5), material('Pad', '#4a4d52', 0.5, 0.6), bevel=0.0)
    ground.build()
    for nm, loc, energy, size in (('Key', (14, 10, 16), 9000, 8), ('Rim', (-12, -16, 10), 7000, 6), ('Fill', (-14, 12, 4), 1800, 10)):
        ld = bpy.data.lights.new(nm, 'AREA')
        ld.energy = energy
        ld.size = size
        lo = bpy.data.objects.new(nm, ld)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        sc.collection.objects.link(lo)
    cd = bpy.data.cameras.new('Cam')
    cd.lens = 40
    cam = bpy.data.objects.new('Cam', cd)
    cam.location = CAMS[name]
    cam.rotation_euler = (Vector((0, 0, -0.5)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = int(os.environ.get('SHIP_SAMPLES', '48'))
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.filepath = os.path.join(out_dir, f'{name}-blender.png')
    sc.view_settings.view_transform = 'AgX'
    bpy.ops.render.render(write_still=True)
    print(f'render -> {sc.render.filepath}')


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    out = None
    if '--render' in argv:
        i = argv.index('--render')
        out = os.path.abspath(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]
    for name in (argv or list(SHIPS)):
        SHIPS[name]()
        export(name)
        if out:
            render(name, out)
