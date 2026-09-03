"""
Updates the sceneTagger entry in index.yml after sceneTagger.zip has been
(re)built: sha256, version (read from sceneTagger.yml), and date.

Uses ruamel.yaml instead of PyYAML so the file's comments (the "how to add
this source" header) and formatting survive the round trip - plain PyYAML
would silently drop all comments on dump.
"""

import hashlib
import re
import datetime
from ruamel.yaml import YAML

yaml = YAML()
yaml.preserve_quotes = True

with open("sceneTagger.zip", "rb") as f:
    sha256 = hashlib.sha256(f.read()).hexdigest()

with open("sceneTagger/sceneTagger.yml", encoding="utf-8") as f:
    plugin_yml = f.read()

m = re.search(r'version:\s*"([^"]+)"', plugin_yml)
version = m.group(1) if m else "0.0.0"

# Stash expects "YYYY-MM-DD HH:MM:SS" (Go's 2006-01-02 15:04:05 layout) -
# a bare date fails to parse.
date = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

with open("index.yml", encoding="utf-8") as f:
    data = yaml.load(f)

for entry in data:
    if entry.get("id") == "sceneTagger":
        entry["version"] = version
        entry["date"] = date
        entry["path"] = "sceneTagger.zip"
        entry["sha256"] = sha256

with open("index.yml", "w", encoding="utf-8") as f:
    yaml.dump(data, f)

print(f"index.yml updated: version={version} date={date} sha256={sha256}")
