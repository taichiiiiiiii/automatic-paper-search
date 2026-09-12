"""Internal, offline-testable launch plumbing; not a sandbox/security boundary.

Historical filename retained for the repository launcher. The shared queue now
owns model routing, provider authentication and Codex home. This supervisor
never reads user provider configuration or Keychain. Python 3.11+ / POSIX only.
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Any, cast

import tomllib

QUEUE = Path("/Users/taichi/.local/bin/qwen-implementation-queue")
CLOUD_CATALOG = "/Users/taichi/.local/share/qwen-flash/cloud-flash-models.json"


def routing_parts(arguments: list[str]) -> tuple[str, dict[str, Any], list[str]]:
    """Normalize only the queue's documented model/config transformations."""
    if len(arguments) > 256 or sum(len(arg) for arg in arguments) > 32768:
        raise ValueError("queue command exceeds the fixed contract")
    model = ""
    configs: dict[str, Any] = {}
    remainder = []
    index = 0
    while index < len(arguments):
        arg = arguments[index]
        if arg == "--model":
            if model or index + 1 == len(arguments):
                raise ValueError("invalid queue model selection")
            index += 1
            model = arguments[index]
        elif arg == "-c":
            index += 1
            if index == len(arguments):
                raise ValueError("invalid queue configuration")
            key, separator, raw_value = arguments[index].partition("=")
            key = key.strip()
            if not separator or not re.fullmatch(r"[a-z_][a-z0-9_.]*", key):
                raise ValueError("invalid queue configuration")
            try:
                value = tomllib.loads("value=" + raw_value)["value"]
                encoded = json.dumps(value, sort_keys=True, allow_nan=False)
            except (ValueError, TypeError, KeyError) as error:
                raise ValueError("invalid queue configuration") from error
            if key in configs and (key != "model_catalog_json" or configs[key] != encoded):
                raise ValueError("conflicting queue configuration")
            configs[key] = encoded
        else:
            remainder.append(arg)
        index += 1
    return model, configs, remainder


def validate_queue_command(actual: list[str], expected: list[str], mode: str) -> None:
    """Keep all safety options fixed; only supervised subscription routing varies."""
    model, configs, rest = routing_parts(actual)
    if mode != "cloud-only":
        raise ValueError("only fixed Cloud-only implementation is authorized")
    expected_model, expected_configs, expected_rest = routing_parts(expected)
    if rest != expected_rest:
        raise ValueError("queue changed fixed execution flags")
    if model == expected_model and configs == expected_configs:
        if mode == "cloud-only":
            raise ValueError("queue did not honor explicit Cloud-only model")
        return
    if model != "qwen3.8-flash":
        raise ValueError("queue selected an unauthorized model")
    wanted = dict(expected_configs)
    wanted.pop("model_providers.qwen_flash_local", None)
    wanted["model_provider"] = json.dumps("qwen_token_plan")
    wanted["model_catalog_json"] = json.dumps(CLOUD_CATALOG)
    provider_json = configs.pop("model_providers.qwen_token_plan", None)
    if configs != wanted or provider_json is None:
        raise ValueError("queue changed fixed configuration")
    provider = json.loads(provider_json)
    if not isinstance(provider, dict) or set(provider) != {
        "name",
        "base_url",
        "wire_api",
        "auth",
        "request_max_retries",
        "stream_max_retries",
        "stream_idle_timeout_ms",
    }:
        raise ValueError("queue selected an unauthorized provider")
    auth = provider.get("auth")
    if (
        provider["base_url"]
        != "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
        or provider["wire_api"] != "responses"
        or type(provider["name"]) is not str
        or not isinstance(auth, dict)
        or set(auth) != {"command", "args"}
        or auth["command"] != "/usr/bin/security"
    ):
        raise ValueError("queue selected an unauthorized provider")
    for field, limit in (
        ("request_max_retries", 0),
        ("stream_max_retries", 0),
        ("stream_idle_timeout_ms", 600000),
    ):
        if type(provider[field]) is not int or provider[field] != limit:
            raise ValueError("queue changed the retry or timeout budget")
    args = auth["args"]
    if (
        not isinstance(args, list)
        or len(args) != 6
        or args[:2] != ["find-generic-password", "-a"]
        or args[3] != "-s"
        or args[5] != "-w"
        or args[2] != "taichi"
        or args[4] != "codex-qwen-token-plan"
        or any(
            type(value) is not str
            or not value
            or len(value) > 256
            or value.startswith("-")
            or not value.isprintable()
            for value in (args[2], args[4])
        )
    ):
        raise ValueError("queue selected an unauthorized authentication route")


def startup_state(directory: Path, *, close: bool = False) -> int | None:
    """Serialize admission with cleanup so a delayed shim cannot start after exit."""
    descriptor = os.open(directory / "startup.lock", os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = directory / "startup.json"
        state = json.loads(path.read_text(encoding="ascii"))
        group = state.get("group")
        if group is not None and (type(group) is not int or group <= 1 or group == os.getpgrp()):
            raise ValueError("invalid owned worker group")
        if close:
            path.write_text(json.dumps({"closed": True, "group": group}), encoding="ascii")
        elif state["closed"] or group is not None:
            raise ValueError("implementation startup is closed or already claimed")
        else:
            if os.getpid() != os.getpgrp():
                raise ValueError("queue must start an isolated worker process group")
            group = os.getpid()
            path.write_text(json.dumps({"closed": False, "group": group}), encoding="ascii")
        return cast(int | None, group)


def shim_main(directory: Path) -> None:
    """Executed by the queue after admission, before the real Codex process."""
    try:
        startup_state(directory)
        metadata = json.loads((directory / "request.json").read_text(encoding="utf-8"))
        # The queue resolves only our shim. Restore tool lookup after claiming
        # startup, never allowing a deleted shim to fall through to real Codex.
        os.environ["PATH"] = metadata["tool_path"]
        for key in tuple(os.environ):
            if key.startswith("GIT_"):
                del os.environ[key]
        validate_queue_command(sys.argv[1:], metadata["arguments"], metadata["mode"])
        ensure_clean(metadata["target"], metadata["common"], git_binary=metadata["git_binary"])
        binary = metadata["binary"]
        os.execv(binary, [binary, *sys.argv[1:]])
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, ValueError) else "queued launch preflight failed"
        print(f"qwen-implement: {message}", file=sys.stderr)
        raise SystemExit(2) from None


def ensure_clean(target: str, common: str, *, git_binary: str = "git") -> None:
    """Repeat mutable Git gates after acquiring the nonblocking repository lock."""

    def git(*args: str) -> str:
        result = subprocess.run(
            [git_binary, "-C", target, *args],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.stdout.strip()

    if Path(git("rev-parse", "--path-format=absolute", "--git-common-dir")).resolve() != Path(
        common
    ):
        raise ValueError("WORKTREE repository changed before launch")
    target_path = Path(target)
    if Path(git("rev-parse", "--show-toplevel")).resolve() != target_path:
        raise ValueError("WORKTREE must remain the exact git top level")
    if (target_path / ".git").is_symlink() or not (target_path / ".git").is_file():
        raise ValueError("WORKTREE must remain a registered linked worktree")
    registered = git("worktree", "list", "--porcelain")
    if not any(
        line.startswith("worktree ") and Path(line[9:]).resolve() == target_path
        for line in registered.splitlines()
    ):
        raise ValueError("WORKTREE is no longer registered")
    branch = git("symbolic-ref", "-q", "--short", "HEAD")
    if branch in {"main", "master", "develop"}:
        raise ValueError("protected branch is not allowed")
    for suffix in ((), ("--recurse-submodules",)):
        flags = git("ls-files", "-v", *suffix, "--")
        if any(line and (line[0].islower() or line[0] == "S") for line in flags.splitlines()):
            raise ValueError("assume-unchanged or skip-worktree flags are not allowed")
    options = (
        "core.fsmonitor=false",
        "core.excludesFile=/dev/null",
        "core.fileMode=true",
        "core.trustctime=true",
        "core.checkStat=default",
        "core.symlinks=true",
        "core.ignoreStat=false",
        "core.ignorecase=false",
        "core.precomposeunicode=false",
    )
    if git(
        *(arg for option in options for arg in ("-c", option)),
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
    ):
        raise ValueError("WORKTREE must be clean, including untracked files")


def run_worker(command: list[str], environment: dict[str, str], directory: Path) -> int:
    """Hold the repository lock until the worker exits, including on interruption."""
    interrupted = 0
    worker: subprocess.Popen[bytes] | None = None

    def close_startup_and_stop_owned_group() -> None:
        group = startup_state(directory, close=True)
        if group is not None:
            with suppress(ProcessLookupError):
                os.killpg(group, signal.SIGKILL)

    def forward(signum: int, _frame: Any) -> None:
        nonlocal interrupted
        interrupted = signum
        if worker is not None:
            with suppress(ProcessLookupError):
                os.killpg(worker.pid, signum)

    previous = {
        sig: signal.signal(sig, forward) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
    }
    try:
        worker = subprocess.Popen(command, env=environment, start_new_session=True)
        if interrupted:
            forward(interrupted, None)
        while worker.poll() is None:
            try:
                worker.wait(timeout=1)
            except subprocess.TimeoutExpired:
                if interrupted:
                    # Close admission before stopping the queue: its child is
                    # in a separate session and may not yet have entered shim.
                    close_startup_and_stop_owned_group()
                    with suppress(ProcessLookupError):
                        os.killpg(worker.pid, signal.SIGKILL)
                    worker.wait()
        result = worker.returncode
        if interrupted:
            with suppress(ProcessLookupError):
                os.killpg(worker.pid, signal.SIGKILL)
            return 128 + interrupted
        return result if result >= 0 else 128 - result
    finally:
        try:
            # Normal queue exits can also leave a child/tool behind. Close the
            # gate and stop only our recorded group before dropping repo lock.
            close_startup_and_stop_owned_group()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)


def main() -> int:
    if len(sys.argv) < 7:
        raise ValueError(
            "use qwen-implement [--interactive | --cloud-only] --role backend|frontend WORKTREE"
        )
    target, common, mode, *command = sys.argv[1:]
    if mode != "cloud-only" or command[:2] != ["codex", "exec"]:
        raise ValueError("invalid implementation execution mode")
    if QUEUE.is_symlink() or not QUEUE.is_file() or not os.access(QUEUE, os.X_OK):
        raise ValueError("shared implementation queue is missing or unsafe")
    binary = shutil.which("codex")
    git_binary = shutil.which("git")
    if binary is None or git_binary is None:
        raise ValueError("Codex or Git command is unavailable")
    binary = str(Path(binary).resolve())
    git_binary = str(Path(git_binary).resolve())
    lock_path = Path(common) / "paperpilot-qwen-implement.lock"
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "r+") as lock:
        info = os.fstat(lock.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_nlink != 1
            or info.st_mode & 0o077
        ):
            raise ValueError("unsafe implementation lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError(
                "another implementation worker is active; no automatic retry"
            ) from error
        ensure_clean(target, common)
        with tempfile.TemporaryDirectory(prefix="paperpilot-qwen-shim-") as shim_directory:
            directory = Path(shim_directory)
            # Snapshot our code, not the target's instructions or user config.
            guard = directory / "guard.py"
            guard.write_bytes(Path(__file__).read_bytes())
            (directory / "startup.lock").touch(mode=0o600)
            (directory / "startup.json").write_text(
                '{"closed":false,"group":null}', encoding="ascii"
            )
            (directory / "request.json").write_text(
                json.dumps(
                    {
                        "target": target,
                        "common": common,
                        "mode": mode,
                        "binary": binary,
                        "arguments": command[1:],
                        "git_binary": git_binary,
                        "tool_path": os.environ.get("PATH", os.defpath),
                    }
                ),
                encoding="utf-8",
            )
            shim = directory / "codex"
            shim.write_text(
                f"#!{sys.executable}\nimport runpy\nfrom pathlib import Path\n"
                f"runpy.run_path({str(guard)!r}, run_name='paperpilot_queue_guard')['shim_main'](Path({str(directory)!r}))\n",
                encoding="utf-8",
            )
            for item in directory.iterdir():
                item.chmod(0o700 if item == shim else 0o600)
            # No inherited API keys, queue-mode selectors or provider settings.
            # CODEX_HOME belongs to the queue; HOME keeps its actual meaning.
            environment = {
                key: value
                for key, value in os.environ.items()
                if key in {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"}
            }
            environment["PATH"] = str(directory)
            queue_command = [
                str(QUEUE),
                "--cloud-only", "--cloud-model", "qwen3.8-flash",
                *command,
            ]
            return run_worker(queue_command, environment, directory)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # Subprocess details and arbitrary user config must not enter logs.
        message = str(error) if isinstance(error, ValueError) else "local launch preflight failed"
        print(f"qwen-implement: {message}", file=sys.stderr)
        raise SystemExit(2) from None
