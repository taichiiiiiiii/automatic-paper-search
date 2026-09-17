"""Offline packet and launch contracts; never call the installed queue/Codex."""
import io
import json
import runpy
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]


def module():
    return runpy.run_path(str(ROOT / 'bin/qwen-evaluate'))


def sample():
    return dict(reason='cross-module', acceptance='Preserve behavior', changed_files=['a.py'],
                diff='-old\n+new', test_results='2 tests passed', context='small excerpt')


@pytest.mark.parametrize('change', [
    {'reason': 'routine'}, {'changed_files': ['../secret']}, {'history': 'extra'},
    {'context': 'x' * 33000}, {'context': 'token=abcdefghijklmno'},
    {'changed_files': ['.env']}, {'context': 'full_repository'},
    {'changed_files': ['a.py'] * 13}, {'parent_confirmed': True},
])
def test_packet_rejects_unsafe_input(change):
    data = sample() | change
    with pytest.raises(ValueError):
        module()['packet'](json.dumps(data).encode())


def test_packet_and_command(tmp_path):
    mod = module()
    assert json.loads(mod['packet'](json.dumps(sample()).encode())) == sample()
    args = mod['command'](tmp_path)
    assert args[args.index('--sandbox') + 1] == 'read-only'
    assert 'shell_tool' in args and 'unified_exec' in args
    assert 'model_reasoning_effort="none"' in args
    assert 'agents.enabled=false' in args


def test_exact_keys_and_twelve_files():
    mod = module()
    data = sample()
    data['changed_files'] = [f'file{i}.py' for i in range(12)]
    assert json.loads(mod['packet'](json.dumps(data).encode())) == data
    del data['test_results']
    with pytest.raises(ValueError):
        mod['packet'](json.dumps(data).encode())
    with pytest.raises(ValueError):
        mod['packet'](b'{"reason":"cross-module","reason":"cross-module"}')


@pytest.mark.parametrize('args', [[], ['--parent-review'], ['--parent-reviewed', 'extra'], ['--help', 'extra']])
def test_invalid_arguments_fail_before_reading_or_queue(monkeypatch, args):
    monkeypatch.setattr(sys, 'argv', ['qwen-evaluate', *args])
    monkeypatch.setattr(sys, 'stdin', None)
    with pytest.raises(ValueError):
        module()['main']()


def test_help_is_offline(monkeypatch, capsys):
    monkeypatch.setattr(sys, 'argv', ['qwen-evaluate', '--help'])
    monkeypatch.setattr(sys, 'stdin', None)
    assert module()['main']() == 0
    assert '.codex/bin/qwen-evaluate --parent-reviewed < evaluation.json' in capsys.readouterr().out


@pytest.mark.parametrize('mutation', ['', 'model', 'sandbox', 'provider', 'auth', 'retry'])
def test_fake_queue_and_fake_codex(tmp_path, monkeypatch, capfd, mutation):
    mod = module()
    binary_dir = tmp_path / 'bin'
    binary_dir.mkdir()
    fake = binary_dir / 'codex'
    fake.write_text(f'#!{sys.executable}\nimport sys,json,os\nprint(json.dumps({{"argv":sys.argv[1:],"prompt":sys.stdin.read(),"cwd_files":os.listdir(sys.argv[sys.argv.index("-C")+1]),"home":os.environ.get("CODEX_HOME")}}))\n')
    fake.chmod(0o700)
    queue = tmp_path / 'queue'
    # No imports of the live queue/provider or credential helper.
    queue.write_text(f'''#!{sys.executable}
import os,sys,json,subprocess,shutil
assert sys.argv[1:4] == ["--cloud-only","--cloud-model","qwen3.8-max"]
a=sys.argv[5:]
a[a.index("--model")+1]={('qwen3.8-flash' if mutation == 'model' else 'qwen3.8-max')!r}
provider='{{name="Fixture",base_url="https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",wire_api="responses",auth={{command="/usr/bin/security",args=["find-generic-password","-a","taichi","-s","codex-qwen-token-plan","-w"]}},request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=600000}}'
for i,v in enumerate(a):
    if v.startswith('model_provider='): a[i]='model_provider="qwen_token_plan"'
    if v.startswith('model_catalog_json='): a[i]='model_catalog_json="/Users/taichi/.local/share/qwen-flash/cloud-max-models.json"'
    if v.startswith('model_providers.qwen_flash_local='): a[i]='model_providers.qwen_token_plan='+provider
if {mutation!r} == 'sandbox': a[a.index('--sandbox')+1]='workspace-write'
if {mutation!r} == 'provider': a=[s.replace('token-plan.ap-southeast-1.maas.aliyuncs.com','dashscope.aliyuncs.com') for s in a]
if {mutation!r} == 'auth': a=[s.replace('codex-qwen-token-plan','other-keychain') for s in a]
if {mutation!r} == 'retry': a=[s.replace('request_max_retries=0','request_max_retries=1') for s in a]
os.environ['CODEX_HOME']={str(tmp_path / 'queue-home')!r}
raise SystemExit(subprocess.run([shutil.which('codex'),*a],start_new_session=True).returncode)
''')
    queue.chmod(0o700)
    # main's globals are the runpy function globals, not the returned mapping.
    mod['main'].__globals__['QUEUE'] = queue
    monkeypatch.setenv('PATH', str(binary_dir))
    monkeypatch.setattr(sys, 'argv', ['qwen-evaluate', '--parent-reviewed'])
    monkeypatch.setattr(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(sample()).encode())))
    status = mod['main']()
    output = capfd.readouterr().out
    if mutation:
        assert status == 2 and not output
    else:
        assert status == 0
        result = json.loads(output)
        assert result['argv'][result['argv'].index('--model') + 1] == 'qwen3.8-max'
        assert result['cwd_files'] == []
        assert 'UNTRUSTED REVIEW PACKET' in result['prompt']
        assert result['home'] == str(tmp_path / 'queue-home')
