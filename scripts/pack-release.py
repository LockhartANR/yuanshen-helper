"""把 dist/ 打成 Chrome 可直接加载的 zip（manifest.json 在根目录，条目用 / 分隔）。"""

import os
import sys
import zipfile

src = os.path.abspath(sys.argv[1])
out = os.path.abspath(sys.argv[2])

if os.path.exists(out):
    os.remove(out)

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for root, _dirs, files in os.walk(src):
        for name in sorted(files):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, src).replace(os.sep, "/")
            archive.write(path, rel)

with zipfile.ZipFile(out) as archive:
    names = archive.namelist()
    print("entries:", len(names), "size:", os.path.getsize(out))
    print("\n".join(sorted(names)))
