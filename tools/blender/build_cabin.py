"""
The pilot's cabin on a station and the trophy models shown in it, built procedurally in Blender.

    blender -b -P tools/blender/build_cabin.py -- [--render docs/screenshots/cabin-blender.png]
    # or with the bpy module: python tools/blender/build_cabin.py [--render ...]

Writes src/client/assets/cabin.glb (glTF binary, Y up). Everything is in deck coordinates
(see src/shared/station/deck.ts): x and z along the deck, y up from the floor; the cabin is
the room x -22..-8, z -56..-40, ceiling 4.2, with its door at x = -15 in the promenade wall.
Blender is Z up, so a deck point (x, y, z) is the Blender point (x, -z, y); see D() below.

Nodes the game uses (src/client/world/cabin.ts):

    CabinRoom, Bed, Desk, RelicShelf, JarCase, PatchBoard, DisplayCase, Decor   furniture
    Slot_<relic|shard|log|specimen|medal|patch>_<n>    empties where trophies go; an item
                                                       placed there faces the empty's -Y
                                                       in Blender (deck +z before rotation)
    Protos/Relic_0..2, Datapad, Jar, Shard, Medal      trophy models at the origin, facing
                                                       deck +z; materials "Tint" / "Tint2"
                                                       are recoloured per trophy

The bed, desk and display table stand where deck.ts CABIN says (the walking obstacles).
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402  (first: with the bpy module, bmesh / mathutils come with it)
import bmesh  # noqa: E402,F401
from mathutils import Euler, Vector  # noqa: E402

from build_rover import Part, empty, material, parent_to, reset  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'src', 'client', 'assets', 'cabin.glb')

# ------------------------------------------------------------------ layout (match CABIN in deck.ts)
X0, X1, Z0, Z1, CEIL = -22.0, -8.0, -56.0, -40.0, 4.2
DOOR_X, DOOR_HALF, DOOR_H = -15.0, 1.5, 3.0
BED = (-9.6, -52.6)
DESK = (-9.2, -45.5)
TABLE = (-15.0, -50.0)


def D(x, y, z):
    """Deck point -> Blender point."""
    return (x, -z, y)


def S(w, h, d):
    """Deck box size (along x, y, z) -> Blender size."""
    return (w, d, h)


def face(fx, fz):
    """Blender rotation that turns an item facing deck +z to face deck (fx, fz)."""
    return Euler((0, 0, math.atan2(fx, fz)))


M = {}


def make_materials():
    M['floor'] = material('Floor', '#3c3a38', 0.1, 0.7)
    M['rug'] = material('Rug', '#23345a', 0.0, 0.95)
    M['rug2'] = material('RugBorder', '#b08a4a', 0.0, 0.9)
    M['wall'] = material('Wall', '#c9c6be', 0.05, 0.6)
    M['panel'] = material('Panel', '#8d939b', 0.2, 0.5)
    M['dark'] = material('DarkMetal', '#2b2f35', 0.7, 0.45)
    M['wood'] = material('Wood', '#7a5233', 0.0, 0.55)
    M['wood2'] = material('WoodDark', '#4a3220', 0.0, 0.6)
    M['sheet'] = material('Sheet', '#e8e6e0', 0.0, 0.85)
    M['blanket'] = material('Blanket', '#2d5a6a', 0.0, 0.9)
    M['glow'] = material('Glow', '#fff4e0', 0.0, 0.3, '#fff0d8', 1.3)
    M['strip'] = material('ShelfLight', '#fff4e0', 0.0, 0.3, '#ffe8c8', 0.5)
    M['cyan'] = material('TrimGlow', '#6af0ff', 0.0, 0.3, '#5ae6ff', 1.0)
    M['amber'] = material('AmberGlow', '#ffb040', 0.0, 0.3, '#ffa030', 2.0)
    M['screen'] = material('Screen', '#0a2a30', 0.0, 0.2, '#3ca8ff', 1.6)
    M['blueprint'] = material('Blueprint', '#10284a', 0.0, 0.4, '#123a7a', 0.6)
    M['lines'] = material('BlueprintLines', '#9ad8ff', 0.0, 0.3, '#9ad8ff', 2.0)
    M['felt'] = material('Felt', '#1d2a3a', 0.0, 0.95)
    M['brass'] = material('Brass', '#c8a050', 1.0, 0.3)
    M['glass'] = material('Glass', '#bfe8ff', 0.0, 0.05)
    M['glass'].node_tree.nodes['Principled BSDF'].inputs['Alpha'].default_value = 0.18
    M['glass'].surface_render_method = 'BLENDED'
    M['pot'] = material('Pot', '#6a5a48', 0.0, 0.8)
    M['leaf'] = material('Leaf', '#3a7a4a', 0.0, 0.7)
    M['stone'] = material('Stone', '#6e6458', 0.0, 0.85)
    M['bronze'] = material('Bronze', '#8a6a3a', 1.0, 0.35)
    # recoloured per trophy by the game
    M['tint'] = material('Tint', '#ff9a40', 0.2, 0.35, '#ff9a40', 1.2)
    M['tint2'] = material('Tint2', '#4080ff', 0.1, 0.5)


def box(p, c, s, mat, **kw):
    p.box(D(*c), S(*s), mat, **kw)


# ------------------------------------------------------------------ room
def build_room():
    p = Part('CabinRoom')
    cx, cz, w, d = (X0 + X1) / 2, (Z0 + Z1) / 2, X1 - X0, Z1 - Z0
    box(p, (cx, -0.1, cz), (w + 0.6, 0.2, d + 0.6), M['floor'], bevel=0)
    for z in range(int(Z0) + 1, int(Z1)):
        box(p, (cx, 0.004, z), (w, 0.008, 0.03), M['dark'], bevel=0)
    # the rug in front of the display table
    box(p, (cx, 0.012, -48.6), (5.2, 0.02, 6.4), M['rug2'], bevel=0)
    box(p, (cx, 0.02, -48.6), (4.8, 0.02, 6.0), M['rug'], bevel=0)
    # ceiling and two long light strips
    box(p, (cx, CEIL + 0.1, cz), (w + 0.6, 0.2, d + 0.6), M['panel'], bevel=0)
    for x in (-18.5, -11.5):
        box(p, (x, CEIL - 0.03, cz), (0.5, 0.05, 12), M['glow'], bevel=0)
    # walls: back, left, right (the front is the promenade wall with the door)
    box(p, (cx, CEIL / 2, Z0 - 0.15), (w + 0.6, CEIL, 0.3), M['wall'], bevel=0)
    for x in (X0 - 0.15, X1 + 0.15):
        box(p, (x, CEIL / 2, cz), (0.3, CEIL, d + 0.6), M['wall'], bevel=0)
    # wainscot, a lit trim line and ribs every 2 m
    box(p, (cx, 0.5, Z0 + 0.03), (w, 1.0, 0.06), M['panel'], bevel=0)
    box(p, (cx, 3.6, Z0 + 0.03), (w, 0.06, 0.05), M['cyan'], bevel=0)
    for x in (X0 + 0.03, X1 - 0.03):
        box(p, (x, 0.5, cz), (0.06, 1.0, d), M['panel'], bevel=0)
        box(p, (x, 3.6, cz), (0.05, 0.06, d), M['cyan'], bevel=0)
        for z in range(int(Z0) + 2, int(Z1), 2):
            box(p, (x, CEIL / 2, z), (0.14, CEIL, 0.12), M['dark'], bevel=0.01)
    for x in range(int(X0) + 2, int(X1), 2):
        box(p, (x, CEIL / 2, Z0 + 0.06), (0.12, CEIL, 0.14), M['dark'], bevel=0.01)
    # the door frame on the cabin side and the front wall's inner face beside it
    for s in (-1, 1):
        box(p, (DOOR_X + s * (DOOR_HALF + 0.12), DOOR_H / 2, Z1 - 0.08), (0.24, DOOR_H + 0.2, 0.2), M['dark'], bevel=0.02)
        box(p, (DOOR_X + s * (DOOR_HALF + 0.27), DOOR_H / 2, Z1 - 0.07), (0.05, DOOR_H, 0.05), M['amber'], bevel=0)
    box(p, (DOOR_X, DOOR_H + 0.12, Z1 - 0.08), (DOOR_HALF * 2 + 0.48, 0.24, 0.2), M['dark'], bevel=0.02)
    for x0, x1 in ((X0, DOOR_X - DOOR_HALF - 0.24), (DOOR_X + DOOR_HALF + 0.24, X1)):
        box(p, ((x0 + x1) / 2, 0.5, Z1 - 0.05), (x1 - x0, 1.0, 0.06), M['panel'], bevel=0)
        box(p, ((x0 + x1) / 2, 3.6, Z1 - 0.05), (x1 - x0, 0.06, 0.05), M['cyan'], bevel=0)
    p.build()


def build_bed():
    p = Part('Bed')
    x, z = BED
    box(p, (x, 0.22, z), (2.2, 0.44, 4.3), M['wood2'], bevel=0.04)
    box(p, (x, 0.56, z + 0.05), (2.0, 0.26, 4.1), M['sheet'], bevel=0.08)
    box(p, (x, 0.72, z + 0.75), (2.06, 0.1, 2.7), M['blanket'], bevel=0.04)
    box(p, (x - 0.02, 0.74, z + 2.05), (2.08, 0.1, 0.12), M['sheet'], bevel=0.03)
    box(p, (x, 0.8, z - 1.6), (1.3, 0.2, 0.6), M['sheet'], bevel=0.08)
    box(p, (x, 0.85, z - 2.18), (2.3, 1.7, 0.12), M['wood'], bevel=0.04)
    box(p, (x, 1.45, z - 2.11), (1.6, 0.05, 0.03), M['amber'], bevel=0)
    # nightstand with a lamp
    box(p, (-9.0, 0.35, -49.7), (0.9, 0.7, 0.8), M['wood2'], bevel=0.03)
    box(p, (-9.0, 0.4, -49.29), (0.7, 0.04, 0.02), M['brass'], bevel=0)
    p.cyl(D(-9.0, 0.7, -49.7), D(-9.0, 1.05, -49.7), 0.03, M['brass'], 10)
    p.cyl(D(-9.0, 1.0, -49.7), D(-9.0, 1.25, -49.7), 0.17, M['glow'], 16, r2=0.11)
    p.build()


def build_desk():
    p = Part('Desk')
    x, z = DESK
    box(p, (x, 0.76, z), (1.4, 0.06, 2.6), M['wood'], bevel=0.02)
    for sz in (-1, 1):
        box(p, (x + 0.1, 0.37, z + sz * 1.15), (1.1, 0.74, 0.08), M['dark'], bevel=0.01)
    box(p, (x + 0.55, 0.45, z - 0.7), (0.3, 0.55, 0.9), M['wood2'], bevel=0.02)
    # a screen on the wall over the desk and a keyboard
    box(p, (X1 - 0.06, 2.35, z), (0.08, 0.7, 1.2), M['dark'], bevel=0.02)
    box(p, (X1 - 0.11, 2.35, z), (0.02, 0.6, 1.1), M['screen'], bevel=0)
    box(p, (x - 0.15, 0.8, z), (0.3, 0.02, 0.7), M['dark'], bevel=0.005)
    # the rack for ship's logs above the desk
    for y in (1.27, 1.72):
        box(p, (X1 - 0.12, y, z), (0.22, 0.04, 2.3), M['dark'], bevel=0.01)
        box(p, (X1 - 0.23, y + 0.05, z), (0.02, 0.06, 2.3), M['cyan'], bevel=0)
    # chair
    cx = x - 1.25
    box(p, (cx, 0.48, z), (0.55, 0.08, 0.55), M['felt'], bevel=0.03)
    box(p, (cx - 0.26, 0.85, z), (0.06, 0.65, 0.5), M['felt'], bevel=0.03)
    p.cyl(D(cx, 0.06, z), D(cx, 0.46, z), 0.04, M['dark'], 10)
    for k in range(5):
        a = 2 * math.pi * k / 5
        p.cyl(D(cx, 0.05, z), D(cx + 0.3 * math.cos(a), 0.03, z + 0.3 * math.sin(a)), 0.02, M['dark'], 6)
    p.build()


def build_relic_shelf():
    """Left wall: three lit shelves (relics on two, anomaly shards on top), drawers below."""
    p = Part('RelicShelf')
    x, z0, z1 = X0 + 0.3, -55.2, -47.0
    zc, L = (z0 + z1) / 2, z1 - z0
    box(p, (X0 + 0.04, 1.6, zc), (0.06, 3.2, L), M['wood2'], bevel=0)
    for z in (z0, z1):
        box(p, (x, 1.6, z), (0.6, 3.2, 0.08), M['wood'], bevel=0.01)
    box(p, (x, 0.42, zc), (0.6, 0.84, L), M['wood2'], bevel=0.02)
    for k in range(4):
        zz = z0 + L * (k + 0.5) / 4
        box(p, (x + 0.31, 0.42, zz), (0.02, 0.6, L / 4 - 0.2), M['wood'], bevel=0.005)
        box(p, (x + 0.33, 0.55, zz), (0.03, 0.04, 0.3), M['brass'], bevel=0)
    for y in (0.86, 1.62, 2.38, 3.14):
        box(p, (x, y, zc), (0.6, 0.05, L), M['wood'], bevel=0.01)
        if y < 3:
            box(p, (x + 0.24, y + 0.7, zc), (0.04, 0.03, L - 0.2), M['strip'], bevel=0)
    p.build()


def build_jar_case():
    """Left wall by the door: a small glass-fronted cabinet for specimen jars."""
    p = Part('JarCase')
    x, z0, z1 = X0 + 0.28, -46.7, -44.1
    zc, L = (z0 + z1) / 2, z1 - z0
    box(p, (X0 + 0.04, 1.4, zc), (0.06, 1.8, L), M['dark'], bevel=0)
    for z in (z0, z1):
        box(p, (x, 1.4, z), (0.56, 1.8, 0.06), M['dark'], bevel=0.01)
    for y in (0.52, 1.18, 1.86, 2.3):
        box(p, (x, y, zc), (0.56, 0.05, L), M['dark'], bevel=0.01)
    for y in (1.1, 1.78):
        box(p, (x + 0.22, y, zc), (0.03, 0.02, L - 0.1), M['cyan'], bevel=0)
    box(p, (x, 0.26, zc), (0.56, 0.52, L), M['panel'], bevel=0.02)
    p.build()


def build_patch_board():
    p = Part('PatchBoard')
    z = Z0 + 0.06
    box(p, (DOOR_X, 2.3, z), (4.6, 2.3, 0.08), M['dark'], bevel=0.02)
    box(p, (DOOR_X, 2.3, z + 0.045), (4.4, 2.1, 0.02), M['felt'], bevel=0)
    box(p, (DOOR_X, 3.52, z + 0.04), (2.0, 0.12, 0.04), M['brass'], bevel=0.01)
    # a framed blueprint of the pilot's ship to the left
    bx = -19.6
    box(p, (bx, 2.2, z), (2.6, 1.7, 0.06), M['dark'], bevel=0.02)
    box(p, (bx, 2.2, z + 0.035), (2.4, 1.5, 0.01), M['blueprint'], bevel=0)
    for y, w in ((2.2, 1.7), (2.45, 0.9), (1.95, 0.9)):
        box(p, (bx, y, z + 0.045), (w, 0.02, 0.005), M['lines'], bevel=0)
    for dx, h in ((-0.85, 0.5), (0.85, 0.3), (0.0, 0.9)):
        box(p, (bx + dx, 2.2, z + 0.045), (0.02, h, 0.005), M['lines'], bevel=0)
    p.build()


def build_display_case():
    p = Part('DisplayCase')
    x, z = TABLE
    box(p, (x, 0.45, z), (1.4, 0.9, 1.0), M['wood2'], bevel=0.03)
    box(p, (x, 0.9, z), (1.46, 0.04, 1.06), M['brass'], bevel=0.01)
    box(p, (x, 0.93, z), (1.3, 0.02, 0.9), M['felt'], bevel=0)
    box(p, (x, 0.06, z), (1.5, 0.12, 1.1), M['amber'], bevel=0.01)
    # glass hood with a frame
    box(p, (x, 1.22, z), (1.32, 0.56, 0.92), M['glass'], bevel=0)
    for sx in (-1, 1):
        for sz in (-1, 1):
            box(p, (x + sx * 0.65, 1.22, z + sz * 0.45), (0.03, 0.56, 0.03), M['brass'], bevel=0)
    box(p, (x, 1.51, z), (1.34, 0.03, 0.94), M['brass'], bevel=0)
    p.build()


def build_decor():
    p = Part('Decor')
    # plants in the corners by the door and beside the bed
    for x, z, s in ((-12.2, -55.2, 1.0), (-8.8, -41.0, 0.8)):
        p.cyl(D(x, 0, z), D(x, 0.6 * s, z), 0.32 * s, M['pot'], 14, r2=0.26 * s)
        for k in range(7):
            a = 2 * math.pi * k / 7
            tip = D(x + math.cos(a) * 0.45 * s, (0.9 + 0.3 * (k % 2)) * s, z + math.sin(a) * 0.45 * s)
            p.cyl(D(x, 0.55 * s, z), tip, 0.06 * s, M['leaf'], 5, r2=0.01)
        p.sphere(D(x, 0.85 * s, z), 0.28 * s, M['leaf'], 8, 6, (1, 1, 1.3))
    # a crate of keepsakes by the shelf
    box(p, (-20.9, 0.3, -56 + 0.45), (0.8, 0.6, 0.6), M['wood'], bevel=0.03)
    p.build()


# ------------------------------------------------------------------ slots
def build_slots():
    sx = X0 + 0.42
    z0, z1 = -55.2, -47.0
    k = 0
    for y in (0.89, 1.65):
        for i in range(6):
            e = empty(f'Slot_relic_{k}', D(sx, y, z0 + (z1 - z0) * (i + 0.5) / 6))
            e.rotation_euler = face(1, 0)
            k += 1
    for i in range(6):
        e = empty(f'Slot_shard_{i}', D(sx, 2.41, z0 + (z1 - z0) * (i + 0.5) / 6))
        e.rotation_euler = face(1, 0)
    k = 0
    for y in (0.55, 1.21):
        for i in range(3):
            e = empty(f'Slot_specimen_{k}', D(X0 + 0.3, y, -46.7 + 2.6 * (i + 0.5) / 3))
            e.rotation_euler = face(1, 0)
            k += 1
    k = 0
    for y in (1.3, 1.75):
        for i in range(4):
            e = empty(f'Slot_log_{k}', D(X1 - 0.16, y, DESK[1] - 0.9 + 0.6 * i))
            e.rotation_euler = face(-1, 0)
            k += 1
    k = 0
    for row in range(3):
        for col in range(5):
            e = empty(f'Slot_patch_{k}', D(DOOR_X - 1.68 + 0.84 * col, 3.0 - 0.66 * row, Z0 + 0.13))
            e.rotation_euler = face(0, 1)
            k += 1
    k = 0
    for row in range(2):
        for col in range(3):
            e = empty(f'Slot_medal_{k}', D(TABLE[0] - 0.4 + 0.4 * col, 0.94, TABLE[1] - 0.18 + 0.36 * row))
            e.rotation_euler = face(0, 1)
            k += 1


# ------------------------------------------------------------------ trophy models (origin, facing deck +z)
def build_protos():
    root = empty('Protos', (0, 0, 0))

    # Relic_0: an idol with a halo
    p = Part('Relic_0')
    p.cyl(D(0, 0, 0), D(0, 0.05, 0), 0.12, M['bronze'], 16)
    p.cyl(D(0, 0.05, 0), D(0, 0.3, 0), 0.09, M['stone'], 8, r2=0.05)
    p.sphere(D(0, 0.35, 0), 0.06, M['stone'], 10, 8)
    p.torus(D(0, 0.36, -0.03), (0, 1, 0), 0.1, 0.012, M['tint'], 20, 6)
    for s in (-1, 1):
        p.cyl(D(s * 0.05, 0.25, 0), D(s * 0.12, 0.16, 0.02), 0.018, M['stone'], 6)
    p.sphere(D(0, 0.2, 0.055), 0.022, M['tint'], 8, 6)
    parent_to(p.build(), root)

    # Relic_1: a glowing orb on a tripod in a tilted ring
    p = Part('Relic_1')
    for k in range(3):
        a = 2 * math.pi * k / 3
        p.cyl(D(math.cos(a) * 0.1, 0, math.sin(a) * 0.1), D(0, 0.18, 0), 0.012, M['bronze'], 6)
    p.torus(D(0, 0.02, 0), (0, 0, 1), 0.1, 0.01, M['bronze'], 18, 6)
    p.sphere(D(0, 0.27, 0), 0.1, M['tint'], 16, 12)
    p.torus(D(0, 0.27, 0), (0.4, 0.3, 1), 0.14, 0.01, M['bronze'], 24, 6)
    parent_to(p.build(), root)

    # Relic_2: a rune tablet on a stand
    p = Part('Relic_2')
    p.box(D(0, 0.03, 0), S(0.3, 0.06, 0.14), M['bronze'], bevel=0.01)
    p.box(D(0, 0.27, 0), S(0.28, 0.42, 0.05), M['stone'], bevel=0.012)
    for i in range(4):
        p.box(D(-0.04 + 0.03 * (i % 2), 0.38 - 0.08 * i, 0.027), S(0.14 - 0.02 * i, 0.018, 0.006), M['tint'], bevel=0)
    p.box(D(0.08, 0.2, 0.027), S(0.018, 0.16, 0.006), M['tint'], bevel=0)
    parent_to(p.build(), root)

    # Datapad: a ship's log card standing in the rack
    p = Part('Datapad')
    p.box(D(0, 0.17, 0), S(0.24, 0.34, 0.03), M['dark'], bevel=0.008)
    p.box(D(0, 0.18, 0.016), S(0.2, 0.26, 0.004), M['tint'], bevel=0)
    p.box(D(0, 0.03, 0.017), S(0.05, 0.012, 0.004), M['tint2'], bevel=0)
    parent_to(p.build(), root)

    # Jar: a specimen in a glass jar
    p = Part('Jar')
    p.cyl(D(0, 0, 0), D(0, 0.04, 0), 0.14, M['brass'], 18)
    p.cyl(D(0, 0.04, 0), D(0, 0.4, 0), 0.125, M['glass'], 18)
    p.cyl(D(0, 0.4, 0), D(0, 0.45, 0), 0.135, M['brass'], 18)
    p.sphere(D(0, 0.2, 0), 0.07, M['tint'], 12, 8, (1.0, 0.8, 1.3))
    p.sphere(D(0, 0.27, 0.03), 0.04, M['tint'], 10, 6)
    for s in (-1, 1):
        p.sphere(D(s * 0.02, 0.285, 0.065), 0.011, M['tint2'], 6, 4)
        p.cyl(D(s * 0.04, 0.17, 0.02), D(s * 0.08, 0.1, 0.05), 0.012, M['tint'], 5)
    parent_to(p.build(), root)

    # Shard: a crystal cluster on a rock
    p = Part('Shard')
    p.sphere(D(0, 0.03, 0), 0.1, M['stone'], 8, 5, (1.3, 1.0, 0.5))
    for k, (dx, dz, h, lean) in enumerate(((0, 0, 0.32, 0), (0.06, 0.02, 0.2, 0.5), (-0.05, 0.03, 0.22, -0.45), (0.02, -0.05, 0.16, 0.3), (-0.03, -0.04, 0.14, -0.3))):
        tip = D(dx + math.sin(lean) * h, 0.05 + math.cos(lean) * h, dz)
        p.cyl(D(dx, 0.04, dz), tip, 0.035 if k else 0.045, M['tint'], 6, r2=0.004, smooth=False)
    parent_to(p.build(), root)

    # Medal: a disc on a ribbon on a small easel
    p = Part('Medal')
    p.box(D(0, 0.01, -0.02), S(0.14, 0.02, 0.1), M['dark'], bevel=0.004)
    p.cyl(D(0, 0.02, -0.05), D(0, 0.22, -0.02), 0.006, M['dark'], 6)
    p.box(D(0, 0.2, 0.0), S(0.07, 0.09, 0.008), M['tint2'], bevel=0)
    p.cyl(D(0, 0.11, -0.004), D(0, 0.11, 0.012), 0.05, M['tint'], 24)
    p.cyl(D(0, 0.11, 0.012), D(0, 0.11, 0.016), 0.032, M['tint2'], 20)
    parent_to(p.build(), root)
    return root


def build():
    reset()
    make_materials()
    build_room()
    build_bed()
    build_desk()
    build_relic_shelf()
    build_jar_case()
    build_patch_board()
    build_display_case()
    build_decor()
    build_slots()
    build_protos()


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
    print(f'cabin: {tris} triangles -> {path} ({os.path.getsize(path) // 1024} KB)')


def render(path):
    """A look into the furnished cabin from the door, trophies on their slots (Cycles, CPU)."""
    sc = bpy.context.scene
    protos = {o.name: o for o in bpy.data.objects['Protos'].children}
    pick = {'relic': ['Relic_0', 'Relic_1', 'Relic_2'], 'shard': ['Shard'], 'specimen': ['Jar'], 'log': ['Datapad'], 'medal': ['Medal']}
    for o in list(bpy.data.objects):
        if not o.name.startswith('Slot_'):
            continue
        kind, n = o.name[5:].rsplit('_', 1)
        if kind not in pick or int(n) > 8:
            continue
        src = protos[pick[kind][int(n) % len(pick[kind])]]
        c = src.copy()
        c.parent = None
        c.matrix_world = o.matrix_world
        sc.collection.objects.link(c)
    world = bpy.data.worlds.new('World')
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.01, 0.012, 0.02, 1)
    sc.world = world
    for name, loc, energy in (('Lamp1', D(-15, 3.8, -51), 260), ('Lamp2', D(-15, 3.8, -44.5), 200), ('Shelf', D(-19, 2.0, -51), 90)):
        ld = bpy.data.lights.new(name, 'POINT')
        ld.energy = energy
        ld.shadow_soft_size = 0.6
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        sc.collection.objects.link(lo)
    cd = bpy.data.cameras.new('Cam')
    cd.lens = 18
    cam = bpy.data.objects.new('Cam', cd)
    cam.location = D(-12.2, 1.75, -41.0)
    cam.rotation_euler = (Vector(D(-17.0, 1.3, -52.0)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = int(os.environ.get('CABIN_SAMPLES', '48'))
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.filepath = path
    sc.view_settings.view_transform = 'AgX'
    bpy.data.objects['Protos'].hide_render = True
    for o in bpy.data.objects['Protos'].children:
        o.hide_render = True
    bpy.ops.render.render(write_still=True)
    print(f'render -> {path}')


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    build()
    export(OUT)
    if '--blend' in argv:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'cabin.blend'))
    if '--render' in argv:
        render(os.path.abspath(argv[argv.index('--render') + 1]))
