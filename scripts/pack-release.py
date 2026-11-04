"""打包 Chrome 扩展并生成同名 .zip.sha256 校验文件。"""

import hashlib
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

with open(out, "rb") as package:
    digest = hashlib.sha256(package.read()).hexdigest()
with open(out + ".sha256", "w", encoding="utf-8", newline="\n") as checksum:
    checksum.write(f"{digest}  {os.path.basename(out)}\n")

with zipfile.ZipFile(out) as archive:
    names = archive.namelist()
    print("entries:", len(names), "size:", os.path.getsize(out))
    print("\n".join(sorted(names)))
print("SHA-256:", digest)
