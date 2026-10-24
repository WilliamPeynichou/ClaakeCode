"""CLAAKY — bureau / chambre : clips d'animation pour l'IDE Claake Code.

Reprend le décor de claaky_bureau.py avec le Claaky articulé de claaky_rig.py.
La timeline est découpée en CLIPS INDÉPENDANTS (un marqueur chacun, un dossier de sprites à l'export) :
chaque clip commence exactement dans la pose finale des clips qui y mènent, l'IDE peut donc
les enchaîner dans n'importe quel ordre sans saut.

  Lieux : bureau (assis) · tableau (debout, réfléchit) · lit (couché) · centre (attend, face à toi)
  Boucles   : travail_clavier · reflechir_tableau · dormir · attente
  Ponctuels : autorisation · erreur · cafe (au bureau)
  Pas de trajets ni de bulles : l'IDE téléporte Claaky d'un lieu à l'autre avec un fondu (plus léger).

UTILISATION (Blender 4.2+) : les fichiers claaky_*.py dans le même dossier,
Scripting > Open > claaky_etats.py > Run Script. Espace : lecture.
Ligne de commande :
  blender --background --python claaky_etats.py -- --render --frame 100
  blender --background --python claaky_etats.py -- --export --gpu
      → sprites + placement.json, à copier dans sinew/public/claaky3d/ (voir export_ide.sh)
"""
import importlib
import math
import os
import random
import sys

import bpy

if os.path.isfile(globals().get('__file__', '')):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
else:  # lancé depuis l'éditeur de texte de Blender
    sys.path += [os.path.dirname(bpy.path.abspath(t.filepath)) for t in bpy.data.texts if t.filepath]
import claaky_rig as rig  # noqa: E402
rig = importlib.reload(rig)
cb = rig.cb

FLOOR, RUG = .075, .12
# Positions des lieux (monde).
POINTS = {
    'bureau_assis': (.15, 1.28, .88),
    'centre': (.10, -.30, RUG),
    'tableau_regard': (-1.80, 1.05, RUG),  # devant la commode, face au tableau blanc
    # Lit le long du bord avant, tête contre le mur gauche : origine à 0,94 de la tête (sur l'oreiller).
    'lit_couche': (cb.BED[0] + .14, cb.BED[1], 1.02),
}
YAW_TABLEAU = rig.yaw_towards(-1, 0)
YAW_LIT = math.pi / 2  # tête vers -X (mur gauche), visage vers le plafond
POSE_CLAVIER = dict(sh_G=(76, 0), sh_D=(76, 0), neck=(1, 0, 0), hips=(2, 0, 0))
POSE_REFLEXION = dict(sh_D=(135, 15), sh_G=(60, -20), neck=(14, 0, 0))


def build_room():
    cb.architecture()
    cb.wall_details()
    cb.bed_and_rug()
    cb.desk()
    cb.CONFIG['animation'] = False
    cb.chair_and_character()
    char_collection = cb.COL
    char_root = cb.ROOT
    for o in list(char_collection.objects):  # retire le Claaky statique d'origine
        bpy.data.objects.remove(o)
    bpy.data.collections.remove(char_collection)
    cb.COL = char_collection
    cb.ROOT = char_root
    cb.accessories()
    # Le chevet est déjà construit une seule fois par bed_and_rug().
    cb.collection('09 · Accessoires des états')
    bx, by = cb.BED
    return cb.cube('Couverture Claaky (sommeil)', (bx + .22, by, .97), (1.40, 1.50, .42), 'teal', .16)


def mug_builder():
    cb.cyl('Tasse en main', (0, .02, .02), .085, .19, 'paper')
    cb.cyl('Café en main', (0, .02, .12), .07, .008, 'soil')


class Clips:
    def __init__(self, c, cover, desk_mug):
        self.c, self.cover, self.mug = c, cover, desk_mug
        self.seg = []
        self.f = 1

    # ---- état de départ / d'arrivée d'un lieu (identique pour tous les clips)
    def settle(self, f, lieu):
        c, P = self.c, POINTS
        rig.set_visible(self.cover, f, lieu == 'lit')
        for o in self.mug:
            rig.set_visible(o, f, True)
        if lieu == 'bureau':
            # En travaillant, Claaky regarde bien le moniteur (+Y).
            c.place(f, P['bureau_assis'], 0, 0, 0); c.pose(f, **POSE_CLAVIER)
        elif lieu == 'tableau':
            c.place(f, P['tableau_regard'], YAW_TABLEAU, 0, 0); c.pose(f, **POSE_REFLEXION)
        elif lieu == 'lit':
            c.place(f, P['lit_couche'], YAW_LIT, -math.pi / 2, math.pi); c.pose(f)
        else:
            c.place(f, P['centre'], rig.CAMERA_YAW, 0, 0); c.pose(f)

    def clip(self, name, lieu_debut, build, loop=False, lieu_fin=None):
        f0 = self.f
        self.settle(f0, lieu_debut)
        f1 = build(f0)
        if lieu_fin:
            self.settle(f1, lieu_fin)
        self.seg.append({'nom': name, 'debut': f0, 'fin': f1, 'boucle': loop,
                         'lieu': lieu_debut, 'lieu_fin': lieu_fin or lieu_debut})
        self.f = f1 + 1

    # ---- boucles
    def loops(self):
        c = self.c
        self.clip('travail_clavier', 'bureau', lambda f: c.type_loop(f, 48), True)

        def reflechir(f):
            # main au menton, tête levée vers le tableau, balancement, hochement de temps en temps
            for i in range(0, 49, 4):
                sway = math.sin(i / 48 * math.tau)
                nod = 4 if i in (20, 40) else 0
                pose = dict(POSE_REFLEXION)
                pose['neck'] = (10 - nod, 0, 7 * sway)
                pose['hips'] = (0, 3 * sway, .015 * sway)
                c.pose(f + i, **pose)
            c.place(f + 48)
            return f + 48
        self.clip('reflechir_tableau', 'tableau', reflechir, True)

        def dormir(f):
            for i in range(0, 72, 12):  # respiration lente
                c.pose(f + i, hips=(0, 0, 0))
                c.pose(f + i + 6, hips=(0, 0, .03))
            c.pose(f + 72)
            c.place(f + 72)
            return f + 72
        self.clip('dormir', 'lit', dormir, True)

        def attente(f):
            for i in range(0, 49, 6):
                b = math.sin(i / 48 * math.tau)
                c.pose(f + i, hips=(0, 0, .015 * b), neck=(2 * b, 0, 6 * b), sh_G=(0, 4 + 3 * b), sh_D=(0, -4 - 3 * b))
            c.place(f + 48)
            return f + 48
        self.clip('attente', 'centre', attente, True)

    # ---- réactions ponctuelles
    def one_shots(self):
        c = self.c

        def autorisation(f):
            c.look_at_camera(f, 16, .5, sh_D=(20, -30))
            c.wave(f + 16, 12, neck=neck_to_camera(c))
            c.hold(f + 28, 8, neck=neck_to_camera(c))
            c.place(f + 40, yaw=0)
            c.pose(f + 40, **POSE_CLAVIER)
            return f + 40
        self.clip('autorisation', 'bureau', autorisation, lieu_fin='bureau')

        def erreur(f):
            c.shake(f, 18)
            c.pose(f + 24, **POSE_CLAVIER)
            c.place(f + 24)
            return f + 24
        self.clip('erreur', 'bureau', erreur, lieu_fin='bureau')

        def cafe(f):
            for o in self.mug:
                rig.set_visible(o, f + 2, False)
                rig.set_visible(o, f + 46, True)
            c.show_prop('tasse', f + 2, f + 46)
            for i, up in [(6, 125), (16, 125), (20, 70), (28, 70), (32, 125), (40, 125)]:
                c.pose(f + i, sh_D=(up, -8), sh_G=(70, 0), neck=(-12 if up > 100 else 4, 0, 0))
            c.pose(f + 48, **POSE_CLAVIER)
            c.place(f + 48)
            return f + 48
        self.clip('cafe', 'bureau', cafe, lieu_fin='bureau')


def neck_to_camera(c):
    target = c.yaw + (rig.CAMERA_YAW - c.yaw + math.pi) % math.tau - math.pi
    return (-6, 0, math.degrees(target - c.yaw))


def main():
    args = rig.parse_args('claaky_etats')
    scene = rig.new_scene('Claaky · États animés')
    cover = build_room()
    desk_mug = [o for o in scene.objects if o.name.split('.')[0] in ('Tasse', 'Café', 'Anse tasse')]
    c = rig.Claaky('Claaky', POINTS['bureau_assis'])
    c.root.rotation_euler.z = rig.yaw_towards(0, -1)  # visage tourné vers l'avant de la caméra
    c.prop('tasse', mug_builder)
    # La couverture n'existe que pendant le sommeil : elle doit être rendue avec le sprite, pas en holdout.
    for col in list(cover.users_collection):
        col.objects.unlink(cover)
    c.col.objects.link(cover)
    cb.setup_render(args.preview)
    clips = Clips(c, cover, desk_mug)
    clips.loops()
    clips.one_shots()
    rig.finalize(scene, [c], clips.seg)
    # Change uniquement les axes racine : chaque déplacement conserve l'orientation et l'inclinaison.
    for fc in rig.fcurves(c.root):
        if fc.data_path == 'location':
            for k in fc.keyframe_points:
                k.interpolation = 'LINEAR'
        elif fc.data_path == 'rotation_euler':
            for k in fc.keyframe_points:
                k.interpolation = 'BEZIER'
                k.handle_left_type = 'AUTO_CLAMPED'
                k.handle_right_type = 'AUTO_CLAMPED'
    rig.run_outputs(scene, [c], clips.seg, POINTS, args, 'claaky_etats')


if __name__ == '__main__':
    main()
