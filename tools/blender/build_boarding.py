"""
The inside of a boardable NPC ship (pirate fighter or convoy freighter), built procedurally in Blender.

    blender -b -P tools/blender/build_boarding.py -- [--render docs/screenshots/boarding-blender.png]
    # or with the bpy module: python tools/blender/build_boarding.py [--render ...]

Writes src/client/assets/boarding.glb (glTF binary, Y up). Everything is in the ship's deck
coordinates (see src/shared/boarding.ts): x to starboard, y up from the floor, -z towards the
bow. Blender is Z up, so a deck point (x, y, z) is the Blender point (x, -z, y); see D().

Rooms (match SHIP_ROOMS): airlock at the stern, a corridor, the hold to port, crew quarters and
the engine room to starboard, the bridge in the bow with a big window on real space.

Nodes the game uses (src/client/world/ship-interior.ts):

    Shell, Corridor, Airlock, Hold, Quarters, Engine, Bridge     static rooms and furniture
    HatchInner_L / HatchInner_R     airlock door leaves, slide along x
    Chest, ChestLid                 the hold's strongbox; the lid swings about its back edge
    materials ReactorGlow, AlarmGlow, HelmScreen, ChestGlow are animated; Glass is see-through

Walls stand on the segments of SHIP_WALLS; the crates, bunks, reactor and consoles stand where
SHIP_POSTS puts the walking obstacles.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
import bmesh  # noqa: E402,F401
from mathutils import Euler, Vector  # noqa: E402

from build_rover import Part, empty, material, parent_to, reset  # noqa: E402,F401

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'src', 'client', 'assets', 'boarding.glb')

# ------------------------------------------------------------------ layout (match src/shared/boarding.ts)
ROOMS = {
    'airlock': (-2, 10, 2, 16, 3.0),
    'corridor': (-1.75, -10, 1.75, 10, 3.0),
    'hold': (-13, -4, -1.75, 9, 5.5),
    'quarters': (1.75, 1, 11, 9, 3.0),
    'engine': (1.75, -9, 11, -1, 4.0),
    'bridge': (-6, -20, 6, -10, 3.6),
}
WALLS = [
    (-2, 16, 2, 16), (-2, 10, -2, 16), (2, 10, 2, 16), (-2, 10, -1.2, 10), (1.2, 10, 2, 10),
    (-1.75, -10, -1.75, 1), (-1.75, 4, -1.75, 10),
    (1.75, -10, 1.75, -6), (1.75, -4, 1.75, 3.5), (1.75, 5.5, 1.75, 10),
    (-13, -4, -13, 9), (-13, 9, -1.75, 9), (-13, -4, -1.75, -4),
    (1.75, 9, 11, 9), (11, 1, 11, 9), (1.75, 1, 11, 1),
    (1.75, -1, 11, -1), (11, -9, 11, -1), (1.75, -9, 11, -9),
    (-6, -10, -1.75, -10), (1.75, -10, 6, -10), (-6, -20, -6, -10), (6, -20, 6, -10),
]
# doorways (wall line, along-axis span, lintel from this height up)
DOORS = [
    ('x', -1.75, 1, 4, 2.5),     # hold
    ('x', 1.75, 3.5, 5.5, 2.4),  # quarters
    ('x', 1.75, -6, -4, 2.4),    # engine room
    ('z', 10, -1.2, 1.2, 2.5),   # airlock inner hatch
    ('z', -10, -1.75, 1.75, 3.0),  # bridge (open)
]
CHEST = (-8, 2.5)
HELM = (0, -16.6)
WALL_H = 5.8
T = 0.2  # wall thickness


def D(x, y, z):
    """Deck point -> Blender point."""
    return (x, -z, y)


def S(w, h, d):
    """Deck box size (along x, y, z) -> Blender size."""
    return (w, d, h)


M = {}


def make_materials():
    M['floor'] = material('Floor', '#3a3d40', 0.7, 0.55)
    M['grate'] = material('Grate', '#24272a', 0.85, 0.5)
    M['wall'] = material('Wall', '#7d847c', 0.35, 0.55)
    M['wall2'] = material('WallDark', '#545a55', 0.4, 0.6)
    M['panel'] = material('Panel', '#9aa09a', 0.3, 0.45)
    M['rib'] = material('Rib', '#2f3337', 0.8, 0.4)
    M['ceil'] = material('Ceiling', '#4b5054', 0.5, 0.6)
    M['pipe'] = material('Pipe', '#a8a29a', 0.9, 0.35)
    M['copper'] = material('Copper', '#b0703a', 1.0, 0.35)
    M['red'] = material('PipeRed', '#8a2a22', 0.3, 0.5)
    M['yellow'] = material('Hazard', '#e0b020', 0.1, 0.5)
    M['black'] = material('HazardBlack', '#141414', 0.1, 0.6)
    M['crate'] = material('Crate', '#56603e', 0.2, 0.6)
    M['crate2'] = material('CrateOrange', '#b4602a', 0.2, 0.55)
    M['crate3'] = material('CrateBlue', '#2f4a6a', 0.2, 0.55)
    M['strap'] = material('Strap', '#1c1c1c', 0.0, 0.8)
    M['barrel'] = material('Barrel', '#7a2a24', 0.5, 0.45)
    M['steel'] = material('Steel', '#c8ccd0', 1.0, 0.25)
    M['dark'] = material('DarkMetal', '#1e2124', 0.8, 0.45)
    M['fabric'] = material('Fabric', '#3a4a5a', 0.0, 0.9)
    M['sheet'] = material('Sheet', '#c8c4b8', 0.0, 0.85)
    M['wood'] = material('Wood', '#5a4430', 0.0, 0.6)
    M['seat'] = material('Seat', '#2a2a2e', 0.0, 0.75)
    M['glow'] = material('Glow', '#fff6e8', 0.0, 0.3, '#fff0dc', 2.2)
    M['blue'] = material('TrimGlow', '#60c8ff', 0.0, 0.3, '#40b0ff', 1.4)
    M['green'] = material('StatusGreen', '#40ff80', 0.0, 0.3, '#30ff70', 2.5)
    M['screen'] = material('Screen', '#0a2030', 0.0, 0.2, '#38a8ff', 1.6)
    M['screen2'] = material('ScreenAmber', '#2a1a08', 0.0, 0.2, '#ffa030', 1.4)
    # animated by the game
    M['reactor'] = material('ReactorGlow', '#80e0ff', 0.0, 0.2, '#50d0ff', 2.0)
    M['alarm'] = material('AlarmGlow', '#ff3020', 0.0, 0.3, '#ff2010', 0.2)
    M['helm'] = material('HelmScreen', '#0a1830', 0.0, 0.2, '#40a0ff', 1.4)
    M['lock'] = material('ChestGlow', '#ff3020', 0.0, 0.3, '#ff2010', 1.6)
    M['glass'] = material('Glass', '#a8d8ff', 0.0, 0.05)
    M['glass'].node_tree.nodes['Principled BSDF'].inputs['Alpha'].default_value = 0.12
    M['glass'].surface_render_method = 'BLENDED'


def box(p, c, s, mat, **kw):
    kw.setdefault('bevel', 0)
    p.box(D(*c), S(*s), mat, **kw)


def cyl(p, a, b, r, mat, **kw):
    p.cyl(D(*a), D(*b), r, mat, **kw)


def hazard(p, x0, z0, x1, z1, y=0.012, w=0.25):
    """A yellow-black striped band on the floor from (x0, z0) to (x1, z1)."""
    l = math.hypot(x1 - x0, z1 - z0)
    n = max(2, int(l / 0.4))
    for i in range(n):
        t0, t1 = i / n, (i + 1) / n
        cx, cz = x0 + (x1 - x0) * (t0 + t1) / 2, z0 + (z1 - z0) * (t0 + t1) / 2
        along_x = abs(x1 - x0) > abs(z1 - z0)
        size = (l / n, 0.01, w) if along_x else (w, 0.01, l / n)
        box(p, (cx, y, cz), size, M['yellow' if i % 2 else 'black'])


# ------------------------------------------------------------------ shell
def build_shell():
    """Floors, ceilings, walls with lintels over the doorways, light strips."""
    p = Part('Shell')
    for key, (x0, z0, x1, z1, ceil) in ROOMS.items():
        cx, cz, w, d = (x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, z1 - z0
        box(p, (cx, -0.1, cz), (w + T, 0.2, d + T), M['floor'])
        box(p, (cx, ceil + 0.1, cz), (w + T, 0.2, d + T), M['ceil'])
        # floor plates
        step = 1.0
        for i in range(1, int(w / step)):
            box(p, (x0 + i * step, 0.003, cz), (0.03, 0.006, d), M['grate'])
        for i in range(1, int(d / step)):
            box(p, (cx, 0.003, z0 + i * step), (w, 0.006, 0.03), M['grate'])
        # ceiling light strips along the room's long side
        if w > d:
            for k in ((-0.25, 0.25) if d > 6 else (0,)):
                box(p, (cx, ceil - 0.02, cz + k * d), (w - 1.0, 0.04, 0.22), M['glow'])
        else:
            for k in ((-0.25, 0.25) if w > 6 else (0,)):
                box(p, (cx + k * w, ceil - 0.02, cz), (0.22, 0.04, d - 1.0), M['glow'])
    for x0, z0, x1, z1 in WALLS:
        l = math.hypot(x1 - x0, z1 - z0)
        cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
        if abs(x1 - x0) > abs(z1 - z0):
            box(p, (cx, WALL_H / 2, cz), (l + T, WALL_H, T), M['wall'])
        else:
            box(p, (cx, WALL_H / 2, cz), (T, WALL_H, l + T), M['wall'])
    # lintels and door frames
    for axis, at, a, b, top in DOORS:
        c, l = (a + b) / 2, b - a
        if axis == 'x':
            box(p, (at, (top + WALL_H) / 2, c), (T, WALL_H - top, l), M['wall'])
            for s in (a, b):
                box(p, (at, top / 2, s), (T + 0.16, top, 0.16), M['rib'])
            box(p, (at, top - 0.08, c), (T + 0.16, 0.16, l + 0.16), M['rib'])
            hazard(p, at, a, at, b, w=0.5)
        else:
            box(p, (c, (top + WALL_H) / 2, at), (l, WALL_H - top, T), M['wall'])
            for s in (a, b):
                box(p, (s, top / 2, at), (0.16, top, T + 0.16), M['rib'])
            box(p, (c, top - 0.08, at), (l + 0.16, 0.16, T + 0.16), M['rib'])
            hazard(p, a, at, b, at, w=0.5)
    # the bridge's front wall: a window from 1.1 m to 3.1 m between x -5 and 5
    box(p, (0, 0.55, -20), (12 + T, 1.1, T), M['wall'])
    box(p, (0, (3.1 + WALL_H) / 2, -20), (12 + T, WALL_H - 3.1, T), M['wall'])
    for x in (-5.5, 5.5):
        box(p, (x, 2.1, -20), (1.0 + T, 2.0, T), M['wall'])
    for x in (-5, -2.5, 0, 2.5, 5):
        box(p, (x, 2.1, -20.02), (0.14, 2.1, 0.3), M['rib'])
    box(p, (0, 1.1, -19.95), (10.2, 0.12, 0.35), M['rib'])
    box(p, (0, 3.1, -19.95), (10.2, 0.12, 0.35), M['rib'])
    p.build()
    g = Part('Glass')
    box(g, (0, 2.1, -20.05), (10, 2.0, 0.04), M['glass'])
    g.build()


def wall_dressing(p, x0, z0, x1, z1, ceil, inward):
    """Panels, ribs every 2 m and a lit trim along a wall; `inward` = unit (nx, nz) into the room."""
    nx, nz = inward
    l = math.hypot(x1 - x0, z1 - z0)
    along_x = abs(x1 - x0) > abs(z1 - z0)
    off = T / 2 + 0.03
    cx, cz = (x0 + x1) / 2 + nx * off, (z0 + z1) / 2 + nz * off
    size = (lambda a, h, b: (a, h, b)) if along_x else (lambda a, h, b: (b, h, a))
    box(p, (cx, 0.55, cz), size(l, 1.1, 0.06), M['wall2'])
    box(p, (cx, ceil - 0.35, cz), size(l, 0.08, 0.05), M['blue'])
    n = int(l / 2)
    for i in range(1, n + 1):
        t = i / (n + 1)
        x, z = x0 + (x1 - x0) * t + nx * (off + 0.05), z0 + (z1 - z0) * t + nz * (off + 0.05)
        box(p, (x, ceil / 2, z), size(0.14, ceil, 0.16), M['rib'], bevel=0.01)


# ------------------------------------------------------------------ rooms
def build_corridor():
    p = Part('Corridor')
    x0, z0, x1, z1, ceil = ROOMS['corridor']
    # a grated walkway with gutters
    box(p, (0, 0.02, 0), (2.0, 0.04, 20), M['grate'])
    for x in (-1.2, 1.2):
        box(p, (x, 0.01, 0), (0.3, 0.02, 20), M['dark'])
    # frames every 2.5 m: posts up the walls and a beam overhead
    for z in range(-8, 10, 3):
        if 0.5 < z < 4.5 or -6.5 < z < -3.5:
            continue
        for x in (-1.6, 1.6):
            box(p, (x, ceil / 2, z), (0.16, ceil, 0.22), M['rib'], bevel=0.02)
        box(p, (0, ceil - 0.15, z), (3.4, 0.2, 0.22), M['rib'], bevel=0.02)
    # pipes in the upper corners and a cable tray
    for x, r, mat in ((-1.4, 0.09, M['pipe']), (-1.15, 0.06, M['red']), (1.4, 0.08, M['copper']), (1.18, 0.05, M['pipe'])):
        cyl(p, (x, ceil - 0.35, -10), (x, ceil - 0.35, 10), r, mat, segs=10)
    box(p, (0.75, ceil - 0.08, 0), (0.5, 0.06, 20), M['dark'])
    # alarm lamps and small wall screens
    a = Part('CorridorAlarms')
    for z in (-7, 0, 7):
        for x in (-1.55, 1.55):
            a.sphere(D(x, ceil - 0.6, z), 0.11, M['alarm'], 12, 8)
            box(a, (x, ceil - 0.6, z), (0.05, 0.16, 0.26), M['dark'])
    a.build()
    for z, x in ((-2, -1.62), (7, 1.62), (-8.5, 1.62)):
        box(p, (x, 1.5, z), (0.06, 0.55, 0.8), M['dark'])
        box(p, (x - math.copysign(0.035, x), 1.5, z), (0.02, 0.45, 0.7), M['screen'])
    p.build()


def build_airlock():
    p = Part('Airlock')
    x0, z0, x1, z1, ceil = ROOMS['airlock']
    for x0_, z0_, x1_, z1_, n in ((-2, 10, -2, 16, (1, 0)), (2, 10, 2, 16, (-1, 0))):
        wall_dressing(p, x0_, z0_, x1_, z1_, ceil, n)
    # the outer hatch: a heavy octagonal door with a wheel
    oct_r = 1.25
    for i in range(8):
        a0, a1 = 2 * math.pi * i / 8 + math.pi / 8, 2 * math.pi * (i + 1) / 8 + math.pi / 8
        pa = (math.cos(a0) * oct_r, 1.45 + math.sin(a0) * oct_r)
        pb = (math.cos(a1) * oct_r, 1.45 + math.sin(a1) * oct_r)
        cyl(p, (pa[0], pa[1], 15.85), (pb[0], pb[1], 15.85), 0.1, M['yellow'], segs=8)
    box(p, (0, 1.45, 15.9), (2.2, 2.2, 0.1), M['wall2'], bevel=0.05)
    p.torus(D(0, 1.45, 15.7), (0, 1, 0), 0.38, 0.04, M['steel'], 24, 8)
    for k in range(3):
        a = math.pi * k / 3
        cyl(p, (math.cos(a) * 0.38, 1.45 + math.sin(a) * 0.38, 15.7), (-math.cos(a) * 0.38, 1.45 - math.sin(a) * 0.38, 15.7), 0.025, M['steel'], segs=8)
    # status lamps by the inner hatch, suit lockers along the sides
    for x, mat in ((-1.5, M['green']), (1.5, M['alarm'])):
        p.sphere(D(x, 2.75, 10.15), 0.07, mat, 10, 6)
    for x in (-1.75, 1.75):
        for z in (12, 13.4):
            box(p, (x, 1.1, z), (0.4, 2.2, 1.2), M['wall2'], bevel=0.03)
            box(p, (x - math.copysign(0.21, x), 1.1, z), (0.02, 2.0, 0.04), M['dark'])
    hazard(p, -1.8, 15.6, 1.8, 15.6, w=0.4)
    p.build()
    # the inner hatch's two leaves (they slide along x), origins at their centres
    for side, name in ((-1, 'HatchInner_L'), (1, 'HatchInner_R')):
        h = Part(name)
        cx = side * 0.6
        box(h, (cx, 1.25, 10), (1.2, 2.5, 0.12), M['wall2'], bevel=0.03)
        box(h, (cx, 1.25, 10.07), (1.0, 2.2, 0.02), M['panel'])
        box(h, (cx - side * 0.5, 1.25, 10.08), (0.06, 2.3, 0.03), M['yellow'])
        box(h, (cx, 1.6, 10.09), (0.5, 0.3, 0.02), M['screen'])
        h.build(origin=D(cx, 1.25, 10))


def build_hold():
    p = Part('Hold')
    x0, z0, x1, z1, ceil = ROOMS['hold']
    for seg, n in (((-13, -4, -13, 9), (1, 0)), ((-13, 9, -1.75, 9), (0, -1)), ((-13, -4, -1.75, -4), (0, 1))):
        wall_dressing(p, *seg, ceil, n)
    # big frames across the ceiling and a crane rail with a hook
    for z in (-1, 3, 7):
        box(p, ((x0 + x1) / 2, ceil - 0.25, z), (x1 - x0, 0.3, 0.3), M['rib'], bevel=0.03)
    box(p, (-7.5, ceil - 0.55, 2.5), (0.3, 0.2, 12.5), M['yellow'])
    box(p, (-7.5, ceil - 0.75, 4.5), (0.6, 0.3, 0.6), M['dark'], bevel=0.04)
    cyl(p, (-7.5, ceil - 0.9, 4.5), (-7.5, 2.7, 4.5), 0.02, M['steel'], segs=6)
    p.torus(D(-7.5, 2.55, 4.5), (1, 0, 0), 0.14, 0.035, M['steel'], 16, 6)
    # loading zone markings around the strongbox
    cx, cz = CHEST
    for a, b in (((cx - 2, cz - 1.8), (cx + 2, cz - 1.8)), ((cx - 2, cz + 1.8), (cx + 2, cz + 1.8))):
        hazard(p, a[0], a[1], b[0], b[1], w=0.18)
    # crate stacks (see SHIP_POSTS)
    def crate(x, y, z, s, mat, rot=0.0):
        r = Euler((0, 0, rot)).to_matrix()
        p.box(D(x, y + s[1] / 2, z), S(*s), mat, rot=r, bevel=0.03)
        for k in (-0.3, 0.3):
            p.box(D(x, y + s[1] / 2, z + k * s[2]), S(s[0] + 0.02, s[1] + 0.02, 0.06), M['strap'], rot=r, bevel=0)
    crate(-11.4, 0, 7.4, (1.2, 1.2, 1.2), M['crate'])
    crate(-10.2, 0, 7.4, (1.1, 1.0, 1.1), M['crate2'], 0.1)
    crate(-11.3, 0, 6.2, (1.2, 1.2, 1.1), M['crate3'])
    crate(-11.2, 1.2, 7.2, (1.0, 0.9, 1.0), M['crate'], -0.15)
    crate(-11.2, 0, -2.4, (1.3, 1.3, 1.3), M['crate2'])
    crate(-10.6, 0, -1.2, (1.0, 0.9, 1.0), M['crate'], 0.3)
    crate(-11.3, 1.3, -2.3, (1.1, 1.0, 1.1), M['crate3'], 0.1)
    crate(-6.0, 0, -2.6, (1.2, 1.0, 1.0), M['crate'], 0.05)
    crate(-6.4, 1.0, -2.6, (0.9, 0.8, 0.9), M['crate2'], -0.2)
    for x, z in ((-5.3, 7.4), (-4.6, 7.0), (-5.0, 7.9)):
        cyl(p, (x, 0, z), (x, 1.15, z), 0.35, M['barrel'], segs=16)
        for y in (0.2, 0.95):
            p.torus(D(x, y, z), (0, 0, 1), 0.36, 0.025, M['dark'], 16, 6)
    # a cargo net hung on the far wall
    for i in range(9):
        x = -12.5 + i * 0.6
        cyl(p, (x, 0.4, 8.85), (x, 3.6, 8.85), 0.015, M['strap'], segs=5)
    for k in range(6):
        y = 0.4 + k * 0.64
        cyl(p, (-12.5, y, 8.85), (-7.7, y, 8.85), 0.015, M['strap'], segs=5)
    p.build()
    # the strongbox: body and a lid hinged at its back edge (deck +z... the far side, z + 0.6)
    c = Part('Chest')
    box(c, (cx, 0.45, cz), (1.8, 0.9, 1.2), M['steel'], bevel=0.05)
    box(c, (cx, 0.45, cz), (1.86, 0.12, 1.26), M['dark'])
    for x in (cx - 0.7, cx + 0.7):
        box(c, (x, 0.45, cz), (0.1, 0.92, 1.24), M['dark'])
    box(c, (cx, 0.62, cz - 0.62), (0.32, 0.22, 0.04), M['dark'])
    box(c, (cx, 0.62, cz - 0.645), (0.2, 0.08, 0.02), M['lock'])
    # inside: what the hold kept (seen once the lid is up)
    box(c, (cx - 0.4, 0.75, cz), (0.6, 0.2, 0.8), M['copper'])
    box(c, (cx + 0.35, 0.78, cz + 0.1), (0.5, 0.25, 0.5), M['crate3'])
    c.build()
    lid = Part('ChestLid')
    box(lid, (cx, 1.0, cz), (1.82, 0.2, 1.22), M['steel'], bevel=0.05)
    box(lid, (cx, 1.11, cz), (1.4, 0.03, 0.8), M['yellow'])
    lid.build(origin=D(cx, 0.9, cz + 0.6))


def build_quarters():
    p = Part('Quarters')
    x0, z0, x1, z1, ceil = ROOMS['quarters']
    for seg, n in (((1.75, 9, 11, 9), (0, -1)), ((11, 1, 11, 9), (-1, 0)), ((1.75, 1, 11, 1), (0, 1))):
        wall_dressing(p, *seg, ceil, n)
    # two bunk beds against the far wall (two tiers each)
    for bx in (4.6, 8.6):
        for y in (0.45, 1.75):
            box(p, (bx, y, 8.0), (2.1, 0.12, 0.95), M['dark'], bevel=0.02)
            box(p, (bx, y + 0.13, 8.0), (2.0, 0.14, 0.88), M['sheet'], bevel=0.04)
            box(p, (bx + 0.2, y + 0.22, 8.0), (1.4, 0.06, 0.9), M['fabric'], bevel=0.02)
            box(p, (bx - 0.8, y + 0.25, 8.0), (0.35, 0.12, 0.6), M['sheet'], bevel=0.05)
        for dx in (-1.02, 1.02):
            for dz in (-0.44, 0.44):
                box(p, (bx + dx, 1.25, 8.0 + dz), (0.06, 2.5, 0.06), M['rib'])
        box(p, (bx + 1.02, 1.2, 7.5), (0.04, 1.2, 0.04), M['steel'])
    # the mess table with benches
    tx, tz = 6.6, 3.6
    box(p, (tx, 0.78, tz), (1.8, 0.07, 1.0), M['wood'], bevel=0.02)
    box(p, (tx, 0.4, tz), (0.2, 0.75, 0.2), M['rib'])
    for dz in (-0.85, 0.85):
        box(p, (tx, 0.45, tz + dz), (1.6, 0.08, 0.35), M['seat'], bevel=0.02)
        box(p, (tx, 0.22, tz + dz), (0.12, 0.45, 0.12), M['rib'])
    # mugs and a deck of cards on the table
    for dx, dz in ((-0.5, 0.2), (0.3, -0.25)):
        cyl(p, (tx + dx, 0.82, tz + dz), (tx + dx, 0.92, tz + dz), 0.045, M['red'], segs=10)
    box(p, (tx + 0.1, 0.83, tz + 0.15), (0.12, 0.02, 0.18), M['sheet'])
    # lockers along the starboard wall, a screen
    for z in (2.0, 2.8, 3.6, 4.4):
        box(p, (10.65, 1.05, z), (0.5, 2.1, 0.76), M['wall2'], bevel=0.02)
        box(p, (10.39, 1.5, z), (0.02, 0.3, 0.05), M['dark'])
    box(p, (2.0, 1.6, 7.0), (0.06, 0.7, 1.1), M['dark'])
    box(p, (2.04, 1.6, 7.0), (0.02, 0.6, 1.0), M['screen2'])
    p.build()


def build_engine():
    p = Part('Engine')
    x0, z0, x1, z1, ceil = ROOMS['engine']
    for seg, n in (((1.75, -1, 11, -1), (0, -1)), ((11, -9, 11, -1), (-1, 0)), ((1.75, -9, 11, -9), (0, 1))):
        wall_dressing(p, *seg, ceil, n)
    rx, rz = 7.0, -5.0
    # the reactor: a squat drum with a glowing core between two collars
    cyl(p, (rx, 0, rz), (rx, 0.5, rz), 1.6, M['dark'], segs=32)
    cyl(p, (rx, 0.5, rz), (rx, 0.8, rz), 1.45, M['steel'], segs=32)
    cyl(p, (rx, 0.8, rz), (rx, 2.7, rz), 0.95, M['reactor'], segs=32)
    for y in (1.2, 1.75, 2.3):
        p.torus(D(rx, y, rz), (0, 0, 1), 1.0, 0.07, M['rib'], 32, 8)
    for k in range(6):
        a = 2 * math.pi * k / 6
        cyl(p, (rx + math.cos(a) * 1.08, 0.8, rz + math.sin(a) * 1.08), (rx + math.cos(a) * 1.08, 2.7, rz + math.sin(a) * 1.08), 0.06, M['steel'], segs=8)
    cyl(p, (rx, 2.7, rz), (rx, 3.0, rz), 1.45, M['steel'], segs=32)
    cyl(p, (rx, 3.0, rz), (rx, ceil, rz), 0.5, M['dark'], segs=16)
    # coolant pipes to the walls
    for a, mat in ((0.3, M['copper']), (1.9, M['pipe']), (3.6, M['red']), (5.0, M['copper'])):
        ex, ez = rx + math.cos(a) * 1.5, rz + math.sin(a) * 1.5
        wx = min(max(ex + math.cos(a) * 3, x0 + 0.3), x1 - 0.3)
        wz = min(max(ez + math.sin(a) * 3, z0 + 0.3), z1 - 0.3)
        p.tube([Vector(D(ex, 0.65, ez)), Vector(D(ex, ceil - 0.6, ez)), Vector(D(wx, ceil - 0.6, wz))], 0.08, mat, 10)
    # control desk by the door, warning stripes round the reactor
    box(p, (3.0, 0.5, -8.2), (1.8, 1.0, 0.8), M['wall2'], bevel=0.03)
    box(p, (3.0, 1.05, -8.05), (1.6, 0.06, 0.6), M['dark'])
    box(p, (3.0, 1.35, -8.5), (1.4, 0.55, 0.05), M['screen2'])
    for i in range(16):
        a0, a1 = 2 * math.pi * i / 16, 2 * math.pi * (i + 1) / 16
        mx, mz = rx + math.cos((a0 + a1) / 2) * 1.95, rz + math.sin((a0 + a1) / 2) * 1.95
        p.box(D(mx, 0.006, mz), S(0.78, 0.01, 0.3), M['yellow' if i % 2 else 'black'], rot=Euler((0, 0, -(a0 + a1) / 2)).to_matrix(), bevel=0)
    p.build()


def build_bridge():
    p = Part('Bridge')
    x0, z0, x1, z1, ceil = ROOMS['bridge']
    for seg, n in (((-6, -20, -6, -10), (1, 0)), ((6, -20, 6, -10), (-1, 0))):
        wall_dressing(p, *seg, ceil, n)
    # a raised floor ring and the helm console (the pilot stands behind it, facing the window)
    box(p, (0, 0.03, -15.5), (9, 0.06, 7), M['grate'])
    hx, hz = HELM
    box(p, (hx, 0.45, hz - 1.2), (1.9, 0.9, 0.9), M['wall2'], bevel=0.05)
    p.box(D(hx, 1.0, hz - 1.0), S(1.8, 0.08, 0.8), M['dark'], rot=Euler((math.radians(-20), 0, 0)).to_matrix(), bevel=0.01)
    p.box(D(hx, 1.04, hz - 1.0), S(1.4, 0.02, 0.55), M['helm'], rot=Euler((math.radians(-20), 0, 0)).to_matrix(), bevel=0)
    box(p, (hx, 1.55, hz - 1.55), (1.6, 0.8, 0.06), M['dark'])
    box(p, (hx, 1.55, hz - 1.51), (1.45, 0.66, 0.02), M['helm'])
    # the yoke
    cyl(p, (hx, 1.0, hz - 0.75), (hx, 1.0, hz - 0.55), 0.04, M['steel'], segs=8)
    cyl(p, (hx - 0.25, 1.0, hz - 0.52), (hx + 0.25, 1.0, hz - 0.52), 0.03, M['dark'], segs=8)
    # side stations
    for sx in (-4.2, 4.2):
        box(p, (sx, 0.45, -17.6), (1.3, 0.9, 1.2), M['wall2'], bevel=0.04)
        box(p, (sx, 1.25, -18.0), (1.2, 0.7, 0.05), M['dark'])
        box(p, (sx, 1.25, -17.97), (1.05, 0.58, 0.02), M['screen'] if sx < 0 else M['screen2'])
    # captain's chair
    box(p, (0, 0.45, -13.4), (0.7, 0.12, 0.7), M['seat'], bevel=0.04)
    box(p, (0, 0.95, -13.08), (0.7, 0.9, 0.12), M['seat'], bevel=0.04)
    cyl(p, (0, 0, -13.4), (0, 0.42, -13.4), 0.08, M['steel'], segs=10)
    # star chart on the port wall, an alarm over the window
    box(p, (-5.85, 1.9, -14), (0.05, 1.2, 2.4), M['dark'])
    box(p, (-5.82, 1.9, -14), (0.02, 1.05, 2.2), M['screen'])
    for x in (-3, 3):
        p.sphere(D(x, 3.35, -19.7), 0.12, M['alarm'], 12, 8)
    p.build()


def build():
    reset()
    make_materials()
    build_shell()
    build_corridor()
    build_airlock()
    build_hold()
    build_quarters()
    build_engine()
    build_bridge()


def export(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', export_yup=True, export_apply=True,
        export_extras=True, export_cameras=False, export_lights=False, export_animations=False,
    )
    tris = 0
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    print(f'boarding: {tris} triangles -> {path} ({os.path.getsize(path) // 1024} KB)')


def render(path, view='corridor'):
    """A look down the corridor from the airlock towards the bridge (Cycles, CPU)."""
    sc = bpy.context.scene
    world = bpy.data.worlds.new('World')
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.004, 0.005, 0.01, 1)
    sc.world = world
    for name, loc, energy in (('L1', D(0, 2.7, 5), 180), ('L2', D(0, 2.7, -5), 180), ('L3', D(-7, 5, 2.5), 400),
                              ('L4', D(6, 2.7, 5), 160), ('L5', D(6, 3.6, -5), 220), ('L6', D(0, 3.2, -15), 260), ('L7', D(0, 2.6, 13), 120)):
        ld = bpy.data.lights.new(name, 'POINT')
        ld.energy = energy
        ld.shadow_soft_size = 0.5
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        sc.collection.objects.link(lo)
    cd = bpy.data.cameras.new('Cam')
    cd.lens = 16
    cam = bpy.data.objects.new('Cam', cd)
    if view == 'hold':
        cam.location = D(-2.6, 2.6, -3.2)
        target = D(-9, 0.8, 4)
    else:
        cam.location = D(0.5, 1.7, 9.0)
        target = D(-0.3, 1.4, -16)
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = int(os.environ.get('BOARDING_SAMPLES', '48'))
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.filepath = path
    sc.view_settings.view_transform = 'AgX'
    # hide the inner hatch for the corridor view (it would be open)
    for n in ('HatchInner_L', 'HatchInner_R'):
        bpy.data.objects[n].hide_render = view != 'hold'
    bpy.ops.render.render(write_still=True)
    print(f'render -> {path}')


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    build()
    export(OUT)
    if '--render' in argv:
        out = argv[argv.index('--render') + 1]
        render(out, 'hold' if 'hold' in os.path.basename(out) else 'corridor')
    if '--blend' in argv:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'boarding.blend'))
