"""
The station smelter on the promenade, built procedurally in Blender.

    blender -b -P tools/blender/build_refinery.py -- [--render docs/screenshots/refinery-blender.png]
    # or with the bpy module: python tools/blender/build_refinery.py [--render ...]

Writes src/client/assets/refinery.glb (glTF binary, Y up). Everything is in deck coordinates
(see src/shared/station/deck.ts REFINERY): the smelter stands against the promenade's back
wall (z = -40) right of the airlock, x 9..25, and keeps behind z = -36.3 so the pilot can walk
in front of it to its control terminal. Blender is Z up: a deck point (x, y, z) is the Blender
point (x, -z, y), see D() below.

Left to right: a blast furnace with a glowing hatch and a catwalk, its tap pouring molten
metal into moulds on a roller conveyor under a cooling hood, a robot arm that lifts the
ingots off, and a glass-walled machining cell where a laser cuts crystals and a lathe turns
parts, with the finished goods stacked on pallets beside it. Pipes run along the wall.

Nodes the game uses (src/client/world/refinery.ts):

    Refinery              everything static
    Ingot_<n>             the moulds riding the conveyor (x is their place along it); material
                          "HotIngot" is cloned per ingot and cools as it moves right
    Chuck                 the crystal on the cutting chuck (spins about deck y)
    Arm                   the robot arm (swings about deck y)
    Materials "Molten" and "Laser" flicker / pulse.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
import bmesh  # noqa: E402,F401
from mathutils import Vector  # noqa: E402

from build_rover import Part, empty, material, parent_to, reset  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'src', 'client', 'assets', 'refinery.glb')

# ------------------------------------------------------------------ layout (match REFINERY in deck.ts)
X0, X1, WALL, FRONT, CEIL = 9.0, 25.0, -40.0, -36.3, 9.0
FURNACE = (13.0, -37.6)
CONVEYOR = (15.2, 19.8, -38.0, 0.95)  # x from, x to, z, belt top
CELL = (20.6, 24.6)
INGOTS = 6


def D(x, y, z):
    """Deck point -> Blender point."""
    return (x, -z, y)


def S(w, h, d):
    """Deck box size (along x, y, z) -> Blender size."""
    return (w, d, h)


M = {}


def make_materials():
    M['plate'] = material('FloorPlate', '#4a4d52', 0.6, 0.55)
    M['stripe'] = material('HazardYellow', '#e0b020', 0.1, 0.5)
    M['black'] = material('HazardBlack', '#1b1c1e', 0.1, 0.6)
    M['iron'] = material('CastIron', '#3a3633', 0.8, 0.62)
    M['steel'] = material('Steel', '#8e959c', 0.9, 0.38)
    M['dark'] = material('DarkMetal', '#2b2f35', 0.7, 0.45)
    M['brick'] = material('Refractory', '#7a4a34', 0.0, 0.85)
    M['rust'] = material('Rust', '#6a3a22', 0.4, 0.75)
    M['paint'] = material('MachinePaint', '#d86a1c', 0.2, 0.42)
    M['paint2'] = material('MachineGrey', '#c9ccd0', 0.15, 0.45)
    M['copper'] = material('Copper', '#b8703c', 1.0, 0.32)
    M['rubber'] = material('Rubber', '#1a1a1b', 0.0, 0.9)
    M['red'] = material('ValveRed', '#c02a1a', 0.2, 0.45)
    M['wood'] = material('Pallet', '#8a6a42', 0.0, 0.8)
    M['crate'] = material('Crate', '#5a6a4a', 0.1, 0.65)
    M['ingot'] = material('Ingot', '#c8ccd2', 1.0, 0.25)
    M['optics'] = material('OpticsCase', '#2a3a5a', 0.3, 0.4)
    M['lens'] = material('Lens', '#9ae6ff', 0.0, 0.05, '#4ad8ff', 0.6)
    M['screen'] = material('Screen', '#0a2a30', 0.0, 0.2, '#ff9a40', 1.8)
    M['lamp'] = material('WorkLamp', '#fff4e0', 0.0, 0.3, '#ffe8c8', 2.0)
    M['glass'] = material('Glass', '#bfe8ff', 0.0, 0.05)
    M['glass'].node_tree.nodes['Principled BSDF'].inputs['Alpha'].default_value = 0.16
    M['glass'].surface_render_method = 'BLENDED'
    # animated by the game
    M['molten'] = material('Molten', '#ff8a20', 0.0, 0.4, '#ff7a10', 6.0)
    M['hot'] = material('HotIngot', '#ff9a40', 0.6, 0.35, '#ff6a10', 4.0)
    M['laser'] = material('Laser', '#6af0ff', 0.0, 0.2, '#4ae8ff', 5.0)
    M['crystal'] = material('Crystal', '#7ae8ff', 0.0, 0.1, '#3ad0ff', 1.2)


def box(p, c, s, mat, **kw):
    p.box(D(*c), S(*s), mat, **kw)


def cyl(p, a, b, r, mat, **kw):
    p.cyl(D(*a), D(*b), r, mat, **kw)


def ring(p, c, R, r, mat, segs=32):
    p.torus(D(*c), (0, 0, 1), R, r, mat, segs, 8)


# ------------------------------------------------------------------ floor and wall
def build_floor(p):
    cx = (X0 + X1) / 2
    depth = FRONT - WALL
    box(p, (cx, 0.03, (WALL + FRONT) / 2), (X1 - X0, 0.06, depth), M['plate'], bevel=0.01)
    # diamond plate ribs
    for i in range(int((X1 - X0) / 0.5)):
        x = X0 + 0.25 + i * 0.5
        for j in range(int(depth / 0.5)):
            z = WALL + 0.25 + j * 0.5
            box(p, (x, 0.065, z), (0.18, 0.012, 0.05), M['steel'], bevel=0)
    # yellow and black hazard border along the front edge
    n = int((X1 - X0) / 0.4)
    for i in range(n):
        box(p, (X0 + 0.2 + i * 0.4, 0.07, FRONT - 0.12), (0.4, 0.02, 0.22), M['stripe'] if i % 2 else M['black'], bevel=0)
    # a wall lining of riveted panels behind the machines
    box(p, (cx, 4.5, WALL + 0.06), (X1 - X0, 9.0, 0.08), M['dark'], bevel=0)
    for x in range(int(X0) + 1, int(X1), 2):
        box(p, (x, 4.5, WALL + 0.12), (0.1, 9.0, 0.08), M['iron'], bevel=0.01)
    for y in (2.2, 5.0):
        box(p, (cx, y, WALL + 0.13), (X1 - X0, 0.08, 0.06), M['iron'], bevel=0)


def build_pipes(p):
    # two long pipes along the wall, drops into the machines, valve wheels
    for y, r, mat in ((6.4, 0.16, M['copper']), (7.1, 0.12, M['steel'])):
        cyl(p, (X0 + 0.2, y, WALL + 0.45), (X1 - 0.2, y, WALL + 0.45), r, mat, segs=14)
        for x in range(int(X0) + 1, int(X1), 3):
            box(p, (x + 0.5, y, WALL + 0.3), (0.12, 0.42, 0.3), M['dark'], bevel=0.01)
    for x, top, bot in ((16.4, 6.4, 3.1), (21.0, 7.1, 3.0), (23.6, 6.4, 3.0)):
        cyl(p, (x, top, WALL + 0.45), (x, bot, WALL + 0.45), 0.1, M['copper'] if top < 7 else M['steel'], segs=12)
        ring(p, (x, (top + bot) / 2, WALL + 0.45), 0.13, 0.03, M['dark'], 16)
    for x, y in ((17.6, 6.4), (22.4, 7.1)):
        cyl(p, (x, y, WALL + 0.45), (x, y, WALL + 0.85), 0.04, M['steel'], segs=8)
        p.torus(D(x, y, WALL + 0.88), (0, 1, 0), 0.22, 0.035, M['red'], 20, 6)
        for k in range(3):
            a = k * math.pi / 3
            cyl(p, (x - 0.22 * math.cos(a), y - 0.22 * math.sin(a), WALL + 0.88), (x + 0.22 * math.cos(a), y + 0.22 * math.sin(a), WALL + 0.88), 0.02, M['red'], segs=6)
    # gas bottles in a rack at the left end
    for i in range(3):
        x, z = 9.6 + i * 0.55, WALL + 0.55
        cyl(p, (x, 0.08, z), (x, 1.45, z), 0.22, [M['paint'], M['paint2'], M['red']][i], segs=16)
        p.sphere(D(x, 1.45, z), 0.22, [M['paint'], M['paint2'], M['red']][i], 16, 8, (1, 1, 0.6))
        cyl(p, (x, 1.55, z), (x, 1.72, z), 0.05, M['steel'], segs=10)
    box(p, (10.15, 1.0, WALL + 0.82), (1.8, 0.05, 0.06), M['dark'], bevel=0)


# ------------------------------------------------------------------ the blast furnace
def build_furnace(p):
    x, z = FURNACE
    box(p, (x, 0.25, z - 0.1), (3.6, 0.5, 3.0), M['iron'], bevel=0.04)
    # the stack: a fat refractory-lined body tapering into a throat and the flue
    cyl(p, (x, 0.5, z), (x, 1.0, z), 1.45, M['iron'], segs=32)
    cyl(p, (x, 1.0, z), (x, 3.9, z), 1.4, M['brick'], segs=32, r2=1.32)
    cyl(p, (x, 3.9, z), (x, 5.4, z), 1.32, M['iron'], segs=32, r2=0.8)
    cyl(p, (x, 5.4, z), (x, 6.0, z), 0.8, M['dark'], segs=24)
    cyl(p, (x, 6.0, z), (x, CEIL, z), 0.48, M['iron'], segs=20, r2=0.42)
    # iron hoops round the body with rivets
    for y in (1.05, 1.9, 2.75, 3.6):
        ring(p, (x, y, z), 1.38 - (y - 1.0) * 0.028, 0.06, M['iron'])
        for k in range(14):
            a = 2 * math.pi * k / 14
            rr = 1.43 - (y - 1.0) * 0.028
            p.sphere(D(x + rr * math.cos(a), y, z + rr * math.sin(a)), 0.035, M['steel'], 6, 4)
    ring(p, (x, 6.0, z), 0.82, 0.07, M['iron'], 24)
    ring(p, (x, 7.6, z), 0.47, 0.05, M['iron'], 20)
    # cooling staves: vertical ribs on the throat
    for k in range(12):
        a = 2 * math.pi * k / 12
        cyl(p, (x + 1.3 * math.cos(a), 3.95, z + 1.3 * math.sin(a)), (x + 0.82 * math.cos(a), 5.35, z + 0.82 * math.sin(a)), 0.05, M['steel'], segs=6)
    # four legs bracing the body
    for sx, sz in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        cyl(p, (x + sx * 1.55, 0.5, z + sz * 1.0), (x + sx * 1.25, 3.9, z + sz * 0.7), 0.09, M['dark'], segs=8)
    # the hatch: a glowing window behind bars in a heavy frame, facing the promenade
    hz = z + 1.36
    box(p, (x, 1.9, hz), (1.25, 1.05, 0.22), M['iron'], bevel=0.04)
    box(p, (x, 1.9, hz + 0.05), (0.95, 0.75, 0.16), M['molten'], bevel=0)
    for i in range(5):
        cyl(p, (x - 0.38 + i * 0.19, 1.5, hz + 0.16), (x - 0.38 + i * 0.19, 2.3, hz + 0.16), 0.025, M['dark'], segs=6)
    for s in (-1, 1):
        cyl(p, (x + s * 0.7, 1.6, hz + 0.05), (x + s * 0.7, 2.2, hz + 0.05), 0.06, M['steel'], segs=8)
    box(p, (x, 2.55, hz + 0.08), (0.5, 0.12, 0.12), M['steel'], bevel=0.02)
    # tuyeres: blast pipes from a bustle ring into the hearth
    ring(p, (x, 2.95, z), 1.65, 0.11, M['copper'], 36)
    for k in range(8):
        a = 2 * math.pi * k / 8 + math.pi / 8
        if abs(math.sin(a) - 1) < 0.3:
            continue
        c, s = math.cos(a), math.sin(a)
        cyl(p, (x + 1.65 * c, 2.95, z + 1.65 * s), (x + 1.4 * c, 2.35, z + 1.4 * s), 0.07, M['copper'], segs=8)
    cyl(p, (x - 1.65, 2.95, z), (x - 1.65, 6.4, WALL + 0.45), 0.13, M['copper'], segs=12)
    # the tap hole and a trough pouring into the first mould
    tx = x + 1.25
    box(p, (tx + 0.25, 1.15, z + 0.45), (0.7, 0.3, 0.5), M['iron'], bevel=0.04)
    p.prism([(-(z + 0.6), 1.12), (-(z + 0.3), 1.12), (-(z + 0.38), 1.25), (-(z + 0.52), 1.25)], tx + 0.4, CONVEYOR[0] + 0.25, M['iron'], bevel=0)
    box(p, ((tx + 0.4 + CONVEYOR[0] + 0.25) / 2, 1.27, z + 0.45), (CONVEYOR[0] - tx - 0.15, 0.03, 0.1), M['molten'], bevel=0)
    cyl(p, (CONVEYOR[0] + 0.28, 1.25, z + 0.45), (CONVEYOR[0] + 0.32, CONVEYOR[3] + 0.18, CONVEYOR[2] + 0.05), 0.045, M['molten'], segs=8)
    # a catwalk round the throat with a railing and a ladder up the back
    cy = 4.05
    ring(p, (x, cy, z), 1.95, 0.05, M['stripe'], 40)
    ring(p, (x, cy + 0.95, z), 1.95, 0.04, M['stripe'], 40)
    ring(p, (x, cy - 0.04, z), 1.65, 0.3, M['dark'], 40)
    for k in range(16):
        a = 2 * math.pi * k / 16
        cyl(p, (x + 1.95 * math.cos(a), cy, z + 1.95 * math.sin(a)), (x + 1.95 * math.cos(a), cy + 0.95, z + 1.95 * math.sin(a)), 0.03, M['stripe'], segs=6)
    lx = x - 1.7
    for s in (-0.25, 0.25):
        cyl(p, (lx, 0.5, WALL + 0.6 + s), (lx, cy + 1.0, WALL + 0.6 + s), 0.03, M['steel'], segs=6)
    for y in [0.8 + i * 0.35 for i in range(10)]:
        cyl(p, (lx, y, WALL + 0.35), (lx, y, WALL + 0.85), 0.02, M['steel'], segs=6)
    # a work lamp over the hatch
    cyl(p, (x + 0.9, 3.6, hz - 0.1), (x + 0.9, 3.25, hz + 0.25), 0.03, M['dark'], segs=6)
    p.cyl(D(x + 0.9, 3.2, hz + 0.28), D(x + 0.9, 3.05, hz + 0.38), 0.12, M['paint'], segs=14, r2=0.16)
    p.cyl(D(x + 0.9, 3.04, hz + 0.39), D(x + 0.9, 3.02, hz + 0.40), 0.14, M['lamp'], segs=14)


# ------------------------------------------------------------------ conveyor and cooling hood
def build_conveyor(p):
    x0, x1, z, top = CONVEYOR
    cx = (x0 + x1) / 2
    for s in (-1, 1):
        box(p, (cx, top - 0.05, z + s * 0.55), (x1 - x0 + 0.2, 0.16, 0.08), M['paint'], bevel=0.015)
    n = int((x1 - x0) / 0.28)
    for i in range(n + 1):
        rx = x0 + i * (x1 - x0) / n
        cyl(p, (rx, top - 0.09, z - 0.5), (rx, top - 0.09, z + 0.5), 0.07, M['steel'], segs=10)
    for rx in (x0 + 0.2, cx, x1 - 0.2):
        for s in (-1, 1):
            box(p, (rx, (top - 0.15) / 2, z + s * 0.5), (0.1, top - 0.15, 0.1), M['dark'], bevel=0.01)
        box(p, (rx, 0.25, z), (0.08, 0.06, 1.0), M['dark'], bevel=0)
    # the cooling hood: a sheet shroud on posts, louvres and two fans on top
    hy = 2.25
    for rx in (x0 + 1.0, x1 - 0.25):
        for s in (-1, 1):
            box(p, (rx, (top + hy) / 2, z + s * 0.62), (0.08, hy - top, 0.08), M['dark'], bevel=0)
    box(p, (x0 + 0.6 + (x1 - x0) / 2, hy, z), (x1 - x0 - 0.6, 0.12, 1.4), M['paint2'], bevel=0.02)
    p.prism([(-(z - 0.7), hy + 0.06), (-(z + 0.7), hy + 0.06), (-(z + 0.4), hy + 0.5), (-(z - 0.4), hy + 0.5)], x0 + 0.9, x1 - 0.1, M['paint2'], bevel=0.02)
    for i in range(10):
        lx = x0 + 1.05 + i * (x1 - x0 - 1.3) / 9
        box(p, (lx, hy - 0.12, z + 0.72), (0.06, 0.2, 0.04), M['dark'], bevel=0)
    for fx in (x0 + 1.9, x1 - 1.3):
        cyl(p, (fx, hy + 0.5, z), (fx, hy + 0.75, z), 0.36, M['dark'], segs=20)
        ring(p, (fx, hy + 0.76, z), 0.36, 0.035, M['steel'], 20)
        for k in range(5):
            a = 2 * math.pi * k / 5
            box(p, (fx + 0.16 * math.cos(a), hy + 0.72, z + 0.16 * math.sin(a)), (0.28, 0.02, 0.1), M['steel'], bevel=0)
    # a flue from the hood into the wall pipe
    cyl(p, (x0 + 3.6, hy + 0.5, z), (x0 + 3.6, 5.6, z - 0.9), 0.16, M['steel'], segs=12)
    cyl(p, (x0 + 3.6, 5.6, z - 0.9), (x0 + 3.6, 6.4, WALL + 0.45), 0.16, M['steel'], segs=12)
    # a small control box with a screen at the conveyor's start
    box(p, (x0 + 0.55, 1.45, z + 0.64), (0.55, 0.42, 0.12), M['paint2'], bevel=0.02)
    box(p, (x0 + 0.55, 1.47, z + 0.71), (0.42, 0.26, 0.02), M['screen'], bevel=0)


def build_ingots(root):
    """Moulds riding the conveyor, each with its ingot (the game moves them along x)."""
    x0, x1, z, top = CONVEYOR
    for i in range(INGOTS):
        x = x0 + 0.35 + i * (x1 - x0 - 0.7) / (INGOTS - 1)
        p = Part(f'Ingot_{i}')
        box(p, (x, top + 0.04, z), (0.62, 0.08, 0.5), M['iron'], bevel=0.015)
        for s in (-1, 1):
            box(p, (x + s * 0.28, top + 0.13, z), (0.06, 0.12, 0.5), M['iron'], bevel=0.01)
            box(p, (x, top + 0.13, z + s * 0.22), (0.62, 0.12, 0.06), M['iron'], bevel=0.01)
        # a trapezoid ingot in the mould
        p.prism([(-(z - 0.17), top + 0.08), (-(z + 0.17), top + 0.08), (-(z + 0.13), top + 0.2), (-(z - 0.13), top + 0.2)], x - 0.22, x + 0.22, M['hot'], bevel=0.012)
        ob = p.build(origin=D(x, top, z))
        parent_to(ob, root)


# ------------------------------------------------------------------ robot arm
def build_arm(root):
    ax, az = 20.05, -38.9
    p = Part('ArmBase')
    cyl(p, (ax, 0.06, az), (ax, 0.3, az), 0.42, M['dark'], segs=24)
    cyl(p, (ax, 0.3, az), (ax, 0.75, az), 0.28, M['paint'], segs=24)
    parent_to(p.build(), root)
    p = Part('Arm')
    p.sphere(D(ax, 0.85, az), 0.27, M['paint'], 20, 12)
    cyl(p, (ax, 0.85, az), (ax - 0.15, 2.1, az + 0.25), 0.13, M['paint'], segs=14)
    p.sphere(D(ax - 0.15, 2.1, az + 0.25), 0.17, M['dark'], 14, 8)
    cyl(p, (ax - 0.15, 2.1, az + 0.25), (ax - 0.45, 1.75, az + 1.0), 0.1, M['paint'], segs=12)
    p.sphere(D(ax - 0.45, 1.75, az + 1.0), 0.12, M['dark'], 12, 8)
    cyl(p, (ax - 0.45, 1.75, az + 1.0), (ax - 0.45, 1.45, az + 1.0), 0.07, M['steel'], segs=10)
    for s in (-1, 1):
        box(p, (ax - 0.45 + s * 0.09, 1.33, az + 1.0), (0.04, 0.2, 0.12), M['steel'], bevel=0.01)
    # hoses along the links
    p.sweep([Vector(D(ax + 0.12, 0.9, az)), Vector(D(ax + 0.05, 1.6, az + 0.2)), Vector(D(ax - 0.05, 2.15, az + 0.3)), Vector(D(ax - 0.35, 1.95, az + 0.8))], 0.025, M['rubber'], 6)
    ob = p.build(origin=D(ax, 0.85, az))
    parent_to(ob, root)


# ------------------------------------------------------------------ machining cell and the finished goods
def build_cell(p, root):
    c0, c1 = CELL
    cx, cz, d = (c0 + c1) / 2, WALL + 1.75, 2.9
    zf = cz + d / 2
    # frame posts and beams, glass walls, a roof with a fan housing
    for x in (c0, c1):
        for zz in (cz - d / 2, zf):
            box(p, (x, 1.4, zz), (0.12, 2.8, 0.12), M['paint'], bevel=0.015)
    for y in (0.08, 2.8):
        for zz in (cz - d / 2, zf):
            box(p, (cx, y, zz), (c1 - c0 + 0.12, 0.12, 0.12), M['paint'], bevel=0.015)
        for x in (c0, c1):
            box(p, (x, y, cz), (0.12, 0.12, d), M['paint'], bevel=0.015)
    box(p, (cx, 2.9, cz), (c1 - c0 + 0.2, 0.1, d + 0.2), M['paint2'], bevel=0.02)
    box(p, (cx, 3.15, cz), (1.4, 0.4, 1.0), M['dark'], bevel=0.04)
    box(p, (cx, 1.5, zf), (c1 - c0 - 0.1, 2.6, 0.03), M['glass'], bevel=0)
    for x in (c0, c1):
        box(p, (x, 1.5, cz), (0.03, 2.6, d - 0.1), M['glass'], bevel=0)
    box(p, (cx, 1.0, zf - 0.04), (c1 - c0 - 0.1, 0.05, 0.03), M['stripe'], bevel=0)
    # the cutting bench: a heavy base, the laser head on a gantry
    box(p, (c0 + 1.1, 0.5, cz), (1.6, 0.9, 1.4), M['paint2'], bevel=0.04)
    box(p, (c0 + 1.1, 0.97, cz), (1.5, 0.04, 1.3), M['dark'], bevel=0)
    for s in (-1, 1):
        box(p, (c0 + 1.1 + s * 0.7, 1.6, cz - 0.55), (0.1, 1.3, 0.1), M['steel'], bevel=0.01)
    box(p, (c0 + 1.1, 2.25, cz - 0.55), (1.5, 0.14, 0.14), M['steel'], bevel=0.015)
    box(p, (c0 + 1.1, 2.0, cz - 0.3), (0.24, 0.4, 0.5), M['paint'], bevel=0.03)
    cyl(p, (c0 + 1.1, 1.8, cz - 0.1), (c0 + 1.1, 1.62, cz - 0.1), 0.06, M['steel'], segs=10)
    # the beam itself, straight down onto the crystal
    cyl(p, (c0 + 1.1, 1.62, cz - 0.1), (c0 + 1.1, 1.18, cz - 0.1), 0.012, M['laser'], segs=6)
    cyl(p, (c0 + 1.1, 1.0, cz - 0.1), (c0 + 1.1, 1.06, cz - 0.1), 0.16, M['steel'], segs=16)
    # the lathe at the back of the cell
    lx0, lx1, lz = c0 + 2.0, c1 - 0.25, cz - 0.7
    box(p, ((lx0 + lx1) / 2, 0.55, lz), (lx1 - lx0, 1.0, 0.7), M['paint2'], bevel=0.04)
    box(p, (lx0 + 0.3, 1.35, lz), (0.6, 0.6, 0.6), M['paint'], bevel=0.04)
    cyl(p, (lx0 + 0.6, 1.3, lz), (lx0 + 0.8, 1.3, lz), 0.22, M['steel'], segs=18)
    cyl(p, (lx0 + 0.8, 1.3, lz), (lx1 - 0.4, 1.3, lz), 0.05, M['ingot'], segs=12)
    box(p, (lx1 - 0.25, 1.3, lz), (0.3, 0.4, 0.4), M['paint'], bevel=0.03)
    box(p, ((lx0 + lx1) / 2 + 0.1, 1.15, lz + 0.25), (0.3, 0.18, 0.25), M['dark'], bevel=0.02)
    # finished parts in a tray: gears and flanges
    for i in range(4):
        gx = lx0 + 0.3 + i * 0.32
        cyl(p, (gx, 1.06, cz + 0.55), (gx, 1.12, cz + 0.55), 0.12, M['ingot'], segs=12)
        cyl(p, (gx, 1.12, cz + 0.55), (gx, 1.14, cz + 0.55), 0.05, M['dark'], segs=8)
    box(p, (lx0 + 0.78, 0.98, cz + 0.55), (1.4, 0.1, 0.4), M['dark'], bevel=0.01)
    box(p, (lx0 + 0.78, 0.5, cz + 0.55), (1.4, 0.9, 0.36), M['paint2'], bevel=0.03)
    # the crystal on its spinning chuck (a node of its own)
    q = Part('Chuck')
    cyl(q, (c0 + 1.1, 1.06, cz - 0.1), (c0 + 1.1, 1.1, cz - 0.1), 0.12, M['dark'], segs=12)
    q.cyl(D(c0 + 1.1, 1.1, cz - 0.1), D(c0 + 1.1, 1.3, cz - 0.1), 0.08, M['crystal'], segs=6, r2=0.07)
    q.cyl(D(c0 + 1.1, 1.3, cz - 0.1), D(c0 + 1.1, 1.42, cz - 0.1), 0.07, M['crystal'], segs=6, r2=0.0)
    parent_to(q.build(origin=D(c0 + 1.1, 1.06, cz - 0.1)), root)


def build_goods(p):
    """Pallets of ingots, cases of optics and crates of parts in front of the cell and the conveyor end."""
    def pallet(x, z, w=1.1, d=0.8):
        box(p, (x, 0.12, z), (w, 0.05, d), M['wood'], bevel=0.005)
        for s in (-1, 0, 1):
            box(p, (x, 0.06, z + s * (d / 2 - 0.06)), (w, 0.08, 0.1), M['wood'], bevel=0.005)
        for i in range(5):
            box(p, (x - w / 2 + 0.1 + i * (w - 0.2) / 4, 0.17, z), (0.12, 0.04, d), M['wood'], bevel=0.005)

    # a stack of ingots, crossed layers
    px, pz = 18.2, -36.85
    pallet(px, pz)
    for layer in range(4):
        y = 0.22 + layer * 0.12
        for i in range(4):
            if layer % 2 == 0:
                box(p, (px - 0.36 + i * 0.24, y, pz), (0.2, 0.11, 0.62), M['ingot'], bevel=0.02)
            else:
                box(p, (px, y, pz - 0.27 + i * 0.18), (0.9, 0.11, 0.16), M['ingot'], bevel=0.02)
    box(p, (px, 0.72, pz), (0.95, 0.02, 0.03), M['black'], bevel=0)
    # optics cases with lenses in the lids, beside the cell
    ox, oz = 23.9, -36.55
    for i, y in enumerate((0.08, 0.4)):
        box(p, (ox, y + 0.15, oz), (0.9, 0.3, 0.4), M['optics'], bevel=0.03)
        for k in range(4):
            cyl(p, (ox - 0.3 + k * 0.2, y + 0.3, oz), (ox - 0.3 + k * 0.2, y + 0.32, oz), 0.07, M['lens'], segs=14)
    # crates of parts with an orange band
    for x, z, h in ((10.2, -36.95, 0.7), (9.9, -37.9, 0.9)):
        box(p, (x, h / 2 + 0.06, z), (0.9, h, 0.75), M['crate'], bevel=0.03)
        box(p, (x, h * 0.6, z), (0.92, 0.1, 0.77), M['paint'], bevel=0.01)
        for s in (-1, 1):
            box(p, (x + s * 0.45, h / 2 + 0.06, z), (0.04, h, 0.77), M['dark'], bevel=0.005)


def build_static(root):
    p = Part('Refinery')
    build_floor(p)
    build_pipes(p)
    build_furnace(p)
    build_conveyor(p)
    build_goods(p)
    parent_to(p.build(), root)
    q = Part('Cell')
    build_cell(q, root)
    parent_to(q.build(), root)


def build():
    reset()
    make_materials()
    root = empty('RefineryRoot', (0, 0, 0))
    build_static(root)
    build_ingots(root)
    build_arm(root)


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
    print(f'refinery: {tris} triangles -> {path} ({os.path.getsize(path) // 1024} KB)')


def render(path):
    """The smelter seen from the promenade (Cycles, CPU)."""
    sc = bpy.context.scene
    world = bpy.data.worlds.new('World')
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.02, 0.025, 0.035, 1)
    sc.world = world
    # the promenade floor and the ceiling light it gets
    fl = Part('PromenadeFloor')
    box(fl, (17, -0.15, -30), (30, 0.3, 30), material('PromFloor', '#8a929c', 0.1, 0.6), bevel=0)
    fl.build()
    for name, loc, energy, color in (
        ('Ceiling1', D(13, 8.5, -33), 900, (1, 0.97, 0.92)), ('Ceiling2', D(21, 8.5, -33), 700, (1, 0.97, 0.92)),
        ('Hatch', D(13, 1.9, -35.6), 160, (1, 0.5, 0.15)), ('Cell', D(22.6, 2.5, -38.2), 60, (0.7, 0.9, 1)),
    ):
        ld = bpy.data.lights.new(name, 'POINT')
        ld.energy = energy
        ld.color = color
        ld.shadow_soft_size = 0.8
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        sc.collection.objects.link(lo)
    cd = bpy.data.cameras.new('Cam')
    cd.lens = 20
    cam = bpy.data.objects.new('Cam', cd)
    cam.location = D(14.5, 2.4, -28.5)
    cam.rotation_euler = (Vector(D(17.6, 2.6, -38.5)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = int(os.environ.get('REFINERY_SAMPLES', '48'))
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.filepath = path
    sc.view_settings.view_transform = 'AgX'
    bpy.ops.render.render(write_still=True)
    print(f'render -> {path}')


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    build()
    export(OUT)
    if '--blend' in argv:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'refinery.blend'))
    if '--render' in argv:
        render(os.path.abspath(argv[argv.index('--render') + 1]))
