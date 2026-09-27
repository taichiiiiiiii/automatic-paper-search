"""Crash-safe whole-file replacement for published artifacts and caches."""

from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path

# What a plain ``open(path, "w")`` produces under the usual 022 umask.
# NamedTemporaryFile creates 0o600, which would silently narrow a
# published artifact that a web server or another container reads.
_DEFAULT_MODE = 0o644


def atomic_write_text(path: str | Path, text: str, *, encoding: str = "utf-8") -> None:
    """Text form of :func:`atomic_write_bytes`."""
    atomic_write_bytes(path, text.encode(encoding))


def atomic_write_bytes(path: str | Path, payload: bytes) -> None:
    """Replace ``path`` with ``payload`` so readers see the old or new file, never a torn one.

    The temporary file is created next to the destination (same filesystem,
    so ``os.replace`` is a rename) with an O_EXCL-unique name. A bare
    ``.tmp`` or ``.tmp.<pid>`` suffix is not unique across concurrent runs
    or across containers that each have their own PID namespace.

    The destination keeps its existing permission bits; a new file gets
    0o644. No fsync: this guards against exceptions and process crashes,
    not power loss.

    This is last-writer-wins. A caller that merges into shared state must
    hold its own lock around the read-merge-write.
    """
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        mode = stat.S_IMODE(destination.stat().st_mode)
    except FileNotFoundError:
        mode = _DEFAULT_MODE
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(payload)
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
