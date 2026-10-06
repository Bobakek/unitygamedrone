"""
Arena 3×3 structures, built procedurally in Blender:

    SpawnGate  the launch gate behind each team's start line: an octagonal truss ring 64 m across
               with emitter pods, floodlights and a docking-clamp spine
    Buoy       a marker floating on the edge of the playing field: a spine with fins, a beacon
               ring and a warning lamp

    python tools/blender/build_arena.py [--render docs/screenshots]
    # or: blender -b -P tools/blender/build_arena.py -- [...]

Writes src/client/assets/arena.glb with two root empties, SpawnGate and Buoy (Y up after export;
the gate's opening faces -Z like a ship's nose, the buoy's spine is the Y axis). The game tints
the TeamGlow and TeamPaint materials in the team colour (src/client/world/arena-view.ts) and
pulses BuoyGlow. With --render: a Cycles shot <dir>/arena-blender.png.
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

# gate: ring radius (to the truss centre line), truss depth (along the opening axis) and width
GATE_R = 32.0
TRUSS = 3.2
SIDES = 8


def make_materials():
    M['frame'] = material('Frame', '#3b3f45', 0.85, 0.42)
    M['hull'] = material('Hull', '#d9d4c8', 0.1, 0.45)
    M['paint'] = material('TeamPaint', '#4aa8ff', 0.15, 0.4)
    M['dark'] = material('DarkPlastic', '#1d1f23', 0.0, 0.6)
    M['alu'] = material('Aluminium', '#c3c7cc', 1.0, 0.3)
    M['warn'] = material('Warning', '#e8b818', 0.1, 0.45)
    M['glow'] = material('TeamGlow', '#4aa8ff', 0.0, 0.2, '#4aa8ff', 6.0)
    M['lamp'] = material('Lamp', '#fff6e0', 0.0, 0.1, '#fff2d6', 8.0)
    M['buoy'] = material('BuoyGlow', '#ff9a20', 0.0, 0.2, '#ff8a10', 7.0)
    M['red'] = material('NavRed', '#ff3040', 0.0, 0.2, '#ff2030', 5.0)
    M['glass'] = material('Glass', '#1a3c4a', 0.6, 0.05, '#2a6a80', 0.6)


def ring_point(a, r, y=0.0):
    """A point of the gate ring at angle `a` in the (x, z) plane (Blender: the opening faces -Y)."""
    return Vector((math.cos(a) * r, y, math.sin(a) * r))


def strut(p, a, b, r, mat, segs=6):
    p.cyl(a, b, r, mat, segs, smooth=False)


def build_gate():
    root = empty('SpawnGate', (0, 0, 0))
    truss = Part('GateTruss')
    plates = Part('GatePlates')
    glow = Part('GateGlow')
    step = 2 * math.pi / SIDES
    half = TRUSS / 2
    for i in range(SIDES):
        a0, a1 = i * step + step / 2, (i + 1) * step + step / 2
        # four chords of a box truss between the corners
        for dy in (-half, half):
            for dr in (-half, half):
                strut(truss, ring_point(a0, GATE_R + dr, dy), ring_point(a1, GATE_R + dr, dy), 0.32, M['frame'])
        # diagonal lacing, five bays per side
        bays = 5
        for k in range(bays):
            t0, t1 = k / bays, (k + 1) / bays
            c0 = ring_point(a0, 1, 0).lerp(ring_point(a1, 1, 0), t0)
            c1 = ring_point(a0, 1, 0).lerp(ring_point(a1, 1, 0), t1)
            for dy in (-half, half):
                strut(truss, c0 * (GATE_R - half) + Vector((0, dy, 0)), c1 * (GATE_R + half) + Vector((0, dy, 0)), 0.14, M['alu'], 5)
            strut(truss, c0 * (GATE_R + half) + Vector((0, -half, 0)), c1 * (GATE_R + half) + Vector((0, half, 0)), 0.14, M['alu'], 5)
            strut(truss, c0 * (GATE_R - half) + Vector((0, half, 0)), c1 * (GATE_R - half) + Vector((0, -half, 0)), 0.14, M['alu'], 5)
        # an armoured cover plate on the outer face of each side, team paint with a warning band
        mid = (a0 + a1) / 2
        side_len = 2 * (GATE_R + half) * math.sin(step / 2)
        rot = Matrix.Rotation(-mid, 3, 'Y')
        c = ring_point(mid, (GATE_R + half + 0.35) * math.cos(step / 2), 0)
        plates.box(c, (0.5, TRUSS * 0.92, side_len * 0.62), M['paint'], rot, bevel=0.12)
        plates.box(c + ring_point(mid, 0.3), (0.2, TRUSS * 0.94, side_len * 0.12), M['warn'], rot, bevel=0.04)
        # inner rail of light along the opening
        ci = ring_point(mid, (GATE_R - half - 0.4) * math.cos(step / 2), 0)
        glow.box(ci, (0.35, 0.5, side_len * 0.7), M['glow'], rot, bevel=0.05)
    # emitter pods on the corners: a drum, a lens ring facing inwards and a red nav light outside
    pods = Part('GatePods')
    for i in range(SIDES):
        a = i * step + step / 2
        c = ring_point(a, GATE_R, 0)
        inward = -ring_point(a, 1, 0)
        pods.cyl(c + Vector((0, -half - 0.6, 0)), c + Vector((0, half + 0.6, 0)), 2.1, M['hull'], 16)
        pods.cyl(c + Vector((0, -half - 0.9, 0)), c + Vector((0, -half - 0.6, 0)), 1.7, M['dark'], 16)
        pods.cyl(c + Vector((0, half + 0.6, 0)), c + Vector((0, half + 0.9, 0)), 1.7, M['dark'], 16)
        glow.cyl(c + inward * 1.9, c + inward * 2.6, 1.0, M['glow'], 16)
        glow.torus(c + Vector((0, -half - 0.95, 0)), (0, 1, 0), 1.2, 0.12, M['glow'], 20, 6)
        pods.sphere(c - inward * 2.4, 0.35, M['red'], 10, 6)
    # floodlights on the top and bottom corners shining into the opening
    for a in (math.pi / 2 + step / 2, -math.pi / 2 + step / 2):
        base = ring_point(a, GATE_R - half - 0.3, -half - 0.5)
        pods.box(base, (2.4, 1.2, 1.6), M['frame'], bevel=0.1)
        pods.cyl(base + Vector((0, -0.6, 0)), base + Vector((0, -1.3, 0)), 0.7, M['dark'], 14)
        glow.cyl(base + Vector((0, -1.3, 0)), base + Vector((0, -1.36, 0)), 0.6, M['lamp'], 14)
    # spine behind the gate: a clamp tower with a control cabin and antennas
    spine = Part('GateSpine')
    top = ring_point(math.pi / 2 + step / 2, GATE_R + half + 1.0, 0)
    tower_base = Vector((0, 6, GATE_R + 6))
    spine.box(tower_base, (5, 9, 5), M['hull'], bevel=0.3)
    spine.box(tower_base + Vector((0, -1.5, 3.2)), (6.5, 5, 2.2), M['paint'], bevel=0.2)
    spine.box(tower_base + Vector((0, -4.3, 3.3)), (5.6, 0.3, 1.2), M['glass'], bevel=0.05)
    strut(spine, tower_base + Vector((-2, -4, -2)), top + Vector((-3, 0, 0)), 0.45, M['frame'])
    strut(spine, tower_base + Vector((2, -4, -2)), top + Vector((3, 0, 0)), 0.45, M['frame'])
    strut(spine, tower_base + Vector((0, 4, -2)), top + Vector((0, half, 0)), 0.45, M['frame'])
    for x in (-1.6, 1.6):
        spine.cyl(tower_base + Vector((x, 0, 4.3)), tower_base + Vector((x, 0, 11)), 0.12, M['alu'], 6)
        spine.sphere(tower_base + Vector((x, 0, 11.1)), 0.3, M['red'], 8, 6)
    spine.cyl(tower_base + Vector((0, 2, 4.3)), tower_base + Vector((0, 2, 6)), 0.3, M['frame'], 8)
    spine.cyl(tower_base + Vector((0, 2, 6)), tower_base + Vector((0, 2.6, 7.4)), 2.2, M['alu'], 20, r2=0.4)
    for part in (truss, plates, glow, pods, spine):
        parent_to(part.build(), root)
    return root


def build_buoy():
    root = empty('Buoy', (0, 0, 0))
    body = Part('BuoyBody')
    glow = Part('BuoyGlow')
    # spine along Blender Z (becomes Y up in the game)
    body.cyl((0, 0, -7), (0, 0, 7), 0.9, M['hull'], 18)
    body.cyl((0, 0, -7.6), (0, 0, -7), 1.4, M['frame'], 18, r2=0.9)
    body.cyl((0, 0, 7), (0, 0, 7.6), 0.9, M['frame'], 18, r2=1.4)
    for z in (-4.5, 0.0, 4.5):
        body.cyl((0, 0, z - 0.35), (0, 0, z + 0.35), 1.15, M['warn'] if z == 0 else M['frame'], 18)
    # three fins with lamps at their tips
    for k in range(3):
        a = k * 2 * math.pi / 3
        d = Vector((math.cos(a), math.sin(a), 0))
        rot = Matrix.Rotation(a, 3, 'Z')
        body.box(d * 2.3 + Vector((0, 0, -2)), (3.0, 0.35, 6.5), M['paint'], rot, bevel=0.1)
        body.box(d * 3.9 + Vector((0, 0, -4.8)), (0.6, 0.6, 1.4), M['frame'], rot, bevel=0.08)
        glow.sphere(d * 3.9 + Vector((0, 0, -5.6)), 0.38, M['buoy'], 10, 6)
    # beacon: a glowing ring and a lamp in a cage on top
    glow.torus((0, 0, 2.4), (0, 0, 1), 1.35, 0.22, M['buoy'], 24, 8)
    glow.sphere((0, 0, 8.6), 0.65, M['buoy'], 14, 8)
    for k in range(4):
        a = k * math.pi / 2
        body.cyl((math.cos(a) * 0.9, math.sin(a) * 0.9, 7.6), (math.cos(a) * 0.5, math.sin(a) * 0.5, 9.6), 0.08, M['alu'], 5)
    body.cyl((0, 0, 9.6), (0, 0, 9.8), 0.7, M['frame'], 14)
    for part in (body, glow):
        parent_to(part.build(), root)
    root.location = (62, -40, -8)
    return root


def export():
    path = os.path.join(ASSETS, 'arena.glb')
    os.makedirs(ASSETS, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', export_yup=True, export_apply=True,
        export_extras=True, export_cameras=False, export_lights=False, export_animations=False,
    )
    tris = 0
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    print(f'arena: {tris} triangles -> {path} ({os.path.getsize(path) // 1024} KB)')


def render(out_dir):
    sc = bpy.context.scene
    world = bpy.data.worlds.new('World')
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.006, 0.007, 0.012, 1)
    sc.world = world
    for nm, loc, energy, size in (('Key', (60, -70, 50), 90000, 30), ('Rim', (-70, 60, 20), 50000, 25)):
        ld = bpy.data.lights.new(nm, 'AREA')
        ld.energy = energy
        ld.size = size
        lo = bpy.data.objects.new(nm, ld)
        lo.location = loc
        lo.rotation_euler = (Vector((20, 0, 0)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        sc.collection.objects.link(lo)
    cd = bpy.data.cameras.new('Cam')
    cd.lens = 30
    cam = bpy.data.objects.new('Cam', cd)
    cam.location = (40, -150, 30)
    cam.rotation_euler = (Vector((22, -10, 0)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = int(os.environ.get('ARENA_SAMPLES', '48'))
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.filepath = os.path.join(out_dir, 'arena-blender.png')
    sc.view_settings.view_transform = 'AgX'
    bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    reset()
    make_materials()
    build_gate()
    build_buoy()
    export()
    if '--render' in argv:
        render(os.path.abspath(argv[argv.index('--render') + 1]))
