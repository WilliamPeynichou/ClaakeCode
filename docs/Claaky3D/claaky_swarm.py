"""CLAAKY — salle du swarm + scénario simulé (étape 8 du plan, section 14).

Salle : estrade + grand tableau kanban au fond, 6 postes de travail (2 rangées × 3),
porte à gauche (vers le bureau), compteur « +N » pour les agents non affichés.
Scénario simulé (marqueurs de timeline = dossiers de sprites à l'export) :

  principal_entre · reunion_ouverte · agents_arrivent · travail_swarm ·
  agent_remet_dossier · agent_leve_la_main · agents_terminent · reunion_close

Tous les sous-agents partagent le même Claaky articulé, seules les couleurs changent.
UTILISATION : les 3 fichiers claaky_*.py dans le même dossier, Run Script dans Blender.
  blender --background --python claaky_swarm.py -- --render --frame 200
  blender --background --python claaky_swarm.py -- --export
"""
import importlib
import math
import os
import random
import sys

import bpy

if os.path.isfile(globals().get('__file__', '')):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
else:
    sys.path += [os.path.dirname(bpy.path.abspath(t.filepath)) for t in bpy.data.texts if t.filepath]
import claaky_rig as rig  # noqa: E402
rig = importlib.reload(rig)
cb = rig.cb

W, D = 8.0, 6.6            # largeur (x) et profondeur (y) de la salle
X0, X1, Y0, Y1 = -W / 2, W / 2, -3.6, 3.0
FLOOR = .075
STAGE_Z = .42              # dessus de l'estrade
AISLE_Y = 1.25             # allée principale devant l'estrade
LANES = (-1.3, 1.3)        # allées verticales entre les colonnes de postes
COLS = (-2.6, 0.0, 2.6)
ROWS = (-.30, -2.50)       # y des fauteuils (rangée avant, rangée arrière)
AGENTS = [('Agent bleu', 'fur_bleu', 'teal'), ('Agent ocre', 'fur_ocre', 'green'),
          ('Agent rose', 'fur_rose', 'green'), ('Agent lilas', 'fur_lilas', 'teal')]
HIDDEN_AGENTS = 2          # agents supplémentaires représentés par le compteur

POINTS = {
    'porte': (X0 + .45, AISLE_Y, FLOOR),
    'allee_centre': (0, AISLE_Y, FLOOR),
    'estrade_pied': (0, 1.45, FLOOR),
    'estrade': (0, 2.30, STAGE_Z),
}


def seat(col, row):
    x, y = COLS[col], ROWS[row]
    return (x, y + .15, .88)


def approach(col, row):
    return (COLS[col] + .75, ROWS[row] - .55, FLOOR)


def lane(col):
    return LANES[0] if COLS[col] < 0 else LANES[1] if COLS[col] > 0 else LANES[0]


# ------------------------------------------------------------------ décor
def architecture():
    cb.collection('01 · Salle du swarm')
    cx, cy = 0, (Y0 + Y1) / 2
    cb.cube('Socle diorama', (cx, cy, -.22), (W + .35, D + .35, .42), 'base', .06)
    cb.cube('Bordure claire', (cx, cy, -.035), (W + .23, D + .23, .10), 'cream', .025)
    rows = int(D / .25)
    for r in range(rows):
        y = Y0 + .125 + r * .25
        off = .5 if r % 2 else 0
        cuts = sorted({X0, X1, *[X0 + off + i for i in range(int(W) + 1) if X0 < X0 + off + i < X1]})
        for a, b in zip(cuts, cuts[1:]):
            cb.cube('Lame parquet', ((a + b) / 2, y, .04), (b - a - .014, .238, .07),
                    random.choice(['plank1', 'plank2', 'plank3']), .008)
    # Mur gauche avec porte (vers le bureau), mur du fond plein.
    dy0, dy1 = AISLE_Y - .5, AISLE_Y + .5
    cb.cube('Mur gauche bas', (X0 - .06, (Y0 + dy0) / 2, 1.95), (.14, dy0 - Y0, 3.9), 'wall')
    cb.cube('Mur gauche haut', (X0 - .06, (dy1 + Y1) / 2 + .07, 1.95), (.14, Y1 - dy1 + .14, 3.9), 'wall')
    cb.cube('Linteau porte', (X0 - .06, AISLE_Y, 3.22), (.14, 1.0, 1.36), 'wall')
    cb.cube('Mur fond', (0, Y1 + .06, 1.95), (W, .14, 3.9), 'wall')
    cb.cube('Plinthe fond', (0, Y1 - .045, .17), (W, .08, .23), 'wood_dark')
    for y in (dy0 - .05, dy1 + .05):
        cb.cube('Chambranle porte', (X0 + .06, y, 1.32), (.23, .10, 2.56), 'metal', .01)
    cb.cube('Chambranle haut', (X0 + .06, AISLE_Y, 2.60), (.23, 1.08, .10), 'metal')
    cb.cube('Porte ouverte', (X0 + .35, dy1 + .05, 1.32), (.60, .08, 2.40), 'wood_dark', .015).rotation_euler.z = .3
    cb.cube('Seuil', (X0 + .05, AISLE_Y, .09), (.35, .9, .08), 'paper')
    cb.cube('Tapis allée', (0, AISLE_Y, .095), (W - .6, .75, .02), 'teal', .01)


def stage_and_board():
    cb.collection('02 · Estrade et tableau principal')
    cb.cube('Estrade', (0, 2.45, .22), (3.4, 1.10, .34), 'wood', .03)
    cb.cube('Estrade bordure', (0, 1.90, .22), (3.4, .05, .30), 'ochre')
    cb.cube('Marche estrade', (0, 1.72, .11), (1.0, .32, .14), 'wood_dark', .015)
    cb.cube('Pupitre', (1.15, 2.35, STAGE_Z + .50), (.55, .40, 1.0), 'wood_dark', .03)
    cb.cube('Pupitre tablette', (1.15, 2.25, STAGE_Z + 1.04), (.65, .50, .06), 'wood', .015)
    # Grand tableau kanban : 3 colonnes (À faire / En cours / Fait).
    z, w, h = 2.35, 3.8, 1.7
    cb.cube('Tableau cadre', (0, Y1 - .04, z), (w, .09, h), 'wood', .03)
    cb.cube('Tableau blanc', (0, Y1 - .095, z), (w - .1, .02, h - .1), 'paper')
    colors = ('ochre', 'sage', 'code')
    for i in range(3):
        x = -w / 3 + i * w / 3
        cb.cube('Titre colonne', (x, Y1 - .12, z + .62), (.9, .012, .10), 'green')
        if i:
            cb.cube('Séparateur', (x - w / 6, Y1 - .12, z), (.02, .012, h - .3), 'sage')
        for j in range(3 - (i == 2)):
            for k in range(2):
                cb.cube('Post-it', (x - .22 + k * .44, Y1 - .125, z + .32 - j * .36), (.32, .012, .26), colors[i])
    cb.cube('Écran participants', (-3.0, Y1 - .05, 2.3), (1.2, .08, .75), 'metal', .03)
    for i in range(6):
        cb.cube('Vignette agent', (-3.33 + (i % 3) * .33, Y1 - .1, 2.45 - (i // 3) * .3), (.27, .012, .22),
                ['fur_bleu', 'fur_ocre', 'fur_rose', 'fur_lilas', 'screen', 'screen'][i])
    # Compteur des agents non affichés.
    cb.cube('Compteur fond', (3.0, Y1 - .05, 2.5), (.9, .08, .55), 'metal', .03)
    t = bpy.data.curves.new('Compteur agents', 'FONT')
    t.body, t.size, t.align_x, t.align_y, t.extrude = f'+{HIDDEN_AGENTS}', .38, 'CENTER', 'CENTER', .01
    o = bpy.data.objects.new('Compteur agents', t)
    cb.COL.objects.link(o)
    o.location, o.rotation_euler = (3.0, Y1 - .1, 2.5), (math.pi / 2, 0, 0)
    o.data.materials.append(cb.MAT['code_gold'])
    for x in (-3.6, 3.6):
        cb.plant(x, Y1 - .4, .075, .9)


def poste(col, row):
    x, y = COLS[col], ROWS[row]
    dy = y + .85
    cb.cube('Plateau poste', (x, dy, 1.32), (1.6, .78, .10), 'wood', .03)
    for sx in (-.72, .72):
        cb.cube('Pied poste', (x + sx, dy, .69), (.08, .65, 1.24), 'wood_dark', .01)
    cb.cube('Moniteur poste', (x, dy + .22, 1.85), (1.0, .08, .62), 'metal', .03)
    cb.cube('Dalle poste', (x, dy + .175, 1.85), (.90, .012, .52), 'screen')
    for i in range(6):
        cb.cube('Code à écran', (x - .30 + random.uniform(0, .15), dy + .165, 2.0 - i * .07),
                (random.uniform(.15, .45), .008, .03), random.choice(['code', 'code_dim', 'code_gold']))
    cb.cube('Pied moniteur', (x, dy + .25, 1.45), (.08, .06, .20), 'metal')
    cb.cube('Clavier poste', (x, dy - .12, 1.39), (.70, .22, .04), 'metal', .01)
    cb.cube('Touches', (x, dy - .12, 1.415), (.64, .17, .012), 'sage')
    # Fauteuil
    cb.cyl('Fauteuil vérin', (x, y, .42), .06, .6, 'metal')
    cb.cyl('Fauteuil base', (x, y, .17), .35, .05, 'metal', 10)
    cb.cube('Fauteuil assise', (x, y, .83), (.80, .66, .15), 'teal', .06)
    cb.cube('Fauteuil dossier', (x, y - .29, 1.25), (.80, .14, .78), 'metal', .05)


def build_room():
    random.seed(cb.CONFIG['seed'])
    architecture()
    stage_and_board()
    cb.collection('03 · Postes de travail')
    for r in range(2):
        for c in range(3):
            poste(c, r)


def folder_builder():
    cb.cube('Dossier', (0, .05, 0), (.30, .04, .38), 'folder', .01)
    cb.cube('Feuille', (0, .03, .03), (.26, .02, .32), 'paper')


# ------------------------------------------------------------------ scénario
def animate(main, agents):
    seg = []

    def mark(name, f0, f1, loop=False):
        seg.append({'nom': name, 'debut': f0, 'fin': f1, 'boucle': loop, 'lieu': 'swarm'})
        return f1 + 1

    P = POINTS
    f = main.walk(1, [P['allee_centre'], P['estrade_pied']])
    main.cut(f + 1, P['estrade'], math.pi)
    f = mark('principal_entre', 1, main.idle(f + 1, 6))

    o = f
    f = mark('reunion_ouverte', o, main.wave(o, 24))

    posts = [(0, 0), (2, 0), (1, 1), (0, 1)]
    a0 = f
    ends = []
    for i, (ag, (col, row)) in enumerate(zip(agents, posts)):
        s = a0 + i * 12
        ag.place(1)
        ag.appear(1, False)
        ag.appear(s, True)
        ag.cut(s, P['porte'], -math.pi / 2)
        L = lane(col)
        e = ag.walk(s, [(L, AISLE_Y, FLOOR), (L, ROWS[row] - .55, FLOOR), approach(col, row)])
        ag.cut(e + 1, seat(col, row), 0)
        ends.append(e + 1)
        ag.post = (col, row)
    main.look_at_camera(a0, 6, 0)  # garde la pose, regarde la salle
    f = mark('agents_arrivent', a0, max(ends))
    main.idle(a0 + 6, f - a0 - 6)

    w = f
    for i, ag in enumerate(agents):
        ag.type_loop(ends[i], w + 36 - ends[i], i)
    main.idle(w, 36)
    f = mark('travail_swarm', w, w + 36, True)

    # Agent ocre : terminé, remet un dossier au principal.
    d, ag = f, agents[1]
    col, row = ag.post
    ag.cut(d + 1, approach(col, row), math.pi)
    e = ag.walk(d + 1, [(lane(col), AISLE_Y, FLOOR), (.45, 1.45, FLOOR)])
    ag.place(e, yaw=0)
    ag.show_prop('dossier', d + 1, e + 14)
    ag.pose(e + 4, sh_D=(95, 0))
    ag.hold(e + 4, 8, sh_D=(95, 0))
    ag.show_bubble('OK', e + 6, e + 22)
    main.show_prop('dossier', e + 14, e + 40)
    main.pose(e + 10, sh_D=(70, 0)); main.pose(e + 18, sh_D=(70, 0))
    e2 = ag.walk(e + 14, [(-.5, AISLE_Y, FLOOR), P['porte']])
    ag.appear(e2 + 1, False)
    for other in (agents[0], agents[2], agents[3]):
        other.type_loop(d, e2 - d, agents.index(other))
    main.idle(d, e + 10 - d)
    main.idle(e + 18, e2 - e - 18)
    f = mark('agent_remet_dossier', d, e2 + 1)

    # Agent rose : bloqué, lève la main ; le principal se tourne vers lui.
    h, ag = f, agents[2]
    ag.show_bubble('?', h + 2, h + 34, 2.2)
    ag.raise_hand(h, 36, 'D', sh_G=(80, 0))
    sx, sy, _ = seat(*ag.post)
    turn = rig.yaw_towards(sx - main.pos.x, sy - main.pos.y) - main.yaw
    turn = math.degrees((turn + math.pi) % math.tau - math.pi)
    main.hold(h, 36, neck=(8, 0, max(-70, min(70, turn))), sh_D=(20, -40))
    for other in (agents[0], agents[3]):
        other.type_loop(h, 36, agents.index(other))
    f = mark('agent_leve_la_main', h, h + 36)

    # Fin : les agents restants terminent (coche) et sortent.
    t = f
    last = t
    for k, ag in enumerate((agents[0], agents[2], agents[3])):
        s = t + k * 10
        ag.type_loop(t, s - t if s > t else 1, k)
        col, row = ag.post
        ag.show_bubble('OK', s, s + 16, 2.2)
        ag.cut(s + 2, approach(col, row), math.pi)
        e = ag.walk(s + 2, [(lane(col), AISLE_Y, FLOOR), P['porte']])
        ag.appear(e + 1, False)
        last = max(last, e + 1)
    main.idle(t, last - t)
    f = mark('agents_terminent', t, last)

    c = f
    main.show_bubble('OK', c + 2, c + 28, 2.3)
    end = main.celebrate(c, 3)
    main.cut(end + 4, P['estrade_pied'], math.pi)
    end = main.walk(end + 4, [P['allee_centre'], P['porte']])
    for ag in agents:
        ag.place(end)
    f = mark('reunion_close', c, end)
    return seg


def main():
    args = rig.parse_args('claaky_swarm')
    scene = rig.new_scene('Claaky · Salle du swarm')
    build_room()
    boss = rig.Claaky('Claaky principal', POINTS['porte'], -math.pi / 2)
    boss.bubble('OK', 'OK', 'code')
    boss.prop('dossier', folder_builder)
    agents = []
    for name, fur, accent in AGENTS:
        a = rig.Claaky(name, POINTS['porte'], -math.pi / 2, fur, accent)
        a.bubble('OK', 'OK', 'code')
        a.bubble('?', '?', 'warn')
        a.prop('dossier', folder_builder)
        agents.append(a)
    cb.CONFIG['camera_scale'] = 12.5
    cb.setup_render(args.preview)
    cam = scene.camera
    cam.location = (10, -14.5, 11)
    from mathutils import Vector
    cam.rotation_euler = (Vector((0, -.4, 1.2)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    segments = animate(boss, agents)
    rig.finalize(scene, [boss, *agents], segments)
    rig.run_outputs(scene, [boss, *agents], segments, POINTS, args, 'claaky_swarm')


if __name__ == '__main__':
    main()
