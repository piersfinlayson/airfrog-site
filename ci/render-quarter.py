"""Render of Airfrog Mini standing beside a US quarter, at true scale.

Usage: python3 ci/render-quarter.py PCB PHOTO OUT
  PCB    an airfrog-pcb checkout, with the board at pcb/mini/airfrog-mini.kicad_pcb
  PHOTO  a 768 x 768 image of the quarter's obverse, with the coin 762 pixels
         across and centred, upright
  OUT    the PNG to write, 1000 x 836 with a transparent background

kicad-cli renders the board with a 3D model of the coin added, once in silver
and once with the coin face flat-coloured and marked with coloured discs. The
discs' positions in the second render locate the face in the picture, and PHOTO
is mapped onto the face in the first. The board file is rendered from a
temporary copy and left unchanged. Requires numpy, Pillow and KiCad's
kicad-cli on PATH or in KiCad.app.
"""
import math
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

MAC_KICAD_CLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
RENDER_ARGS = ['--perspective', '--background', 'transparent', '--rotate', ' -50,0,25',
               '--zoom', '0.45', '--width', '2400', '--height', '2000']

# US quarter, in mm
RADIUS = 12.13
THICKNESS = 1.75
PHOTO_PX = 768
PHOTO_MM_PER_PX = 24.26 / 762
# Where the coin stands: its centre in the board file's coordinates in mm, and
# the height of its centre above the board's surface. The face is turned
# towards the board's long edge.
COIN_X = 118.9
COIN_Y = 113.0
COIN_Z = 2.0
# The coin's edge is reeded
REEDS = 119
REED_DEPTH = 0.15
SILVER = '0.5 0.51 0.54'

# Discs on the coin face, as (x mm, y mm, VRML colour, colour in the render)
# from the face's centre. The face is flat-coloured MARK_FACE.
MARK_FACE = ('1 0 1', (254, 0, 254))
MARKS = [
    (0, 0, '0 1 1', (1, 254, 254)),
    (8, 0, '1 0 0', (254, 9, 11)),
    (0, 8, '0 0 1', (0, 0, 254)),
    (6, 6, '1 0.5 0', (254, 163, 2)),
    (-6, 6, '0.5 0 1', (163, 0, 254)),
]
MARK_RADIUS = 1.6
# Pixels within this of a colour in the render are that colour
CENTROID_TOL = 14
FACE_TOL = 26
# Pixels past this fraction of the radius are the coin's edge
FACE_MARGIN = 0.985

# The output's size, and the margin around the picture as a fraction of it
OUT_SIZE = (1000, 836)
MARGIN = 0.05
# Edge pixels darker than this, summed over R, G and B, are the render's dark
# fringe and are made transparent
FRINGE = 60


def wrl_shape(verts, faces, colour, flat=False):
    emissive = ' emissiveColor %s' % colour if flat else ''
    return ('Shape { appearance Appearance { material Material { diffuseColor %s '
            'specularColor 0.5 0.5 0.55 ambientIntensity 0.3 shininess 0.25%s } }\n'
            'geometry IndexedFaceSet { solid FALSE creaseAngle 0.2 coord Coordinate { point [%s] } '
            'coordIndex [%s] } }'
            % (colour, emissive,
               ','.join('%.5f %.5f %.5f' % v for v in verts),
               ','.join(' '.join(map(str, f)) + ' -1' for f in faces)))


def coin(flat):
    """VRML of the coin, standing with its face towards -x. flat gives the
    face a single colour with the marks on it. VRML units are 0.1 inch."""
    scale = 1 / 2.54
    n = 2 * REEDS

    def point(p, q, t):
        """A point p to the right of and q above the face's centre, and t
        out from the face"""
        return (-t * scale, -p * scale, q * scale)

    def ring(t):
        out = []
        for i in range(n):
            r = RADIUS if i % 2 == 0 else RADIUS - REED_DEPTH
            a = 2 * math.pi * i / n
            out.append(point(r * math.cos(a), r * math.sin(a), t))
        return out

    parts = ['#VRML V2.0 utf8']
    verts = ring(-THICKNESS) + ring(0) + [point(0, 0, -THICKNESS)]
    faces = [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
    faces += [[(i + 1) % n, i, 2 * n] for i in range(n)]
    parts.append(wrl_shape(verts, faces, SILVER))
    verts = ring(0) + [point(0, 0, 0)]
    faces = [[i, (i + 1) % n, n] for i in range(n)]
    if flat:
        parts.append(wrl_shape(verts, faces, MARK_FACE[0], True))
        sides = 24
        for x, y, colour, _ in MARKS:
            disc = [point(x + MARK_RADIUS * math.cos(2 * math.pi * k / sides),
                          y + MARK_RADIUS * math.sin(2 * math.pi * k / sides), 0.03)
                    for k in range(sides)] + [point(x, y, 0.03)]
            tris = [[k, (k + 1) % sides, sides] for k in range(sides)]
            parts.append(wrl_shape(disc, tris, colour, True))
    else:
        parts.append(wrl_shape(verts, faces, SILVER))
    return '\n'.join(parts)


def scene(board_text, model):
    footprint = ('\t(footprint "COIN"\n\t\t(layer "F.Cu")\n\t\t(at %g %g)\n'
                 '\t\t(model "%s"\n\t\t\t(offset (xyz 0 0 %g))\n\t\t\t(scale (xyz 1 1 1))\n'
                 '\t\t\t(rotate (xyz 0 0 0))\n\t\t)\n\t)\n' % (COIN_X, COIN_Y, model, COIN_Z))
    end = board_text.rstrip().rindex(')')
    return board_text[:end] + footprint + board_text[end:]


def render(cli, pcb, out, silver):
    quality = ['--quality', 'high', '--floor'] if silver else ['--quality', 'basic']
    # A fresh configuration directory keeps the render's settings at their
    # defaults whatever the user has set in KiCad
    with tempfile.TemporaryDirectory() as config:
        subprocess.run([cli, 'pcb', 'render'] + quality + RENDER_ARGS + ['-o', str(out), str(pcb)],
                       check=True, capture_output=True, env=dict(os.environ, KICAD_CONFIG_HOME=config))
    return np.asarray(Image.open(out).convert('RGBA')).astype(np.float64)


def near(img, colour, tol):
    return (img[..., 3] >= 250) & (np.abs(img[..., :3] - np.array(colour)) < tol).all(axis=-1)


def homography(src, dst):
    """The 3 x 3 matrix mapping each src point to its dst point, by least
    squares"""
    rows, rhs = [], []
    for (x, y), (u, v) in zip(src, dst):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        rhs += [u, v]
    h = np.linalg.lstsq(np.array(rows, float), np.array(rhs, float), rcond=None)[0]
    return np.append(h, 1).reshape(3, 3)


def apply(h, x, y):
    d = h[2, 0] * x + h[2, 1] * y + h[2, 2]
    return (h[0, 0] * x + h[0, 1] * y + h[0, 2]) / d, (h[1, 0] * x + h[1, 1] * y + h[1, 2]) / d


def sample(photo, tx, ty):
    """photo, bilinearly sampled at tx, ty pixels"""
    x0, y0 = np.floor(tx).astype(int), np.floor(ty).astype(int)
    fx, fy = (tx - x0)[..., None], (ty - y0)[..., None]
    return ((photo[y0, x0] * (1 - fx) + photo[y0, x0 + 1] * fx) * (1 - fy)
            + (photo[y0 + 1, x0] * (1 - fx) + photo[y0 + 1, x0 + 1] * fx) * fy)


def paint_face(silver, marked, photo):
    """silver with the coin's face replaced by photo, in the pixels where
    marked shows the face"""
    height, width = marked.shape[:2]
    src, dst = [], []
    for x, y, _, colour in MARKS:
        ys, xs = np.nonzero(near(marked, colour, CENTROID_TOL))
        if len(xs) < 50:
            sys.exit('Mark at %g, %g is not visible in the render' % (x, y))
        src.append((x, y))
        dst.append((xs.mean(), ys.mean()))
    to_image = homography(src, dst)
    to_face = np.linalg.inv(to_image)
    face = near(marked, MARK_FACE[1], FACE_TOL)
    for _, _, _, colour in MARKS:
        face |= near(marked, colour, FACE_TOL)
    ys, xs = np.mgrid[0:height, 0:width]
    u, v = apply(to_face, xs.astype(float), ys.astype(float))
    tx = PHOTO_PX / 2 + u / PHOTO_MM_PER_PX
    ty = PHOTO_PX / 2 - v / PHOTO_MM_PER_PX
    inside = (u * u + v * v <= (RADIUS * FACE_MARGIN) ** 2) & (tx >= 1) & (ty >= 1) \
        & (tx <= PHOTO_PX - 2) & (ty <= PHOTO_PX - 2)
    painted = face & inside
    # The marks' colours blend at the face's edge, so grow the painted area
    # into the pixels beside it
    for _ in range(3):
        padded = np.pad(painted, 1)
        count = sum(padded[1 + dy:height + 1 + dy, 1 + dx:width + 1 + dx].astype(int)
                    for dy in (-1, 0, 1) for dx in (-1, 0, 1))
        grown = ~painted & (count >= 5) & (marked[..., 3] > 0) & inside
        painted |= grown
    out = silver.copy()
    out[painted, :3] = sample(photo, tx[painted], ty[painted])
    out[painted, 3] = 255
    return out


def main(pcb_dir, photo_path, out_path):
    cli = shutil.which('kicad-cli') or MAC_KICAD_CLI
    photo = np.asarray(Image.open(photo_path).convert('RGB')).astype(np.float64)
    if photo.shape[:2] != (PHOTO_PX, PHOTO_PX):
        sys.exit('%s is not %d x %d' % (photo_path, PHOTO_PX, PHOTO_PX))
    src = pcb_dir / 'pcb' / 'mini' / 'airfrog-mini.kicad_pcb'
    text = src.read_text().replace('${KIPRJMOD}', str(src.parent))
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        renders = {}
        for name, silver in (('silver', True), ('marked', False)):
            (tmp / (name + '.wrl')).write_text(coin(not silver))
            pcb = tmp / (name + '.kicad_pcb')
            pcb.write_text(scene(text, tmp / (name + '.wrl')))
            renders[name] = render(cli, pcb, tmp / (name + '.png'), silver)
    out = paint_face(renders['silver'], renders['marked'], photo)
    # Edge pixels that are partly transparent and dark are the render's fringe
    fringe = (out[..., 3] < 250) & (out[..., :3].sum(axis=-1) <= FRINGE)
    out[fringe, 3] = 0
    img = Image.fromarray(out.round().astype(np.uint8), 'RGBA')
    left, top, right, bottom = img.getchannel('A').getbbox()
    scale = max((right - left) / (OUT_SIZE[0] * (1 - 2 * MARGIN)),
                (bottom - top) / (OUT_SIZE[1] * (1 - 2 * MARGIN)))
    width, height = OUT_SIZE[0] * scale, OUT_SIZE[1] * scale
    x, y = (left + right - width) / 2, (top + bottom - height) / 2
    img.transform(OUT_SIZE, Image.EXTENT, (x, y, x + width, y + height), Image.BICUBIC).save(out_path)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
