"""Flat top-side renders of each released Airfrog model's PCB.

Usage: python3 ci/render-boards.py PCB
  PCB  an airfrog-pcb checkout, with each model's board at
       pcb/KEY/airfrog-KEY.kicad_pcb, where KEY is the model's key in
       schema.toml

Writes ui/images/airfrog-KEY-top.webp, where KEY is the model's key in
schema.toml, scaled to PX_PER_MM, ui/images/renders.js, which imports each,
and ui/images/boards.json: each render's size and the box [x, y, width, height]
around J1's and J2's pins, in pixels. The render includes what overhangs the
board, for example the module's antenna. The board files are rendered from
temporary copies and left unchanged. Requires numpy, Pillow and KiCad's
kicad-cli on PATH or in KiCad.app.
"""
import json
import math
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

from schema import load

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'ui' / 'images'
PX_PER_MM = 17
RENDER_PX = 2000
# kicad-cli frames the board outline. Zooming out brings what overhangs it
# into the render.
ZOOM = 0.6
# J1's and J2's pin pitch
PITCH_MM = 2.54
MAC_KICAD_CLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'


def edges(text):
    """The board outline's left, top, right and bottom in mm."""
    xs, ys = [], []
    for item in re.finditer(r'\(gr_(?:line|arc|rect)\b(.*?)\(layer "Edge\.Cuts"\)', text, re.S):
        for x, y in re.findall(r'\((?:start|mid|end) (-?[\d.]+) (-?[\d.]+)', item.group(1)):
            xs.append(float(x))
            ys.append(float(y))
    return min(xs), min(ys), max(xs), max(ys)


def block(text, start):
    """The s-expression starting at start."""
    depth = 0
    for end in range(start, len(text)):
        depth += {'(': 1, ')': -1}.get(text[end], 0)
        if depth == 0:
            return text[start:end + 1]
    raise ValueError('unterminated s-expression at %d' % start)


def footprint(text, ref):
    return block(text, text.rfind('(footprint ', 0, text.index('(property "Reference" "%s"' % ref)))


def without_footprints(text):
    """text with every footprint removed, leaving the bare board."""
    while (start := text.find('(footprint ')) >= 0:
        text = text[:start] + text[start + len(block(text, start)):]
    return text


def pads(text, ref):
    """ref's pad centres in mm."""
    fp = footprint(text, ref)
    x, y, rot = re.search(r'\(at (-?[\d.]+) (-?[\d.]+)(?: (-?[\d.]+))?\)', fp).groups()
    x, y, a = float(x), float(y), math.radians(float(rot or 0))
    return [(x + px * math.cos(a) + py * math.sin(a), y - px * math.sin(a) + py * math.cos(a))
            for px, py in ((float(p), float(q))
                           for p, q in re.findall(r'\(pad "\d+" \S+ \S+\s*\(at (-?[\d.]+) (-?[\d.]+)', fp))]


def render(cli, pcb, out):
    subprocess.run([cli, 'pcb', 'render', '--side', 'top', '--quality', 'high',
                    '--background', 'transparent', '--width', str(RENDER_PX),
                    '--height', str(RENDER_PX), '--zoom', str(ZOOM), '-o', str(out), str(pcb)],
                   check=True, capture_output=True)
    img = np.asarray(Image.open(out).convert('RGBA')).astype(float) / 255
    # KiCad shades the background around the board with a partly transparent
    # shadow. Only the board itself is opaque.
    img[img[..., 3] < 0.98] = 0
    img[..., 3] = np.ceil(img[..., 3])
    return img


def opaque(img):
    """The left, top, right and bottom of img's opaque part in pixels."""
    return Image.fromarray((img[..., 3] * 255).astype(np.uint8)).getbbox()


def main(pcb_dir):
    cli = shutil.which('kicad-cli') or MAC_KICAD_CLI
    s = load()
    boards = {}
    constants = {}
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        for model in s.released():
            key = model['key']
            src = pcb_dir / 'pcb' / key / ('airfrog-%s.kicad_pcb' % key)
            text = src.read_text().replace('${KIPRJMOD}', str(src.parent))
            pcb = tmp / src.name
            pcb.write_text(text)
            img = render(cli, pcb, tmp / 'render.png')
            box = opaque(img)
            if box[0] == 0 or box[1] == 0 or box[2] == RENDER_PX or box[3] == RENDER_PX:
                sys.exit('%s is cut off at the render\'s edge: lower ZOOM' % src)
            # The bare board's render locates the board outline in the full
            # render, as kicad-cli frames both the same.
            pcb.write_text(without_footprints(text))
            board = opaque(render(cli, pcb, tmp / 'board.png'))
            left, top, right, _ = edges(text)
            px_per_mm = (board[2] - board[0]) / (right - left)
            scale = PX_PER_MM / px_per_mm
            crop = img[box[1]:box[3], box[0]:box[2]]
            size = (round(crop.shape[1] * scale), round(crop.shape[0] * scale))
            Image.fromarray((crop * 255).astype(np.uint8), 'RGBA').resize(size, Image.LANCZOS) \
                .save(OUT / ('airfrog-%s-top.webp' % key), 'WEBP', quality=70)
            x0 = (board[0] - box[0]) * scale - left * PX_PER_MM
            y0 = (board[1] - box[1]) * scale - top * PX_PER_MM
            entry = {'width': size[0], 'height': size[1]}
            for ref in ('J1', 'J2'):
                xs, ys = zip(*pads(text, ref))
                half = PITCH_MM / 2
                x1, y1 = (max(0, round(x0 + (min(xs) - half) * PX_PER_MM)),
                          max(0, round(y0 + (min(ys) - half) * PX_PER_MM)))
                x2, y2 = (min(size[0], round(x0 + (max(xs) + half) * PX_PER_MM)),
                          min(size[1], round(y0 + (max(ys) + half) * PX_PER_MM)))
                entry[ref] = [x1, y1, x2 - x1, y2 - y1]
            boards[key] = entry
            constants[key] = model['constant']
    (OUT / 'boards.json').write_text(json.dumps(boards, indent=2) + '\n')
    (OUT / 'renders.js').write_text(
        "// Generated by ci/render-boards.py. Don't edit.\n\n"
        + ''.join("import %s from './airfrog-%s-top.webp';\n" % (constants[k], k) for k in boards)
        + "\n/** Each released model's board render, by its key. */\n"
        + 'export const RENDERS = { %s };\n' % ', '.join("'%s': %s" % (k, constants[k]) for k in boards))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(pathlib.Path(sys.argv[1]))
