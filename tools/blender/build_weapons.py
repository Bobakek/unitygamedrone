"""
Weapon modules for ship slots and the proximity mine, built procedurally in Blender:

    Railgun     a turret-mounted rail cannon: armoured breech housing with capacitor banks and
                cooling fins, two long conductor rails with a glowing gap, magnetic coil rings and
                a flared muzzle brake
    MinePod     the mine layer: an armoured pod with a hydraulic tail hatch and a mine in the chute
    EmpEmitter  a stacked tesla coil on a gimbal base with a capacitor ring and a glowing crown
    Mine        the mine itself: an armoured sphere with contact horns, a lamp belt and armour ribs

    python tools/blender/build_weapons.py [--render docs/screenshots]
    # or: blender -b -P tools/blender/build_weapons.py -- [...]

Writes src/client/assets/weapons.glb with four root empties (Y up, forward = -Z after export).
Each module's origin is its mounting point on the hull; it rises along +Y from there (the game
turns it upside down for a mount under the hull, see MOUNTS in src/shared/modules.ts). The
railgun muzzle sits at game (0, 0.55, -4.3) = Blender (0, 4.3, 0.55): RAIL_MUZZLE in modules.ts.
The game tints the Paint material with the pilot's colour, pulses RailGlow / EmpGlow when a slot
recharges and blinks MineGlow (red for enemy mines, green for one's own).
With --render: a Cycles shot <dir>/weapons-blender.png.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
import bmesh  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402

from build_rover import Part, empty, material, parent_to, reset  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
ASSETS = os.path.join(ROOT, 'src', 'client', 'assets')

M = {}

# railgun: rail axis height above the mount and the muzzle (Blender y)
RAIL_Z = 0.55
MUZZLE_Y = 4.3


def make_materials():
    M['gun'] = material('Gunmetal', '#3a3e44', 0.9, 0.38)
    M['paint'] = material('Paint', '#4a8acc', 0.15, 0.4)
    M['dark'] = material('DarkPlastic', '#1b1d21', 0.0, 0.6)
    M['chrome'] = material('Chrome', '#e8ecef', 1.0, 0.12)
    M['copper'] = material('Copper', '#c8743a', 1.0, 0.28)
    M['alu'] = material('Aluminium', '#c3c7cc', 1.0, 0.3)
    M['warn'] = material('Warning', '#e8b818', 0.1, 0.45)
    M['rail'] = material('RailGlow', '#7fe8ff', 0.0, 0.2, '#5fdcff', 9.0)
    M['emp'] = material('EmpGlow', '#9ab8ff', 0.0, 0.2, '#7aa0ff', 9.0)
    M['mine'] = material('MineGlow', '#ff3030', 0.0, 0.2, '#ff2020', 8.0)
    M['ceramic'] = material('Ceramic', '#d9d4c8', 0.05, 0.5)


def ring(p, c, axis, R, r, mat, segs=24):
    p.torus(c, axis, R, r, mat, segs, 8)


def build_railgun():
    root = empty('Railgun', (0, 0, 0))
    body = Part('RailgunBody')
    glow = Part('RailgunGlow')
    # turret ring and a low pedestal with bolts
    body.cyl((0, 0, 0), (0, 0, 0.12), 0.62, M['gun'], 28)
    body.cyl((0, 0, 0.12), (0, 0, 0.26), 0.5, M['dark'], 28)
    for k in range(10):
        a = 2 * math.pi * k / 10
        body.cyl((math.cos(a) * 0.55, math.sin(a) * 0.55, 0.12), (math.cos(a) * 0.55, math.sin(a) * 0.55, 0.15), 0.035, M['chrome'], 8)
    # trunnion yoke: two cheeks holding the housing
    for sx in (-1, 1):
        body.box((sx * 0.42, 0.0, 0.42), (0.1, 0.7, 0.42), M['gun'], bevel=0.03)
        body.cyl((sx * 0.36, 0.0, 0.5), (sx * 0.5, 0.0, 0.5), 0.13, M['chrome'], 16)
    # breech housing: chamfered box, painted, from behind the mount to a third of the length
    hw, hh = 0.62, 0.5
    c = 0.14
    prof = [(-hw / 2 + c, RAIL_Z - hh / 2), (hw / 2 - c, RAIL_Z - hh / 2), (hw / 2, RAIL_Z - hh / 2 + c), (hw / 2, RAIL_Z + hh / 2 - c),
            (hw / 2 - c, RAIL_Z + hh / 2), (-hw / 2 + c, RAIL_Z + hh / 2), (-hw / 2, RAIL_Z + hh / 2 - c), (-hw / 2, RAIL_Z - hh / 2 + c)]
    bm = bmesh.new()
    y0, y1 = -1.35, 1.1
    a = [bm.verts.new((x, y0, z)) for x, z in prof]
    b = [bm.verts.new((x, y1, z)) for x, z in prof]
    bm.faces.new(list(reversed(a)))
    bm.faces.new(b)
    for i in range(len(prof)):
        j = (i + 1) % len(prof)
        bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    body._merge(bm, M['paint'], False)
    # armour seam bands, a sensor block and a power conduit on top
    for y in (-1.0, 0.0, 0.85):
        body.box((0, y, RAIL_Z), (hw + 0.04, 0.06, hh + 0.04), M['gun'], bevel=0.01)
    body.box((0.0, -0.4, RAIL_Z + hh / 2 + 0.08), (0.26, 0.5, 0.16), M['gun'], bevel=0.03)
    body.box((0.0, -0.18, RAIL_Z + hh / 2 + 0.1), (0.18, 0.04, 0.08), M['dark'], bevel=0.0)
    glow.box((0.0, -0.155, RAIL_Z + hh / 2 + 0.1), (0.14, 0.01, 0.05), M['rail'], bevel=0.0)
    body.sweep([Vector((0.2, -1.2, RAIL_Z + hh / 2)), Vector((0.24, -0.6, RAIL_Z + hh / 2 + 0.12)), Vector((0.24, 0.6, RAIL_Z + hh / 2 + 0.12)), Vector((0.16, 1.05, RAIL_Z + hh / 2 - 0.02))], 0.035, M['copper'], 8)
    # cooling fins at the back
    for k in range(6):
        y = -1.3 + k * 0.09
        body.box((0, y, RAIL_Z), (hw + 0.16, 0.025, hh + 0.12), M['alu'], bevel=0.0)
    # capacitor banks along both flanks with glowing charge windows
    for sx in (-1, 1):
        x = sx * (hw / 2 + 0.11)
        body.cyl((x, -1.15, RAIL_Z - 0.06), (x, 0.75, RAIL_Z - 0.06), 0.12, M['gun'], 16)
        for y in (-0.85, -0.4, 0.05, 0.5):
            body.torus((x, y, RAIL_Z - 0.06), (0, 1, 0), 0.125, 0.02, M['chrome'], 16, 6)
            glow.box((x + sx * 0.1, y + 0.2, RAIL_Z - 0.06), (0.02, 0.18, 0.06), M['rail'], bevel=0.0)
        body.cyl((x, 0.75, RAIL_Z - 0.06), (x, 0.82, RAIL_Z - 0.06), 0.09, M['chrome'], 12)
    # the two conductor rails with insulating spacers, the glowing gap between them
    for sx in (-1, 1):
        body.box((sx * 0.13, (1.0 + MUZZLE_Y) / 2, RAIL_Z), (0.1, MUZZLE_Y - 1.0, 0.22), M['gun'], bevel=0.02)
        body.box((sx * 0.075, (1.0 + MUZZLE_Y) / 2, RAIL_Z), (0.02, MUZZLE_Y - 1.05, 0.14), M['copper'], bevel=0.0)
    glow.box((0, (1.0 + MUZZLE_Y) / 2, RAIL_Z), (0.05, MUZZLE_Y - 1.1, 0.06), M['rail'], bevel=0.0)
    for y in (1.6, 2.4, 3.2, 3.9):
        body.box((0, y, RAIL_Z + 0.14), (0.36, 0.08, 0.05), M['ceramic'], bevel=0.01)
        body.box((0, y, RAIL_Z - 0.14), (0.36, 0.08, 0.05), M['ceramic'], bevel=0.01)
    # magnetic coils round the barrel, getting smaller towards the muzzle
    for k in range(7):
        y = 1.3 + k * 0.42
        R = 0.32 - k * 0.012
        ring(body, (0, y, RAIL_Z), (0, 1, 0), R, 0.05, M['copper'], 28)
        ring(body, (0, y + 0.07, RAIL_Z), (0, 1, 0), R - 0.01, 0.025, M['gun'], 28)
    # muzzle brake: a flared collar with vents
    body.cyl((0, MUZZLE_Y - 0.35, RAIL_Z), (0, MUZZLE_Y - 0.05, RAIL_Z), 0.3, M['gun'], 20, r2=0.36)
    body.cyl((0, MUZZLE_Y - 0.05, RAIL_Z), (0, MUZZLE_Y, RAIL_Z), 0.36, M['chrome'], 20)
    for k in range(6):
        a = 2 * math.pi * k / 6 + math.pi / 6
        body.box((math.cos(a) * 0.32, MUZZLE_Y - 0.2, RAIL_Z + math.sin(a) * 0.32), (0.06, 0.18, 0.06), M['dark'], bevel=0.0)
    glow.cyl((0, MUZZLE_Y - 0.01, RAIL_Z), (0, MUZZLE_Y + 0.005, RAIL_Z), 0.12, M['rail'], 16)
    for part in (body, glow):
        parent_to(part.build(), root)
    return root


def build_mine_body(p, glow, c=(0, 0, 0), r=0.9):
    """The mine: an armoured ball with contact horns, armour ribs and a lamp belt."""
    c = Vector(c)
    p.sphere(c, r, M['gun'], 28, 16)
    # armour ribs: three great circles
    for axis in ((1, 0, 0), (0, 1, 0)):
        p.torus(c, axis, r * 1.0, 0.05, M['dark'], 40, 6)
    # equator belt with lamps
    p.torus(c, (0, 0, 1), r * 1.02, 0.09, M['paint'], 40, 8)
    for k in range(8):
        a = 2 * math.pi * k / 8 + math.pi / 8
        glow.sphere(c + Vector((math.cos(a), math.sin(a), 0)) * r * 1.08, 0.075, M['mine'], 10, 6)
    # contact horns: a short ceramic stem with a chrome tip, on an icosahedron's directions
    dirs = []
    t = (1 + 5 ** 0.5) / 2
    for v in ((0, 1, t), (0, -1, t), (0, 1, -t), (0, -1, -t), (1, t, 0), (-1, t, 0), (1, -t, 0), (-1, -t, 0), (t, 0, 1), (-t, 0, 1), (t, 0, -1), (-t, 0, -1)):
        dirs.append(Vector(v).normalized())
    for d in dirs:
        if abs(d.z) < 0.25:
            continue  # keep the belt clear
        p.cyl(c + d * r * 0.85, c + d * r * 1.32, 0.09, M['ceramic'], 10, r2=0.06)
        p.cyl(c + d * r * 1.32, c + d * r * 1.42, 0.06, M['chrome'], 10, r2=0.03)
        p.cyl(c + d * r * 0.95, c + d * r * 1.02, 0.15, M['dark'], 12)
    # arming plugs top and bottom
    for s in (-1, 1):
        p.cyl(c + Vector((0, 0, s * r * 0.9)), c + Vector((0, 0, s * r * 1.08)), 0.22, M['gun'], 16)
        glow.cyl(c + Vector((0, 0, s * r * 1.08)), c + Vector((0, 0, s * r * 1.1)), 0.1, M['mine'], 12)


def build_mine():
    root = empty('Mine', (0, 0, 0))
    p = Part('MineBody')
    glow = Part('MineLamps')
    build_mine_body(p, glow)
    for part in (p, glow):
        parent_to(part.build(), root)
    return root


def build_minepod():
    root = empty('MinePod', (0, 0, 0))
    p = Part('MinePodBody')
    glow = Part('MinePodGlow')
    # pylon and the pod: a rounded armoured box, nose fairing at the front
    p.box((0, 0.2, 0.12), (0.5, 1.3, 0.24), M['gun'], bevel=0.04)
    p.box((0, -0.15, 0.62), (1.05, 2.3, 0.78), M['paint'], bevel=0.12)
    p.cyl((0, 0.95, 0.62), (0, 1.45, 0.62), 0.39, M['paint'], 24, r2=0.12)
    p.sphere((0, 1.45, 0.62), 0.12, M['gun'], 12, 8)
    # side armour plates with warning stripes
    for sx in (-1, 1):
        p.box((sx * 0.54, -0.2, 0.62), (0.04, 1.8, 0.56), M['gun'], bevel=0.02)
        for k in range(5):
            p.box((sx * 0.565, -0.85 + k * 0.32, 0.62), (0.02, 0.14, 0.5), M['warn'], rot=Euler((0.6, 0, 0)).to_matrix(), bevel=0.0)
    # tail chute: the hatch hinged open on hydraulic rams, a mine waiting inside
    p.box((0, -1.32, 0.62), (0.98, 0.06, 0.72), M['dark'], bevel=0.0)
    p.box((0, -1.6, 0.98), (0.96, 0.5, 0.05), M['gun'], rot=Euler((-0.5, 0, 0)).to_matrix(), bevel=0.02)
    for sx in (-1, 1):
        p.cyl((sx * 0.4, -1.25, 0.4), (sx * 0.4, -1.65, 0.86), 0.035, M['chrome'], 8)
    build_mine_body(p, glow, (0, -1.15, 0.62), 0.28)
    # status lamps and a sensor eye
    for sx in (-1, 1):
        glow.box((sx * 0.3, 0.7, 1.02), (0.12, 0.06, 0.02), M['mine'], bevel=0.0)
    p.cyl((0, 0.4, 1.0), (0, 0.4, 1.06), 0.14, M['dark'], 16)
    glow.cyl((0, 0.4, 1.06), (0, 0.4, 1.07), 0.08, M['rail'], 12)
    for part in (p, glow):
        parent_to(part.build(), root)
    return root


def build_emp():
    root = empty('EmpEmitter', (0, 0, 0))
    p = Part('EmpBody')
    glow = Part('EmpGlow')
    # gimbal base with a capacitor ring
    p.cyl((0, 0, 0), (0, 0, 0.14), 0.7, M['gun'], 32)
    p.cyl((0, 0, 0.14), (0, 0, 0.3), 0.55, M['paint'], 32, r2=0.45)
    for k in range(8):
        a = 2 * math.pi * k / 8
        cpos = Vector((math.cos(a) * 0.6, math.sin(a) * 0.6, 0.14))
        p.cyl(cpos, cpos + Vector((0, 0, 0.32)), 0.08, M['gun'], 12)
        p.cyl(cpos + Vector((0, 0, 0.32)), cpos + Vector((0, 0, 0.36)), 0.06, M['chrome'], 12)
        glow.box(cpos + Vector((math.cos(a) * 0.08, math.sin(a) * 0.08, 0.2)), (0.03, 0.03, 0.12), M['emp'], bevel=0.0)
    p.torus((0, 0, 0.42), (0, 0, 1), 0.6, 0.04, M['copper'], 40, 6)
    # the coil: a mast wound with copper, ceramic insulators in between
    p.cyl((0, 0, 0.3), (0, 0, 1.55), 0.14, M['ceramic'], 16)
    for k in range(9):
        z = 0.45 + k * 0.12
        p.torus((0, 0, z), (0, 0, 1), 0.2, 0.035, M['copper'], 24, 6)
    for z, R in ((0.42, 0.32), (1.0, 0.27), (1.5, 0.22)):
        p.cyl((0, 0, z - 0.03), (0, 0, z + 0.03), R, M['ceramic'], 20)
    # the toroidal crown that lets the pulse go, glowing inside
    p.torus((0, 0, 1.72), (0, 0, 1), 0.42, 0.13, M['chrome'], 40, 12)
    glow.torus((0, 0, 1.72), (0, 0, 1), 0.42, 0.06, M['emp'], 40, 8)
    glow.sphere((0, 0, 1.72), 0.16, M['emp'], 16, 10)
    # emitter fins pointing out
    for k in range(4):
        a = 2 * math.pi * k / 4 + math.pi / 4
        d = Vector((math.cos(a), math.sin(a), 0))
        p.box(d * 0.33 + Vector((0, 0, 1.12)), (0.04, 0.04, 0.9), M['gun'], bevel=0.0)
        p.cyl(d * 0.33 + Vector((0, 0, 1.57)), d * 0.62 + Vector((0, 0, 1.72)), 0.025, M['alu'], 8)
    for part in (p, glow):
        parent_to(part.build(), root)
    return root


def export():
    path = os.path.join(ASSETS, 'weapons.glb')
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
    print(f'weapons: {tris} triangles -> {path} ({os.path.getsize(path) // 1024} KB)')


def render(out_dir):
    """Studio shot: the four models side by side, plus the modules mounted on the three ships."""
    sc = bpy.context.scene
    roots = {o.name: o for o in bpy.data.objects if o.parent is None and o.type == 'EMPTY'}
    for name, (x, y, z, s) in {'Railgun': (-5.0, 0, 0, 1.0), 'MinePod': (-1.2, 0, 0, 1.0), 'EmpEmitter': (1.6, 0, 0, 1.0), 'Mine': (4.2, 0, 1.0, 1.0)}.items():
        roots[name].location = (x, y, z)
        roots[name].scale = (s, s, s)
    world = bpy.data.worlds.new('World')
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.006, 0.007, 0.012, 1)
    sc.world = world
    for nm, loc, energy, size in (('Key', (6, -10, 9), 2600, 6), ('Rim', (-8, 8, 4), 1500, 5), ('Fill', (0, -12, 0), 400, 8)):
        ld = bpy.data.lights.new(nm, 'AREA')
        ld.energy = energy
        ld.size = size
        lo = bpy.data.objects.new(nm, ld)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 0.8)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        sc.collection.objects.link(lo)
    cd = bpy.data.cameras.new('Cam')
    cd.lens = 42
    cam = bpy.data.objects.new('Cam', cd)
    cam.location = (3.5, -13.5, 5.2)
    cam.rotation_euler = (Vector((-0.4, 0.6, 0.9)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = int(os.environ.get('WEAPON_SAMPLES', '64'))
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.filepath = os.path.join(out_dir, 'weapons-blender.png')
    sc.view_settings.view_transform = 'AgX'
    bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    reset()
    make_materials()
    build_railgun()
    build_minepod()
    build_emp()
    build_mine()
    export()
    if '--render' in argv:
        render(os.path.abspath(argv[argv.index('--render') + 1]))
