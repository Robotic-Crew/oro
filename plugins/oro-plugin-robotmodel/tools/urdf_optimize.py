#!/usr/bin/env python3
#
# Copyright 2026 Robotic Crew
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
#    Unless required by applicable law or agreed to in writing, software
#    distributed under the License is distributed on an "AS IS" BASIS,
#    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#    See the License for the specific language governing permissions and
#    limitations under the License.
"""Prepare a ROS URDF for ORO's 3D Model widget: small, self-contained, browser-friendly.

    urdf_optimize.py robot.urdf --out public/robot-models/ur5e \
                     [--package ur_description=/path/to/ur_description ...] \
                     [--simplify 0.3] [--keep-collision]

ROS description packages ship meshes as STL/Collada, often tens of MB of CAD detail, plus
collision meshes a viewer never draws. This writes to --out:

  <robot>.urdf     the same kinematics (links, joints, limits, origins, materials), without
                   <collision> elements, with every visual mesh pointing at meshes/*.glb
  meshes/*.glb     one GLB per source mesh. If `gltfpack` (meshoptimizer) is on the PATH, it is
                   also simplified to --simplify of its triangles and meshopt-compressed: usually
                   10-20x smaller than the STL/DAE. The widget decodes meshopt natively.

`package://pkg/...` mesh URIs resolve through --package pkg=DIR (repeatable) or ROS_PACKAGE_PATH;
relative ones against the URDF's folder. Xacro must be expanded first (`xacro robot.urdf.xacro`).
Serve --out from the app's public/ folder (or any origin) and point a `RobotModel` at the URDF.
See the oro-plugin-robotmodel README.

Requires trimesh (and pycollada for .dae): `pip install trimesh pycollada`.
`gltfpack` is optional: https://github.com/zeux/meshoptimizer/releases
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

import trimesh


def parse_packages(pairs):
    packages = {}
    for pair in pairs:
        name, sep, directory = pair.partition('=')
        if not sep:
            sys.exit(f'--package expects NAME=DIR, got {pair!r}')
        packages[name] = directory
    for root in os.environ.get('ROS_PACKAGE_PATH', '').split(os.pathsep):
        if root and os.path.isdir(root):
            for name in os.listdir(root):
                packages.setdefault(name, os.path.join(root, name))
    return packages


def resolve_mesh(uri, urdf_dir, packages):
    if uri.startswith('package://'):
        package, _, rel = uri[len('package://'):].partition('/')
        if package not in packages:
            sys.exit(f'Unknown package {package!r} in {uri}: pass --package {package}=DIR')
        return os.path.join(packages[package], rel)
    if uri.startswith('file://'):
        return uri[len('file://'):]
    return os.path.join(urdf_dir, uri)


def mesh_name(path, taken):
    base = os.path.splitext(os.path.basename(path))[0]
    name, n = base, 1
    while name in taken:
        n += 1
        name = f'{base}_{n}'
    taken.add(name)
    return name


def convert_mesh(src, dst, simplify, gltfpack):
    # force='scene' keeps Collada materials/colors and sub-meshes
    scene = trimesh.load(src, force='scene')
    if gltfpack is None:
        scene.export(dst)
        return
    with tempfile.TemporaryDirectory() as tmp:
        raw = os.path.join(tmp, 'raw.glb')
        scene.export(raw)
        # -cc: meshopt compression (better ratio); -si: simplification ratio; -kn: keep node names
        cmd = [gltfpack, '-i', raw, '-o', dst, '-cc', '-kn']
        if simplify < 1:
            cmd += ['-si', str(simplify)]
        subprocess.run(cmd, check=True, capture_output=True)


def human(size):
    for unit in ('B', 'KB', 'MB'):
        if size < 1024:
            return f'{size:.0f} {unit}'
        size /= 1024
    return f'{size:.1f} GB'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('urdf')
    parser.add_argument('--out', required=True, help='output folder')
    parser.add_argument('--package', action='append', default=[], metavar='NAME=DIR')
    parser.add_argument('--simplify', type=float, default=0.3,
                        help='fraction of triangles to keep, with gltfpack (default 0.3; 1 = none)')
    parser.add_argument('--keep-collision', action='store_true')
    args = parser.parse_args()
    if not 0 < args.simplify <= 1:
        sys.exit('--simplify must be in (0, 1]')

    packages = parse_packages(args.package)
    urdf_dir = os.path.dirname(os.path.abspath(args.urdf))
    tree = ET.parse(args.urdf)
    robot = tree.getroot()
    gltfpack = shutil.which('gltfpack')
    if gltfpack is None:
        print('gltfpack not found: meshes are converted to GLB but not simplified nor compressed',
              file=sys.stderr)

    if not args.keep_collision:
        for link in robot.iter('link'):
            for collision in link.findall('collision'):
                link.remove(collision)

    meshes_dir = os.path.join(args.out, 'meshes')
    os.makedirs(meshes_dir, exist_ok=True)
    converted = {}  # source path -> relative output path
    taken = set()
    size_in = size_out = 0
    for mesh in robot.iter('mesh'):
        src = os.path.normpath(resolve_mesh(mesh.get('filename', ''), urdf_dir, packages))
        if src not in converted:
            if not os.path.isfile(src):
                sys.exit(f'Mesh not found: {src}')
            rel = f'meshes/{mesh_name(src, taken)}.glb'
            dst = os.path.join(args.out, rel)
            convert_mesh(src, dst, args.simplify, gltfpack)
            size_in += os.path.getsize(src)
            size_out += os.path.getsize(dst)
            print(f'{os.path.basename(src)} -> {rel} ({human(os.path.getsize(dst))})', file=sys.stderr)
            converted[src] = rel
        mesh.set('filename', converted[src])

    out_urdf = os.path.join(args.out, os.path.basename(args.urdf))
    tree.write(out_urdf, encoding='utf-8', xml_declaration=True)
    print(f'{len(converted)} meshes: {human(size_in)} -> {human(size_out)}', file=sys.stderr)
    print(out_urdf)


if __name__ == '__main__':
    main()
