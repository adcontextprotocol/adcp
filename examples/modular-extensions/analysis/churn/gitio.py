"""Small git helpers: a persistent `git cat-file --batch` reader and raw diff parsing."""
import json
import re
import subprocess

PREFIX = "static/schemas/source/"


def git(repo, *args):
    return subprocess.check_output(["git", "-C", repo, *args], text=True)


class Blobs:
    """Reads objects through one long-lived `git cat-file --batch` process."""

    def __init__(self, repo):
        self.p = subprocess.Popen(["git", "-C", repo, "cat-file", "--batch"],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.cache = {}

    def raw(self, spec):
        if spec in self.cache:
            return self.cache[spec]
        self.p.stdin.write(spec.encode() + b"\n")
        self.p.stdin.flush()
        header = self.p.stdout.readline().decode().rstrip("\n")
        if header.endswith(" missing") or header.endswith(" ambiguous"):
            self.cache[spec] = None
            return None
        size = int(header.split()[2])
        data = self.p.stdout.read(size)
        self.p.stdout.read(1)
        if len(self.cache) < 20000:
            self.cache[spec] = data
        return data

    def json(self, spec):
        data = self.raw(spec)
        if data is None:
            return None
        try:
            return json.loads(data)
        except ValueError:
            return "__PARSE_ERROR__"

    def close(self):
        self.p.stdin.close()
        self.p.wait()


RAW_RE = re.compile(r"^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$")


def parse_raw_line(line):
    """Parse one `--raw --no-abbrev` line into a dict, or None."""
    meta, _, paths = line.partition("\t")
    m = RAW_RE.match(meta)
    if not m:
        return None
    parts = paths.split("\t")
    status = m.group(5)
    old = parts[0]
    new = parts[1] if len(parts) > 1 else parts[0]
    return {"status": status, "score": int(m.group(6) or 0),
            "old_blob": m.group(3), "new_blob": m.group(4),
            "old": old, "new": new}


def rel(path):
    return path[len(PREFIX):] if path.startswith(PREFIX) else None


PR_RE = [re.compile(r"\(#(\d+)\)\s*$"), re.compile(r"Merge pull request #(\d+)"),
         re.compile(r"#(\d+)")]


def pr_number(subject):
    for rx in PR_RE:
        m = rx.search(subject)
        if m:
            return int(m.group(1))
    return None


GA_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
PRE_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)-(alpha|beta|rc)\.(\d+)$")


def version_key(tag):
    m = GA_RE.match(tag)
    if m:
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)), 9, 0)
    m = PRE_RE.match(tag)
    if m:
        order = {"alpha": 0, "beta": 1, "rc": 2}[m.group(4)]
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)), order, int(m.group(5)))
    return None
