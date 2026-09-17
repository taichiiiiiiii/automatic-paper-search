"""Offline launch regression using disposable repositories, queue, and Codex."""

import json
import os
import select
import shutil
import signal
import subprocess
import tempfile
import time
import tomllib
import unittest
from contextlib import suppress
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
FAKE = '''#!/opt/homebrew/bin/python3
import json, os, sys
open(os.environ["FAKE_CODEX_MARKER"], "w", encoding="utf-8").write(str(os.getpid()))
print(json.dumps({"argv": sys.argv[1:], "stdin": sys.stdin.read(), "home": os.environ["CODEX_HOME"], "home_mode": os.stat(os.environ["CODEX_HOME"]).st_mode & 0o777, "env_keys": list(os.environ), "pid": os.getpid(), "runner_pid": os.getppid(), "queue_argv": json.loads(os.environ["FAKE_QUEUE_ARGV"])}), flush=True)
raise SystemExit(STATUS)
'''
FAKE_QUEUE = '''#!/opt/homebrew/bin/python3
import json, os, shutil, signal, subprocess, sys, time
args = sys.argv[1:]
environment = dict(os.environ)
environment["CODEX_HOME"] = __QUEUE_HOME__
environment["FAKE_QUEUE_ARGV"] = json.dumps(args)
environment["FAKE_CODEX_MARKER"] = __MARKER__
queue_mode = args[0] if args and args[0] in ("--interactive", "--cloud-only") else None
command = args[1:] if queue_mode else args
if command[:2] == ["--cloud-model", "qwen3.8-flash"]:
    command = command[2:]
codex_binary = shutil.which(command[0], path=environment.get("PATH"))
if codex_binary is None:
    raise SystemExit("fixture queue cannot resolve private Codex shim")
command[0] = codex_binary
control = open(__CONTROL__, encoding="utf-8").read()
target = command[command.index("-C") + 1]
select_cloud = control in ("cloud", "cloud_catalog_conflict") or (
    queue_mode == "--cloud-only" and control != "cloud_only_flash"
)
if select_cloud:
    command[command.index("--model") + 1] = "qwen3.8-flash"
    rewritten = []
    index = 0
    while index < len(command):
        if (command[index] == "-c" and index + 1 < len(command)
                and command[index + 1].startswith("model_providers.qwen_flash_local=")):
            index += 2
            continue
        rewritten.append(command[index])
        index += 1
    command = rewritten
    for index, item in enumerate(command):
        if item == 'model_provider="qwen_flash_local"':
            command[index] = 'model_provider="qwen_token_plan"'
        elif item.startswith("model_catalog_json="):
            command[index] = 'model_catalog_json="/Users/taichi/.local/share/qwen-flash/cloud-flash-models.json"'
    command.extend(["-c", 'model_providers.qwen_token_plan={name="Fixture Cloud",base_url="https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",wire_api="responses",auth={command="/usr/bin/security",args=["find-generic-password","-a","taichi","-s","codex-qwen-token-plan","-w"]},request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=600000}'])
    duplicate_catalog = ('model_catalog_json="/tmp/conflicting-models.json"'
                         if control == "cloud_catalog_conflict" else
                         'model_catalog_json="/Users/taichi/.local/share/qwen-flash/cloud-flash-models.json"')
    command.extend(["-c", duplicate_catalog])
if control == "wrong_cloud_model":
    command[command.index("--model") + 1] = "qwen3.7-plus"
elif control in ("payg", "wrong_keychain"):
    index = next(i for i, item in enumerate(command) if item.startswith("model_providers.qwen_token_plan="))
    command[index] = command[index].replace("token-plan.ap-southeast-1.maas.aliyuncs.com", "dashscope.aliyuncs.com") if control == "payg" else command[index].replace("codex-qwen-token-plan", "other-service")
elif control == "unsafe_flag":
    command[command.index("workspace-write")] = "danger-full-access"
elif control == "unsafe_retry":
    index = next(i for i, item in enumerate(command) if item.startswith("model_providers.qwen_token_plan="))
    command[index] = command[index].replace("request_max_retries=0", "request_max_retries=1")
elif control in ("poison_git", "poison_git_dirty"):
    environment["GIT_INDEX_FILE"] = "/nonexistent/queue-index"
    environment["GIT_CONFIG_COUNT"] = "1"
    environment["GIT_CONFIG_KEY_0"] = "status.showUntrackedFiles"
    environment["GIT_CONFIG_VALUE_0"] = "no"
    if control == "poison_git_dirty":
        environment["PATH"] = __FAKE_GIT_DIR__
        open(os.path.join(target, "late.txt"), "w", encoding="utf-8").write("pending")
if control == "dirty":
    open(os.path.join(target, "late.txt"), "w", encoding="utf-8").write("pending")
elif control == "protected":
    subprocess.run([__GIT__, "-C", target, "switch", "-c", "develop"], check=True,
                   capture_output=True)
elif control == "delayed":
    helper_code = "import os,subprocess,sys,time; time.sleep(2); raise SystemExit(subprocess.run(sys.argv[1:], env=os.environ).returncode)"
    helper = subprocess.Popen([sys.executable, "-c", helper_code, *command],
                              env=environment, start_new_session=True)
    open(__HELPER_PID__, "w", encoding="utf-8").write(str(helper.pid))
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(60)
worker = subprocess.Popen(command,
                          env=environment, start_new_session=True)
if control == "orphan":
    for _ in range(100):
        if os.path.exists(__MARKER__):
            break
        time.sleep(0.01)
    raise SystemExit(0)
interrupted = 0
def forward(signum, _frame):
    global interrupted
    interrupted = signum
    try:
        os.killpg(worker.pid, signum)
    except ProcessLookupError:
        pass
for caught in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(caught, forward)
while worker.poll() is None:
    try:
        worker.wait(timeout=0.1)
    except subprocess.TimeoutExpired:
        pass
if interrupted:
    try:
        os.killpg(worker.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    raise SystemExit(128 + interrupted)
raise SystemExit(worker.returncode)
'''


class PaperLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qwen-paperpilot-launcher-")
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        for rel in ("bin/qwen-implement", "bin/qwen-cloud-runner.py", "runners/paperpilot_backend_implementer.instructions.md",
                    "runners/paperpilot_frontend_implementer.instructions.md"):
            target = self.repo / ".codex" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SOURCE / rel, target)
        self.launcher = self.repo / ".codex/bin/qwen-implement"
        # A fixture-only source edit prevents contacting the real shared queue.
        self.queue_home = self.root / "queue-home"
        self.queue_home.mkdir(mode=0o700)
        self.queue_control = self.root / "queue-control"
        self.queue_control.write_text("")
        self.codex_marker = self.root / "codex-marker"
        self.helper_pid = self.root / "helper-pid"
        self.fake_git_marker = self.root / "fake-git-marker"
        self.fake_git_dir = self.root / "fake-git-bin"
        self.fake_git_dir.mkdir()
        git_binary = shutil.which("git")
        if git_binary is None:
            self.fail("git is required for the disposable repository fixture")
        fake_git = self.fake_git_dir / "git"
        fake_git.write_text(
            "#!/opt/homebrew/bin/python3\n"
            "import os, sys\n"
            f"open({str(self.fake_git_marker)!r}, 'w', encoding='utf-8').write('called')\n"
            "if 'status' in sys.argv[1:]:\n"
            "    raise SystemExit(0)\n"
            f"os.execv({git_binary!r}, [{git_binary!r}, *sys.argv[1:]])\n"
        )
        fake_git.chmod(0o700)
        self.queue = self.root / "qwen-implementation-queue"
        queue_source = FAKE_QUEUE.replace("__QUEUE_HOME__", repr(str(self.queue_home)))
        queue_source = queue_source.replace("__CONTROL__", repr(str(self.queue_control)))
        queue_source = queue_source.replace("__MARKER__", repr(str(self.codex_marker)))
        queue_source = queue_source.replace("__HELPER_PID__", repr(str(self.helper_pid)))
        queue_source = queue_source.replace("__GIT__", repr(git_binary))
        queue_source = queue_source.replace("__FAKE_GIT_DIR__", repr(str(self.fake_git_dir)))
        self.queue.write_text(queue_source)
        self.queue.chmod(0o700)
        runner = self.repo / ".codex/bin/qwen-cloud-runner.py"
        runner_source = runner.read_text()
        real_queue = 'QUEUE = Path("/Users/taichi/.local/bin/qwen-implementation-queue")'
        self.assertEqual(runner_source.count(real_queue), 1)
        runner.write_text(runner_source.replace(real_queue, f"QUEUE = Path({str(self.queue)!r})"))
        self.launcher.chmod(0o700)
        self.git("init", "-b", "main")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
        self.worktree = self.root / "linked"
        self.git("worktree", "add", "-b", "test-bounded", str(self.worktree))
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.fake = self.bin / "codex"
        self.fake.write_text(FAKE.replace("STATUS", "0"))
        self.fake.chmod(0o700)
        self.env = dict(os.environ, PATH=str(self.bin) + ":" + os.environ["PATH"])

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args, cwd=None):
        return subprocess.run(["git", "-C", str(cwd or self.repo), "-c", "core.hooksPath=/dev/null", *args],
                              check=True, capture_output=True, text=True, timeout=10)

    def invoke(self, target=None, task="Inspect only; make no changes.\n", status=0,
               role="backend", interactive=False, cloud_only=False):
        self.codex_marker.unlink(missing_ok=True)
        self.fake.write_text(FAKE.replace("STATUS", str(status)))
        if interactive and cloud_only:
            self.fail("test fixture modes are mutually exclusive")
        optional = ["--interactive"] if interactive else (["--cloud-only"] if cloud_only else [])
        return subprocess.run([str(self.launcher), *optional, "--role", role,
                               str(target or self.worktree)], input=task,
                              env=self.env,
                              capture_output=True, text=True, timeout=10, check=False)

    def test_valid_task_uses_flash_by_default_and_preserves_status(self):
        task = "Inspect only; 日本語の依頼.\n"
        result = self.invoke(task=task, status=7)
        self.assertEqual(result.returncode, 7, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["home"], str(self.queue_home))
        self.assertEqual(data["home_mode"], 0o700)
        self.assertTrue(Path(data["home"]).exists())
        args = data["argv"]
        self.assertEqual(args[args.index("--model") + 1], "qwen3.8-flash")
        self.assertIn("--ignore-user-config", args)
        self.assertIn('model_provider="qwen_token_plan"', args)
        self.assertIn('model_catalog_json="/Users/taichi/.local/share/qwen-flash/cloud-flash-models.json"', args)
        self.assertIn("sandbox_workspace_write.network_access=false", args)
        self.assertIn("agents.enabled=false", args)
        self.assertIn("analytics.enabled=false", args)
        self.assertIn('web_search="disabled"', args)
        self.assertTrue(data["stdin"].startswith("Configured reasoning effort: none"))
        self.assertIn('model_reasoning_effort="none"', args)
        self.assertTrue(data["stdin"].endswith(task))
        self.assertEqual(data["stdin"].count(task), 1)
        self.assertEqual(data["queue_argv"][:5], ["--cloud-only", "--cloud-model", "qwen3.8-flash", "codex", "exec"])
        self.assertNotIn("--interactive", data["queue_argv"])
        self.assertIn("--cloud-only", data["queue_argv"])
        self.assertNotIn("Cloud-only implementation is explicitly authorized", data["stdin"])
        self.assertEqual(self.git("status", "--porcelain", cwd=self.worktree).stdout, "")

    def test_primary_is_refused(self):
        result = self.invoke(target=self.repo)
        self.assertEqual(result.returncode, 2)
        self.assertIn("not the primary checkout", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_dirty_worktree_is_refused(self):
        (self.worktree / "untracked.txt").write_text("pending change")
        result = self.invoke()
        self.assertEqual(result.returncode, 2)
        self.assertIn("must be clean", result.stderr)

    def test_protected_branch_is_refused(self):
        self.git("switch", "-c", "develop", cwd=self.worktree)
        result = self.invoke()
        self.assertEqual(result.returncode, 2)
        self.assertIn("protected branch", result.stderr)

    def test_detached_head_is_refused(self):
        self.git("checkout", "--detach", cwd=self.worktree)
        result = self.invoke()
        self.assertEqual(result.returncode, 2)
        self.assertIn("detached HEAD", result.stderr)

    def test_invalid_tasks_are_refused(self):
        for task in ("", "  \n", "invalid\0task"):
            with self.subTest(task=repr(task)):
                result = self.invoke(task=task)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")


    def test_foreign_worktree_is_refused(self):
        foreign = self.root / "foreign"
        foreign.mkdir()
        self.git("init", "-b", "main", cwd=foreign)
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture", cwd=foreign)
        linked = self.root / "foreign-linked"
        self.git("worktree", "add", "-b", "test-foreign", str(linked), cwd=foreign)
        result = self.invoke(target=linked)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("another repository", result.stderr)

    def test_symlink_policy_is_refused(self):
        policy = self.repo / ".codex/runners/paperpilot_backend_implementer.instructions.md"
        contents = policy.read_text()
        policy.unlink()
        outside = self.root / "policy.md"
        outside.write_text(contents)
        policy.symlink_to(outside)
        result = self.invoke()
        self.assertEqual(result.returncode, 2)
        self.assertIn("policy is missing or unsafe", result.stderr)

    def test_oversized_task_is_refused(self):
        result = self.invoke(task="x" * (1048576 + 1))
        self.assertEqual(result.returncode, 2)
        self.assertIn("task exceeds", result.stderr)

    def test_multibyte_task_across_buffer_boundary(self):
        task = "a" * 4095 + "日本語の依頼\n"
        result = self.invoke(task=task)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["stdin"].endswith(task))

    def test_malformed_policy_is_refused(self):
        policy = self.repo / ".codex/runners/paperpilot_backend_implementer.instructions.md"
        for content in (b"bad\xffpolicy", b"bad\0policy", b""):
            with self.subTest(content=content):
                policy.write_bytes(content)
                result = self.invoke()
                self.assertEqual(result.returncode, 2)
                self.assertIn("policy", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_non_utf8_task_is_refused(self):
        result = subprocess.run([str(self.launcher), "--role", "backend", str(self.worktree)],
                                input=b"invalid" + bytes([255]) + b"task", env=self.env,
                                capture_output=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"not valid UTF-8", result.stderr)

    def test_hidden_index_flags_are_refused(self):
        path = ".codex/runners/paperpilot_backend_implementer.instructions.md"
        for flag, unset in (("--assume-unchanged", "--no-assume-unchanged"),
                            ("--skip-worktree", "--no-skip-worktree")):
            with self.subTest(flag=flag):
                self.git("update-index", flag, path, cwd=self.worktree)
                result = self.invoke()
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("flags are not allowed", result.stderr)
                self.git("update-index", unset, path, cwd=self.worktree)

    def test_git_environment_is_neutralized(self):
        self.env.update(GIT_DIR="/nonexistent/redirect", GIT_WORK_TREE="/nonexistent/work",
                        GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="status.showUntrackedFiles",
                        GIT_CONFIG_VALUE_0="no")
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        (self.worktree / "pending.txt").write_text("caller-owned")
        result = self.invoke()
        self.assertEqual(result.returncode, 2)
        self.assertIn("must be clean", result.stderr)

    def test_flash_protocol_and_safety_flags(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        args = data["argv"]
        for arg in ("--ephemeral", "--strict-config", "--ignore-user-config",
                    'approval_policy="never"', "features.apps=false",
                    "features.plugins=false", "features.remote_plugin=false",
                    "model_context_window=32768", "model_auto_compact_token_limit=24000",
                    "agents.max_depth=0"):
            self.assertIn(arg, args)
        self.assertEqual(args[args.index("--sandbox") + 1], "workspace-write")
        provider_arg = next(a for a in args if a.startswith("model_providers.qwen_token_plan="))
        provider = tomllib.loads(provider_arg)["model_providers"]["qwen_token_plan"]
        self.assertEqual(provider["name"], "Fixture Cloud")
        self.assertEqual(provider["base_url"], "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1")
        self.assertEqual(provider["wire_api"], "responses")
        self.assertEqual(provider["auth"]["args"][4], "codex-qwen-token-plan")
        self.assertEqual(provider["request_max_retries"], 0)
        self.assertEqual(provider["stream_max_retries"], 0)
        self.assertEqual(provider["stream_idle_timeout_ms"], 600000)
        self.assertEqual(
            next(a for a in args if a.startswith("model_catalog_json=")),
            'model_catalog_json="/Users/taichi/.local/share/qwen-flash/cloud-flash-models.json"',
        )
        self.assertNotIn("qwen_flash_local", " ".join(args))
        for term in ("Use only exact qwen3.8-flash", "apply_patch",
                     "Do not spawn agents", "SOL parent", "deterministic"):
            self.assertIn(term, data["stdin"])
        self.assertLess(
            data["stdin"].index("PaperPilot backend Qwen"),
            data["stdin"].index("Routing authority (latest user instruction"),
        )
        self.assertLess(
            data["stdin"].index("Routing authority (latest user instruction"),
            data["stdin"].index("--- BOUNDED TASK (verbatim) ---"),
        )
        self.assertFalse((SOURCE / "agents/paperpilot_backend_implementer.toml").exists())

    def test_interactive_flag_is_forwarded_only_to_queue(self):
        result = self.invoke(interactive=True)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.codex_marker.exists())

    def test_cloud_only_is_explicit_cloud_route_and_preserves_status(self):
        result = self.invoke(cloud_only=True, status=9)
        self.assertEqual(result.returncode, 9, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["queue_argv"][:5], ["--cloud-only", "--cloud-model", "qwen3.8-flash", "codex", "exec"])
        self.assertNotIn("--cloud-only", data["argv"])
        self.assertEqual(data["argv"][data["argv"].index("--model") + 1], "qwen3.8-flash")
        self.assertIn('model_provider="qwen_token_plan"', data["argv"])
        self.assertIn("Use only exact qwen3.8-flash", data["stdin"])
        self.assertNotIn("fixture-secret", result.stdout + result.stderr)

    def test_cloud_only_refuses_flash_return_without_fallback(self):
        self.queue_control.write_text("cloud_only_flash")
        result = self.invoke(cloud_only=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse(self.codex_marker.exists())

    def test_default_route_refuses_queue_cloud_selection(self):
        self.queue_control.write_text("cloud")
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["argv"][data["argv"].index("--model") + 1], "qwen3.8-flash")

    def test_interactive_route_accepts_only_validated_cloud_selection(self):
        self.queue_control.write_text("cloud")
        result = self.invoke(cloud_only=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        args = data["argv"]
        self.assertEqual(args[args.index("--model") + 1], "qwen3.8-flash")
        self.assertIn('model_provider="qwen_token_plan"', args)
        self.assertIn(
            'model_catalog_json="/Users/taichi/.local/share/qwen-flash/cloud-flash-models.json"',
            args,
        )
        self.assertEqual(
            [
                item
                for item in args
                if item
                == 'model_catalog_json="/Users/taichi/.local/share/qwen-flash/cloud-flash-models.json"'
            ],
            [
                'model_catalog_json="/Users/taichi/.local/share/qwen-flash/cloud-flash-models.json"',
                'model_catalog_json="/Users/taichi/.local/share/qwen-flash/cloud-flash-models.json"',
            ],
        )
        provider = next(item for item in args if item.startswith("model_providers.qwen_token_plan="))
        self.assertIn('command="/usr/bin/security"', provider)
        self.assertNotIn("fixture-secret", result.stdout + result.stderr)

    def test_interactive_route_refuses_conflicting_duplicate_catalog(self):
        self.queue_control.write_text("cloud_catalog_conflict")
        result = self.invoke()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("conflicting queue configuration", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse(self.codex_marker.exists())

    def test_queue_cannot_change_fixed_flags_or_retry_budget(self):
        for mutation in ("unsafe_flag", "unsafe_retry", "wrong_cloud_model", "payg", "wrong_keychain"):
            with self.subTest(mutation=mutation):
                self.queue_control.write_text(mutation)
                result = self.invoke()
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertFalse(self.codex_marker.exists())

    def test_queue_git_environment_cannot_redirect_postwait_gate(self):
        self.queue_control.write_text("poison_git")
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        for key in ("GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0"):
            self.assertNotIn(key, data["env_keys"])

    def test_queue_path_and_git_environment_cannot_hide_postwait_dirty_state(self):
        self.queue_control.write_text("poison_git_dirty")
        result = self.invoke()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("must be clean", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse(self.codex_marker.exists())
        self.assertFalse(self.fake_git_marker.exists(), "shim used queue-injected git")


    def test_frontend_uses_only_its_domain_policy(self):
        result = self.invoke(role="frontend")
        self.assertEqual(result.returncode, 0, result.stderr)
        policy = json.loads(result.stdout)["stdin"]
        self.assertIn("PaperPilot frontend Qwen", policy)
        self.assertIn("safe DOM APIs", policy)
        self.assertIn("keyboard navigation", policy)
        self.assertNotIn("AbstractSource", policy)
        self.assertFalse((SOURCE / "agents/paperpilot_frontend_implementer.toml").exists())

    def test_missing_or_unsafe_queue_is_refused_without_worker(self):
        original = self.queue.read_bytes()
        self.queue.unlink()
        self.assertEqual(self.invoke().returncode, 2)
        outside = self.root / "outside-queue"
        outside.write_bytes(original)
        outside.chmod(0o700)
        self.queue.symlink_to(outside)
        result = self.invoke()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_busy_worker_is_refused_without_retry(self):
        import fcntl

        with (self.repo / ".git/paperpilot-qwen-implement.lock").open("w") as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            started = time.monotonic()
            result = self.invoke(cloud_only=True)
            elapsed = time.monotonic() - started
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("another implementation worker", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertLess(elapsed, 2.0, "cloud-only retried a busy repository lock")

    def test_provider_environment_cannot_override_route(self):
        self.env.update(OPENAI_API_KEY="fixture-secret", OPENAI_BASE_URL="http://wrong.invalid",
                        QWEN_API_KEY="fixture-secret", DASHSCOPE_API_KEY="fixture-secret",
                        CODEX_HOME="/nonexistent/flash-home", CODEX_PROFILE="unwanted")
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        for key in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "QWEN_API_KEY", "DASHSCOPE_API_KEY", "CODEX_PROFILE"):
            self.assertNotIn(key, data["env_keys"])
        self.assertNotIn("fixture-secret", result.stdout + result.stderr)

    def test_signal_stops_worker_descendants_and_releases_lock(self):
        waiting = FAKE.replace("raise SystemExit(STATUS)", "import time\nwhile True: time.sleep(1)")
        grandchild_code = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(60)"
        setup = ("import subprocess\n"
                 f"grandchild = subprocess.Popen([sys.executable, '-c', {grandchild_code!r}], stdout=subprocess.PIPE, text=True)\n"
                 "assert grandchild.stdout.readline().strip() == 'ready'\n")
        waiting = waiting.replace("print(json.dumps", setup + "print(json.dumps")
        waiting = waiting.replace('"runner_pid": os.getppid()', '"runner_pid": os.getppid(), "grandchild_pid": grandchild.pid')
        self.fake.write_text(waiting)
        process = subprocess.Popen([str(self.launcher), "--role", "backend", str(self.worktree)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, env=self.env)
        grandchild_pid = None
        try:
            stdin = process.stdin
            stdout = process.stdout
            assert stdin is not None
            assert stdout is not None
            stdin.write("Inspect only.\n")
            stdin.close()
            process.stdin = None
            self.assertTrue(select.select([stdout], [], [], 10)[0], "fake worker did not start")
            data = json.loads(stdout.readline())
            grandchild_pid = data["grandchild_pid"]
            self.assertNotEqual(data["runner_pid"], process.pid)
            os.kill(process.pid, signal.SIGTERM)
            _, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 143, stderr)
            self.assertEqual(data["home"], str(self.queue_home))
            for _ in range(100):
                state = subprocess.run(["ps", "-o", "stat=", "-p", str(grandchild_pid)],
                                       capture_output=True, text=True, check=False, timeout=2).stdout.strip()
                if not state or state.startswith("Z"):
                    break
                time.sleep(0.01)
            self.assertTrue(not state or state.startswith("Z"), "worker grandchild survived interruption")
            grandchild_pid = None
            self.assertEqual(self.invoke().returncode, 0)
        finally:
            if grandchild_pid is not None:
                with suppress(ProcessLookupError):
                    os.kill(grandchild_pid, signal.SIGKILL)
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)

    def test_cancel_before_delayed_shim_prevents_codex_start(self):
        self.queue_control.write_text("delayed")
        process = subprocess.Popen(
            [str(self.launcher), "--role", "backend", str(self.worktree)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=self.env,
        )
        helper_pid = None
        try:
            stdin = process.stdin
            assert stdin is not None
            stdin.write("Inspect only.\n")
            stdin.close()
            process.stdin = None
            for _ in range(100):
                if self.helper_pid.exists():
                    helper_pid = int(self.helper_pid.read_text())
                    break
                time.sleep(0.01)
            self.assertIsNotNone(helper_pid, "fake queue did not schedule delayed shim")
            os.kill(process.pid, signal.SIGTERM)
            _, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 143, stderr)
            time.sleep(2.5)
            self.assertFalse(self.codex_marker.exists(), "closed startup gate allowed Codex")
            self.queue_control.write_text("")
            self.assertEqual(self.invoke().returncode, 0)
        finally:
            if helper_pid is not None:
                with suppress(ProcessLookupError):
                    os.killpg(helper_pid, signal.SIGKILL)
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)

    def test_normal_queue_exit_reaps_recorded_separate_session_worker(self):
        self.queue_control.write_text("orphan")
        waiting = FAKE.replace(
            "raise SystemExit(STATUS)", "import time\nwhile True: time.sleep(1)"
        )
        self.fake.write_text(waiting)
        result = subprocess.run(
            [str(self.launcher), "--role", "backend", str(self.worktree)],
            input="Inspect only.\n",
            env=self.env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        worker_pid = json.loads(result.stdout)["pid"]
        for _ in range(100):
            state = subprocess.run(
                ["ps", "-o", "stat=", "-p", str(worker_pid)],
                capture_output=True,
                text=True,
                check=False,
                timeout=2,
            ).stdout.strip()
            if not state or state.startswith("Z"):
                break
            time.sleep(0.01)
        self.assertTrue(not state or state.startswith("Z"), "orphan worker survived queue exit")

    def test_state_is_rechecked_after_lock(self):
        for mutate, expected in (("dirty", "must be clean"),
                                 ("protected", "protected branch")):
            with self.subTest(expected=expected):
                self.queue_control.write_text(mutate)
                result = self.invoke()
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(expected, result.stderr)
                self.assertEqual(result.stdout, "")
                (self.worktree / "late.txt").unlink(missing_ok=True)
                if mutate == "protected":
                    self.git("switch", "test-bounded", cwd=self.worktree)
                    self.git("branch", "-D", "develop", cwd=self.worktree)
                self.queue_control.write_text("")

    def test_cloud_only_rechecks_dirty_state_after_queue_wait(self):
        self.queue_control.write_text("dirty")
        result = self.invoke(cloud_only=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("must be clean", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse(self.codex_marker.exists())

    def test_role_selection_is_required_and_closed(self):
        for args in ([str(self.worktree)],
                     ["--role", "../../outside", str(self.worktree)],
                     ["--role", "Backend", str(self.worktree)],
                     ["--role", "backend", "--role", "frontend", str(self.worktree)],
                     ["--interactive", "--interactive", "--role", "backend", str(self.worktree)],
                     ["--cloud-only", "--cloud-only", "--role", "backend", str(self.worktree)],
                     ["--cloud-only", "--interactive", "--role", "backend", str(self.worktree)],
                     ["--interactive", "--cloud-only", "--role", "backend", str(self.worktree)],
                     ["--role", "backend", "--interactive", str(self.worktree)],
                     ["--role", "backend", "--cloud-only", str(self.worktree)],
                     ["--cloud", "--role", "backend", str(self.worktree)]):
            with self.subTest(args=args):
                result = subprocess.run([str(self.launcher), *args], input="inspect only",
                                        env=self.env, text=True, capture_output=True,
                                        timeout=10, check=False)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")

    def test_environment_cannot_enable_interactive_or_cloud_route(self):
        self.env.update(
            QWEN_IMPLEMENT_INTERACTIVE="1",
            QWEN_IMPLEMENT_CLOUD="1",
            QWEN_IMPLEMENT_CLOUD_ONLY="1",
            QWEN_IMPLEMENT_MODEL="qwen3.8-flash",
        )
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertNotIn("--interactive", data["queue_argv"])
        self.assertIn("--cloud-only", data["queue_argv"])
        self.assertEqual(data["argv"][data["argv"].index("--model") + 1], "qwen3.8-flash")


if __name__ == "__main__":
    unittest.main()
