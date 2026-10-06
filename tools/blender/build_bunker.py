"""
A pirate base's command bunker, its blockhouse and the shield generator, built procedurally in Blender.

    python tools/blender/build_bunker.py [--render docs/screenshots/bunker-blender.png]
    # or: blender -b -P tools/blender/build_bunker.py -- [--render ...]

Writes three glTF binaries into src/client/assets/ (Y up):

    bunker.glb      the inside, in the bunker's deck coordinates (src/shared/base-assault.ts): x to the
                    right, y up from the floor, -z forward from the lift. A deck point (x, y, z) is the
                    Blender point (x, -z, y); see D(). Rooms match BUNKER_ROOMS, walls BUNKER_WALLS,
                    furniture stands where BUNKER_POSTS puts the walking obstacles.
                    Nodes the game moves: HatchInner_L / HatchInner_R (the lift's cage door, slides
                    along x), ChestLid (the armory strongbox's lid, swings about its back edge).
                    Animated materials: ReactorGlow, AlarmGlow, HelmScreen, ChestGlow.
    bunker-gate.glb the blockhouse over the lift shaft as it stands in the base: 8 x 8 m, the blast door in
                    its west wall. Same axes as the base's buildings (x east, y up, z south), origin at its
                    centre on the ground. Material DoorGlow is recoloured by the game (sealed / open / held).
    generator.glb   the shield generator pylon, a networked entity: origin 5 m above its foot (where the
                    server keeps the entity), tinted per side through the Hull / Paint / Accent / EngineGlow
                    materials like the Blender ships (src/client/entities/glb-ship.ts).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402

from build_rover import Part, material, reset  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
ASSETS = os.path.join(ROOT, 'src', 'client', 'assets')

# ------------------------------------------------------------------ layout (match src/shared/base-assault.ts)
ROOMS = {
    'lift': (-2.5, 12, 2.5, 18, 3.4),
    'hall': (-3, -14, 3, 12, 4.5),
    'armory': (-15, 0, -3, 11, 4.0),
    'reactor': (-15, -12, -3, -2, 5.0),
    'barracks': (3, 1, 15, 11, 3.4),
    'comms': (3, -12, 13, -1, 3.4),
    'command': (-8, -26, 8, -14, 4.2),
}
WALLS = [
    (-2.5, 18, 2.5, 18), (-2.5, 12, -2.5, 18), (2.5, 12, 2.5, 18), (-3, 12, -1.2, 12), (1.2, 12, 3, 12),
    (-3, -14, -3, -8), (-3, -6, -3, 5), (-3, 7, -3, 12),
    (3, -14, 3, -7), (3, -5, 3, 3), (3, 5, 3, 12),
    (-8, -14, -1.6, -14), (1.6, -14, 8, -14), (-8, -26, -8, -14), (8, -26, 8, -14), (-8, -26, 8, -26),
    (-15, 0, -15, 11), (-15, 11, -3, 11), (-15, 0, -3, 0),
    (-15, -12, -15, -2), (-15, -2, -3, -2), (-15, -12, -3, -12),
    (15, 1, 15, 11), (3, 11, 15, 11), (3, 1, 15, 1),
    (13, -12, 13, -1), (3, -1, 13, -1), (3, -12, 13, -12),
]
# doorways: wall line axis, its position, the span along it, lintel height
DOORS = [
    ('x', -3, 5, 7, 2.6),     # armory
    ('x', -3, -8, -6, 2.6),   # reactor
    ('x', 3, 3, 5, 2.6),      # barracks
    ('x', 3, -7, -5, 2.6),    # comms
    ('z', 12, -1.2, 1.2, 2.6),  # lift cage
    ('z', -14, -1.6, 1.6, 3.2),  # command post
]
CHEST = (-11, 6)
CONSOLE = (0, -22.6)
WALL_H = 5.4
T = 0.3  # concrete walls are thick


def D(x, y, z):
    """Deck (or three.js local) point -> Blender point."""
    return (x, -z, y)


def S(w, h, d):
    """Box size along deck x, y, z -> Blender size."""
    return (w, d, h)


M = {}


def make_materials():
    M['concrete'] = material('Concrete', '#6e6a64', 0.0, 0.85)
    M['concrete2'] = material('ConcreteDark', '#4a4744', 0.0, 0.9)
    M['floor'] = material('Floor', '#3c3a38', 0.3, 0.7)
    M['grate'] = material('Grate', '#24262a', 0.85, 0.5)
    M['ceil'] = material('Ceiling', '#3f3d3b', 0.2, 0.8)
    M['rib'] = material('Rib', '#2c2e32', 0.8, 0.45)
    M['steel'] = material('Steel', '#b8bcc0', 1.0, 0.3)
    M['rust'] = material('Rust', '#7a4a2c', 0.6, 0.7)
    M['dark'] = material('DarkMetal', '#1c1e21', 0.8, 0.45)
    M['pipe'] = material('Pipe', '#9a948a', 0.9, 0.35)
    M['copper'] = material('Copper', '#b0703a', 1.0, 0.35)
    M['red'] = material('PirateRed', '#8a1e22', 0.1, 0.6)
    M['cloth'] = material('Banner', '#6e1418', 0.0, 0.9)
    M['bone'] = material('Bone', '#d8d0bc', 0.0, 0.6)
    M['yellow'] = material('Hazard', '#e0b020', 0.1, 0.5)
    M['black'] = material('HazardBlack', '#141414', 0.1, 0.6)
    M['crate'] = material('Crate', '#56603e', 0.2, 0.6)
    M['crate2'] = material('CrateOrange', '#b4602a', 0.2, 0.55)
    M['crate3'] = material('CrateBlue', '#2f4a6a', 0.2, 0.55)
    M['strap'] = material('Strap', '#1c1c1c', 0.0, 0.8)
    M['sand'] = material('Sandbag', '#8a7a58', 0.0, 0.95)
    M['wood'] = material('Wood', '#5a4430', 0.0, 0.6)
    M['fabric'] = material('Fabric', '#3a3a30', 0.0, 0.9)
    M['sheet'] = material('Sheet', '#a8a090', 0.0, 0.85)
    M['seat'] = material('Seat', '#2a2a2e', 0.0, 0.75)
    M['gold'] = material('Gold', '#e0b040', 1.0, 0.25)
    M['gem'] = material('Gem', '#40e0ff', 0.0, 0.1, '#30c8ff', 2.0)
    M['glow'] = material('Glow', '#fff0d8', 0.0, 0.3, '#ffe8c8', 2.0)
    M['redlamp'] = material('RedLamp', '#ff5030', 0.0, 0.3, '#ff3010', 2.4)
    M['green'] = material('StatusGreen', '#40ff80', 0.0, 0.3, '#30ff70', 2.5)
    M['screen'] = material('Screen', '#0a2030', 0.0, 0.2, '#38a8ff', 1.6)
    M['screen2'] = material('ScreenAmber', '#2a1a08', 0.0, 0.2, '#ffa030', 1.4)
    M['holo'] = material('HoloMap', '#ff6a30', 0.0, 0.2, '#ff5a20', 2.2)
    # animated by the game
    M['reactor'] = material('ReactorGlow', '#ff8040', 0.0, 0.2, '#ff6020', 2.0)
    M['alarm'] = material('AlarmGlow', '#ff3020', 0.0, 0.3, '#ff2010', 0.2)
    M['helm'] = material('HelmScreen', '#0a1830', 0.0, 0.2, '#ff5030', 1.4)
    M['lock'] = material('ChestGlow', '#ff3020', 0.0, 0.3, '#ff2010', 1.6)


def box(p, c, s, mat, **kw):
    kw.setdefault('bevel', 0)
    p.box(D(*c), S(*s), mat, **kw)


def cyl(p, a, b, r, mat, **kw):
    p.cyl(D(*a), D(*b), r, mat, **kw)


def rbox(p, c, s, mat, yaw, bevel=0.02):
    """A box turned about the vertical by `yaw` (radians, deck)."""
    p.box(D(*c), S(*s), mat, rot=Euler((0, 0, yaw)).to_matrix(), bevel=bevel)


def hazard(p, x0, z0, x1, z1, y=0.012, w=0.25):
    l = math.hypot(x1 - x0, z1 - z0)
    n = max(2, int(l / 0.4))
    for i in range(n):
        t0, t1 = i / n, (i + 1) / n
        cx, cz = x0 + (x1 - x0) * (t0 + t1) / 2, z0 + (z1 - z0) * (t0 + t1) / 2
        along_x = abs(x1 - x0) > abs(z1 - z0)
        size = (l / n, 0.01, w) if along_x else (w, 0.01, l / n)
        box(p, (cx, y, cz), size, M['yellow' if i % 2 else 'black'])


def crate(p, x, y, z, s, mat, rot=0.0):
    r = Euler((0, 0, rot)).to_matrix()
    p.box(D(x, y + s[1] / 2, z), S(*s), mat, rot=r, bevel=0.03)
    for k in (-0.3, 0.3):
        p.box(D(x, y + s[1] / 2, z + k * s[2]), S(s[0] + 0.02, s[1] + 0.02, 0.06), M['strap'], rot=r, bevel=0)


def banner(p, x, z, facing, y=3.0, w=1.4, h=2.2):
    """A pirate banner hung on a wall: red cloth, a pale skull-and-blades emblem. `facing` = (nx, nz) into the room."""
    nx, nz = facing
    along_x = abs(nz) > abs(nx)
    size = (lambda a, hh, b: (a, hh, b)) if along_x else (lambda a, hh, b: (b, hh, a))
    box(p, (x, y + 0.05, z), size(w + 0.3, 0.08, 0.08), M['dark'])
    box(p, (x + nx * 0.03, y - h / 2, z + nz * 0.03), size(w, h, 0.03), M['cloth'])
    # the emblem: a round skull, two eye holes, crossed blades below
    ex, ez = x + nx * 0.06, z + nz * 0.06
    p.sphere(D(ex, y - h * 0.38, ez), w * 0.2, M['bone'], 14, 8, scale=(1, 0.25, 1) if along_x else (0.25, 1, 1))
    for s in (-1, 1):
        ox, oz = (s * w * 0.08, 0) if along_x else (0, s * w * 0.08)
        p.sphere(D(ex + ox + nx * 0.04, y - h * 0.37, ez + oz + nz * 0.04), w * 0.05, M['dark'], 8, 6)
        a = s * 0.7
        if along_x:
            p.box(D(ex, y - h * 0.68, ez + 0.01 * nz), S(w * 0.75, 0.07, 0.02), M['bone'], rot=Euler((0, a, 0)).to_matrix(), bevel=0)
        else:
            p.box(D(ex + 0.01 * nx, y - h * 0.68, ez), S(0.02, 0.07, w * 0.75), M['bone'], rot=Euler((a, 0, 0)).to_matrix(), bevel=0)


def wall_dressing(p, x0, z0, x1, z1, ceil, inward):
    """Concrete wainscot, a cable run and buttresses every 3 m along a wall; `inward` = (nx, nz) into the room."""
    nx, nz = inward
    l = math.hypot(x1 - x0, z1 - z0)
    along_x = abs(x1 - x0) > abs(z1 - z0)
    off = T / 2 + 0.03
    cx, cz = (x0 + x1) / 2 + nx * off, (z0 + z1) / 2 + nz * off
    size = (lambda a, h, b: (a, h, b)) if along_x else (lambda a, h, b: (b, h, a))
    box(p, (cx, 0.45, cz), size(l, 0.9, 0.08), M['concrete2'])
    box(p, (cx + nx * 0.05, ceil - 0.45, cz + nz * 0.05), size(l, 0.12, 0.1), M['dark'])
    n = int(l / 3)
    for i in range(1, n + 1):
        t = i / (n + 1)
        x, z = x0 + (x1 - x0) * t + nx * (off + 0.12), z0 + (z1 - z0) * t + nz * (off + 0.12)
        box(p, (x, ceil / 2, z), size(0.4, ceil, 0.3), M['concrete'], bevel=0.03)


# ------------------------------------------------------------------ bunker shell
def build_shell():
    p = Part('Shell')
    for key, (x0, z0, x1, z1, ceil) in ROOMS.items():
        cx, cz, w, d = (x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, z1 - z0
        box(p, (cx, -0.1, cz), (w + T, 0.2, d + T), M['floor'])
        box(p, (cx, ceil + 0.1, cz), (w + T, 0.2, d + T), M['ceil'])
        # floor slabs
        for i in range(1, int(w / 2)):
            box(p, (x0 + i * 2, 0.003, cz), (0.04, 0.006, d), M['grate'])
        for i in range(1, int(d / 2)):
            box(p, (cx, 0.003, z0 + i * 2), (w, 0.006, 0.04), M['grate'])
        # caged ceiling lamps
        nx, nz = max(1, int(w / 5)), max(1, int(d / 5))
        for i in range(nx):
            for k in range(nz):
                lx, lz = x0 + (i + 0.5) * w / nx, z0 + (k + 0.5) * d / nz
                box(p, (lx, ceil - 0.06, lz), (0.9, 0.12, 0.3), M['dark'])
                box(p, (lx, ceil - 0.14, lz), (0.8, 0.04, 0.22), M['glow'])
        # ceiling beams
        if w > d:
            for i in range(1, int(w / 3)):
                box(p, (x0 + i * 3, ceil - 0.2, cz), (0.3, 0.4, d), M['concrete2'])
        else:
            for i in range(1, int(d / 3)):
                box(p, (cx, ceil - 0.2, z0 + i * 3), (w, 0.4, 0.3), M['concrete2'])
    for x0, z0, x1, z1 in WALLS:
        l = math.hypot(x1 - x0, z1 - z0)
        cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
        if abs(x1 - x0) > abs(z1 - z0):
            box(p, (cx, WALL_H / 2, cz), (l + T, WALL_H, T), M['concrete'])
        else:
            box(p, (cx, WALL_H / 2, cz), (T, WALL_H, l + T), M['concrete'])
    for axis, at, a, b, top in DOORS:
        c, l = (a + b) / 2, b - a
        if axis == 'x':
            box(p, (at, (top + WALL_H) / 2, c), (T, WALL_H - top, l), M['concrete'])
            for s in (a, b):
                box(p, (at, top / 2, s), (T + 0.2, top, 0.2), M['rib'])
            box(p, (at, top - 0.1, c), (T + 0.2, 0.2, l + 0.2), M['rib'])
            hazard(p, at, a, at, b, w=0.6)
            for s in (-1, 1):
                p.sphere(D(at + s * (T / 2 + 0.05), top + 0.25, c), 0.09, M['alarm'], 10, 6)
        else:
            box(p, (c, (top + WALL_H) / 2, at), (l, WALL_H - top, T), M['concrete'])
            for s in (a, b):
                box(p, (s, top / 2, at), (0.2, top, T + 0.2), M['rib'])
            box(p, (c, top - 0.1, at), (l + 0.2, 0.2, T + 0.2), M['rib'])
            hazard(p, a, at, b, at, w=0.6)
    p.build()


def build_lift():
    p = Part('Lift')
    x0, z0, x1, z1, ceil = ROOMS['lift']
    # the platform (a grate on a steel frame) and the shaft's guide rails up the walls
    box(p, (0, 0.04, 15), (4.6, 0.08, 5.6), M['grate'])
    for x in (-2.2, 2.2):
        for z in (12.6, 17.4):
            box(p, (x, ceil / 2, z), (0.16, ceil, 0.16), M['steel'])
        box(p, (x, 1.1, 15), (0.08, 0.08, 4.8), M['yellow'])
    box(p, (0, ceil - 0.2, 15), (4.6, 0.3, 0.3), M['rib'])
    cyl(p, (0, ceil - 0.05, 15), (0, ceil + 0.5, 15), 0.06, M['steel'], segs=8)
    hazard(p, -2.2, 12.5, 2.2, 12.5, w=0.3)
    # call panel and a skull sign on the back wall
    box(p, (1.95, 1.3, 13), (0.2, 0.7, 0.45), M['dark'])
    for k, mat in enumerate((M['green'], M['redlamp'])):
        p.sphere(D(1.84, 1.45 - k * 0.25, 13), 0.06, mat, 8, 6)
    banner(p, 0, 17.8, (0, -1), y=2.9, w=1.6, h=1.8)
    p.build()
    # the cage door's two leaves (slide along x), origins at their centres
    for side, name in ((-1, 'HatchInner_L'), (1, 'HatchInner_R')):
        h = Part(name)
        cx = side * 0.6
        box(h, (cx, 1.3, 12), (1.2, 2.6, 0.06), M['dark'])
        for i in range(5):
            box(h, (cx - 0.5 + i * 0.25, 1.3, 12.05), (0.04, 2.5, 0.04), M['steel'])
        for y in (0.3, 1.3, 2.3):
            box(h, (cx, y, 12.05), (1.2, 0.08, 0.06), M['yellow'])
        h.build(origin=D(cx, 1.3, 12))


def build_hall():
    p = Part('Hall')
    x0, z0, x1, z1, ceil = ROOMS['hall']
    for seg, n in (((-3, -14, -3, -8), (1, 0)), ((-3, -6, -3, 5), (1, 0)), ((-3, 7, -3, 12), (1, 0)),
                   ((3, -14, 3, -7), (-1, 0)), ((3, -5, 3, 3), (-1, 0)), ((3, 5, 3, 12), (-1, 0))):
        wall_dressing(p, *seg, ceil, n)
    # a strip of grating down the middle, drains along the walls
    box(p, (0, 0.02, -1), (1.6, 0.04, 25), M['grate'])
    # pipes and cable trays under the ceiling
    for x, r, mat in ((-2.4, 0.12, M['pipe']), (-2.05, 0.07, M['red']), (2.4, 0.1, M['copper']), (2.1, 0.06, M['pipe'])):
        cyl(p, (x, ceil - 0.6, -14), (x, ceil - 0.6, 12), r, mat, segs=10)
    # banners and the base's stolen-goods tally on the walls
    banner(p, -2.8, -11, (1, 0), y=3.6)
    banner(p, 2.8, 9, (-1, 0), y=3.6)
    banner(p, 2.8, -10.5, (-1, 0), y=3.6)
    box(p, (-2.82, 1.7, 9.5), (0.06, 1.0, 1.6), M['dark'])
    box(p, (-2.78, 1.7, 9.5), (0.02, 0.85, 1.45), M['screen2'])
    # sandbags at the command post's doorway
    for s in (-1, 1):
        for k in range(3):
            for row in range(2):
                p.sphere(D(s * (2.2 - row * 0.2), 0.18 + row * 0.3, -12.2 + k * 0.62), 0.33, M['sand'], 10, 6, scale=(0.9, 1.0, 0.55))
    p.build()
    a = Part('HallAlarms')
    for z in (-9, -1, 7):
        for x in (-2.7, 2.7):
            a.sphere(D(x, ceil - 1.0, z), 0.13, M['alarm'], 12, 8)
            box(a, (x, ceil - 1.0, z), (0.06, 0.2, 0.32), M['dark'])
    a.build()


def build_armory():
    p = Part('Armory')
    x0, z0, x1, z1, ceil = ROOMS['armory']
    for seg, n in (((-15, 0, -15, 11), (1, 0)), ((-15, 11, -3, 11), (0, -1)), ((-15, 0, -3, 0), (0, 1))):
        wall_dressing(p, *seg, ceil, n)
    # plunder piled in corners (see BUNKER_POSTS)
    crate(p, -13.6, 0, 9.6, (1.3, 1.3, 1.3), M['crate'])
    crate(p, -12.3, 0, 9.8, (1.1, 1.0, 1.1), M['crate2'], 0.2)
    crate(p, -13.5, 1.3, 9.5, (1.0, 0.9, 1.0), M['crate3'], -0.1)
    crate(p, -13.6, 0, 1.4, (1.3, 1.2, 1.2), M['crate2'])
    crate(p, -12.4, 0, 1.3, (1.0, 1.0, 1.0), M['crate'], 0.3)
    crate(p, -13.4, 1.2, 1.5, (1.0, 0.8, 1.0), M['crate'], 0.1)
    # gold bars and crystals spilling out of an open crate
    box(p, (-12.0, 0.35, 7.8), (1.0, 0.7, 0.8), M['wood'], bevel=0.02)
    for i in range(6):
        rbox(p, (-12.3 + (i % 3) * 0.28, 0.74 + (i // 3) * 0.1, 7.7 + (i % 2) * 0.2), (0.26, 0.09, 0.12), M['gold'], 0.2 * i, 0.01)
    for k in range(5):
        a = k * 1.3
        p.cyl(D(-11.6 + math.cos(a) * 0.35, 0.05, 8.6 + math.sin(a) * 0.3), D(-11.6 + math.cos(a) * 0.45, 0.45 + k * 0.05, 8.6 + math.sin(a) * 0.38), 0.07, M['gem'], segs=6, r2=0.0)
    # weapon racks with blasters on the walls
    for (rx, rz), yaw in (((-7, 10.4), 0), ((-7.5, 0.6), math.pi)):
        box(p, (rx, 1.1, rz), (1.8, 2.2, 0.4), M['dark'], bevel=0.02)
        for i in range(5):
            gx = rx - 0.7 + i * 0.35
            box(p, (gx, 1.25, rz + (0.12 if yaw == 0 else -0.12) * -1), (0.08, 0.9, 0.14), M['steel'])
            box(p, (gx, 0.95, rz + (0.12 if yaw == 0 else -0.12) * -1), (0.1, 0.2, 0.3), M['rib'])
    banner(p, -14.8, 5.5, (1, 0), y=3.2)
    # loading marks round the strongbox
    cx, cz = CHEST
    hazard(p, cx - 1.8, cz - 1.5, cx + 1.8, cz - 1.5, w=0.18)
    hazard(p, cx - 1.8, cz + 1.5, cx + 1.8, cz + 1.5, w=0.18)
    p.build()
    c = Part('Chest')
    box(c, (cx, 0.45, cz), (1.2, 0.9, 1.8), M['steel'], bevel=0.05)
    box(c, (cx, 0.45, cz), (1.26, 0.12, 1.86), M['dark'])
    for z in (cz - 0.7, cz + 0.7):
        box(c, (cx, 0.45, z), (1.24, 0.92, 0.1), M['dark'])
    box(c, (cx + 0.62, 0.62, cz), (0.04, 0.22, 0.32), M['dark'])
    box(c, (cx + 0.645, 0.62, cz), (0.02, 0.08, 0.2), M['lock'])
    box(c, (cx, 0.75, cz - 0.35), (0.8, 0.2, 0.6), M['gold'])
    box(c, (cx - 0.1, 0.8, cz + 0.4), (0.5, 0.25, 0.5), M['crate3'])
    c.build()
    lid = Part('ChestLid')
    box(lid, (cx, 1.0, cz), (1.22, 0.2, 1.82), M['steel'], bevel=0.05)
    box(lid, (cx, 1.11, cz), (0.8, 0.03, 1.4), M['red'])
    # hinged at the back (towards the wall, −x), swings up (rotation about deck z)
    lid.build(origin=D(cx - 0.6, 0.9, cz))


def build_reactor():
    p = Part('Reactor')
    x0, z0, x1, z1, ceil = ROOMS['reactor']
    for seg, n in (((-15, -12, -15, -2), (1, 0)), ((-15, -2, -3, -2), (0, -1)), ((-15, -12, -3, -12), (0, 1))):
        wall_dressing(p, *seg, ceil, n)
    rx, rz = -9.5, -7.0
    # the generator core feeding the dome: a drum with a hot glowing column and coils
    cyl(p, (rx, 0, rz), (rx, 0.6, rz), 2.1, M['dark'], segs=32)
    cyl(p, (rx, 0.6, rz), (rx, 0.9, rz), 1.9, M['steel'], segs=32)
    cyl(p, (rx, 0.9, rz), (rx, 3.6, rz), 1.1, M['reactor'], segs=32)
    for y in (1.3, 1.9, 2.5, 3.1):
        p.torus(D(rx, y, rz), (0, 0, 1), 1.2, 0.09, M['copper'], 32, 8)
    for k in range(8):
        a = 2 * math.pi * k / 8
        cyl(p, (rx + math.cos(a) * 1.3, 0.9, rz + math.sin(a) * 1.3), (rx + math.cos(a) * 1.3, 3.6, rz + math.sin(a) * 1.3), 0.07, M['steel'], segs=8)
    cyl(p, (rx, 3.6, rz), (rx, 4.0, rz), 1.9, M['steel'], segs=32)
    cyl(p, (rx, 4.0, rz), (rx, ceil, rz), 0.6, M['dark'], segs=16)
    for a, mat in ((0.4, M['copper']), (2.0, M['pipe']), (3.7, M['red']), (5.2, M['copper'])):
        ex, ez = rx + math.cos(a) * 2.0, rz + math.sin(a) * 2.0
        wx = min(max(ex + math.cos(a) * 3, x0 + 0.4), x1 - 0.4)
        wz = min(max(ez + math.sin(a) * 3, z0 + 0.4), z1 - 0.4)
        p.tube([Vector(D(ex, 0.7, ez)), Vector(D(ex, ceil - 0.7, ez)), Vector(D(wx, ceil - 0.7, wz))], 0.1, mat, 10)
    for i in range(18):
        a0, a1 = 2 * math.pi * i / 18, 2 * math.pi * (i + 1) / 18
        mx, mz = rx + math.cos((a0 + a1) / 2) * 2.55, rz + math.sin((a0 + a1) / 2) * 2.55
        p.box(D(mx, 0.006, mz), S(0.86, 0.01, 0.32), M['yellow' if i % 2 else 'black'], rot=Euler((0, 0, -(a0 + a1) / 2)).to_matrix(), bevel=0)
    # a control desk by the door
    box(p, (-4.4, 0.5, -10.8), (1.6, 1.0, 0.8), M['concrete2'], bevel=0.03)
    box(p, (-4.4, 1.05, -10.65), (1.4, 0.06, 0.6), M['dark'])
    box(p, (-4.4, 1.35, -11.1), (1.3, 0.55, 0.05), M['screen2'])
    p.build()


def build_barracks():
    p = Part('Barracks')
    x0, z0, x1, z1, ceil = ROOMS['barracks']
    for seg, n in (((15, 1, 15, 11), (-1, 0)), ((3, 11, 15, 11), (0, -1)), ((3, 1, 15, 1), (0, 1))):
        wall_dressing(p, *seg, ceil, n)

    def bunk(bx, bz, yaw):
        for y in (0.45, 1.7):
            rbox(p, (bx, y, bz), (2.1, 0.12, 0.95), M['dark'], yaw)
            rbox(p, (bx, y + 0.13, bz), (2.0, 0.14, 0.88), M['sheet'], yaw, 0.04)
            rbox(p, (bx, y + 0.22, bz), (1.4, 0.06, 0.9), M['fabric'], yaw)
        c, s = math.cos(yaw), math.sin(yaw)
        for dx in (-1.02, 1.02):
            for dz in (-0.44, 0.44):
                box(p, (bx + dx * c + dz * s, 1.2, bz - dx * s + dz * c), (0.06, 2.4, 0.06), M['rib'])
    bunk(6.2, 10.0, 0)
    bunk(9.8, 10.0, 0)
    bunk(14.0, 7.0, math.pi / 2)
    # the table with cards, bottles and a knife
    tx, tz = 9.5, 4.6
    box(p, (tx, 0.78, tz), (1.4, 0.07, 1.0), M['wood'], bevel=0.02)
    box(p, (tx, 0.4, tz), (0.2, 0.75, 0.2), M['rib'])
    for dx, dz in ((-0.4, 0.2), (0.35, -0.2), (0.1, 0.3)):
        cyl(p, (tx + dx, 0.82, tz + dz), (tx + dx, 1.05, tz + dz), 0.05, M['crate3'], segs=10)
    box(p, (tx - 0.1, 0.83, tz - 0.2), (0.14, 0.02, 0.2), M['sheet'])
    for s in (-1, 1):
        box(p, (tx + s * 1.0, 0.45, tz), (0.4, 0.06, 0.4), M['seat'], bevel=0.02)
        box(p, (tx + s * 1.0, 0.22, tz), (0.08, 0.45, 0.08), M['rib'])
    # lockers by the door
    for x in (5.0, 5.8, 6.6):
        box(p, (x, 1.05, 1.45), (0.76, 2.1, 0.5), M['rust'], bevel=0.02)
        box(p, (x, 1.5, 1.72), (0.05, 0.3, 0.02), M['dark'])
    banner(p, 14.8, 3.2, (-1, 0), y=3.0, w=1.2, h=1.6)
    p.build()


def build_comms():
    p = Part('Comms')
    x0, z0, x1, z1, ceil = ROOMS['comms']
    for seg, n in (((13, -12, 13, -1), (-1, 0)), ((3, -1, 13, -1), (0, -1)), ((3, -12, 13, -12), (0, 1))):
        wall_dressing(p, *seg, ceil, n)
    # radio racks; their fronts face into the room (nx, nz)
    for (rx, rz), (nx, nz) in (((11.9, -4.5), (-1, 0)), ((11.9, -9.0), (-1, 0)), ((7.0, -11.0), (0, 1))):
        side_x = nz != 0
        box(p, (rx, 1.0, rz), (1.3, 2.0, 0.8) if side_x else (0.8, 2.0, 1.3), M['dark'], bevel=0.02)
        fx, fz = rx + nx * 0.42, rz + nz * 0.42
        for k in range(4):
            yy = 0.4 + k * 0.42
            box(p, (fx, yy, fz), (1.1, 0.3, 0.03) if side_x else (0.03, 0.3, 1.1), M['screen'] if k % 2 else M['screen2'])
            for j in range(4):
                o = -0.4 + j * 0.25
                p.sphere(D(fx + (o if side_x else nx * 0.02), yy + 0.18, fz + (nz * 0.02 if side_x else o)), 0.025, M['green'] if (j + k) % 3 else M['redlamp'], 6, 4)
    # an operator's seat and a big screen with the system map
    box(p, (8.5, 0.45, -6.5), (0.6, 0.1, 0.6), M['seat'], bevel=0.04)
    cyl(p, (8.5, 0, -6.5), (8.5, 0.42, -6.5), 0.07, M['steel'], segs=8)
    box(p, (8, 1.9, -1.2), (3.2, 1.4, 0.06), M['dark'])
    box(p, (8, 1.9, -1.24), (3.0, 1.25, 0.02), M['screen'])
    p.build()


def build_command():
    p = Part('Command')
    x0, z0, x1, z1, ceil = ROOMS['command']
    for seg, n in (((-8, -26, -8, -14), (1, 0)), ((8, -26, 8, -14), (-1, 0)), ((-8, -14, -1.6, -14), (0, -1)), ((1.6, -14, 8, -14), (0, -1))):
        wall_dressing(p, *seg, ceil, n)
    # raised dais with the capture console (HelmScreen) in front of a wall of screens
    box(p, (0, 0.05, -23.4), (8, 0.1, 4.6), M['grate'])
    hx, hz = CONSOLE
    box(p, (hx, 0.5, hz - 1.2), (2.2, 1.0, 0.9), M['concrete2'], bevel=0.05)
    p.box(D(hx, 1.08, hz - 1.0), S(2.0, 0.08, 0.8), M['dark'], rot=Euler((math.radians(-22), 0, 0)).to_matrix(), bevel=0.01)
    p.box(D(hx, 1.12, hz - 1.0), S(1.6, 0.02, 0.55), M['helm'], rot=Euler((math.radians(-22), 0, 0)).to_matrix(), bevel=0)
    for s in (-1, 1):
        p.sphere(D(hx + s * 0.85, 1.18, hz - 0.75), 0.06, M['redlamp'], 8, 6)
    # the screen wall
    box(p, (0, 2.3, -25.8), (12, 3.0, 0.1), M['dark'])
    for i, x in enumerate((-4.5, -1.5, 1.5, 4.5)):
        box(p, (x, 2.6, -25.74), (2.7, 1.6, 0.02), M['screen'] if i % 2 else M['screen2'])
    box(p, (0, 3.75, -25.74), (5, 0.4, 0.02), M['helm'])
    # plot tables with a holo map of the system
    for tx in (-4.5, 4.5):
        cyl(p, (tx, 0, -19.5), (tx, 0.9, -19.5), 0.95, M['concrete2'], segs=20)
        cyl(p, (tx, 0.9, -19.5), (tx, 0.96, -19.5), 1.05, M['dark'], segs=20)
        cyl(p, (tx, 0.96, -19.5), (tx, 0.98, -19.5), 0.9, M['holo'], segs=20)
        p.sphere(D(tx, 1.4, -19.5), 0.16, M['holo'], 12, 8)
        p.torus(D(tx, 1.25, -19.5), (0, 0, 1), 0.55, 0.012, M['holo'], 24, 4)
    # side screens, the commander's chair, banners
    for sx in (-6.9, 6.9):
        box(p, (sx, 0.5, -24.8), (1.0, 1.0, 1.0), M['concrete2'], bevel=0.03)
        box(p, (sx, 1.35, -25.1), (0.9, 0.6, 0.05), M['screen'])
    box(p, (0, 0.5, -17.5), (0.8, 0.14, 0.8), M['red'], bevel=0.05)
    box(p, (0, 1.1, -17.85), (0.8, 1.1, 0.14), M['red'], bevel=0.05)
    cyl(p, (0, 0, -17.5), (0, 0.45, -17.5), 0.09, M['steel'], segs=10)
    banner(p, -7.8, -18.5, (1, 0), y=3.5, w=1.6, h=2.6)
    banner(p, 7.8, -18.5, (-1, 0), y=3.5, w=1.6, h=2.6)
    for x in (-3, 3):
        p.sphere(D(x, ceil - 0.4, -25.5), 0.14, M['alarm'], 12, 8)
    p.build()


def build_interior():
    reset()
    make_materials()
    build_shell()
    build_lift()
    build_hall()
    build_armory()
    build_reactor()
    build_barracks()
    build_comms()
    build_command()


# ------------------------------------------------------------------ the blockhouse (x east, y up, z south)
def build_gate():
    reset()
    make_materials()
    M['doorglow'] = material('DoorGlow', '#ff3020', 0.0, 0.3, '#ff2010', 2.4)
    p = Part('Blockhouse')
    w, h = 8.0, 5.5
    # a plinth sunk into the ground (the terrain can slope under it)
    box(p, (0, -1.4, 0), (w + 0.8, 3.0, w + 0.8), M['concrete2'])
    # the walls with chamfered top edges and buttresses
    box(p, (0, h / 2, 0), (w, h, w), M['concrete'], bevel=0.25)
    box(p, (0, h + 0.2, 0), (w - 0.6, 0.4, w - 0.6), M['concrete2'], bevel=0.1)
    for sx in (-1, 1):
        for sz in (-1, 1):
            box(p, (sx * (w / 2 + 0.15), h / 2 - 0.3, sz * (w / 2 + 0.15)), (0.9, h - 0.6, 0.9), M['concrete2'], bevel=0.12)
    # the blast door in the west wall (x = −4): two heavy leaves in a hazard frame
    dw, dh = 3.0, 3.4
    box(p, (-w / 2 - 0.15, dh / 2 + 0.1, 0), (0.3, dh + 0.6, dw + 0.8), M['dark'])
    for s in (-1, 1):
        box(p, (-w / 2 - 0.35, dh / 2, s * dw / 4), (0.18, dh, dw / 2 - 0.04), M['rust'], bevel=0.04)
        for k in range(4):
            box(p, (-w / 2 - 0.46, 0.5 + k * 0.85, s * dw / 4), (0.05, 0.12, dw / 2 - 0.3), M['dark'])
    for i in range(9):
        y0 = i * (dh + 0.4) / 9
        box(p, (-w / 2 - 0.3, y0 + 0.2, -dw / 2 - 0.25), (0.12, 0.38, 0.3), M['yellow' if i % 2 else 'black'])
        box(p, (-w / 2 - 0.3, y0 + 0.2, dw / 2 + 0.25), (0.12, 0.38, 0.3), M['yellow' if i % 2 else 'black'])
    box(p, (-w / 2 - 0.3, dh + 0.45, 0), (0.12, 0.3, dw + 0.8), M['yellow'])
    # status lamps over the door and a light strip on the threshold (DoorGlow)
    for s in (-1, 1):
        p.sphere(D(-w / 2 - 0.3, dh + 0.9, s * 1.1), 0.18, M['doorglow'], 12, 8)
    box(p, (-w / 2 - 0.6, 0.06, 0), (0.6, 0.06, dw), M['doorglow'])
    # a card reader and a skull painted beside the door
    box(p, (-w / 2 - 0.08, 1.4, dw / 2 + 0.75), (0.16, 0.5, 0.35), M['dark'])
    box(p, (-w / 2 - 0.17, 1.5, dw / 2 + 0.75), (0.02, 0.2, 0.2), M['screen2'])
    p.sphere(D(-w / 2 - 0.02, 3.6, -2.7), 0.5, M['bone'], 14, 8, scale=(0.15, 1, 1))
    # sandbag walls flanking the approach
    for s in (-1, 1):
        for k in range(4):
            for row in range(2):
                p.sphere(D(-w / 2 - 2.2 + k * 0.0, 0.25 + row * 0.38, s * (2.6 + k * 0.7)), 0.42, M['sand'], 10, 6, scale=(0.6, 1, 0.5))
    # roof: lift winch housing, vents, a mast with a beacon, a floodlight over the door
    box(p, (1.2, h + 1.2, 0.8), (3.2, 1.6, 2.8), M['rust'], bevel=0.08)
    box(p, (1.2, h + 2.05, 0.8), (3.4, 0.1, 3.0), M['dark'])
    for x, z in ((-2.4, -2.4), (-2.4, 2.4)):
        cyl(p, (x, h + 0.4, z), (x, h + 1.0, z), 0.45, M['dark'], segs=16)
        cyl(p, (x, h + 1.0, z), (x, h + 1.06, z), 0.5, M['steel'], segs=16)
    cyl(p, (2.8, h + 0.4, -2.8), (2.8, h + 6.0, -2.8), 0.08, M['steel'], segs=8)
    p.sphere(D(2.8, h + 6.2, -2.8), 0.2, M['redlamp'], 10, 6)
    for y in (h + 2.5, h + 4.0):
        cyl(p, (2.4, y, -2.8), (3.2, y, -2.8), 0.03, M['steel'], segs=6)
    box(p, (-w / 2 - 0.2, h - 0.2, 0), (0.6, 0.3, 1.2), M['dark'])
    box(p, (-w / 2 - 0.52, h - 0.28, 0), (0.04, 0.16, 1.0), M['glow'])
    p.build()


# ------------------------------------------------------------------ the shield generator (ship-like entity: −z forward)
def build_generator():
    reset()
    hull = material('Hull', '#5a4a5e', 0.6, 0.45)
    paint = material('Paint', '#2a2430', 0.4, 0.55)
    accent = material('Accent', '#e8485a', 0.1, 0.4)
    glow = material('EngineGlow', '#ff6a3a', 0.0, 0.2, '#ff6a3a', 4.0)
    steel = material('Steel', '#b8bcc0', 1.0, 0.3)
    dark = material('DarkMetal', '#1c1e21', 0.8, 0.45)
    concrete = material('Concrete', '#6e6a64', 0.0, 0.85)
    y0 = -4.95  # the entity sits 4.95 m above the pylon's foot
    p = Part('Generator')
    # octagonal concrete foot, a steel ring, four buttress legs
    cyl(p, (0, y0 - 2.0, 0), (0, y0 + 0.8, 0), 3.2, concrete, segs=8, smooth=False)
    cyl(p, (0, y0 + 0.8, 0), (0, y0 + 1.2, 0), 2.8, steel, segs=24)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        ca, sa = math.cos(a), math.sin(a)
        p.box(D(ca * 1.9, y0 + 2.6, sa * 1.9), S(0.5, 3.4, 1.0), hull, rot=Euler((0, 0, -a)).to_matrix(), bevel=0.06)
        cyl(p, (ca * 2.4, y0 + 0.9, sa * 2.4), (ca * 1.0, y0 + 5.2, sa * 1.0), 0.16, dark, segs=8)
    # the column: stacked drums and glowing coil rings
    cyl(p, (0, y0 + 1.2, 0), (0, y0 + 5.0, 0), 1.25, paint, segs=24)
    for k in range(5):
        y = y0 + 1.6 + k * 0.75
        p.torus(D(0, y, 0), (0, 0, 1), 1.45, 0.16, glow if k % 2 else accent, 32, 8)
    cyl(p, (0, y0 + 5.0, 0), (0, y0 + 5.6, 0), 1.7, hull, segs=24)
    cyl(p, (0, y0 + 5.6, 0), (0, y0 + 8.4, 0), 0.7, paint, segs=20)
    for k in range(6):
        a = 2 * math.pi * k / 6
        cyl(p, (math.cos(a) * 0.9, y0 + 5.6, math.sin(a) * 0.9), (math.cos(a) * 0.55, y0 + 8.6, math.sin(a) * 0.55), 0.08, steel, segs=6)
    # the emitter: a crown of prongs round a glowing sphere
    cyl(p, (0, y0 + 8.4, 0), (0, y0 + 8.8, 0), 1.3, hull, segs=24)
    p.sphere(D(0, y0 + 9.8, 0), 0.85, glow, 24, 14)
    for k in range(6):
        a = 2 * math.pi * k / 6 + 0.3
        p.tube([Vector(D(math.cos(a) * 1.1, y0 + 8.8, math.sin(a) * 1.1)), Vector(D(math.cos(a) * 1.5, y0 + 9.9, math.sin(a) * 1.5)),
                Vector(D(math.cos(a) * 1.0, y0 + 11.0, math.sin(a) * 1.0))], 0.1, accent, 8)
    # cables to the ground and warning panels
    for k in range(3):
        a = k * 2 * math.pi / 3 + 0.4
        p.tube([Vector(D(math.cos(a) * 1.25, y0 + 2.0, math.sin(a) * 1.25)), Vector(D(math.cos(a) * 2.9, y0 + 1.25, math.sin(a) * 2.9)),
                Vector(D(math.cos(a) * 4.0, y0 - 0.2, math.sin(a) * 4.0))], 0.12, dark, 8)
    p.build()


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
    print(f'{os.path.basename(path)}: {tris} triangles ({os.path.getsize(path) // 1024} KB)')


def render(path, view):
    """Cycles previews: the hall from the lift ('hall'), the command post ('command'), the armory, or the outside."""
    sc = bpy.context.scene
    world = bpy.data.worlds.new('World')
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.004, 0.005, 0.01, 1) if view != 'outside' else (0.35, 0.3, 0.26, 1)
    sc.world = world
    lights = [('L1', D(0, 3.6, 6), 260), ('L2', D(0, 3.6, -6), 260), ('L3', D(-9, 3.4, 5.5), 380), ('L4', D(-9, 4.4, -7), 300),
              ('L5', D(9, 3.0, 6), 220), ('L6', D(8, 3.0, -6.5), 200), ('L7', D(0, 3.6, -20), 420), ('L8', D(0, 3.0, 15), 140)]
    if view == 'outside':
        lights = [('Sun', None, 4.0)]
    for name, loc, energy in lights:
        if loc is None:
            ld = bpy.data.lights.new(name, 'SUN')
            ld.energy = energy
            lo = bpy.data.objects.new(name, ld)
            lo.rotation_euler = (math.radians(50), math.radians(10), math.radians(-60))
        else:
            ld = bpy.data.lights.new(name, 'POINT')
            ld.energy = energy
            ld.shadow_soft_size = 0.5
            lo = bpy.data.objects.new(name, ld)
            lo.location = loc
        sc.collection.objects.link(lo)
    cd = bpy.data.cameras.new('Cam')
    cd.lens = 16 if view != 'outside' else 28
    cam = bpy.data.objects.new('Cam', cd)
    if view == 'command':
        cam.location, target = D(-3.5, 2.0, -15.2), D(0.5, 1.2, -23.5)
    elif view == 'armory':
        cam.location, target = D(-4.0, 2.3, 2.5), D(-11, 0.8, 7)
    elif view == 'outside':
        cam.location, target = Vector((-14, -11, 4)), Vector((0, 0, 2.2))
    else:
        cam.location, target = D(0.6, 1.8, 11.0), D(-0.3, 1.4, -20)
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = int(os.environ.get('BUNKER_SAMPLES', '48'))
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.filepath = path
    sc.view_settings.view_transform = 'AgX'
    for n in ('HatchInner_L', 'HatchInner_R'):
        if n in bpy.data.objects:
            bpy.data.objects[n].hide_render = True
    bpy.ops.render.render(write_still=True)
    print(f'render -> {path}')


def build_outside_preview():
    """The blockhouse and a generator next to it on a ground plane (render only)."""
    build_gate()
    gate = [o for o in bpy.data.objects]
    # bring in the generator built in a fresh scene
    gen_path = os.path.join(ASSETS, 'generator.glb')
    bpy.ops.import_scene.gltf(filepath=gen_path)
    for o in bpy.context.selected_objects:
        if o not in gate:
            o.location = (-9, 6, 4.95)
    ground = material('Ground', '#7a6a50', 0.0, 0.95)
    bpy.ops.mesh.primitive_plane_add(size=120, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(ground)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    build_generator()
    export(os.path.join(ASSETS, 'generator.glb'))
    build_gate()
    export(os.path.join(ASSETS, 'bunker-gate.glb'))
    build_interior()
    export(os.path.join(ASSETS, 'bunker.glb'))
    if '--render' in argv:
        out = argv[argv.index('--render') + 1]
        base = os.path.basename(out)
        view = 'command' if 'command' in base else 'armory' if 'armory' in base else 'outside' if 'outside' in base else 'hall'
        if view == 'outside':
            build_outside_preview()
        render(out, view)
