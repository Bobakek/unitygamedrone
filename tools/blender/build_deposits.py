"""
Rover expedition deposits for Nova Frontier, built procedurally in Blender.

    python tools/blender/build_deposits.py [--render docs/screenshots/deposits-blender.png]

Writes src/client/assets/deposits.glb with one root node per kind (see src/shared/planet/deposits.ts):

    Vein         basalt outcrop split by glowing ore seams, an old survey stake
    Geode        a cracked-open boulder full of glowing crystals
    Meteorite    a charred iron lump with hot cracks in a small crater
    Probe        a crashed landing probe, half buried, beacon still blinking
    Fossil       the ribcage and skull of something huge, with amber nodules

Each root's origin is on the ground at the deposit's centre; the models reach ~0.6 m below
it so they sit in the terrain whatever its local level. Glowing parts use materials whose
names start with "Glow": the game dims them once a deposit is drilled out.
Sizes match DEPOSIT_SOLID in deposits.ts (solid radius ≈ the footprint the rover bumps into).
"""
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402  (first, so bmesh / mathutils come with the bpy module)
import bmesh  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

from build_rover import Part, empty, material, parent_to, reset  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'src', 'client', 'assets', 'deposits.glb')

M = {}


def make_materials():
    M['basalt'] = material('Basalt', '#3a3634', 0.0, 0.9)
    M['rock'] = material('Rock', '#6e665c', 0.0, 0.92)
    M['rust'] = material('OreRust', '#8a4a22', 0.6, 0.55)
    M['ore'] = material('GlowOre', '#ff8a2a', 0.2, 0.4, '#ff7a1a', 5.0)
    M['shell'] = material('GeodeShell', '#857a6c', 0.0, 0.95)
    M['quartz'] = material('Quartz', '#d8d2ff', 0.0, 0.15)
    M['crystal'] = material('GlowCrystal', '#9a7aff', 0.0, 0.1, '#8a6aff', 4.0)
    M['crystal2'] = material('GlowCrystalCyan', '#7ae8ff', 0.0, 0.1, '#5ad8ff', 3.5)
    M['char'] = material('Char', '#1e1b1a', 0.3, 0.75)
    M['iron'] = material('MeteorIron', '#5c5a58', 0.95, 0.35)
    M['hot'] = material('GlowHot', '#ff4a10', 0.0, 0.5, '#ff3a08', 6.0)
    M['ejecta'] = material('Ejecta', '#5a5048', 0.0, 0.95)
    M['hull'] = material('ProbeHull', '#d9d6cf', 0.6, 0.35)
    M['foil'] = material('ProbeFoil', '#cf9a32', 1.0, 0.3)
    M['frame'] = material('ProbeFrame', '#3b3f45', 0.85, 0.42)
    M['solar'] = material('ProbeSolar', '#16264a', 0.4, 0.18)
    M['chute'] = material('Parachute', '#e86a1c', 0.0, 0.85)
    M['chute2'] = material('ParachuteWhite', '#ece6da', 0.0, 0.85)
    M['blink'] = material('GlowBeacon', '#ff3020', 0.0, 0.2, '#ff2010', 6.0)
    M['bone'] = material('Bone', '#d8ccb0', 0.0, 0.7)
    M['bone2'] = material('BoneOld', '#a8987a', 0.0, 0.8)
    M['amber'] = material('GlowAmber', '#ffb030', 0.0, 0.2, '#ffa020', 3.0)
    M['flag'] = material('Flag', '#e0661c', 0.0, 0.7)


# ------------------------------------------------------------------ helpers
def rock(p, c, size, mat, rng, sub=1, jag=0.22, rot=None):
    """A faceted boulder: a displaced icosphere, squashed to `size` (half extents)."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
    for v in bm.verts:
        v.co *= 1.0 + rng.uniform(-jag, jag)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    r = rot if rot is not None else Matrix.Rotation(rng.uniform(0, math.tau), 3, 'Z') @ Matrix.Rotation(rng.uniform(-0.25, 0.25), 3, 'X')
    bmesh.ops.rotate(bm, matrix=r, verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(c), verts=bm.verts)
    p._merge(bm, mat, False)


def crystal(p, base, direction, length, radius, mat):
    """A hexagonal crystal with a pointed tip."""
    d = Vector(direction).normalized()
    body = Vector(base) + d * length * 0.75
    p.cyl(base, body, radius, mat, 6, smooth=False)
    p.cyl(body, Vector(base) + d * length, radius, mat, 6, r2=0.002, smooth=False)


def blob_ring(p, c, r_in, r_out, height, mat, rng, segs=14):
    """A rough ring of ground thrown up around a crater."""
    for i in range(segs):
        a = math.tau * i / segs + rng.uniform(-0.1, 0.1)
        rr = rng.uniform(r_in, r_out)
        rock(p, (c[0] + math.cos(a) * rr, c[1] + math.sin(a) * rr, -0.15), (rng.uniform(0.35, 0.6), rng.uniform(0.25, 0.4), height * rng.uniform(0.6, 1.1)), mat, rng, 1, 0.18)


# ------------------------------------------------------------------ kinds
def build_vein(x):
    rng = random.Random(11)
    root = empty('Vein', (x, 0, 0))
    p = Part('VeinRock')
    # a ridge of basalt slabs leaning together
    slabs = [((-0.9, 0.2, 0.2), (0.9, 0.7, 1.2)), ((0.3, -0.3, 0.4), (1.0, 0.8, 1.5)), ((1.1, 0.4, 0.1), (0.7, 0.6, 0.9)),
             ((-0.2, 0.9, 0.0), (0.8, 0.5, 0.7)), ((0.6, 0.8, -0.1), (0.5, 0.45, 0.6)), ((-1.3, -0.5, -0.1), (0.6, 0.5, 0.6))]
    for c, s in slabs:
        rock(p, (x + c[0], c[1], c[2]), s, M['basalt'], rng, 1, 0.2)
        # glowing ore knots breaking through each slab's skin
        for _ in range(3):
            a, e = rng.uniform(0, math.tau), rng.uniform(-0.2, 0.9)
            q = (x + c[0] + math.cos(a) * math.cos(e) * s[0] * 0.92, c[1] + math.sin(a) * math.cos(e) * s[1] * 0.92, c[2] + math.sin(e) * s[2] * 0.92)
            rock(p, q, (0.17, 0.14, 0.12), M['ore'], rng, 1, 0.3)
    # ore seams: glowing ribbons in the cracks and rusty nuggets
    seams = [[(-0.55, 0.0, -0.2), (-0.3, 0.05, 0.6), (-0.15, 0.1, 1.15), (0.05, 0.0, 1.5)],
             [(0.75, 0.1, -0.2), (0.7, 0.25, 0.5), (0.85, 0.3, 0.95)],
             [(-0.6, 0.65, -0.1), (-0.1, 0.7, 0.35), (0.3, 0.65, 0.5)]]
    for s in seams:
        p.sweep([Vector((x + a, b, c)) for a, b, c in s], 0.07, M['ore'], 6)
    for _ in range(9):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(0.6, 1.8)
        rock(p, (x + math.cos(a) * r, math.sin(a) * r, rng.uniform(-0.05, 0.15)), (0.16, 0.13, 0.11), M['rust'], rng, 1, 0.3)
    for _ in range(5):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(1.6, 2.4)
        rock(p, (x + math.cos(a) * r, math.sin(a) * r, -0.08), (0.28, 0.22, 0.18), M['basalt'], rng, 1, 0.25)
    # survey stake with a flag
    s0 = Vector((x - 1.6, -1.1, -0.3))
    p.cyl(s0, s0 + Vector((0.05, 0.02, 1.9)), 0.025, M['frame'], 8)
    p.box(s0 + Vector((0.25, 0.02, 1.68)), (0.42, 0.02, 0.24), M['flag'], bevel=0)
    for k in range(3):
        p.box(s0 + Vector((0.0, 0.0, 0.5 + k * 0.4)), (0.06, 0.06, 0.08), M['ore'] if k == 2 else M['rust'], bevel=0)
    ob = p.build((x, 0, 0))
    parent_to(ob, root)


def build_geode(x):
    rng = random.Random(23)
    root = empty('Geode', (x, 0, 0))
    p = Part('GeodeRock')
    # two halves of a hollow boulder, split and fallen apart
    for side, ang in ((-1, -0.45), (1, 0.4)):
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
        for v in bm.verts:
            v.co *= 1.0 + rng.uniform(-0.12, 0.12)
        cut = [v for v in bm.verts if v.co.x * side < -0.05]
        bmesh.ops.delete(bm, geom=cut, context='VERTS')
        bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=-0.18)
        bmesh.ops.scale(bm, vec=Vector((1.0, 1.05, 1.0)), verts=bm.verts)
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(ang, 3, 'Y'), verts=bm.verts)
        bmesh.ops.translate(bm, vec=Vector((x + side * 0.35, 0, 0.55)), verts=bm.verts)
        p._merge(bm, M['shell'], False)
        # crystals lining the hollow, pointing inwards and up
        for _ in range(16):
            u, v = rng.uniform(-1.1, 1.1), rng.uniform(0.0, 1.2)
            th = rng.uniform(-1.2, 1.2)
            dirv = Vector((-side * 0.6, math.sin(th) * 0.5, rng.uniform(0.3, 0.9)))
            b = Vector((x + side * (0.55 + 0.25 * math.cos(th)), math.sin(th) * 0.75, 0.1 + v * 0.75))
            crystal(p, b, Matrix.Rotation(ang, 3, 'Y') @ dirv, rng.uniform(0.3, 0.6), rng.uniform(0.05, 0.09), M['crystal'] if rng.random() < 0.7 else M['crystal2'])
    # a big cluster in the middle and strays around
    for _ in range(9):
        d = Vector((rng.uniform(-0.5, 0.5), rng.uniform(-0.5, 0.5), 1.0))
        crystal(p, (x + rng.uniform(-0.2, 0.2), rng.uniform(-0.25, 0.25), -0.1), d, rng.uniform(0.7, 1.5), rng.uniform(0.09, 0.15), M['crystal'])
    for _ in range(10):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(1.3, 2.3)
        d = Vector((math.cos(a) * 0.5, math.sin(a) * 0.5, 1.0))
        crystal(p, (x + math.cos(a) * r, math.sin(a) * r, -0.15), d, rng.uniform(0.25, 0.6), rng.uniform(0.04, 0.08), M['crystal2'] if rng.random() < 0.5 else M['quartz'])
    for _ in range(6):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(1.2, 2.0)
        rock(p, (x + math.cos(a) * r, math.sin(a) * r, -0.05), (0.3, 0.25, 0.2), M['shell'], rng, 1, 0.2)
    ob = p.build((x, 0, 0))
    parent_to(ob, root)


def build_meteorite(x):
    rng = random.Random(37)
    root = empty('Meteorite', (x, 0, 0))
    p = Part('MeteoriteRock')
    blob_ring(p, (x, 0), 1.5, 1.9, 0.35, M['ejecta'], rng, 16)
    # scorched floor
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, segments=20, radius=1.6)
    bmesh.ops.translate(bm, vec=Vector((x, 0, -0.06)), verts=bm.verts)
    p._merge(bm, M['char'], False)
    # the iron itself: a lumpy, regmaglypt-pitted mass with glowing cracks
    rock(p, (x, 0.05, 0.35), (0.85, 0.7, 0.62), M['iron'], rng, 2, 0.16)
    rock(p, (x + 0.25, -0.15, 0.55), (0.55, 0.5, 0.42), M['char'], rng, 2, 0.2)
    for _ in range(9):
        a, e = rng.uniform(0, math.tau), rng.uniform(-0.1, 0.9)
        pts = []
        for k in range(5):
            pts.append(Vector((x + math.cos(a) * math.cos(e) * 0.86, 0.05 + math.sin(a) * math.cos(e) * 0.71, 0.35 + math.sin(e) * 0.63)))
            a += rng.uniform(-0.25, 0.25)
            e += rng.uniform(-0.2, 0.2)
        p.sweep(pts, 0.045, M['hot'], 5)
    for _ in range(12):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(0.9, 2.6)
        rock(p, (x + math.cos(a) * r, math.sin(a) * r, -0.02), (0.12, 0.1, 0.08), M['iron'] if rng.random() < 0.5 else M['char'], rng, 1, 0.3)
    ob = p.build((x, 0, 0))
    parent_to(ob, root)


def build_probe(x):
    rng = random.Random(41)
    root = empty('Probe', (x, 0, 0))
    p = Part('ProbeWreck')
    tilt = Matrix.Rotation(math.radians(24), 3, 'X') @ Matrix.Rotation(math.radians(-12), 3, 'Y')
    o = Vector((x, 0, 0.45))

    def at(v):
        return o + tilt @ Vector(v)
    # body: a squat cylinder with a domed top and a heat shield skirt, half dug in
    p.cyl(at((0, 0, -0.6)), at((0, 0, 0.6)), 0.6, M['hull'], 18, smooth=False)
    p.cyl(at((0, 0, -0.75)), at((0, 0, -0.6)), 0.78, M['char'], 18, r2=0.62, smooth=False)
    p.cyl(at((0, 0, 0.6)), at((0, 0, 0.95)), 0.6, M['foil'], 18, r2=0.25, smooth=False)
    for i in range(6):
        a = math.tau * i / 6
        p.box(at((math.cos(a) * 0.6, math.sin(a) * 0.6, 0.0)), (0.08, 0.08, 1.1), M['frame'], tilt, bevel=0.01)
    p.box(at((0.0, -0.61, 0.15)), (0.4, 0.04, 0.3), M['frame'])
    p.box(at((0.0, -0.635, 0.15)), (0.3, 0.02, 0.18), M['solar'], bevel=0)
    # legs: two splayed, one snapped
    for i, a in enumerate((0.4, 2.5, 4.6)):
        hip = at((math.cos(a) * 0.55, math.sin(a) * 0.55, -0.3))
        foot = Vector((x + math.cos(a) * 1.35, math.sin(a) * 1.35, -0.1))
        if i == 2:
            foot = hip + (foot - hip) * 0.45
            p.cyl(foot + Vector((0.2, 0.25, -0.2)), Vector((x + math.cos(a) * 1.5, math.sin(a) * 1.5, -0.05)), 0.035, M['frame'], 8)
        p.cyl(hip, foot, 0.04, M['frame'], 8)
        p.cyl(foot, foot + Vector((0, 0, -0.06)), 0.14, M['frame'], 12)
    # a bent solar wing
    w0 = at((0.6, 0, 0.3))
    p.box(w0 + Vector((0.55, 0.0, -0.05)), (1.0, 0.55, 0.03), M['frame'], Matrix.Rotation(math.radians(-30), 3, 'Y'))
    for k in range(3):
        p.box(w0 + Vector((0.25 + k * 0.28, 0.0, 0.06 - k * 0.16)), (0.24, 0.48, 0.012), M['solar'], Matrix.Rotation(math.radians(-30), 3, 'Y'), bevel=0)
    # antenna mast and the blinking beacon
    top = at((-0.2, 0.15, 0.95))
    p.cyl(top, top + tilt @ Vector((0.0, 0.0, 0.9)), 0.015, M['frame'], 6)
    p.sphere(top + tilt @ Vector((0.0, 0.0, 0.93)), 0.06, M['blink'], 10, 6)
    p.sphere(at((0.25, -0.3, 0.9)), 0.05, M['blink'], 10, 6)
    # parachute draped over the ground behind it: a rumpled sheet in two colours
    for k, mat in ((0, M['chute']), (1, M['chute2'])):
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=8, y_segments=6, size=1.0)
        for v in bm.verts:
            v.co.z = 0.05 + 0.12 * math.sin(v.co.x * 5 + k) * math.cos(v.co.y * 4) + rng.uniform(0, 0.05)
        bmesh.ops.scale(bm, vec=Vector((1.2, 0.5, 1.0)), verts=bm.verts)
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(0.5 + k * 0.25, 3, 'Z'), verts=bm.verts)
        bmesh.ops.translate(bm, vec=Vector((x - 1.6 + k * 0.4, -1.4 - k * 0.6, 0.0)), verts=bm.verts)
        bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.02)
        p._merge(bm, mat, True)
    for k in range(4):  # shroud lines back to the probe
        p.cyl(at((math.cos(k) * 0.3, math.sin(k) * 0.3, 0.9)), Vector((x - 1.0 + k * 0.2, -1.2 - k * 0.1, 0.08)), 0.006, M['frame'], 4)
    blob_ring(p, (x, 0), 0.9, 1.4, 0.2, M['ejecta'], rng, 10)
    ob = p.build((x, 0, 0))
    parent_to(ob, root)


def build_fossil(x):
    rng = random.Random(53)
    root = empty('Fossil', (x, 0, 0))
    p = Part('FossilBones')
    # a spine arching along the ground
    spine = [Vector((x - 2.0 + i * 0.25, 0.25 * math.sin(i * 0.35), 0.2 + 0.18 * math.sin(i * 0.22))) for i in range(17)]
    for i, c in enumerate(spine):
        p.sphere(c, 0.13 - 0.003 * i, M['bone'] if i % 2 else M['bone2'], 10, 6, (0.8, 1.0, 0.9))
        p.cyl(c, c + Vector((0, 0, 0.22)), 0.03, M['bone'], 6)
    p.tube(spine, 0.06, M['bone2'], 8)
    # ribs: curved bones arching up on both sides, the middle ones tallest
    for i in range(3, 13):
        c = spine[i]
        hgt = 1.0 + 0.6 * math.sin((i - 3) / 9 * math.pi)
        for side in (-1, 1):
            if rng.random() < 0.12:
                continue
            pts = []
            for k in range(9):
                t = k / 8
                a = t * math.pi * 0.95
                pts.append(c + Vector((0.05 * t, side * (0.15 + 0.85 * math.sin(a * 0.9)), hgt * math.sin(a) * (1 - 0.25 * t) - 0.35 * t)))
            p.sweep(pts, 0.05 - 0.004 * abs(i - 8), M['bone'], 6)
    # skull at the head end, jaws open, and a broken limb bone
    s = Vector((x + 2.35, 0.2, 0.35))
    p.sphere(s, 0.42, M['bone'], 14, 10, (1.4, 0.8, 0.7))
    p.sphere(s + Vector((0.35, 0.0, 0.05)), 0.2, M['bone2'], 10, 6, (1.6, 0.8, 0.6))
    for sy in (-1, 1):
        p.sphere(s + Vector((0.1, sy * 0.22, 0.12)), 0.1, M['char'], 8, 6)
        for k in range(4):
            p.cyl(s + Vector((0.55 + k * 0.08, sy * 0.15, -0.12)), s + Vector((0.57 + k * 0.08, sy * 0.15, -0.3)), 0.025, M['bone'], 5, r2=0.004)
    p.box(s + Vector((0.45, 0.0, -0.4)), (0.8, 0.35, 0.08), M['bone2'], Matrix.Rotation(math.radians(-15), 3, 'Y'))
    p.cyl((x - 0.5, -1.5, 0.05), (x + 0.6, -1.9, 0.12), 0.07, M['bone2'], 8)
    p.sphere((x - 0.5, -1.5, 0.05), 0.12, M['bone'], 8, 6)
    # amber nodules with something trapped inside, glowing
    for _ in range(6):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(0.3, 1.6)
        rock(p, (x + math.cos(a) * r, math.sin(a) * r * 0.8, 0.0), (0.12, 0.1, 0.1), M['amber'], rng, 1, 0.2)
    for _ in range(7):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(1.4, 2.5)
        rock(p, (x + math.cos(a) * r, math.sin(a) * r, -0.1), (0.35, 0.3, 0.2), M['rock'], rng, 1, 0.22)
    ob = p.build((x, 0, 0))
    parent_to(ob, root)


KINDS = (('Vein', build_vein), ('Geode', build_geode), ('Meteorite', build_meteorite), ('Probe', build_probe), ('Fossil', build_fossil))
SPACING = 6.5


def build():
    reset()
    make_materials()
    for i, (_, fn) in enumerate(KINDS):
        fn((i - (len(KINDS) - 1) / 2) * SPACING)


def export(path):
    # each kind is exported at the origin: shift the roots back after exporting a lineup
    roots = [bpy.data.objects[n] for n, _ in KINDS]
    keep = [r.location.copy() for r in roots]
    for r in roots:
        r.location = (0, 0, 0)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_yup=True, export_apply=True,
                              export_cameras=False, export_lights=False, export_animations=False)
    for r, loc in zip(roots, keep):
        r.location = loc
    tris = 0
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    print(f'deposits: {tris} triangles -> {path} ({os.path.getsize(path) // 1024} KB)')


def render(path):
    sc = bpy.context.scene
    world = bpy.data.worlds.new('World')
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.015, 0.016, 0.025, 1)
    sc.world = world
    me = bpy.data.meshes.new('Ground')
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=60)
    bm.to_mesh(me)
    g = bpy.data.objects.new('Ground', me)
    g.location = (0, 0, -0.02)
    g.data.materials.append(material('Regolith', '#7d6c5a', 0, 0.95))
    sc.collection.objects.link(g)
    for name, loc, energy, size in (('Key', (8, -12, 14), 6000, 12), ('Rim', (-12, 10, 6), 1500, 6), ('Fill', (0, -16, 4), 1600, 14)):
        ld = bpy.data.lights.new(name, 'AREA')
        ld.energy = energy
        ld.size = size
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        sc.collection.objects.link(lo)
    cd = bpy.data.cameras.new('Cam')
    cd.lens = 24
    cam = bpy.data.objects.new('Cam', cd)
    cam.location = (0.0, -21.0, 5.5)
    cam.rotation_euler = (Vector((0, 0, 0.6)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = int(os.environ.get('DEPOSIT_SAMPLES', '48'))
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 560
    sc.render.filepath = path
    sc.view_settings.view_transform = 'AgX'
    bpy.ops.render.render(write_still=True)
    print(f'render -> {path}')


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    build()
    export(OUT)
    if '--render' in argv:
        render(os.path.abspath(argv[argv.index('--render') + 1]))
