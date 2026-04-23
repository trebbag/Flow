#!/usr/bin/env python3

import os
import stat
import sys
import zipfile


def usage() -> int:
    print("usage: create-clean-zip.py <source_dir> <output_zip>", file=sys.stderr)
    return 2


def main() -> int:
    if len(sys.argv) != 3:
        return usage()

    source_dir = os.path.abspath(sys.argv[1])
    output_zip = os.path.abspath(sys.argv[2])

    if not os.path.isdir(source_dir):
        print(f"source directory does not exist: {source_dir}", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(output_zip), exist_ok=True)
    if os.path.exists(output_zip):
        os.remove(output_zip)

    with zipfile.ZipFile(output_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for root, dirs, files in os.walk(source_dir):
            dirs.sort()
            files.sort()

            rel_root = os.path.relpath(root, source_dir)
            if rel_root == ".":
                rel_root = ""

            if rel_root and not dirs and not files:
                info = zipfile.ZipInfo(f"{rel_root}/")
                info.compress_type = zipfile.ZIP_STORED
                info.external_attr = (0o755 << 16) | stat.S_IFDIR
                archive.writestr(info, b"")

            for filename in files:
                abs_path = os.path.join(root, filename)
                rel_path = os.path.join(rel_root, filename) if rel_root else filename
                source_path = abs_path
                if os.path.islink(abs_path):
                    resolved_path = os.path.realpath(abs_path)
                    if not os.path.exists(resolved_path):
                        continue
                    source_path = resolved_path

                info = zipfile.ZipInfo.from_file(source_path, rel_path)
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(source_path, "rb") as handle:
                    archive.writestr(info, handle.read())

    print(output_zip)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
