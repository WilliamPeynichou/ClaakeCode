"""CLAAKY — personnage articulé, bibliothèque de mouvements et export (module partagé).

Utilisé par claaky_etats.py et claaky_swarm.py. Réutilise les primitives de claaky_bureau.py
(cube, sphere, line, palette...) pour garder exactement le même style.

Hiérarchie d'un Claaky (tout est nommé « <nom> · ... ») :
    racine (pieds = repère du sprite)
      ├─ pied G / pied D            (pas de marche)
      └─ bassin                     (respiration, saut, inclinaison)
           ├─ corps + spirale
           ├─ cou → tête, oreilles, visage
           └─ épaule G / épaule D → bras, main, « prise main » (objets tenus)

Angles des épaules en degrés : rx > 0 = bras vers l'avant / le haut, ry = bras écarté sur le côté.
"""
import argparse
import importlib
import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def _script_dir():
    f = globals().get('__file__')
    if f and os.path.isfile(f):
        return os.path.dirname(os.path.abspath(f))
    for t in bpy.data.texts:  # lancé depuis l'éditeur de texte de Blender
        if t.filepath and t.name.startswith('claaky'):
            return os.path.dirname(bpy.path.abspath(t.filepath))
    return os.environ.get('CLAAKY_DIR', os.getcwd())


HERE = _script_dir()
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import claaky_bureau as cb  # noqa: E402
cb = importlib.reload(cb)   # remet les globales à zéro à chaque exécution dans Blender

FPS = 12
CAMERA_POS = Vector((10, -13, 11))
NEUTRAL = dict(sh_G=(0, 0), sh_D=(0, 0), neck=(0, 0, 0), hips=(0, 0, 0), foot_G=(0, 0), foot_D=(0, 0))
SIDES = (('G', -1), ('D', 1))


def yaw_towards(dx, dy):
    """Rotation Z pour que l'avant du personnage (+Y local) regarde la direction (dx, dy)."""
    return math.atan2(-dx, dy)


CAMERA_YAW = yaw_towards(CAMERA_POS.x, CAMERA_POS.y)


# ------------------------------------------------------------------ scène
def new_scene(name):
    cb.S = bpy.data.scenes.new(name)
    cb.MAT.clear()
    cb.ROOT = None
    if bpy.context.window:
        bpy.context.window.scene = cb.S
    cb.palette()
    extra_materials()
    return cb.S


def extra_materials():
    add = {
        'red': ((.85, .12, .08), 1.5), 'bubble': ((.98, .95, .85), 1.6), 'warn': ((.95, .65, .15), 1.6),
        'fur_bleu': ((.45, .66, .86), 0), 'fur_ocre': ((.90, .72, .38), 0),
        'fur_rose': ((.92, .62, .66), 0), 'fur_lilas': ((.68, .60, .86), 0),
        'fur_menthe': ((.55, .86, .70), 0), 'fur_gris': ((.70, .72, .70), 0),
        'folder': ((.86, .62, .20), 0),
    }
    for n, (c, e) in add.items():
        cb.material(n, c, emission=e)


def set_visible(obj, frame, visible):
    for o in [obj, *obj.children_recursive]:
        o.hide_render = o.hide_viewport = not visible
        o.keyframe_insert('hide_render', frame=frame)
        o.keyframe_insert('hide_viewport', frame=frame)


def fcurves(obj):
    ad = obj.animation_data
    if not ad or not ad.action:
        return []
    act = ad.action
    try:
        return list(act.fcurves)
    except AttributeError:  # Blender 5 : actions à couches
        out = []
        for layer in act.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    out += list(bag.fcurves)
        return out


# ------------------------------------------------------------------ personnage
class Claaky:
    def __init__(self, name, loc=(0, 0, 0), yaw=0.0, fur='fur', accent='green'):
        self.name = name
        cb.ROOT = None
        cb.collection('Personnage · ' + name)
        self.col = cb.COL
        self.root = cb.empty(name + ' · racine (pieds)', loc, yaw)
        self.pos, self.yaw, self.rx, self.ry = Vector(loc), yaw, 0.0, 0.0
        self.hips = self._pivot('bassin', self.root, (0, 0, 0))
        self.neck = self._pivot('cou', self.hips, (0, 0, .62))
        self.sh = {s: self._pivot('épaule ' + s, self.hips, (d * .30, .07, .57)) for s, d in SIDES}
        self.foot = {s: self._pivot('pied ' + s, self.root, (d * .20, 0, .10)) for s, d in SIDES}
        self.hand = {}
        self.bubbles = {}
        self.props = {}

        cb.ROOT = self.hips
        cb.sphere('Corps', (0, 0, .34), (.36, .27, .38), fur)
        pts = []
        for i in range(26):
            a, r = .2 + i * .16, .19 * (1 - i / 40)
            pts.append((math.cos(a) * r, .272, .31 + math.sin(a) * r))
        for a, b in zip(pts, pts[1:]):
            cb.line('Spirale ventre', a, b, .045, accent)

        cb.ROOT = self.neck  # tête : coordonnées d'origine moins la hauteur du cou (.62)
        head = cb.sphere('Tête', (0, .015, .32), (.49, .38, .46), fur, 48, 32)
        for p in head.data.polygons:
            p.use_smooth = True
        ball = cb.sphere('Boule sur tête', (0, .015, .81), (.14, .14, .14), accent, 40, 28)
        for p in ball.data.polygons:
            p.use_smooth = True
        for s, d in SIDES:
            ear = cb.sphere('Oreille arrondie', (d * .56, .015, .76), (.27, .14, .40), accent, 24, 12)
            ear.rotation_euler.y = math.radians(-d * 22)
            for p in ear.data.polygons:
                p.use_smooth = True
            eye = cb.sphere('Œil', (d * .19, .354, .37), (.105, .035, .14), 'eye', 24, 16)
            for p in eye.data.polygons:
                p.use_smooth = True
            iris = cb.sphere('Iris', (d * .19, .384, .34), (.070, .012, .075), accent, 20, 12)
            for p in iris.data.polygons:
                p.use_smooth = True
            cb.sphere('Reflet œil', (d * .17, .399, .42), (.030, .008, .037), 'paper', 16, 10)
            cb.sphere('Joue', (d * .33, .312, .21), (.074, .018, .042), 'pink', 20, 12)
        smile = cb.sphere('Sourire', (0, .386, .19), (.11, .018, .055), 'eye', 24, 16)
        smile.rotation_euler.y = math.radians(8)
        for p in smile.data.polygons:
            p.use_smooth = True

        for s, d in SIDES:
            cb.ROOT = self.sh[s]
            cb.line('Bras', (0, 0, 0), (d * .05, 0, -.30), .105, fur)
            cb.sphere('Main', (d * .05, 0, -.36), (.12, .14, .10), fur)
            self.hand[s] = self._pivot('prise main ' + s, self.sh[s], (d * .05, .06, -.42))
            cb.ROOT = self.foot[s]
            cb.sphere('Pied', (0, .17, -.065), (.15, .20, .12), fur)
        cb.ROOT = None

    def _pivot(self, n, parent, loc):
        o = cb.empty(self.name + ' · ' + n, loc)
        o.parent = parent
        return o

    # -------- accessoires et bulles
    def prop(self, key, builder, side='D'):
        """builder() crée des objets (avec cb.ROOT = prise de main). Caché par défaut."""
        prev = cb.COL
        cb.COL = self.col
        holder = self._pivot('accessoire ' + key, self.hand[side], (0, 0, 0))
        cb.ROOT = holder
        builder()
        cb.ROOT, cb.COL = None, prev
        self.props[key] = holder
        set_visible(holder, 1, False)
        return holder

    def bubble(self, key, text, mat='bubble', size=.5):
        curve = bpy.data.curves.new(self.name + ' · bulle ' + key, 'FONT')
        curve.body, curve.size, curve.extrude = text, size, .025
        curve.align_x, curve.align_y = 'CENTER', 'CENTER'
        o = bpy.data.objects.new(curve.name, curve)
        self.col.objects.link(o)
        o.data.materials.append(cb.MAT[mat])
        prev, cb.COL, cb.ROOT = cb.COL, self.col, o  # pastille sombre derrière le texte
        wide = max(1.0, len(text) * .75)
        disc = cb.cyl('Pastille bulle', (0, 0, -.05), size * .5 * wide, .03, 'base', 24)
        disc.scale.y = 1 / wide
        cb.COL, cb.ROOT = prev, None
        self.bubbles[key] = o
        set_visible(o, 1, False)
        return o

    def show_bubble(self, key, f0, f1, height=1.95, loc=None):
        o = self.bubbles[key]
        o.location = Vector(loc) if loc else self.pos + Vector((0, 0, height))
        o.keyframe_insert('location', frame=f0)
        set_visible(o, f0, True)
        set_visible(o, f1, False)

    def appear(self, f, visible):
        """Affiche / cache le personnage sans toucher aux accessoires (gérés par show_prop)."""
        skip = {o for p in self.props.values() for o in [p, *p.children_recursive]}
        for o in [self.root, *self.root.children_recursive]:
            if o not in skip:
                o.hide_render = o.hide_viewport = not visible
                o.keyframe_insert('hide_render', frame=f)
                o.keyframe_insert('hide_viewport', frame=f)

    def show_prop(self, key, f0, f1):
        set_visible(self.props[key], f0, True)
        set_visible(self.props[key], f1, False)

    # -------- clés de base
    def pose(self, f, **kw):
        p = {**NEUTRAL, **kw}
        for s, d in SIDES:
            rx, ry = p['sh_' + s]
            o = self.sh[s]
            o.rotation_euler = (math.radians(rx), math.radians(ry), 0)
            o.keyframe_insert('rotation_euler', frame=f)
            fy, fz = p['foot_' + s]
            o = self.foot[s]
            o.location = (d * .20, fy, .10 + fz)
            o.keyframe_insert('location', frame=f)
        self.neck.rotation_euler = [math.radians(a) for a in p['neck']]
        self.neck.keyframe_insert('rotation_euler', frame=f)
        hx, hy, hz = p['hips']
        self.hips.rotation_euler = (math.radians(hx), math.radians(hy), 0)
        self.hips.location = (0, 0, hz)
        self.hips.keyframe_insert('rotation_euler', frame=f)
        self.hips.keyframe_insert('location', frame=f)

    def place(self, f, loc=None, yaw=None, rx=None, ry=None):
        if loc is not None:
            self.pos = Vector(loc)
        if yaw is not None:  # chemin le plus court : pas de tour complet sur soi-même
            yaw = self.yaw + (yaw - self.yaw + math.pi) % math.tau - math.pi
            self.yaw = yaw
        if rx is not None:
            self.rx = rx
        if ry is not None:
            self.ry = ry
        self.root.location = self.pos
        self.root.rotation_euler = (self.rx, self.ry, self.yaw)
        self.root.keyframe_insert('location', frame=f)
        self.root.keyframe_insert('rotation_euler', frame=f)

    def cut(self, f, loc, yaw=None, rx=0.0, ry=0.0):
        """Changement instantané (s'asseoir, se coucher, monter sur l'estrade...)."""
        self.place(f - 1)
        self.place(f, loc, yaw, rx, ry)

    # -------- mouvements réutilisables (renvoient la frame de fin)
    def hold(self, f, n, **pose):
        self.place(f); self.pose(f, **pose)
        self.place(f + n); self.pose(f + n, **pose)
        return f + n

    def idle(self, f, n):
        for i in range(0, n + 1, 6):
            b = math.sin(i / 12 * math.tau)
            self.pose(f + i, hips=(0, 0, .015 * b), neck=(2 * b, 0, 0), sh_G=(0, 4 + 3 * b), sh_D=(0, -4 - 3 * b))
        self.place(f); self.place(f + n)
        return f + n

    def walk(self, f, points, speed=1.25):
        step = speed / FPS
        for p in points:
            p = Vector(p)
            d = p - self.pos
            if d.length < 1e-3:
                continue
            self.place(f)
            f += 2
            self.place(f, yaw=yaw_towards(d.x, d.y))
            n = max(12, round(d.length / step))
            for i in range(0, n + 1, 2):
                s = math.sin(i / 8 * math.tau)
                self.pose(f + i, foot_G=(.13 * s, .07 * max(0, s)), foot_D=(-.13 * s, .07 * max(0, -s)),
                          sh_G=(-22 * s, 6), sh_D=(22 * s, -6), hips=(5, 0, .035 * abs(math.cos(i / 8 * math.tau))))
            f += n
            self.place(f, p)
        self.pose(f + 2)
        return f + 2

    def type_loop(self, f, n, phase=0):
        for i in range(0, n + 1, 2):
            a = 1 if (i // 2 + phase) % 2 else -1
            self.pose(f + i, sh_G=(80 + 7 * a, 0), sh_D=(80 - 7 * a, 0), neck=(6, 0, 3 * a), hips=(3, 0, 0))
        self.place(f); self.place(f + n)
        return f + n

    def write(self, f, n):
        for i in range(0, n + 1, 3):
            w = math.sin(i / 9 * math.tau)
            self.pose(f + i, sh_D=(150 + 8 * w, -12 * w), sh_G=(15, 8), neck=(-12, 0, 6 * w))
        self.place(f); self.place(f + n)
        return f + n

    def wave(self, f, n, side='D', **extra):
        d = 1 if side == 'D' else -1
        for i in range(0, n + 1, 3):
            w = 1 if (i // 3) % 2 else -1
            pose = {'sh_' + side: (20, -d * (150 + 15 * w))}
            pose.update(extra)
            self.pose(f + i, **pose)
        self.place(f); self.place(f + n)
        return f + n

    def raise_hand(self, f, n, side='D', **extra):
        d = 1 if side == 'D' else -1
        for i in range(0, n + 1, 6):
            self.pose(f + i, **{'sh_' + side: (175, -d * 10)}, neck=(-8, 0, 4 * (-1) ** (i // 6)), **extra)
        self.place(f); self.place(f + n)
        return f + n

    def shake(self, f, n=18):
        for i in range(0, n + 1, 2):
            a = (-1) ** (i // 2) * (1 - i / n)
            self.pose(f + i, neck=(-6, 0, 22 * a), sh_G=(30, 25), sh_D=(30, -25), hips=(-4, 0, 0))
        self.place(f); self.place(f + n)
        return f + n

    def celebrate(self, f, jumps=2):
        base = Vector(self.pos)
        for j in range(jumps):
            for i, h in [(0, 0), (3, .30), (6, 0)]:
                self.place(f + i, base + Vector((0, 0, h)))
                up = 160 if h else 120
                self.pose(f + i, sh_G=(10, up), sh_D=(10, -up), foot_G=(0, h * .2), foot_D=(0, h * .2), neck=(-10, 0, 0))
            f += 8
        self.pose(f)
        self.place(f, base)
        return f

    def stretch(self, f, n=18):
        self.pose(f)
        self.pose(f + n // 2, sh_G=(170, 20), sh_D=(170, -20), neck=(-15, 0, 0), hips=(-6, 0, .03))
        self.pose(f + n)
        self.place(f); self.place(f + n)
        return f + n

    def look_at_camera(self, f, n, body_turn=.6, **extra):
        """Tourne le corps (fraction body_turn) puis la tête vers l'utilisateur."""
        target = self.yaw + (CAMERA_YAW - self.yaw + math.pi) % math.tau - math.pi
        body = self.yaw + (target - self.yaw) * body_turn
        head = math.degrees(target - body)
        self.place(f)
        self.place(f + 4, yaw=body)
        self.pose(f, **extra)
        self.pose(f + 4, neck=(-6, 0, head), **extra)
        self.pose(f + n, neck=(-6, 0, head), **extra)
        self.place(f + n)
        return f + n


# ------------------------------------------------------------------ finitions et export
def finalize(scene, characters, segments):
    cam = scene.camera
    for c in characters:
        for o in c.bubbles.values():
            con = o.constraints.new('COPY_ROTATION')
            con.target = cam
        for fc in fcurves(c.root):
            for k in fc.keyframe_points:
                k.interpolation = 'BEZIER'
                k.handle_left_type = 'AUTO_CLAMPED'
                k.handle_right_type = 'AUTO_CLAMPED'
    for o in scene.objects:
        for fc in fcurves(o):
            if fc.data_path.startswith('hide_'):
                for k in fc.keyframe_points:
                    k.interpolation = 'CONSTANT'
    scene.timeline_markers.clear()
    for s in segments:
        scene.timeline_markers.new(s['nom'], frame=s['debut'])
    scene.frame_start = 1
    scene.frame_end = max(s['fin'] for s in segments)
    scene.render.fps = FPS
    scene.frame_set(1)


def parse_args(stem):
    tail = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser(prog=stem)
    p.add_argument('--output', default=cb.CONFIG['output'])
    p.add_argument('--render', action='store_true', help='rendu fixe de la frame --frame')
    p.add_argument('--frame', type=int, default=1)
    p.add_argument('--save-blend', action='store_true')
    p.add_argument('--preview', action='store_true')
    p.add_argument('--export', action='store_true', help='sprites + décor + JSON de placement')
    p.add_argument('--segments', default='', help='liste séparée par des virgules (export partiel)')
    p.add_argument('--export-size', type=int, default=640)
    p.add_argument('--export-samples', type=int, default=24)
    p.add_argument('--gpu', action='store_true', help='rendu GPU (Metal sur Mac)')
    p.add_argument('--keep-frames', action='store_true', help='garder les images brutes')
    return p.parse_args(tail)


def _pixel(scene, world):
    from bpy_extras.object_utils import world_to_camera_view
    v = world_to_camera_view(scene, scene.camera, Vector(world))
    r = scene.render
    return [round(v.x * r.resolution_x, 1), round((1 - v.y) * r.resolution_y, 1)]


def use_gpu(scene):
    """Active le GPU (Metal sur Mac, sinon CUDA/OptiX/HIP) ; reste sur CPU si rien n'est trouvé."""
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
        except TypeError:
            continue
        gpus = [d for d in prefs.devices if d.type == kind]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == kind
            scene.cycles.device = 'GPU'
            print('GPU :', kind, ', '.join(d.name for d in gpus))
            return
    print('GPU : aucun, rendu CPU')


def pack_sheet(folder, frames, name, dest):
    """Recadre les images d'un clip sur leur zone utile commune et les range dans une planche unique.
    Renvoie la description du clip pour le manifeste (positions en pixels du décor)."""
    import numpy as np
    arrays = []
    for f in frames:
        img = bpy.data.images.load(str(folder / f'{f:04d}.png'))
        w, h = img.size
        a = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(a)
        arrays.append(a.reshape(h, w, 4))  # Blender : ligne 0 = bas de l'image
        bpy.data.images.remove(img)
    alpha = np.max([a[:, :, 3] for a in arrays], axis=0) > 0.004
    ys, xs = np.nonzero(alpha)
    if len(xs) == 0:
        x0 = y0 = 0; x1 = y1 = 1
    else:
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    cw, ch = int(x1 - x0), int(y1 - y0)
    cols = min(len(frames), max(1, 4096 // max(cw, 1)))
    rows = math.ceil(len(frames) / cols)
    sheet = np.zeros((rows * ch, cols * cw, 4), dtype=np.float32)
    for i, a in enumerate(arrays):
        r, c = divmod(i, cols)
        top = (rows - 1 - r) * ch  # remettre la 1re image en haut à gauche
        sheet[top:top + ch, c * cw:(c + 1) * cw] = a[y0:y1, x0:x1]
    img = bpy.data.images.new(name, cols * cw, rows * ch, alpha=True)
    img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = str(dest / f'{name}.png')
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    height = arrays[0].shape[0]
    return {'planche': f'{name}.png', 'x': int(x0), 'y': int(height - y1), 'l': cw, 'h': ch,
            'colonnes': cols, 'images': len(frames)}


def export(scene, characters, segments, waypoints, out, args):
    """Décor seul (decor.png, fond transparent) + une planche de sprites par clip (personnage seul,
    meubles en holdout pour qu'il passe derrière eux) + clips.json, lu tel quel par l'IDE."""
    import shutil
    out = Path(out) / scene.name.replace(' · ', '_').replace(' ', '_')
    out.mkdir(parents=True, exist_ok=True)
    raw = out / '_images'
    r = scene.render
    r.resolution_x = r.resolution_y = args.export_size
    r.resolution_percentage = 100
    scene.cycles.samples = args.export_samples
    scene.cycles.use_denoising = True
    r.film_transparent = True
    if args.gpu:
        use_gpu(scene)
    for o in scene.objects:  # le fond infini resterait opaque derrière la pièce
        if o.name.startswith('Fond teal'):
            o.hide_render = True
    char_cols = {c.col.name for c in characters}
    decor = scene.view_layers[0]
    decor.name = 'Décor'
    perso = scene.view_layers.get('Personnages') or scene.view_layers.new('Personnages')
    for lc in decor.layer_collection.children:
        lc.exclude = lc.name in char_cols
    for lc in perso.layer_collection.children:
        lc.exclude = False
        lc.holdout = lc.name not in char_cols
    perso.use, decor.use = False, True
    wanted = {s.strip() for s in args.segments.split(',') if s.strip()}
    manifest_path = out / 'clips.json'
    data = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() and wanted else {}
    data.update({'scene': scene.name, 'fps': FPS, 'taille': args.export_size, 'decor': 'decor.png',
                 'points': {k: _pixel(scene, v) for k, v in waypoints.items()}})
    data.setdefault('clips', {})
    if not wanted or 'decor' in wanted:
        scene.frame_set(1)
        r.filepath = str(out / 'decor.png')
        bpy.ops.render.render(write_still=True, scene=scene.name)

    perso.use, decor.use = True, False
    total = len([s for s in segments if not wanted or s['nom'] in wanted])
    done = 0
    for s in segments:
        if wanted and s['nom'] not in wanted:
            continue
        folder = raw / s['nom']
        scene.frame_start, scene.frame_end = s['debut'], s['fin']
        r.filepath = str(folder / '####')
        bpy.ops.render.render(animation=True, scene=scene.name)
        frames = list(range(s['debut'], s['fin'] + 1))
        info = pack_sheet(folder, frames, s['nom'], out)
        info.update(boucle=s['boucle'], lieu=s['lieu'], lieu_fin=s.get('lieu_fin', s['lieu']))
        data['clips'][s['nom']] = info
        manifest_path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
        done += 1
        print(f'CLIP {done}/{total} :', s['nom'], f"{info['l']}×{info['h']}", len(frames), 'images', flush=True)
    decor.use = True
    if not args.keep_frames:
        shutil.rmtree(raw, ignore_errors=True)
    print('EXPORT :', out)


def run_outputs(scene, characters, segments, waypoints, args, stem):
    out = Path(args.output).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    if args.save_blend:
        fp = cb.unique_path(out, stem, '.blend')
        bpy.ops.wm.save_as_mainfile(filepath=str(fp))
        print('BLEND :', fp)
    if args.render:
        scene.frame_set(args.frame)
        scene.render.filepath = str(cb.unique_path(out, stem, '.png'))
        bpy.ops.render.render(write_still=True, scene=scene.name)
        print('RENDU :', scene.render.filepath)
    if args.export:
        export(scene, characters, segments, waypoints, out, args)
    print('PRÊT :', scene.name, '·', len(scene.objects), 'objets ·', scene.frame_end, 'frames ·',
          ', '.join(s['nom'] for s in segments))
