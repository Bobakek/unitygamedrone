"""
Planetary rover for Nova Frontier, built procedurally in Blender.

    blender -b -P tools/blender/build_rover.py -- [--render docs/screenshots/rover-blender.png]
    # or with the bpy module: python tools/blender/build_rover.py [--render ...]

Writes src/client/assets/rover.glb (glTF binary, Y up, forward = -Z like every ship in the game)
and keeps the moving parts as separate named nodes so the game can animate them:

    Chassis                        body, frame, cab, cargo bed, mast (static)
    Dish                           high-gain antenna (turns slowly)
    Driver                         seated pilot (shown while someone drives)
    Beacon                         amber beacon lens on the roll cage
    DrillRig                       core drill mast behind the tail (static)
    Drill                          drill carriage (slides down the mast along -Y while drilling)
      DrillBit                     auger (spins about Y)
    Corner_<FL|FR|RL|RR>           per wheel, origin at the wheel centre at rest:
      ArmUpper_*, ArmLower_*       wishbones, origin at the inner hinge (rotate about Z)
      Shock_*                      coil-over, origin at the top mount, axis along -Y (aim + scale)
      Knuckle_*                    upright + spindle (moves along Y with the suspension)
        Steer_*                    steering pivot (rotates about Y)
          Wheel_*                  tyre + rim (spins about X)

Blender is Z up / +Y forward; the glTF exporter turns that into Y up / -Z forward.
All sizes are metres. The origin is the centre of mass; at rest the ground is 0.87 m below it.
The numbers that the physics depends on live in src/shared/sim/rover.ts (ROVER) and must match.
"""
import math
import os
import sys

import bpy  # first: with the bpy module, bmesh / mathutils come with it
import bmesh
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'src', 'client', 'assets', 'rover.glb')

# ------------------------------------------------------------------ dimensions (match ROVER in rover.ts)
TRACK = 1.15          # wheel centre |x|
BASE = 1.30           # wheel centre |y|
WHEEL_Z = -0.40       # wheel centre z at rest
WHEEL_R = 0.47        # tyre radius incl. lugs
TYRE_W = 0.36
HINGE_X = 0.50        # inner wishbone hinges |x|
UPPER_DZ = 0.13       # upper / lower ball joints relative to the wheel centre
LOWER_DZ = -0.13
KNUCKLE_X = 0.93


# ------------------------------------------------------------------ scene
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, metal=0.0, rough=0.5, emit=None, strength=1.0):
    m = bpy.data.materials.new(name)
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*srgb(color), 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*srgb(emit), 1)
        b.inputs['Emission Strength'].default_value = strength
    return m


def srgb(hexstr):
    h = hexstr.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


M = {}


def make_materials():
    M['paint'] = material('Paint', '#e4dfd2', 0.05, 0.42)
    M['accent'] = material('Accent', '#e0661c', 0.1, 0.38)
    M['frame'] = material('Frame', '#3b3f45', 0.85, 0.42)
    M['alu'] = material('Aluminium', '#c3c7cc', 1.0, 0.3)
    M['dark'] = material('DarkPlastic', '#1d1f23', 0.0, 0.6)
    M['rubber'] = material('Rubber', '#1a1a1b', 0.0, 0.92)
    M['gold'] = material('GoldFoil', '#d6a53c', 1.0, 0.28)
    M['solar'] = material('SolarCell', '#16264a', 0.4, 0.18)
    M['seat'] = material('Seat', '#4b525c', 0.0, 0.8)
    M['spring'] = material('Spring', '#d8b020', 0.6, 0.35)
    M['chrome'] = material('Chrome', '#e8ecef', 1.0, 0.12)
    M['lamp'] = material('Headlamp', '#fff6e0', 0.0, 0.1, '#fff2d6', 6.0)
    M['tail'] = material('Taillight', '#ff2a1a', 0.0, 0.2, '#ff2010', 4.0)
    M['screen'] = material('Screen', '#0a2a30', 0.0, 0.2, '#3ce0ff', 2.5)
    M['beacon'] = material('Beacon', '#ffb020', 0.0, 0.2, '#ff9a10', 3.0)
    M['suit'] = material('Suit', '#eceae4', 0.0, 0.7)
    M['visor'] = material('Visor', '#c08a20', 1.0, 0.08)


# ------------------------------------------------------------------ geometry helpers (bmesh)
class Part:
    """A mesh object assembled from primitives; each primitive keeps its material."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []

    def _slot(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def _merge(self, bm, mat, smooth):
        idx = self._slot(mat)
        for f in bm.faces:
            f.material_index = idx
            f.smooth = smooth
        me = bpy.data.meshes.new('tmp')
        bm.to_mesh(me)
        bm.free()
        self.bm.from_mesh(me)
        bpy.data.meshes.remove(me)

    def box(self, center, size, mat, rot=None, smooth=False, bevel=None):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
        if rot is not None:
            bmesh.ops.rotate(bm, matrix=rot.to_matrix() if isinstance(rot, Quaternion) else rot, verts=bm.verts)
        bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
        bevel_bm(bm, min(size) * 0.18 if bevel is None else bevel)
        self._merge(bm, mat, smooth)

    def cyl(self, p0, p1, r, mat, segs=20, r2=None, cap=True, smooth=True):
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segs, radius1=r, radius2=r if r2 is None else r2, depth=d.length)
        q = Vector((0, 0, 1)).rotation_difference(d.normalized())
        bmesh.ops.rotate(bm, matrix=q.to_matrix(), verts=bm.verts)
        bmesh.ops.translate(bm, vec=(p0 + p1) / 2, verts=bm.verts)
        self._merge(bm, mat, smooth)

    def tube(self, pts, r, mat, segs=10):
        """Straight tube segments through `pts` with ball joints at the bends."""
        for a, b in zip(pts, pts[1:]):
            self.cyl(a, b, r, mat, segs)
        for p in pts[1:-1]:
            self.sphere(p, r * 1.02, mat, 10, 6)

    def sphere(self, c, r, mat, segs=16, rings=10, scale=(1, 1, 1)):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=r)
        bmesh.ops.scale(bm, vec=Vector(scale), verts=bm.verts)
        bmesh.ops.translate(bm, vec=Vector(c), verts=bm.verts)
        self._merge(bm, mat, True)

    def prism(self, profile, x0, x1, mat, bevel=0.025):
        """Extrudes a (y, z) polygon from x0 to x1."""
        bm = bmesh.new()
        a = [bm.verts.new((x0, y, z)) for y, z in profile]
        b = [bm.verts.new((x1, y, z)) for y, z in profile]
        bm.faces.new(list(reversed(a)))
        bm.faces.new(b)
        n = len(profile)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bevel_bm(bm, bevel)
        self._merge(bm, mat, False)

    def lathe(self, profile, segs, mat, center=(0, 0, 0), smooth=True):
        """Revolves a (x, r) profile about the X axis (wheels)."""
        bm = bmesh.new()
        cx, cy, cz = center
        rings = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            rings.append([bm.verts.new((cx + x, cy + r * math.cos(a), cz + r * math.sin(a))) for x, r in profile])
        for i in range(segs):
            r0, r1 = rings[i], rings[(i + 1) % segs]
            for k in range(len(profile) - 1):
                bm.faces.new((r0[k], r0[k + 1], r1[k + 1], r1[k]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        self._merge(bm, mat, smooth)

    def sweep(self, pts, r, mat, segs=8):
        """A round tube swept along a polyline (springs, cables)."""
        bm = bmesh.new()
        rings = []
        up = Vector((0, 0, 1))
        for i, p in enumerate(pts):
            t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
            n = t.cross(up)
            if n.length < 1e-4:
                n = t.cross(Vector((1, 0, 0)))
            n.normalize()
            bnm = t.cross(n)
            rings.append([bm.verts.new(p + (n * math.cos(2 * math.pi * k / segs) + bnm * math.sin(2 * math.pi * k / segs)) * r) for k in range(segs)])
        for r0, r1 in zip(rings, rings[1:]):
            for k in range(segs):
                bm.faces.new((r0[k], r0[(k + 1) % segs], r1[(k + 1) % segs], r1[k]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        self._merge(bm, mat, True)

    def torus(self, c, axis, R, r, mat, segs=24, rsegs=8):
        q = Vector((0, 0, 1)).rotation_difference(Vector(axis).normalized())
        pts = [Vector(c) + q @ Vector((R * math.cos(2 * math.pi * i / segs), R * math.sin(2 * math.pi * i / segs), 0)) for i in range(segs + 1)]
        self.sweep(pts, r, mat, rsegs)

    def build(self, origin=(0, 0, 0)):
        """Creates the object with its origin at `origin` (geometry stays in place)."""
        o = Vector(origin)
        bmesh.ops.translate(self.bm, vec=-o, verts=self.bm.verts)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        if hasattr(me, 'set_sharp_from_angle'):
            me.set_sharp_from_angle(angle=math.radians(40))
        ob = bpy.data.objects.new(self.name, me)
        ob.location = o
        bpy.context.scene.collection.objects.link(ob)
        return ob


def bevel_bm(bm, w):
    if w <= 0:
        return
    edges = [e for e in bm.edges if e.is_manifold and e.calc_face_angle(0) > math.radians(30)]
    if edges:
        bmesh.ops.bevel(bm, geom=edges, offset=w, segments=2, profile=0.5, affect='EDGES', clamp_overlap=True)


def empty(name, loc, parent=None):
    e = bpy.data.objects.new(name, None)
    e.location = Vector(loc)
    e.empty_display_size = 0.2
    bpy.context.scene.collection.objects.link(e)
    if parent:
        parent_to(e, parent)
    return e


def parent_to(ob, parent):
    bpy.context.view_layer.update()
    mw = ob.matrix_world.copy()
    ob.parent = parent
    ob.matrix_parent_inverse = parent.matrix_world.inverted()
    ob.matrix_world = mw


def mirror_x(pts, sx):
    return [(sx * x, y, z) for x, y, z in pts]


# ------------------------------------------------------------------ parts
def build_chassis():
    p = Part('Chassis')
    # --- ladder frame
    for sx in (-1, 1):
        p.cyl((sx * 0.45, -1.85, -0.22), (sx * 0.45, 1.85, -0.22), 0.055, M['frame'], 12)
    for y in (-1.75, -1.3, -0.7, 0.0, 0.7, 1.3, 1.75):
        p.cyl((-0.45, y, -0.22), (0.45, y, -0.22), 0.045, M['frame'], 10)
    # suspension towers: boxes the wishbones and shocks hang from
    for sx in (-1, 1):
        for sy in (-1, 1):
            y = sy * BASE
            p.box((sx * 0.47, y, WHEEL_Z), (0.12, 0.42, 0.42), M['frame'])
            p.box((sx * 0.58, y, 0.06), (0.24, 0.16, 0.12), M['frame'])
    # --- floor pan and side sills
    p.box((0, 0, -0.28), (1.2, 3.5, 0.05), M['dark'])
    for sx in (-1, 1):
        p.box((sx * 0.72, 0.0, -0.18), (0.16, 1.4, 0.2), M['paint'])
        p.box((sx * 0.82, 0.0, -0.18), (0.05, 1.0, 0.06), M['alu'])  # step plate
    # --- nose: a wedge with headlamps, grille and a winch
    nose = [(1.05, -0.3), (1.92, -0.3), (2.02, -0.12), (2.0, 0.06), (1.78, 0.2), (1.05, 0.24)]
    p.prism(nose, -0.78, 0.78, M['paint'], 0.04)
    p.prism([(1.6, 0.205), (1.9, 0.08), (1.92, 0.1), (1.62, 0.23)], -0.6, 0.6, M['accent'], 0.01)
    for sx in (-1, 1):
        p.cyl((sx * 0.55, 1.98, -0.04), (sx * 0.55, 2.05, -0.04), 0.1, M['frame'], 20)
        p.cyl((sx * 0.55, 2.05, -0.04), (sx * 0.55, 2.06, -0.04), 0.085, M['lamp'], 20)
        p.cyl((sx * 0.33, 2.0, -0.05), (sx * 0.33, 2.05, -0.05), 0.045, M['frame'], 12)
        p.cyl((sx * 0.33, 2.05, -0.05), (sx * 0.33, 2.055, -0.05), 0.036, M['lamp'], 12)
    for i in range(5):
        p.box((0, 2.01, -0.2 + i * 0.035), (0.36, 0.02, 0.015), M['dark'])
    p.cyl((-0.25, 2.08, -0.24), (0.25, 2.08, -0.24), 0.07, M['frame'], 16)  # winch drum
    p.cyl((-0.12, 2.08, -0.24), (0.12, 2.08, -0.24), 0.075, M['spring'], 16)
    p.box((0, 2.17, -0.25), (0.05, 0.08, 0.05), M['alu'])
    # front bumper bar
    p.tube([(-0.85, 1.9, -0.3), (-0.8, 2.15, -0.3), (0.8, 2.15, -0.3), (0.85, 1.9, -0.3)], 0.04, M['frame'])
    # --- dashboard with screens and the control yoke
    p.prism([(0.95, -0.1), (1.12, -0.1), (1.12, 0.3), (0.9, 0.42), (0.82, 0.38)], -0.7, 0.7, M['dark'], 0.03)
    p.prism([(0.86, 0.39), (0.93, 0.43), (0.97, 0.36), (0.9, 0.32)], -0.6, -0.1, M['screen'], 0.005)
    p.prism([(0.86, 0.39), (0.93, 0.43), (0.97, 0.36), (0.9, 0.32)], 0.12, 0.6, M['screen'], 0.005)
    p.cyl((-0.35, 0.85, 0.3), (-0.35, 0.72, 0.42), 0.025, M['frame'], 8)
    p.torus((-0.35, 0.7, 0.44), (0, 1, -0.6), 0.13, 0.018, M['dark'], 20, 6)
    # --- seats
    for sx in (-1, 1):
        x = sx * 0.36
        p.box((x, 0.32, -0.12), (0.46, 0.5, 0.14), M['seat'])
        p.box((x, 0.06, 0.2), (0.46, 0.12, 0.6), M['seat'], Matrix.Rotation(math.radians(-12), 3, 'X'))
        p.box((x, 0.32, -0.2), (0.4, 0.42, 0.06), M['frame'])
        p.cyl((x - 0.2, 0.55, -0.03), (x - 0.2, 0.15, -0.03), 0.02, M['alu'], 8)
        p.cyl((x + 0.2, 0.55, -0.03), (x + 0.2, 0.15, -0.03), 0.02, M['alu'], 8)
    p.box((0, 0.3, -0.05), (0.18, 0.5, 0.18), M['dark'])  # centre console
    # --- roll cage
    for sx in (-1, 1):
        p.tube(mirror_x([(0.74, -0.12, -0.15), (0.74, -0.12, 0.98), (0.66, 0.42, 1.08), (0.72, 1.08, 0.24)], sx), 0.04, M['frame'])
    p.cyl((-0.74, -0.12, 0.98), (0.74, -0.12, 0.98), 0.04, M['frame'], 10)
    p.cyl((-0.66, 0.42, 1.08), (0.66, 0.42, 1.08), 0.04, M['frame'], 10)
    p.cyl((-0.74, -0.12, 0.5), (0.74, -0.12, 0.5), 0.035, M['frame'], 10)
    for sx in (-1, 1):  # diagonal braces
        p.cyl((sx * 0.74, -0.12, 0.98), (sx * 0.74, -0.7, 0.2), 0.03, M['frame'], 8)
    # sun shade over the cab
    p.box((0, 0.15, 1.1), (1.3, 0.62, 0.03), M['accent'])
    # light bar
    p.box((0, 0.44, 1.15), (1.1, 0.1, 0.08), M['dark'])
    for i in range(4):
        x = -0.39 + i * 0.26
        p.box((x, 0.5, 1.15), (0.18, 0.02, 0.05), M['lamp'])
    # --- fenders over each wheel
    for sx in (-1, 1):
        for sy in (-1, 1):
            arc_fender(p, sx, sy)
    # --- rear deck: batteries in gold foil, a radiator and cargo
    deck = [(-2.0, -0.3), (-0.42, -0.3), (-0.42, 0.12), (-1.95, 0.12), (-2.0, 0.05)]
    p.prism(deck, -0.8, 0.8, M['paint'], 0.035)
    p.prism([(-1.9, 0.13), (-0.5, 0.13), (-0.5, 0.16), (-1.9, 0.16)], -0.82, 0.82, M['accent'], 0.01)
    p.box((0, -1.05, 0.34), (1.0, 0.7, 0.36), M['gold'])
    for i in range(6):
        p.box((0, -0.78 - i * 0.11, 0.53), (1.02, 0.025, 0.04), M['frame'])
    for i in range(9):  # radiator fins
        p.box((-0.55 + i * 0.137, -1.7, 0.36), (0.02, 0.36, 0.42), M['alu'])
    p.box((0, -1.7, 0.16), (1.2, 0.4, 0.04), M['frame'])
    p.box((0.55, -0.6, 0.3), (0.34, 0.26, 0.3), M['accent'])  # crate
    p.box((0.55, -0.6, 0.46), (0.36, 0.28, 0.025), M['frame'])
    p.box((-0.55, -0.62, 0.26), (0.3, 0.3, 0.22), M['dark'])
    # cargo rails
    for sx in (-1, 1):
        p.tube(mirror_x([(0.8, -0.5, 0.12), (0.8, -0.5, 0.42), (0.8, -1.9, 0.42), (0.8, -1.9, 0.12)], sx), 0.025, M['alu'])
    # tail lamps and tow hitch
    for sx in (-1, 1):
        p.box((sx * 0.6, -2.0, -0.05), (0.26, 0.04, 0.08), M['tail'])
    p.box((0, -2.05, -0.27), (0.12, 0.16, 0.08), M['frame'])
    p.sphere((0, -2.14, -0.22), 0.04, M['chrome'])
    # --- mast with a solar panel and a whip antenna
    p.cyl((0.62, -1.62, 0.16), (0.62, -1.62, 1.55), 0.045, M['alu'], 12)
    p.cyl((0.62, -1.62, 1.55), (0.62, -1.62, 1.62), 0.07, M['frame'], 12)
    p.cyl((-0.66, -1.85, 0.16), (-0.66, -1.85, 2.15), 0.008, M['dark'], 6)
    p.sphere((-0.66, -1.85, 2.16), 0.018, M['accent'])
    p.cyl((-0.62, -1.62, 0.16), (-0.62, -1.62, 0.95), 0.035, M['alu'], 10)
    sp_q = Matrix.Rotation(math.radians(18), 3, 'X')
    p.box((-0.62, -1.62, 0.98), (0.9, 0.62, 0.025), M['frame'], sp_q)
    for i in range(3):
        for j in range(2):
            c = sp_q @ Vector((-0.28 + i * 0.28, -0.14 + j * 0.28, 0.016))
            p.box((-0.62 + c.x, -1.62 + c.y, 0.98 + c.z), (0.26, 0.26, 0.01), M['solar'], sp_q)
    # cables
    p.sweep([Vector(v) for v in [(0.62, -1.5, 0.2), (0.4, -1.4, 0.3), (0.2, -1.2, 0.5)]], 0.012, M['dark'])
    return p.build()


def arc_fender(p, sx, sy):
    """A curved fender shell over a wheel, open at the bottom."""
    bm = bmesh.new()
    cx, cy, cz = sx * TRACK, sy * BASE, WHEEL_Z
    R0, R1 = 0.6, 0.64
    segs = 16
    a0, a1 = math.radians(10), math.radians(170)
    w = 0.25
    rows = []
    for i in range(segs + 1):
        a = a0 + (a1 - a0) * i / segs
        y, z = cy + math.cos(a) * 1.0, cz + math.sin(a) * 1.0
        ring = []
        for rr in (R0, R1):
            for x in (cx - w, cx + w):
                ring.append(bm.verts.new((x, cy + math.cos(a) * rr, cz + math.sin(a) * rr)))
        rows.append(ring)
    for r0, r1 in zip(rows, rows[1:]):
        for a, b in ((0, 1), (1, 3), (3, 2), (2, 0)):
            bm.faces.new((r0[a], r0[b], r1[b], r1[a]))
    bm.faces.new((rows[0][0], rows[0][2], rows[0][3], rows[0][1]))
    bm.faces.new((rows[-1][0], rows[-1][1], rows[-1][3], rows[-1][2]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    p._merge(bm, M['paint'], True)
    # orange flare on the outer edge
    bm = bmesh.new()
    rows = []
    for i in range(segs + 1):
        a = a0 + (a1 - a0) * i / segs
        rows.append([bm.verts.new((cx + sx * x, cy + math.cos(a) * rr, cz + math.sin(a) * rr)) for x, rr in ((w, R1), (w + 0.04, R1 + 0.02), (w + 0.04, R0 - 0.01), (w, R0))])
    for r0, r1 in zip(rows, rows[1:]):
        for k in range(3):
            bm.faces.new((r0[k], r0[k + 1], r1[k + 1], r1[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    p._merge(bm, M['accent'], True)


def build_wheel(name, sx, center):
    p = Part(name)
    c = Vector(center)
    hw = TYRE_W / 2
    # tyre carcass: rounded shoulders
    prof = [(-hw + 0.02, 0.29), (-hw, 0.33), (-hw, 0.4), (-hw + 0.03, 0.435), (-hw + 0.07, 0.445),
            (hw - 0.07, 0.445), (hw - 0.03, 0.435), (hw, 0.4), (hw, 0.33), (hw - 0.02, 0.29)]
    p.lathe(prof, 48, M['rubber'], c)
    # chevron tread lugs
    n = 22
    for i in range(n):
        a = 2 * math.pi * i / n
        rot = Matrix.Rotation(a, 3, 'X')
        for side in (-1, 1):
            tilt = Matrix.Rotation(side * math.radians(28), 3, 'Z')
            off = rot @ Vector((side * 0.075, 0, 0.455))
            p.box(c + off, (0.13, 0.07, 0.035), M['rubber'], rot @ tilt, bevel=0)
        # shoulder blocks
        for side in (-1, 1):
            off = rot @ Vector((side * (hw - 0.01), 0.0, 0.41))
            p.box(c + off, (0.04, 0.06, 0.06), M['rubber'], rot, bevel=0)
    # rim: dish, six spokes, hub and nuts (outer face towards +sx)
    o = sx
    p.lathe([(-hw + 0.03, 0.29), (-hw + 0.03, 0.27), (hw - 0.03, 0.27), (hw - 0.03, 0.29)], 32, M['alu'], c)
    p.cyl(c + Vector((-0.08 * o, 0, 0)), c + Vector((0.02 * o, 0, 0)), 0.27, M['frame'], 32)
    for i in range(6):
        a = 2 * math.pi * i / 6
        rot = Matrix.Rotation(a, 3, 'X')
        p.box(c + rot @ Vector((0.06 * o, 0, 0.16)), (0.05, 0.07, 0.22), M['alu'], rot)
    p.cyl(c + Vector((0.0, 0, 0)), c + Vector((0.12 * o, 0, 0)), 0.09, M['alu'], 20)
    p.cyl(c + Vector((0.12 * o, 0, 0)), c + Vector((0.15 * o, 0, 0)), 0.06, M['accent'], 16)
    for i in range(6):
        a = 2 * math.pi * i / 6 + math.pi / 6
        off = Vector((0.12 * o, math.cos(a) * 0.065, math.sin(a) * 0.065))
        p.cyl(c + off, c + off + Vector((0.025 * o, 0, 0)), 0.012, M['chrome'], 6)
    return p.build(center)


def build_corner(tag, sx, sy, root):
    y = sy * BASE
    wc = (sx * TRACK, y, WHEEL_Z)
    corner = empty(f'Corner_{tag}', wc, root)
    # wishbones: two tubes from front/back hinges to the ball joint, origin at the hinge axis
    for kind, dz in (('Upper', UPPER_DZ), ('Lower', LOWER_DZ)):
        a = Part(f'Arm{kind}_{tag}')
        hz = WHEEL_Z + dz
        ball = (sx * (KNUCKLE_X - 0.02), y, hz)
        r = 0.032 if kind == 'Upper' else 0.04
        for dy in (-0.17, 0.17):
            a.cyl((sx * HINGE_X, y + dy, hz), ball, r, M['frame'], 10)
            a.cyl((sx * HINGE_X, y + dy - 0.05, hz), (sx * HINGE_X, y + dy + 0.05, hz), 0.045, M['dark'], 12)
        a.sphere(ball, 0.05, M['chrome'], 12, 8)
        if kind == 'Lower':
            a.box((sx * 0.78, y, hz - 0.01), (0.1, 0.16, 0.05), M['frame'])  # shock mount plate
        ob = a.build((sx * HINGE_X, y, hz))
        parent_to(ob, corner)
    # coil-over shock: top mount on the tower, bottom on the lower arm; built along -Z from the top
    top = Vector((sx * 0.62, y, 0.06))
    bot = Vector((sx * 0.78, y, WHEEL_Z + LOWER_DZ + 0.03))
    L = (top - bot).length
    s = Part(f'Shock_{tag}')
    s.cyl((0, 0, 0), (0, 0, -L * 0.55), 0.038, M['frame'], 14)
    s.cyl((0, 0, -L * 0.5), (0, 0, -L), 0.018, M['chrome'], 10)
    s.cyl((0, 0, -0.02), (0, 0, -0.05), 0.065, M['alu'], 16)
    s.cyl((0, 0, -L * 0.82), (0, 0, -L * 0.86), 0.06, M['alu'], 16)
    turns, coil = 7, []
    for i in range(turns * 16 + 1):
        t = i / (turns * 16)
        a = t * turns * 2 * math.pi
        coil.append(Vector((math.cos(a) * 0.055, math.sin(a) * 0.055, -0.05 - t * (L * 0.77))))
    s.sweep(coil, 0.011, M['spring'], 6)
    s.sphere((0, 0, 0), 0.03, M['chrome'], 8, 6)
    s.sphere((0, 0, -L), 0.025, M['chrome'], 8, 6)
    sh = s.build((0, 0, 0))
    sh.location = top
    # tilt it from -Z to the bottom mount (the game re-aims it as the wheel moves)
    d = (bot - top).normalized()
    sh.rotation_mode = 'QUATERNION'
    sh.rotation_quaternion = Vector((0, 0, -1)).rotation_difference(d)
    sh['rest_length'] = L
    parent_to(sh, corner)
    # knuckle: an upright between the ball joints and the spindle into the hub
    k = Part(f'Knuckle_{tag}')
    k.box((sx * KNUCKLE_X, y, WHEEL_Z), (0.07, 0.12, UPPER_DZ - LOWER_DZ + 0.06), M['frame'])
    k.cyl((sx * KNUCKLE_X, y, WHEEL_Z), (sx * (TRACK - 0.12), y, WHEEL_Z), 0.06, M['alu'], 14)
    k.cyl((sx * (KNUCKLE_X - 0.02), y, WHEEL_Z + 0.03), (sx * (KNUCKLE_X - 0.02), y + 0.12, WHEEL_Z + 0.03), 0.075, M['dark'], 14)  # brake caliper
    knuckle = k.build(wc)
    parent_to(knuckle, corner)
    steer = empty(f'Steer_{tag}', wc, knuckle)
    wheel = build_wheel(f'Wheel_{tag}', sx, wc)
    parent_to(wheel, steer)


def build_dish(root):
    p = Part('Dish')
    base = Vector((0.62, -1.62, 1.62))
    p.cyl(base, base + Vector((0, 0, 0.16)), 0.03, M['alu'], 10)
    p.box(base + Vector((0, 0, 0.17)), (0.12, 0.08, 0.06), M['frame'])
    tilt = Matrix.Rotation(math.radians(55), 3, 'X')
    # parabolic reflector, opening forward-up
    c = base + Vector((0, 0.05, 0.3))
    bm = bmesh.new()
    segs, rings = 24, 6
    R = 0.32
    verts = []
    for j in range(rings + 1):
        rr = R * j / rings
        row = []
        for i in range(segs if j else 1):
            a = 2 * math.pi * i / segs
            v = Vector((rr * math.cos(a), rr * math.sin(a), 0.9 * rr * rr))
            row.append(bm.verts.new(c + tilt @ Vector((v.x, v.z, v.y))))
        verts.append(row)
    for j in range(rings):
        a, b = verts[j], verts[j + 1]
        for i in range(segs):
            if j == 0:
                bm.faces.new((a[0], b[i], b[(i + 1) % segs]))
            else:
                bm.faces.new((a[i], b[i], b[(i + 1) % segs], a[(i + 1) % segs]))
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.012)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    p._merge(bm, M['paint'], True)
    feed = c + tilt @ Vector((0, 0.24, 0))
    for i in range(3):
        a = 2 * math.pi * i / 3
        rim = c + tilt @ Vector((math.cos(a) * R * 0.95, 0.9 * R * R * 0.9, math.sin(a) * R * 0.95))
        p.cyl(rim, feed, 0.006, M['dark'], 5)
    p.sphere(feed, 0.03, M['accent'], 10, 6)
    ob = p.build(base)
    parent_to(ob, root)


def build_beacon(root):
    p = Part('Beacon')
    c = Vector((-0.5, -0.12, 1.02))
    p.cyl(c, c + Vector((0, 0, 0.04)), 0.06, M['dark'], 14)
    p.sphere(c + Vector((0, 0, 0.08)), 0.055, M['beacon'], 14, 8, (1, 1, 1.2))
    ob = p.build(c)
    parent_to(ob, root)


def build_driver(root):
    """A seated pilot in a white suit, hands on the yoke (left seat)."""
    p = Part('Driver')
    x = -0.36
    p.box((x, 0.12, 0.38), (0.4, 0.26, 0.5), M['suit'], Matrix.Rotation(math.radians(-10), 3, 'X'))
    p.box((x, -0.06, 0.4), (0.36, 0.14, 0.44), M['alu'], Matrix.Rotation(math.radians(-10), 3, 'X'))  # life support pack
    p.sphere((x, 0.14, 0.78), 0.17, M['suit'], 20, 12)
    p.sphere((x, 0.21, 0.79), 0.135, M['visor'], 20, 12, (1, 0.8, 0.9))
    p.cyl((x - 0.18, 0.1, 0.92), (x - 0.18, 0.1, 1.0), 0.02, M['lamp'], 8)
    for sx in (-1, 1):
        hip = Vector((x + sx * 0.11, 0.22, 0.02))
        knee = Vector((x + sx * 0.12, 0.62, 0.08))
        foot = Vector((x + sx * 0.12, 0.72, -0.24))
        p.tube([hip, knee, foot], 0.075, M['suit'], 12)
        p.box(foot + Vector((0, 0.06, -0.03)), (0.11, 0.24, 0.08), M['frame'])
        sh = Vector((x + sx * 0.22, 0.14, 0.56))
        el = Vector((x + sx * 0.24, 0.38, 0.42))
        hand = Vector((-0.35 + sx * 0.12, 0.7, 0.45))
        p.tube([sh, el, hand], 0.055, M['suit'], 10)
        p.sphere(hand, 0.05, M['frame'], 10, 6)
    p.box((x, 0.18, 0.08), (0.34, 0.3, 0.14), M['suit'])
    p.box((x - 0.2, 0.12, 0.42), (0.03, 0.1, 0.1), M['accent'])  # flag patch
    ob = p.build((x, 0.3, 0.0))
    parent_to(ob, root)


def build_drill(root):
    """A core drill on a vertical mast behind the tail: the carriage slides down, the auger spins."""
    y = -2.3
    rig = Part('DrillRig')
    for sx in (-1, 1):
        rig.cyl((sx * 0.11, y, -0.42), (sx * 0.11, y, 0.98), 0.024, M['alu'], 10)
    rig.box((0, y, 1.0), (0.36, 0.14, 0.08), M['frame'])
    rig.box((0, y - 0.075, 1.0), (0.3, 0.012, 0.05), M['accent'])
    rig.cyl((0, y, 1.04), (0, y, 1.14), 0.05, M['frame'], 14)          # hoist motor
    rig.cyl((0, y + 0.06, 1.09), (0, y + 0.06, 1.12), 0.035, M['tail'], 10)
    for z in (-0.12, 0.5):                                             # brackets to the frame
        rig.box((0, (y - 2.02) / 2, z), (0.32, abs(y + 2.02) + 0.06, 0.05), M['frame'])
    for sx in (-1, 1):
        rig.cyl((sx * 0.11, y, 0.48), (sx * 0.45, -1.95, 0.14), 0.018, M['frame'], 8)
    rig.torus((0, y, -0.44), (0, 0, 1), 0.1, 0.02, M['frame'], 16, 6)  # bit guide
    rig.box((0, y, -0.44), (0.34, 0.05, 0.03), M['frame'])
    rig.sweep([Vector(v) for v in [(0.3, -1.9, 0.2), (0.25, -2.1, 0.6), (0.12, y + 0.05, 1.0)]], 0.014, M['dark'])
    ob = rig.build()
    parent_to(ob, root)
    # carriage: rides the rails with the motor that turns the auger
    c = Vector((0, y, 0.62))
    car = Part('Drill')
    car.box(c, (0.3, 0.16, 0.16), M['accent'])
    for sx in (-1, 1):
        car.box(c + Vector((sx * 0.11, 0, 0)), (0.07, 0.09, 0.22), M['dark'])
    car.cyl(c + Vector((0, 0, 0.08)), c + Vector((0, 0, 0.24)), 0.07, M['frame'], 16)
    car.cyl(c + Vector((0, 0, 0.24)), c + Vector((0, 0, 0.27)), 0.05, M['alu'], 12)
    for i in range(5):  # cooling fins
        car.cyl(c + Vector((0, 0, 0.11 + i * 0.03)), c + Vector((0, 0, 0.12 + i * 0.03)), 0.085, M['alu'], 16)
    drill = car.build(c)
    parent_to(drill, root)
    # auger: shaft, helical flight and a carbide tip
    top = c + Vector((0, 0, -0.08))
    bit = Part('DrillBit')
    bit.cyl(top, top + Vector((0, 0, -0.88)), 0.032, M['alu'], 10)
    flight = []
    turns = 9
    for i in range(turns * 12 + 1):
        t = i / (turns * 12)
        a = t * turns * 2 * math.pi
        flight.append(top + Vector((math.cos(a) * 0.06, math.sin(a) * 0.06, -0.1 - t * 0.72)))
    bit.sweep(flight, 0.013, M['chrome'], 5)
    bit.cyl(top + Vector((0, 0, -0.88)), top + Vector((0, 0, -1.02)), 0.055, M['frame'], 12, r2=0.006)
    bit.cyl(top + Vector((0, 0, -0.02)), top + Vector((0, 0, -0.06)), 0.05, M['dark'], 12)
    b = bit.build(top)
    parent_to(b, drill)


def build():
    reset()
    make_materials()
    root = empty('Rover', (0, 0, 0))
    ch = build_chassis()
    parent_to(ch, root)
    for tag, sx, sy in (('FL', -1, 1), ('FR', 1, 1), ('RL', -1, -1), ('RR', 1, -1)):
        build_corner(tag, sx, sy, root)
    build_dish(root)
    build_beacon(root)
    build_driver(root)
    build_drill(root)
    return root


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
    print(f'rover: {tris} triangles -> {path} ({os.path.getsize(path) // 1024} KB)')


def render(path):
    """Studio shot for the docs (Cycles, CPU)."""
    sc = bpy.context.scene
    world = bpy.data.worlds.new('World')
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.02, 0.022, 0.03, 1)
    sc.world = world
    me = bpy.data.meshes.new('Ground')
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=30)
    bm.to_mesh(me)
    g = bpy.data.objects.new('Ground', me)
    g.location = (0, 0, -0.87)
    g.data.materials.append(material('Regolith', '#8a7660', 0, 0.95))
    sc.collection.objects.link(g)
    for name, loc, energy, size in (('Key', (5, 4, 6), 900, 3), ('Rim', (-4, -5, 4), 600, 2), ('Fill', (-5, 4, 2), 200, 4)):
        ld = bpy.data.lights.new(name, 'AREA')
        ld.energy = energy
        ld.size = size
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        sc.collection.objects.link(lo)
    cd = bpy.data.cameras.new('Cam')
    cd.lens = 40
    cam = bpy.data.objects.new('Cam', cd)
    cam.location = tuple(float(v) for v in os.environ.get('ROVER_CAM', '5.4,5.0,2.2').split(','))
    cam.rotation_euler = (Vector((0, 0.1, -0.1)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = int(os.environ.get('ROVER_SAMPLES', '48'))
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.film_transparent = False
    sc.render.filepath = path
    sc.view_settings.view_transform = 'AgX'
    bpy.ops.render.render(write_still=True)
    print(f'render -> {path}')


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    build()
    export(OUT)
    if '--blend' in argv:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'rover.blend'))
    if '--render' in argv:
        render(os.path.abspath(argv[argv.index('--render') + 1]))
