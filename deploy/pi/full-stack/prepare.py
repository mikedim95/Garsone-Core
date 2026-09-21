#!/usr/bin/env python3
"""Prepare a portable source release without accessing the Pi or cloud secrets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tarfile
import gzip
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parents[3]
REPOS = ("Garsone-Core", "Garsone-Front", "Garsone-Nodes")
SKIP_DIRS = {".git", "node_modules", "dist", ".vite", "__pycache__", "artifacts", "backups", "data", "uploads", ".vscode", ".kilo"}


def run(*args, cwd=HERE, capture=False):
    return subprocess.run(args, cwd=cwd, check=True, text=True, encoding="utf-8", capture_output=capture)


def safe_file(path):
    if path.name in {"images.published-before-prework.env", "images.lock.env"}:
        return True
    return (
        not any(part in SKIP_DIRS for part in path.parts)
        and (not path.name.startswith(".env") or path.name == ".env.example")
        and not path.name.endswith((".env", ".local", ".log", ".pyc", ".tsbuildinfo", ".pem", ".key", ".tar.gz"))
    )


def source_files(root):
    if (root / ".git").exists():
        names = run("git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", cwd=root, capture=True).stdout.split("\0")
        paths = [root / name for name in names if name]
    else:
        # For unversioned source copies, package only explicit application inputs.
        paths = [root / name for name in ("package.json", "package-lock.json", "Dockerfile", ".dockerignore", "nginx.conf", "index.html", "vite.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "README.md")]
        paths += list((root / "src").rglob("*"))
        if (root / "tests").exists():
            paths += list((root / "tests").rglob("*"))
        if (root / "public").exists():
            paths += list((root / "public").rglob("*"))
    return sorted(p for p in paths if p.is_file() and not p.is_symlink() and safe_file(p.relative_to(root)))


def init(args):
    if (HERE / ".env").exists():
        raise SystemExit(".env already exists; edit it explicitly. Secrets were preserved.")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*", args.host):
        raise SystemExit("Use a hostname or IPv4 address, without a scheme or port.")
    values = {
        "PUBLIC_HOST": args.host,
        "PUBLIC_ORIGIN": f"http://{args.host}:8080",
        "POSTGRES_PASSWORD": secrets.token_hex(24),
        "JWT_SECRET": secrets.token_hex(48),
        "MQTT_PASSWORD": secrets.token_hex(24),
        "NODE_KEY": secrets.token_hex(16),
        "NODE_PAIRING_SECRET": secrets.token_hex(32),
        "LOCAL_ADMIN_PASSWORD": secrets.token_urlsafe(24),
        "RELEASE_TAG": datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S"),
    }
    if args.source:
        values["IMAGE_MODE"] = "source"
        values.update({key: f"garsone/{name}:{values['RELEASE_TAG']}" for key, name in (
            ("CORE_IMAGE", "core"), ("FRONT_IMAGE", "front"), ("NODE_IMAGE", "node"))})
        values["CORE_BIND_ADDRESS"] = "127.0.0.1"
    if args.prebuilt:
        references = json.loads((HERE / "images.prebuilt.json").read_text(encoding="utf-8"))
        values.update({key: value["reference"] for key, value in references.items()})
        values["IMAGE_MODE"] = "prebuilt"
    template = (HERE / ".env.example").read_text(encoding="utf-8")
    for key, value in values.items():
        template = re.sub(rf"^{key}=.*$", f"{key}={value}", template, flags=re.M)
    with (HERE / ".env").open("x", encoding="utf-8", newline="\n") as file:
        file.write(template)
    (HERE / ".env").chmod(0o600)
    print("Created .env with independent local secrets. No hosted credentials were copied.")


def config():
    path = HERE / ".env"
    if not path.exists():
        raise SystemExit("Run: python prepare.py init --host <pi-host>")
    values = dict(line.split("=", 1) for line in path.read_text().splitlines() if line and not line.startswith("#") and "=" in line)
    for key in ("POSTGRES_PASSWORD", "JWT_SECRET", "MQTT_PASSWORD"):
        if len(values.get(key, "")) < 24 or "change-this" in values[key]:
            raise SystemExit(f"{key} must be a real random secret of at least 24 characters")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", values["POSTGRES_PASSWORD"]):
        raise SystemExit("POSTGRES_PASSWORD must be URL-safe (letters, digits, underscore or hyphen).")
    for key in ("POSTGRES_DB", "POSTGRES_USER", "MQTT_USERNAME"):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", values.get(key, "")):
            raise SystemExit(f"Invalid {key}")
    return values


def check(_args):
    values = config()
    compose = ["docker", "compose", "--env-file", ".env", "-f", "compose.yml"]
    if values.get("BLUETOOTH_ENABLED") == "true":
        compose += ["-f", "compose.bluetooth.yml"]
    if values.get("QR_SYNC_ENABLED") == "true":
        sync_file = HERE / "data" / "qr-sync.json"
        if not sync_file.is_file() or not 0 < sync_file.stat().st_size <= 128 * 1024:
            raise SystemExit("QR sync requires a private data/qr-sync.json file of at most 128 KiB. See EVENT_QR.md.")
        if os.name == "posix" and sync_file.stat().st_mode & 0o007:
            raise SystemExit("data/qr-sync.json must not allow access to other users. See the permissions in EVENT_QR.md.")
        try:
            json.loads(sync_file.read_text(encoding="utf-8"))
        except PermissionError:
            # A root:CoreGID 0640 file is intentionally unreadable by the SSH user.
            # Core validates its mounted contents; EVENT_QR.md includes a container read check.
            pass
        except (OSError, ValueError):
            raise SystemExit("Cannot read valid JSON from data/qr-sync.json. See EVENT_QR.md.") from None
        compose += ["-f", "compose.qr-sync.yml"]
    run(*compose, "--profile", "printer", "--profile", "node", "--profile", "seed", "config", "--quiet")
    for repo in REPOS:
        root = WORKSPACE / repo
        required = "MQTT_Printer/Dockerfile" if repo == "Garsone-Nodes" else "Dockerfile"
        if not (root / required).is_file():
            raise SystemExit(f"Missing build input: {root / required}")
    if values.get("IMAGE_MODE") == "prebuilt":
        expected = json.loads((HERE / "images.prebuilt.json").read_text(encoding="utf-8"))
        for entry in expected.values():
            detail = json.loads(run("docker", "image", "inspect", "--platform", "linux/arm64", entry["reference"], capture=True).stdout)[0]
            if detail["Id"] != entry["id"]:
                raise SystemExit(f"Image differs from the tested archive: {entry['reference']}")
    print("Compose and all deployment build contexts are valid. This does not contact the Pi.")


def lock_images(args):
    """Resolve the existing GitHub workflow publications, without pushing anything."""
    if (HERE / "images.lock.env").exists():
        raise SystemExit("images.lock.env already exists. Archive it before resolving a new release.")
    channel = "pi" if args.channel == "stable" else "stage"
    refs = {
        "CORE_IMAGE": f"mikedim95/garsone-core:{channel}",
        "FRONT_IMAGE": f"mikedim95/garsone-front:{channel}",
        "NODE_IMAGE": "mikedim95/mqtt-printer:latest",
    }
    lines = ["# Resolved from the existing GitHub Actions Docker Hub publications."]
    for key, ref in refs.items():
        result = run("docker", "buildx", "imagetools", "inspect", ref, capture=True).stdout
        match = re.search(r"^Digest:\s+(sha256:[0-9a-f]{64})", result, re.M)
        if not match:
            raise SystemExit(f"Cannot resolve digest for {ref}")
        raw = run("docker", "buildx", "imagetools", "inspect", "--raw", ref.split(":")[0] + "@" + match[1], capture=True).stdout
        manifest = json.loads(raw)
        if "manifests" in manifest and not any(
            entry.get("platform", {}).get("os") == "linux" and entry.get("platform", {}).get("architecture") == "arm64"
            for entry in manifest["manifests"]
        ):
            raise SystemExit(f"No linux/arm64 image found for {ref}")
        pinned = ref.split(":")[0] + "@" + match[1]
        lines.append(f"{key}={pinned}")
        print(f"{key}={pinned}")
    (HERE / "images.lock.env").write_text("\n".join(lines) + "\n", encoding="ascii")


def bundle(_args):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = HERE / "artifacts"
    out.mkdir(exist_ok=True)
    archive = out / f"garsone-pi-{stamp}.tar.gz"
    manifest = {"createdAt": stamp, "targetPlatform": "linux/arm64", "repositories": {}, "files": {}}
    files = []
    for repo in REPOS:
        root = WORKSPACE / repo
        if not root.is_dir():
            raise SystemExit(f"Missing repository: {root}")
        if (root / ".git").exists():
            manifest["repositories"][repo] = {
                "commit": run("git", "rev-parse", "HEAD", cwd=root, capture=True).stdout.strip(),
                "dirty": bool(run("git", "status", "--porcelain", cwd=root, capture=True).stdout.strip()),
            }
        else:
            manifest["repositories"][repo] = {"commit": None, "note": "Unversioned application; content hashes below identify the snapshot."}
        for path in source_files(root):
            name = path.relative_to(WORKSPACE).as_posix()
            manifest["files"][name] = hashlib.sha256(path.read_bytes()).hexdigest()
            files.append((path, name))
    import io
    with tarfile.open(archive, "w:gz") as tar:
        for path, name in files:
            tar.add(path, arcname=name, recursive=False)
        data = json.dumps(manifest, indent=2).encode()
        info = tarfile.TarInfo("release-manifest.json")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(archive.suffix + ".sha256").write_text(f"{digest}  {archive.name}\n", encoding="ascii")
    print(f"Prepared {archive}\n{len(files)} source files; .env files, Git metadata, uploads and build outputs excluded.")


def verify(_args):
    manifest_path = WORKSPACE / "release-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for name, expected in manifest["files"].items():
        path = (WORKSPACE / name).resolve()
        if not path.is_relative_to(WORKSPACE) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise SystemExit(f"Release verification failed: {name}")
    print(f"Verified {len(manifest['files'])} source files against release-manifest.json")


def images(_args):
    values = config()
    references = {key: values[key] for key in ("CORE_IMAGE", "FRONT_IMAGE")}
    references["POSTGRES_IMAGE"] = "postgres:16-alpine"
    metadata = {}
    for key, reference in references.items():
        detail = json.loads(run("docker", "image", "inspect", "--platform", "linux/arm64", reference, capture=True).stdout)[0]
        if detail["Os"] != "linux" or detail["Architecture"] != "arm64":
            raise SystemExit(f"{reference} is not a local Linux ARM64 image")
        metadata[key] = {"reference": reference, "id": detail["Id"], "platform": "linux/arm64"}
    out = HERE / "artifacts"
    out.mkdir(exist_ok=True)
    archive = out / "garsone-images-arm64.tar.gz"
    if archive.exists():
        raise SystemExit("Image archive already exists; keep it with its matching source release.")
    with archive.open("xb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=3) as compressed:
            process = subprocess.Popen(["docker", "image", "save", "--platform", "linux/arm64", *references.values()], stdout=subprocess.PIPE)
            while chunk := process.stdout.read(1024 * 1024):
                compressed.write(chunk)
            if process.wait() != 0:
                raise SystemExit("docker image save failed; discard the incomplete archive")
    (HERE / "images.prebuilt.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    with archive.open("rb") as stream:
        checksum = hashlib.sha256()
        while chunk := stream.read(1024 * 1024): checksum.update(chunk)
    archive.with_suffix(archive.suffix + ".sha256").write_text(f"{checksum.hexdigest()}  {archive.name}\n", encoding="ascii")
    print(f"Saved {len(references)} ARM64 runtime images to {archive}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("init", help="Generate a new local .env; never overwrite")
    command.add_argument("--host", default="raspberrypi.local")
    command.add_argument("--source", action="store_true", help="Use separate local image tags for source builds")
    command.add_argument("--prebuilt", action="store_true", help="Use images.prebuilt.json from the tested image archive")
    command.set_defaults(func=init)
    command = commands.add_parser("lock-images", help="Pin images already published by GitHub Actions")
    command.add_argument("--channel", choices=("stable", "stage"), default="stable")
    command.set_defaults(func=lock_images)
    for name, func in (("check", check), ("bundle", bundle), ("verify", verify), ("images", images)):
        commands.add_parser(name).set_defaults(func=func)
    args = parser.parse_args()
    if args.command == "init" and args.source and args.prebuilt:
        parser.error("--source and --prebuilt are mutually exclusive")
    args.func(args)


if __name__ == "__main__":
    main()
