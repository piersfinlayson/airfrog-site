"""Tests of ci/schema.py's models with the test models in
tests/fixtures/models.toml: a released one whose name has a space and one
that isn't released. Checks the key and the constants derived from a name,
the files generated from the schema, the release files' paths, check names
and the rules for a name.

Usage: python3 tests/models_test.py
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'ci'))
import schema  # noqa: E402

failures = 0


def check(ok, what):
    global failures
    if not ok:
        failures += 1
    print('%s %s' % ('ok  ' if ok else 'FAIL', what))


def run(*args):
    return subprocess.run([sys.executable] + list(args), capture_output=True, text=True, cwd=ROOT)


def read(path):
    with open(path) as f:
        return f.read()


s = schema.load(test=True)
spaced = next(v for v in s.models if v['name'] == 'Mini v2')
unreleased = next(v for v in s.models if not v['released'] and ' ' in v['name'])
check(spaced['key'] == 'mini-v2' and spaced['constant'] == 'MINI_V2',
      'Mini v2: key mini-v2, constant MINI_V2 (%s, %s)' % (spaced['key'], spaced['constant']))
check(run('ci/schema.py', '--test', 'models').stdout.split() == [v['key'] for v in s.models],
      'models lists every key')
got = json.loads(run('ci/schema.py', '--test', 'model', 'mini-v2').stdout)
check(got == {'value': spaced['value'], 'name': 'Mini v2', 'key': 'mini-v2', 'constant': 'MINI_V2',
              'released': True, 'target': 'esp32c3'}, 'model mini-v2 (%s)' % got)
check(run('ci/schema.py', '--test', 'model', 'mini-v2', 'key').stdout == 'mini-v2\n'
      and run('ci/schema.py', '--test', 'model', 'pro-v2', 'released').stdout == 'false\n',
      "model KEY FIELD prints the field's value")
check(run('ci/schema.py', 'model', 'mini-v2').returncode != 0, 'the test models are only added with --test')
check(run('ci/schema.py', '--test', 'write', 'site').returncode != 0,
      "--test doesn't write this site's files")

with tempfile.TemporaryDirectory() as out:
    check(run('ci/schema.py', '--test', 'write', 'site', out).returncode == 0
          and run('ci/schema.py', '--test', 'write', 'v2', out).returncode == 0, 'the generated files are written')
    js = read(os.path.join(out, 'js', 'schema.js'))
    check('    MINI_V2: %d,' % spaced['value'] in js
          and "%d: Object.freeze({ chip: 5, name: 'Mini v2', key: 'mini-v2' })," % spaced['value'] in js,
          "JS: Model.MINI_V2, and MODELS' name Mini v2 and key mini-v2")
    check('%d: Object.freeze({ chip: 9, name: null, key: null }),' % unreleased['value'] in js,
          'JS: a model not released has its number and chip, without its name and key')
    client = read(os.path.join(out, 'rust', 'airfrog-client', 'src', 'schema.rs'))
    check('pub const MINI_V2: u16 = %d;' % spaced['value'] in client, 'airfrog-client: model::MINI_V2')
    signing = read(os.path.join(out, 'rust', 'airfrog-signing-server', 'src', 'models.rs'))
    check('"mini-v2"' in signing, "the signing server's keys contain mini-v2")
    cli = read(os.path.join(out, 'rust', 'airfrog-cli', 'src', 'schema.rs'))
    check('("mini-v2", %d, "Mini v2", 5),' % spaced['value'] in cli, "airfrog-cli's MODELS contains mini-v2")
    forms = [unreleased['name'].lower(), unreleased['key'], unreleased['constant'].lower()]
    leaked = [os.path.relpath(os.path.join(d, f), out) for d, _, fs in os.walk(out) for f in fs
              if any(n in read(os.path.join(d, f)).lower() for n in forms)]
    check(not leaked, "the generated files don't contain the name, key or constant of a model not released (%s)"
          % leaked)

    url = run('ci/urls.py', 'url', 'FIRMWARE_UPDATE_IMAGE', 'model=mini-v2', 'release=0.2.0').stdout.strip()
    check(url.endswith('/firmware/airfrog-mini-v2/v0.2.0/airfrog-mini-v2.bin'), 'the update image is %s' % url)
    files = run('ci/urls.py', 'url', 'FIRMWARE_FACTORY_FILES', 'model=mini-v2', 'release=0.2.0').stdout.strip()
    check(files.endswith('/firmware/airfrog-mini-v2/v0.2.0/airfrog-mini-v2.factory/'),
          'the factory files are in %s' % files)

    words = unreleased['name'].lower().split(' ')
    forms = {'spaced': 'Airfrog ' + unreleased['name'], 'hyphenated': 'airfrog-%s.bin' % unreleased['key'],
             'underscored': 'AIRFROG_' + unreleased['constant'], 'mixed': 'airfrog %s' % '-'.join(words)}
    for form, text in forms.items():
        path = os.path.join(out, form)
        with open(path, 'w') as f:
            f.write('x %s y\n' % text)
        check(run('ci/schema.py', '--test', 'check', 'names', path).returncode == 1,
              'check names finds the name %s (%s)' % (form, text))
        check(run('ci/schema.py', 'check', 'names', path).returncode == 0,
              'without --test, %s isn\'t found' % text)
    path = os.path.join(out, 'released')
    with open(path, 'w') as f:
        f.write('Airfrog %s, airfrog-%s, airfrog-%s, airfrog %s2\n'
                % (spaced['name'], spaced['key'], words[0], unreleased['name']))
    check(run('ci/schema.py', '--test', 'check', 'names', path).returncode == 0,
          "check names doesn't find a released name, the first word alone or a longer word")

base = {k: v for k, v in s.data.items()}
for name in (' Mini', 'Mini ', 'Mini  v2', 'Mini-v2', '2Mini', ''):
    data = dict(base, models=[{'value': 1, 'name': name, 'chip': 'ESP32C3', 'released': True}])
    try:
        schema.Schema(data)
        check(False, 'the name %r fails' % name)
    except schema.SchemaError:
        check(True, 'the name %r fails' % name)
data = dict(base, models=[{'value': 1, 'name': 'Mini v2', 'chip': 'ESP32C3', 'released': True},
                            {'value': 2, 'name': 'Mini V2', 'chip': 'ESP32C3', 'released': True}])
try:
    schema.Schema(data)
    check(False, 'two names with one key fail')
except schema.SchemaError:
    check(True, 'two names with one key fail')

sys.exit(1 if failures else 0)
