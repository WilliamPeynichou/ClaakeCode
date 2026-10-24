"""CLAAKY — bureau / chambre isométrique, entièrement procédural.

Conçu pour Blender 4.2+ ; génération et rendu testés avec bpy 4.5.3. Aucun asset, police ou module externe.
UTILISATION : nouveau fichier Blender > Scripting > Open > ce fichier > Run Script.
La scène est créée dans une NOUVELLE scène ; les scènes existantes sont conservées.
F12 : rendu. Pavé numérique 0 : caméra. Espace : petite boucle de frappe.
En ligne de commande : blender --background --python claaky_bureau.py -- --render
Options après -- : --output /chemin/dossier --render --save-blend --preview
Les sorties existantes sont conservées : un suffixe numérique est ajouté.

Interprétation 3D de l'image de concept, pas une reproduction pixel pour pixel.
Les formes sont volontairement simples, éditables et organisées par collections.
"""
import argparse
import math
import os
from pathlib import Path
import random
import sys

import bpy
from mathutils import Vector

# -------------------- RÉGLAGES FACILES À MODIFIER --------------------
CONFIG = {
    'resolution': 1000,
    'samples': 48,
    'pixel_render': False,  # True : rendu natif 384 px, sans agrandissement.
    'seed': 12,
    'animation': True,
    'camera_scale': 10.8,
    'output': str(Path.home() / 'Claaky_Blender'),
}
random.seed(CONFIG['seed'])
S = None
COL = None
MAT = {}
ROOT = None


def material(name, color, roughness=.65, metal=0, emission=0):
    m = bpy.data.materials.new('Claaky_' + name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    # Ne pas rechercher les nœuds par leur nom : Blender peut traduire
    # les noms des nouveaux éléments (interface française, notamment).
    nodes = m.node_tree.nodes
    nodes.clear()
    p = nodes.new('ShaderNodeBsdfPrincipled')
    output = nodes.new('ShaderNodeOutputMaterial')
    p.location = (-260, 0)
    output.location = (60, 0)
    m.node_tree.links.new(p.outputs[0], output.inputs['Surface'])
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Metallic'].default_value = metal
    if emission:
        p.inputs['Emission Color'].default_value = (*color, 1)
        p.inputs['Emission Strength'].default_value = emission
    MAT[name] = m
    return m


def collection(name):
    global COL
    COL = bpy.data.collections.new(name)
    S.collection.children.link(COL)


def finish(obj, name, mat=None):
    obj.name = name
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    COL.objects.link(obj)
    if mat:
        obj.data.materials.append(MAT[mat] if isinstance(mat, str) else mat)
    if ROOT:
        obj.parent = ROOT
    return obj


def cube(name, loc, dims, mat, bevel=0):
    # API directe : beaucoup plus rapide que des milliers d'opérateurs UI.
    x,y,z=(d/2 for d in dims)
    vertices=[(-x,-y,-z),(-x,-y,z),(-x,y,-z),(-x,y,z),
              (x,-y,-z),(x,-y,z),(x,y,-z),(x,y,z)]
    faces=[(0,4,6,2),(1,3,7,5),(0,1,5,4),
           (2,6,7,3),(0,2,3,1),(4,5,7,6)]
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata(vertices,[],faces)
    mesh.update()
    o=bpy.data.objects.new(name,mesh)
    o.location=loc
    finish(o,name,mat)
    if bevel:
        b = o.modifiers.new('Arêtes douces', 'BEVEL')
        b.width = bevel
        b.segments = 2
        o.modifiers.new('Normales', 'WEIGHTED_NORMAL')
    return o


def sphere(name, loc, scale, mat, segments=16, rings=8):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
    o = finish(bpy.context.object, name, mat)
    o.scale = scale
    return o


def pointed_ear(name, loc, scale, mat, segments=24, rings=12):
    """Ellipsoïde dont la moitié haute se resserre en pointe (oreille en feuille)."""
    o = sphere(name, loc, (1, 1, 1), mat, segments, rings)
    for v in o.data.vertices:
        if v.co.z > 0:
            k = max(.22, 1 - .78 * v.co.z)
            v.co.x *= k
            v.co.y *= k
    o.scale = scale
    return o


def cyl(name, loc, radius, depth, mat, vertices=12):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    return finish(bpy.context.object, name, mat)


def line(name, a, b, radius, mat):
    a, b = Vector(a), Vector(b)
    o = cyl(name, (a+b)/2, radius, (b-a).length, mat, 8)
    o.rotation_euler = (b-a).to_track_quat('Z', 'Y').to_euler()
    return o


def empty(name, loc=(0, 0, 0), angle=0):
    o = bpy.data.objects.new(name, None)
    COL.objects.link(o)
    o.location = loc
    o.rotation_euler.z = angle
    return o


def area(name, loc, energy, color, size, target):
    d = bpy.data.lights.new(name, 'AREA')
    d.energy, d.color, d.shape, d.size = energy, color, 'DISK', size
    o = bpy.data.objects.new(name, d)
    COL.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector(target)-o.location).to_track_quat('-Z', 'Y').to_euler()
    return o


def plant(x, y, z, size=1, trailing=False):
    """Pot + feuilles à facettes, tous éditables individuellement."""
    cyl('Pot terre cuite', (x,y,z+.13*size), .18*size, .26*size, 'pot')
    cyl('Terre', (x,y,z+.267*size), .156*size, .015*size, 'soil')
    for i in range(9):
        a = i*2.399
        r = random.uniform(.11,.23)*size
        end = (x+math.cos(a)*r, y+math.sin(a)*r, z+random.uniform(.43,.68)*size)
        line('Tige', (x,y,z+.25*size), end, .012*size, 'leaf_dark')
        leaf = sphere('Feuille', end, (.13*size,.065*size,.20*size), random.choice(['leaf','leaf_dark','leaf_light']), 8, 4)
        leaf.rotation_euler = (.5*math.cos(a), .7*math.sin(a), a)
    if trailing:
        for strand in range(3):
            px, py = x+(strand-1)*.11*size, y-.13*size
            for j in range(8):
                qx=px+math.sin(j*.9+strand)*.07*size
                qz=z+.20*size-j*.14*size
                sphere('Lierre suspendu', (qx,py,qz), (.10*size,.05*size,.10*size), 'leaf', 8,4)
                if j:
                    line('Liane', (prev,py,qz+.14*size), (qx,py,qz), .012*size,'leaf_dark')
                prev=qx


def book(x,y,z,height=.4, width=.10, color=None):
    color = color or random.choice(['green','sage','paper','teal','ochre'])
    cube('Livre couverture', (x,y,z+height/2), (width,.24,height),color,.008)
    cube('Livre pages', (x,y-.125,z+height/2), (width*.72,.009,height*.83),'paper')
    cube('Étiquette dos', (x,y-.134,z+height*.72), (width*.6,.008,.035),'cream')


def bookcase(x,y,width=.85,height=1.65):
    cube('Bibliothèque fond',(x,y,height/2+.09),(width,.12,height),'wood_dark')
    for side in [-1,1]:
        cube('Bibliothèque montant',(x+side*(width/2-.045),y-.16,height/2+.09),(.09,.44,height),'wood')
    levels=[.12,.12+height/3,.12+2*height/3,.12+height]
    for z in levels:
        cube('Bibliothèque tablette',(x,y-.16,z),(width,.47,.07),'wood')
    for z in levels[:-1]:
        for i in range(max(2,int((width-.15)/.13))):
            book(x-width/2+.14+i*.13,y-.17,z+.04,random.uniform(.29,.43),.105)


def lantern(x,y,z,size=.26):
    cube('Lanterne socle',(x,y,z+.025),(size*1.2,size*1.2,.05),'wood_dark',.012)
    cube('Lanterne diffuseur',(x,y,z+size/2+.05),(size*.85,size*.85,size),'glow',.02)
    for dx in [-1,1]:
        for dy in [-1,1]:
            cube('Lanterne cadre',(x+dx*size*.48,y+dy*size*.48,z+size/2+.05),(.022,.022,size+.02),'wood')
    cube('Lanterne chapeau',(x,y,z+size+.07),(size*1.1,size*1.1,.04),'wood',.008)
    point_light('Lueur lanterne',(x,y,z+size/2+.05),90,(1,.58,.28),.08)


def point_light(name, loc, energy, color, radius=.1):
    d = bpy.data.lights.new(name, 'POINT')
    d.energy, d.color, d.shadow_soft_size = energy, color, radius
    o = bpy.data.objects.new(name, d)
    COL.objects.link(o)
    o.location = loc
    return o


def wall_group(name, pos, angle=0):
    global ROOT
    ROOT=empty(name,pos,angle)


def frame_picture(x,z,w=.8,h=.65):
    # Coordonnées locales : mur arrière, face dirigée vers -Y.
    cube('Cadre paysage',(x,-.10,z),(w,.07,h),'metal',.025)
    cube('Passe-partout',(x,-.142,z),(w-.075,.014,h-.075),'paper')
    cube('Ciel',(x,-.154,z),(w-.16,.012,h-.16),'sky')
    for i in range(7):
        ht=random.uniform(.12,.30)*h
        cube('Paysage pixel',(x-w*.34+i*w*.113,-.166,z-h*.32+ht/2),(w*.12,.009,ht),random.choice(['green','sage','teal']))
    sphere('Soleil',(x+w*.18,-.17,z+h*.14),(.065,.008,.065),'ochre',12,6)


def whiteboard(x,z,w=1.35,h=1.05):
    cube('Tableau cadre',(x,-.10,z),(w,.09,h),'wood',.03)
    cube('Tableau blanc',(x,-.155,z),(w-.09,.02,h-.09),'paper')
    coords=[(-.35,.27),(.12,.27),(.36,-.03),(-.23,-.20),(.20,-.30)]
    for dx,dz in coords:
        xx,zz=x+dx*w*.8,z+dz*h*.9
        cube('Schéma haut',(xx,-.18,zz+.055),(.21,.012,.015),'green')
        cube('Schéma bas',(xx,-.18,zz-.055),(.21,.012,.015),'green')
        for s in [-1,1]:
            cube('Schéma côté',(xx+s*.10,-.18,zz),(.014,.012,.11),'green')
    for a,b in [(0,1),(1,2),(0,3),(3,4)]:
        aa,bb=coords[a],coords[b]
        line('Lien schéma',(x+aa[0]*w*.8,-.18,z+aa[1]*h*.9),(x+bb[0]*w*.8,-.18,z+bb[1]*h*.9),.009,'sage')
    for i in range(3):
        cube('Post-it',(x+w*.33,-.18,z+h*.28-i*.17),(.13,.012,.13),'ochre')
    cube('Repose feutres',(x,-.22,z-h/2),(.55,.14,.04),'metal')


def architecture():
    collection('01 · Architecture et parquet')
    cube('Socle diorama',(0,0,-.22),(6.35,6.35,.42),'base',.06)
    cube('Bordure claire',(0,0,-.035),(6.23,6.23,.10),'cream',.025)
    # Lattes : géométrie réelle, aucun téléchargement de texture.
    for row in range(24):
        y=-2.875+row*.25
        offset=.50 if row%2 else 0
        cuts=sorted(set([-3,3]+[v for v in [-3+offset+i for i in range(7)] if -3<v<3]))
        for a,b in zip(cuts,cuts[1:]):
            cube('Lame parquet',((a+b)/2,y,.04),(b-a-.014,.238,.07),random.choice(['plank1','plank2','plank3']),.008)
    cube('Mur gauche',(-3.06,0,1.95),(.14,6.18,3.9),'wall')
    # Porte dans le mur du fond à droite.
    cube('Mur fond principal',(-.54,3.06,1.95),(5.05,.14,3.9),'wall')
    cube('Mur fond côté porte',(2.94,3.06,1.95),(.24,.14,3.9),'wall')
    cube('Linteau porte',(2.40,3.06,3.22),(1,.14,1.36),'wall')
    cube('Plinthe gauche',(-2.955,0,.17),(.08,6,.23),'wood_dark')
    cube('Plinthe fond',(-.55,2.955,.17),(4.9,.08,.23),'wood_dark')
    for x in [1.91,2.89]:
        cube('Chambranle porte',(x,2.94,1.32),(.10,.23,2.56),'metal',.01)
    cube('Chambranle haut',(2.4,2.94,2.60),(1.08,.23,.10),'metal')
    cube('Seuil',(2.40,3,.09),(.9,.35,.08),'paper')
    cube('Porte bois',(2.40,3.13,1.32),(.85,.10,2.40),'wood_dark',.015)
    for z in [.64,1.88]:
        cube('Panneau porte',(2.4,3.06,z),(.63,.035,.90),'wood')
    sphere('Poignée',(2.10,2.98,1.25),(.045,.055,.045),'ochre')


def wall_details():
    global ROOT
    collection('02 · Fenêtre, tableaux et étagères')
    wall_group('Décoration mur gauche',(-2.975,0,0),math.pi/2)
    # Sur ce mur, x local correspond à y monde.
    cube('Fenêtre cadre',(-.90,-.10,2.45),(1.45,.13,1.75),'wood_dark',.015)
    cube('Fenêtre lumière',(-.90,-.18,2.45),(1.30,.025,1.60),'window')
    for i in range(11):
        cube('Store lamelle',(-.90,-.235,1.76+i*.135),(1.34,.06,.07),'paper',.008)
    for x in [-1.43,-.37]:
        line('Cordon store',(x,-.28,1.72),(x,-.28,3.23),.008,'cream')
    cube('Appui fenêtre',(-.90,-.30,1.56),(1.60,.45,.09),'wood')
    whiteboard(1.1,2.17,1.50,1.15)
    frame_picture(1.12,3.20,.84,.62)
    ROOT=None
    wall_group('Décoration mur fond',(0,2.975,0))
    frame_picture(-1.48,2.99,.86,.80)
    cube('Étagère haute',(.36,-.30,3.19),(2.48,.52,.10),'wood',.015)
    for i in range(7):
        book(-.12+i*.16,-.30,3.25,random.uniform(.35,.52),.13)
    plant(1.12,-.31,3.25,.65,True)
    lantern(-.62,-.32,3.25,.23)
    ROOT=None


# Lit le long du bord avant, tête contre le mur gauche (comme sur l'illustration de référence).
BED = (-1.65, -2.15)


def bed_and_rug():
    collection('03 · Lit et tapis')
    # Tapis à carreaux au centre : du pied du lit jusque sous le fauteuil.
    cube('Tapis bordure',(.30,-.25,.095),(3.30,3.30,.025),'teal',.015)
    for i in range(11):
        for j in range(11):
            cube('Tapis carreau',(-1.20+i*.29,-1.70+j*.29,.113),(.285,.285,.012),random.choice(['rug1','rug2','rug3']))
    bx,by=BED
    # Axe du lit selon X : tête à gauche (x négatif), pied vers le centre de la pièce.
    cube('Lit cadre',(bx,by,.33),(2.65,1.68,.41),'wood_dark',.045)
    for xx in [-1.10,1.10]:
        for yy in [-.66,.66]:
            cube('Pied lit',(bx+xx,by+yy,.21),(.15,.15,.34),'wood')
    cube('Matelas',(bx,by,.61),(2.52,1.57,.28),'cream',.09)
    cube('Tête de lit',(bx-1.28,by,.73),(.12,1.72,1.10),'wood',.04)
    cube('Oreiller',(bx-.80,by,.81),(.58,1.18,.20),'paper',.09)
    for i in range(9):
        for j in range(8):
            cube('Couette patchwork',(bx+1.08-i*.18,by-.70+j*.20,.82),(.185,.205,.16),random.choice(['green','sage','teal','rug2']),.025)
    cube('Couette rabat',(bx-.53,by,.86),(.25,1.60,.15),'cream',.035)
    # Couverture retombant côté pièce (bord avant visible).
    for i in range(9):
        cube('Couette retombée',(bx+1.08-i*.18,by-.815,.62),(.18,.045,.44),'teal',.01)
    # Chevet posé au sol juste à côté de l'oreiller, contre le mur gauche.
    nx,ny=bx-.95,by+1.15
    cube('Table de chevet',(nx,ny,.40),(.50,.50,.66),'wood',.025)
    cube('Tiroir chevet',(nx+.255,ny,.52),(.035,.40,.18),'wood_dark',.01)
    cube('Poignée chevet',(nx+.28,ny,.52),(.025,.12,.03),'ochre')
    lantern(nx,ny,.73,.22)
    cube('Paillasson porte',(2.39,2.34,.10),(.91,.65,.035),'teal',.025)
    cube('Paillasson centre',(2.39,2.34,.123),(.77,.51,.012),'sage')


def desk():
    collection('04 · Bureau et informatique')
    dx,dy=.43,2.12
    cube('Plateau bureau',(dx,dy,1.32),(2.75,.92,.13),'wood',.035)
    for x in [-.78,1.64]:
        for y in [1.80,2.45]:
            cube('Pied bureau',(x,y,.69),(.09,.09,1.24),'wood_dark',.012)
    # Retour du bureau en L, le long du côté droit de la pièce (comme sur l'illustration).
    cube('Retour bureau en L',(-1.45,2.12,1.32),(.58,.92,.13),'wood',.035)
    for y in [1.80,2.45]:
        cube('Pied retour bureau',(-1.68,y,.69),(.09,.09,1.24),'wood_dark',.012)
    cube('Caisson bureau',(-.55,2.16,.65),(.59,.70,1.10),'metal',.025)
    for z in [.35,.67,.99]:
        cube('Tiroir bureau',(-.55,1.79,z),(.52,.035,.26),'base',.012)
        cube('Tiroir poignée',(-.55,1.76,z+.04),(.18,.025,.025),'ochre')
    cube('Moniteur socle',(.18,2.30,1.425),(.58,.36,.05),'metal',.02)
    cube('Moniteur pied',(.18,2.43,1.64),(.10,.09,.43),'metal',.01)
    cube('Moniteur cadre',(.18,2.44,2.09),(1.72,.12,.98),'metal',.04)
    cube('Moniteur dalle',(.18,2.372,2.09),(1.58,.015,.83),'screen',.008)
    # Lignes de code stylisées : géométrie émissive, pas de texte requis.
    for i in range(15):
        z=2.44-i*.048
        cube('Numéro de ligne',(-.53,2.357,z),(.025,.008,.012),'code_dim')
        cursor=-.44+(.08 if i%4 in [1,2] else 0)
        for j in range(random.randint(2,5)):
            length=random.uniform(.07,.21)
            if cursor+length>.87:
                break
            cube('Code à écran',(cursor+length/2,2.354,z),(length,.009,.012),random.choice(['code','code_dim','code_gold']))
            cursor+=length+.035
    cube('Tapis clavier',(.13,1.94,1.398),(1.08,.40,.018),'teal',.015)
    cube('Clavier',(.12,1.92,1.43),(.92,.29,.045),'metal',.018)
    for row in range(4):
        for key in range(13):
            cube('Touche clavier',(-.294+key*.066,1.81+row*.065,1.461),(.051,.045,.018),'sage',.004)
    cube('Tapis souris',(.91,1.90,1.40),(.40,.36,.014),'green',.015)
    sphere('Souris',(.92,1.89,1.45),(.09,.13,.05),'metal')
    cube('Tour ordinateur',(1.34,2.25,1.70),(.40,.48,.63),'metal',.025)
    for z in [1.54,1.61,1.68]:
        cube('Ventilation PC',(1.34,2.00,z),(.29,.015,.018),'base')
    sphere('Voyant PC',(1.46,1.996,1.89),(.018,.008,.018),'code')
    # Tasse et anse.
    cyl('Tasse',(.83,2.25,1.52),.10,.23,'paper')
    cyl('Café',(.83,2.25,1.638),.083,.008,'soil')
    bpy.ops.mesh.primitive_torus_add(major_radius=.065,minor_radius=.018,major_segments=12,minor_segments=6,location=(.96,2.25,1.52),rotation=(math.pi/2,0,0))
    finish(bpy.context.object,'Anse tasse','paper')
    # Lampe articulée côté gauche du bureau.
    cyl('Lampe base',(-.77,2.32,1.43),.15,.05,'metal')
    line('Lampe bras 1',(-.77,2.32,1.45),(-.85,2.32,1.98),.026,'metal')
    line('Lampe bras 2',(-.85,2.32,1.98),(-.55,2.32,2.15),.026,'metal')
    bpy.ops.mesh.primitive_cone_add(vertices=12,radius1=.14,radius2=.06,depth=.15,location=(-.53,2.32,2.10))
    finish(bpy.context.object,'Abat-jour','metal')
    cyl('Ampoule bureau',(-.53,2.32,2.018),.10,.012,'glow')
    point_light('Lueur lampe bureau',(-.53,2.32,1.95),130,(1,.60,.30),.1)


def chair_and_character():
    global ROOT
    collection('05 · Fauteuil')
    cx,cy=.15,1.28  # sous Claaky assis (POINTS bureau_assis)
    cyl('Fauteuil vérin',(cx,cy,.42),.065,.60,'metal')
    for i in range(5):
        a=i*math.tau/5
        p=(cx+.43*math.cos(a),cy+.43*math.sin(a),.17)
        line('Fauteuil branche',(cx,cy,.25),p,.035,'metal')
        sphere('Roulette',p,(.07,.07,.06),'metal',12,6)
    cube('Fauteuil assise',(cx,cy,.83),(.85,.70,.16),'teal',.07)
    back=cube('Fauteuil dossier',(cx,cy-.29,1.30),(.85,.16,.92),'metal',.06)
    back.rotation_euler.x=math.radians(-8)
    pad=cube('Fauteuil coussin dossier',(cx,cy-.185,1.32),(.71,.10,.75),'teal',.05)
    pad.rotation_euler.x=math.radians(-8)
    for side in [-1,1]:
        cube('Fauteuil accoudoir',(cx+side*.45,cy,1.09),(.11,.61,.09),'metal',.035)
        cube('Support accoudoir',(cx+side*.43,cy,.98),(.055,.08,.25),'metal')
    collection('06 · Claaky et animation de frappe')
    ROOT=empty('CLAAKY · déplacer ce parent',(cx,cy+.15,.88))
    sphere('Corps',(0,0,.34),(.36,.27,.38),'fur',32,20)
    head = sphere('Tête',(0,.015,.94),(.49,.38,.46),'fur',48,32)
    for polygon in head.data.polygons:
        polygon.use_smooth = True
    ball = sphere('Boule sur tête',(0,.015,1.43),(.14,.14,.14),'green',40,28)
    for polygon in ball.data.polygons:
        polygon.use_smooth = True
    # Oreilles en feuille : ellipsoïde doux qui se termine en pointe.
    for side in [-1,1]:
        ear = pointed_ear(
            'Oreille pointue',
            (side*.56,.015,1.38),
            (.25,.13,.44),
            'green',
            24,
            12,
        )
        ear.rotation_euler.y = math.radians(-side*22)
        for polygon in ear.data.polygons:
            polygon.use_smooth = True
        sphere('Pied',(side*.20,.17,.035),(.15,.20,.12),'fur')
        arm=line('Bras',(side*.30,.07,.57),(side*.31,.47,.48),.105,'fur')
        hand=sphere('Main clavier',(side*.30,.50,.50),(.12,.14,.10),'fur')
        if CONFIG['animation']:
            for frame,dz in [(1,0),(5,.045 if side==1 else -.015),(9,0),(13,.045 if side==-1 else -.015),(17,0)]:
                hand.location.z=.50+dz
                hand.keyframe_insert('location',frame=frame)
    # Sourire joyeux courbe, placé sur la face (+Y) et parenté au Claaky.
    mouth = bpy.data.curves.new('Bouche sourire', 'CURVE')
    mouth.dimensions = '3D'; mouth.resolution_u = 16; mouth.bevel_depth = .024; mouth.bevel_resolution = 4
    spline = mouth.splines.new('POLY'); spline.points.add(12)
    for i, point in enumerate(spline.points):
        # Petit sourire « U » du Claaky 2D : étroit, sous les yeux, entre les joues.
        x = -.075 + .15 * i / 12
        point.co = (x, .403, .80 + .05 * (x / .075) ** 2, 1)
    smile = bpy.data.objects.new('Sourire joyeux', mouth)
    COL.objects.link(smile); smile.data.materials.append(MAT['eye']); smile.parent = ROOT
    # Joues plus larges et chaudes.
    for side in [-1, 1]:
        cheek = sphere('Joue rosée',(side*.33,.318,.83),(.09,.022,.055),'pink',24,16)
        for p in cheek.data.polygons: p.use_smooth = True
    # Motif ventral constitué d'une spirale géométrique verte.
    points=[]
    for i in range(26):
        a=.2+i*.16
        r=.19*(1-i/40)
        points.append((math.cos(a)*r,.272,.31+math.sin(a)*r))
    for a,b in zip(points,points[1:]):
        line('Spirale ventre',a,b,.045,'green')
    char_root = ROOT
    char_root.rotation_euler.z = math.atan2(-10, -13)
    ROOT = None
    if CONFIG['animation']:
        for o in COL.objects:
            if o.animation_data and o.animation_data.action:
                # Blender 4.2–4.5 legacy access ; garde compatible si l'API évolue.
                try:
                    for fc in o.animation_data.action.fcurves:
                        fc.modifiers.new('CYCLES')
                except AttributeError:
                    pass


def accessories():
    global ROOT
    collection('07 · Bibliothèques, végétation et accessoires')
    # Bibliothèque contre le mur gauche, sous la fenêtre, derrière le chevet (coordonnées locales : x = y monde).
    ROOT = empty('Bibliothèque mur gauche', (-2.70, -.10, 0), math.pi / 2)
    bookcase(0, 0, 1.00, 1.35)
    plant(-.22, -.12, 1.50, .80)
    plant(.25, -.12, 1.50, .55)
    ROOT = None
    # Commode noire à tiroirs sous le tableau blanc, avec lampe articulée et lanterne.
    kx, ky = -2.68, 1.00
    cube('Commode noire', (kx, ky, .58), (.58, 1.00, 1.02), 'metal', .025)
    cube('Plateau commode', (kx, ky, 1.12), (.64, 1.06, .07), 'wood', .015)
    for z in [.30, .62, .92]:
        cube('Tiroir commode', (kx+.295, ky, z), (.02, .86, .24), 'base', .008)
        cube('Poignée commode', (kx+.315, ky, z+.04), (.02, .22, .03), 'ochre')
    lantern(kx+.05, ky-.33, 1.155, .22)
    cyl('Lampe commode base', (kx+.02, ky+.30, 1.18), .12, .04, 'metal')
    line('Lampe commode bras 1', (kx+.02, ky+.30, 1.20), (kx-.05, ky+.30, 1.62), .022, 'metal')
    line('Lampe commode bras 2', (kx-.05, ky+.30, 1.62), (kx+.20, ky+.18, 1.74), .022, 'metal')
    bpy.ops.mesh.primitive_cone_add(vertices=12, radius1=.11, radius2=.05, depth=.12, location=(kx+.24, ky+.16, 1.69))
    finish(bpy.context.object, 'Abat-jour commode', 'metal')
    point_light('Lueur lampe commode', (kx+.26, ky+.15, 1.60), 45, (1, .62, .32), .08)
    # Coin du fond : plantes tombantes sur deux étagères murales.
    plant(-2.75,2.70,2.65,1.0,True)
    cube('Étagère plante angle',(-2.75,2.70,2.60),(.61,.63,.09),'wood')
    cube('Étagère angle basse',(-2.15,2.65,2.56),(.52,.50,.08),'wood',.012)
    plant(-2.15,2.56,2.60,.65,True)
    # Sac à dos au sol, entre la commode et le bureau.
    cube('Sac à dos',(-2.55,1.95,.45),(.35,.43,.73),'sage',.10)
    cube('Poche sac',(-2.34,1.95,.40),(.07,.25,.30),'green',.025)
    line('Anse sac',(-2.55,1.85,.83),(-2.55,2.05,.83),.025,'wood_dark')
    # Meuble bas au pied du lit (bord avant) : livres, plante et lanterne, comme sur l'illustration.
    fx, fy = .25, -2.62
    cube('Meuble pied de lit fond', (fx, fy+.20, .38), (1.10, .08, .60), 'wood_dark')
    for z in [.11, .66]:
        cube('Meuble pied de lit plateau', (fx, fy, z), (1.10, .48, .06), 'wood', .012)
    for side in [-1, 1]:
        cube('Meuble pied de lit montant', (fx+side*.52, fy, .38), (.06, .48, .60), 'wood', .01)
    for i in range(6):
        book(fx-.36+i*.14, fy+.06, .14, random.uniform(.26,.36), .11)
    plant(fx+.25, fy, .69, .55)
    lantern(fx-.25, fy, .69, .20)
    plant(1.15, -2.70, .075, .70)
    cube('Tablette au sol', (1.55, -2.55, .085), (.45, .32, .02), 'metal', .008)
    cube('Tablette écran', (1.55, -2.55, .097), (.39, .26, .006), 'sky')
    test_machine()


def test_machine(x=-1.40, y=2.15):
    """Machine de test à gauche du bureau. Éteinte dans le décor ; l'IDE la fait s'allumer (halo).
    Le centre de l'écran (« Machine test écran ») sert de repère au clip."""
    collection('07b · Machine de test')
    cube('Machine test corps', (x, y, 1.68), (.46, .42, .60), 'metal', .03)
    cube('Machine test cadre', (x, y-.215, 1.68), (.39, .025, .51), 'wood_dark', .015)
    cube('Machine test écran', (x, y-.235, 1.78), (.30, .012, .20), 'screen', .006)
    cube('Machine test voyant', (x, y-.242, 1.55), (.09, .012, .035), 'screen', .004)
    for i in range(3):
        cube('Machine test grille', (x, y-.235, 1.44+i*.025), (.30, .012, .009), 'base')
    # Libellé géométrique : marque de tube / éprouvette, distincte du PC à droite.
    line('Machine test tube', (x-.045,y-.248,1.73), (x-.045,y-.248,1.83), .008, 'sage')
    line('Machine test tube', (x+.045,y-.248,1.73), (x+.045,y-.248,1.83), .008, 'sage')
    line('Machine test tube', (x-.045,y-.248,1.73), (x+.045,y-.248,1.73), .008, 'sage')


def setup_render(preview=False):
    collection('08 · Caméra et éclairage')
    S.render.engine='CYCLES'
    S.cycles.samples=16 if preview else CONFIG['samples']
    S.cycles.use_denoising=True
    S.cycles.device='CPU'  # Fonctionne aussi sans GPU dédié.
    S.render.resolution_x=S.render.resolution_y=(384 if CONFIG['pixel_render'] else (640 if preview else CONFIG['resolution']))
    S.render.resolution_percentage=100
    S.render.image_settings.file_format='PNG'
    S.render.image_settings.color_mode='RGBA'
    S.render.film_transparent=False
    S.render.threads_mode='FIXED'; S.render.threads=min(8,os.cpu_count() or 4)
    S.world=bpy.data.worlds.new('Claaky atmosphère')
    S.world.use_nodes=True
    nodes=S.world.node_tree.nodes
    nodes.clear()
    bg=nodes.new('ShaderNodeBackground')
    output=nodes.new('ShaderNodeOutputWorld')
    S.world.node_tree.links.new(bg.outputs[0],output.inputs['Surface'])
    bg.inputs['Color'].default_value=(.16,.14,.12,1)
    bg.inputs['Strength'].default_value=.30
    cube('Fond teal',(0,0,-.49),(200,200,.08),'background')
    # Ambiance cosy : lumière principale ambrée, fenêtre de fin de journée discrète, lampes chaudes (point_light).
    area('Grande lumière chaude',(0,-3,8),500,(1,.66,.36),5,(0,0,0))
    area('Remplissage fenêtre',(-4,-1,5),180,(.90,.80,.80),4,(0,1,1))
    area('Lumière arrière',(1,4,7),420,(1,.62,.36),3,(0,0,1))
    area('Éclairage écran',(.2,2.13,2.2),14,(.43,1,.73),1,(.15,1.1,1.5))
    point_light('Fenêtre soleil doré',(-2.55,-.90,2.4),100,(1,.68,.30),.5)
    camera_data=bpy.data.cameras.new('Caméra isométrique')
    camera=bpy.data.objects.new('Caméra isométrique',camera_data)
    COL.objects.link(camera)
    camera.location=(10,-13,11)
    target=Vector((0,0,1.35))
    camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler()
    camera_data.type='ORTHO'; camera_data.ortho_scale=CONFIG['camera_scale']
    camera_data.lens=50
    S.camera=camera
    S.view_settings.view_transform='AgX'
    S.render.fps=12; S.frame_start=1; S.frame_end=48; S.frame_set(1)
    # Ouvrir directement sur la caméra dans l'interface Blender.
    for screen in bpy.data.screens:
        for a in screen.areas:
            if a.type=='VIEW_3D':
                a.spaces.active.region_3d.view_perspective='CAMERA'
                a.spaces.active.shading.type='MATERIAL'


def palette():
    colors={
        'wall':(.79,.77,.65),'cream':(.89,.86,.72),'paper':(.96,.93,.80),
        'wood':(.36,.17,.065),'wood_dark':(.15,.065,.028),
        'plank1':(.33,.14,.055),'plank2':(.42,.20,.085),'plank3':(.47,.23,.10),
        'base':(.025,.075,.077),'metal':(.035,.055,.051),
        'green':(.025,.27,.105),'sage':(.25,.43,.20),'teal':(.025,.26,.22),
        'leaf':(.12,.32,.035),'leaf_dark':(.035,.17,.025),'leaf_light':(.30,.44,.045),
        'pot':(.34,.39,.36),'soil':(.045,.025,.012),'ochre':(.81,.54,.12),
        'rug1':(.15,.30,.18),'rug2':(.25,.39,.18),'rug3':(.34,.43,.21),
        'fur':(.72,.86,.43),'eye':(.006,.020,.010),'pink':(.90,.34,.31),
        'screen':(.006,.025,.022),'code':(.13,.85,.40),'code_dim':(.07,.32,.22),
        'code_gold':(.70,.72,.24),'sky':(.19,.38,.42),'background':(.012,.19,.20),
        'glow':(1,.57,.16),'window':(1,.82,.48),
    }
    for name,color in colors.items():
        material(name,color,emission=(5 if name=='glow' else 1.1 if name in ['code','code_gold','window'] else 0))


def unique_path(folder, stem, suffix):
    p=folder/(stem+suffix)
    i=2
    while p.exists():
        p=folder/(stem+'_'+str(i)+suffix); i+=1
    return p


def main():
    global S
    tail=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--render',action='store_true')
    parser.add_argument('--save-blend',action='store_true')
    parser.add_argument('--preview',action='store_true')
    parser.add_argument('--output',default=CONFIG['output'])
    args=parser.parse_args(tail)
    S=bpy.data.scenes.new('Claaky · Bureau et chambre')
    if bpy.context.window:
        bpy.context.window.scene=S
    else:
        raise RuntimeError('Exécuter depuis Blender ou son module bpy avec une fenêtre de contexte disponible.')
    palette()
    architecture(); wall_details(); bed_and_rug(); desk(); chair_and_character(); accessories()
    setup_render(args.preview)
    bpy.ops.object.select_all(action='DESELECT')
    out=Path(args.output).expanduser()
    out.mkdir(parents=True,exist_ok=True)
    S.render.filepath=str(unique_path(out,'claaky_bureau','.png'))
    # Une copie du script accompagne la scène enregistrée dans un bloc texte.
    script=globals().get('__file__')
    if script and Path(script).is_file():
        text=bpy.data.texts.new('LISEZ_MOI · claaky_bureau.py')
        text.write(Path(script).read_text(encoding='utf-8'))
    if args.save_blend:
        filepath=unique_path(out,'claaky_bureau','.blend')
        bpy.ops.wm.save_as_mainfile(filepath=str(filepath))
        print('BLEND :',filepath)
    if args.render:
        bpy.ops.render.render(write_still=True,scene=S.name)
        print('RENDU :',S.render.filepath)
    print('CLAAKY PRÊT :',len(S.objects),'objets. F12 = rendu ; Espace = animation.')


if __name__=='__main__':
    main()
