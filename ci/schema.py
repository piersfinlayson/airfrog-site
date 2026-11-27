"""Code generated from schema.toml: AWP's constants and layouts, the page
texts, Airfrog's project name and its models.

Usage: python3 ci/schema.py [--test] COMMAND
  write site [DIR]
                  writes js/schema.js and js/messages.js in DIR (default:
                  this site)
  write v2 DIR    writes the files airfrog-v2 checkout DIR generates from
                  the schema
  check site [DIR]
                  fails when DIR's js/schema.js or js/messages.js isn't what
                  write produces
  check v2 DIR    fails when one of DIR's generated files isn't what write
                  produces, or DIR's docs/websocket-protocol.md's tables,
                  or the recovery tables and values in
                  docs/recovery-protocol.md, differ from the schema
  check names PATH...
                  fails when a file in PATH, a file or a directory, contains
                  an unreleased model's name in any case after "airfrog"
                  and a space, hyphen or underscore, with its words separated
                  by any of these. Directories
                  named build, node_modules, target, managed_components and
                  .git, schema.toml and tests/fixtures/models.toml aren't
                  read.
  models        prints each model's key, one per line
  model KEY [FIELD]
                  prints, as JSON, the value, name, key, constant, released
                  and ESP-IDF target of the model with key KEY, or only
                  FIELD's value as text

--test adds the test models in tests/fixtures/models.toml to
schema.toml's. write site and check site then require DIR.

Use the Python ci/install-python.sh installs.
"""
import json
import os
import re
import sys
import tomllib

import urls

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(ROOT, 'schema.toml')
TEST_MODELS = os.path.join(ROOT, 'tests', 'fixtures', 'models.toml')

SITE_FILES = {
    'js/schema.js': lambda s: js_schema(s),
    'js/messages.js': lambda s: js_messages(s),
}
V2_FILES = {
    'components/protocol/airfrog_awp.h': lambda s: c_header(s),
    'components/protocol/airfrog_image.h': lambda s: c_image_header(s),
    'components/protocol/airfrog_recovery.h': lambda s: c_recovery_header(s),
    'rust/airfrog-ext-api/src/awp.rs': lambda s: ext_api_module(s),
    'rust/airfrog-client/src/schema.rs': lambda s: rust_module(s),
    'apps/airfrog/schema.cmake': lambda s: cmake(s),
    'ci/awp.py': lambda s: py_module(s),
    'apps/airfrog/main/page-texts.js': lambda s: page_texts(s),
    'rust/picoboot-airfrog/src/text.rs': lambda s: crate_texts(s, 'picoboot-airfrog'),
    'rust/airfrog-signing-server/src/models.rs': lambda s: signing_models(s),
    'rust/airfrog-cli/src/schema.rs': lambda s: cli_module(s),
}
SKIPPED_DIRS = {'build', 'node_modules', 'target', 'managed_components', '.git'}

SCALARS = {'u8': 1, 'i8': 1, 'u16': 2, 'u32': 4, 'u64': 8}
FIXED = set(SCALARS) | {'bytes', 'padded', 'reserved'}
PLACEHOLDER = re.compile(r'\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\}')


class SchemaError(Exception):
    pass


def load(test=False):
    """The schema, with TEST_MODELS' models when test is true."""
    with open(SCHEMA, 'rb') as f:
        data = tomllib.load(f)
    if test:
        with open(TEST_MODELS, 'rb') as f:
            data['models'] = data['models'] + tomllib.load(f)['models']
    s = Schema(data)
    s.test = test
    return s


def model_key(name):
    """A model's key: its name in lower case with each space a hyphen."""
    return name.lower().replace(' ', '-')


def model_constant(name):
    """A model's constant: its name in upper case with each space an
    underscore."""
    return name.upper().replace(' ', '_')


def camel(name):
    """HW_INFO to HwInfo."""
    parts = name.lower().split('_')
    return ''.join(p.capitalize() for p in parts)


def lower_camel(name):
    """max_transfer to maxTransfer."""
    c = camel(name)
    return c[0].lower() + c[1:]


class Enum:
    """A set of named values: an [enums.NAME] table, or [services]."""

    def __init__(self, key, table, values):
        self.key = key
        self.comment = table.get('comment')
        self.prefix = table.get('prefix', '')
        self.c_prefix = table['c_prefix']
        self.c_enum = 'af_' + self.c_prefix.lower().rstrip('_') if table.get('c_enum') else None
        self.rust = table.get('rust', {})
        self.public = self.rust.get('public', False)
        self.js = table.get('js', {})
        self.type = table.get('type')
        self.hex = table.get('hex', False)
        self.values = []
        for name, v in values.items():
            if 'bit' in v:
                value, bit = 1 << v['bit'], v['bit']
            else:
                value, bit = v['value'], None
            self.values.append({'name': name, 'value': value, 'bit': bit, 'entry': v})

    def c_name(self, v):
        return name_in(v['entry'], 'c', 'AF_' + self.c_prefix + v['name'])

    def rust_name(self, v):
        return name_in(v['entry'], 'rust', self.prefix + v['name'])

    def py_name(self, v):
        return name_in(v['entry'], 'py', self.prefix + v['name'])

    def js_name(self, v):
        default = v['name'] if self.js.get('object') else self.prefix + v['name']
        return name_in(v['entry'], 'js', default)

    def number(self, v, width=4):
        if self.hex:
            return '0x%0*X' % (width if v['bit'] is not None else 2, v['value'])
        return str(v['value'])


def name_in(entry, language, default):
    """An entry's name in a language: its override, None when it is left
    out, or default."""
    name = entry.get(language, default)
    return None if name is False else name


class Field:
    def __init__(self, layout, f):
        self.layout = layout
        self.name = f.get('name')
        self.type = f['type']
        self.size = f.get('size')
        self.entry = f.get('entry')
        self.count = f.get('count')
        self.optional = f.get('optional', False)
        self.max = f.get('max', False)
        self.offset = None


class Layout:
    def __init__(self, name, table, schema):
        self.name = name
        self.comment = table.get('comment')
        self.doc = table.get('doc')
        self.doc_table = table.get('doc_table', 1)
        self.prefix = table.get('prefix', name)
        self.fields = [Field(self, f) for f in table['fields']]
        offset = 0
        self.fixed_len = None
        for f in self.fields:
            if f.type in FIXED:
                f.size_value = SCALARS[f.type] if f.type in SCALARS else schema.size(f.size)
                f.offset = offset
                offset += f.size_value
            else:
                self.fixed_len = offset
                break
        self.variable = self.fixed_len is not None
        if not self.variable:
            self.fixed_len = offset
        default = '%s_%s' % (self.prefix, 'HEAD' if self.variable else 'LEN')
        self.len_name = table.get('head' if self.variable else 'len', default.lstrip('_'))

    def constants(self):
        """(name without AF_, value, comment) for each offset, then the
        fixed part's length."""
        out = []
        for f in self.fields:
            if f.offset is not None and f.name:
                name = '%s_%s_OFFSET' % (self.prefix, f.name.upper())
                out.append((name.lstrip('_'), f.offset))
        if self.fixed_len or not self.variable:
            out.append((self.len_name, self.fixed_len))
        return out


class Schema:
    def __init__(self, data):
        self.data = data
        self.project = data['project']
        self.manifest_version = data['manifest_version']
        self.constants = data['constants']
        self.enums = [Enum(k, t, t['values']) for k, t in data['enums'].items()]
        svc = data['services']
        self.services = {k: v for k, v in svc.items() if isinstance(v, dict) and 'value' in v}
        self.service_enum = Enum('service', svc, {k: {'value': v['value']} for k, v in self.services.items()})
        self.operation_type = svc.get('operation_type')
        self.operations = {'ALL': svc['all']}
        for name, service in self.services.items():
            for op, value in service.get('operations', {}).items():
                self.operations['%s_%s' % (name, op)] = value
        self.layouts = {name: Layout(name, t, self) for name, t in data['layouts'].items()}
        self.firmware_states = data['firmware_states']
        self.messages = data['messages']
        self.target_mcus = data['target_mcus']
        self.chips = data['chips']
        self.models = [dict(v, key=model_key(v['name']), constant=model_constant(v['name']))
                         for v in data['models']]
        self.validate()

    def released(self):
        return [v for v in self.models if v['released']]

    def unreleased_names(self):
        return [v['name'] for v in self.models if not v['released']]

    def size(self, size):
        if isinstance(size, int):
            return size
        if size not in self.constants:
            raise SchemaError('size %s is not a constant' % size)
        return self.constants[size]['value']

    def enum(self, key):
        for e in self.enums:
            if e.key == key:
                return e
        raise SchemaError('no enum %s' % key)

    def all_enums(self):
        return self.enums + [self.service_enum]

    def validate(self):
        for language in ('c', 'rust', 'js', 'py'):
            seen = {}
            for name, value in self.names(language):
                if name in seen and seen[name] != value:
                    raise SchemaError('%s name %s has the values %s and %s' % (language, name, seen[name], value))
                seen[name] = value
        for layout in self.layouts.values():
            names = set()
            for f in layout.fields:
                if f.type not in FIXED | {'text', 'layout', 'variable', 'list', 'rest'}:
                    raise SchemaError('%s.%s has the type %s' % (layout.name, f.name, f.type))
                if f.max and f.type not in ('u8', 'u16', 'u32'):
                    raise SchemaError('%s.%s has max but isn\'t u8, u16 or u32' % (layout.name, f.name))
                if f.type == 'layout' and f.entry not in self.layouts:
                    raise SchemaError('%s.%s has the entry %s' % (layout.name, f.name, f.entry))
                if f.type == 'variable' and (f.entry not in self.layouts or self.layouts[f.entry].variable):
                    raise SchemaError('%s.%s needs a fixed-length entry layout' % (layout.name, f.name))
                if f.type == 'list':
                    if f.count not in names:
                        raise SchemaError('%s.%s counts with a field before it' % (layout.name, f.name))
                    if f.entry not in self.layouts and f.entry not in ('text', 'u16', 'u32'):
                        raise SchemaError('%s.%s has the entry %s' % (layout.name, f.name, f.entry))
                if f.name:
                    names.add(f.name)
        types = [e.type for e in self.all_enums()] + [self.operation_type]
        if None in types or len(set(types)) != len(types):
            raise SchemaError('every enum and the operations need their own type')
        prefixes = [e.c_prefix for e in self.all_enums()] + ['OP_']
        for p in prefixes:
            if any(q != p and q.startswith(p) for q in prefixes):
                raise SchemaError('the C prefix %s is the start of another' % p)
        for key in ('value', 'key'):
            values = [v[key] for v in self.models]
            if len(set(values)) != len(values):
                raise SchemaError('two models have one %s' % key)
        for v in self.models:
            if v['chip'] not in self.chips or not isinstance(v['released'], bool):
                raise SchemaError('model %d needs a chip and released' % v['value'])
            if not re.fullmatch(r'[A-Za-z][A-Za-z0-9]*( [A-Za-z0-9]+)*', v['name']):
                raise SchemaError('model %d\'s name isn\'t words of letters and digits, starting with a letter, '
                                  'between single spaces' % v['value'])
        Messages(self).check()

    def names(self, language):
        """Every (name, value) a language's generated code defines, to find
        two values with one name."""
        out = []
        prefix = 'AF_' if language == 'c' else ''
        for name, c in self.constants.items():
            n = name_in(c, language, prefix + name)
            if n:
                out.append((n, c['value']))
        for e in self.all_enums():
            if language == 'js' and e.js.get('object') or language == 'rust' and e.public:
                continue
            for v in e.values:
                n = {'c': e.c_name, 'rust': e.rust_name, 'js': e.js_name, 'py': e.py_name}[language](v)
                if n:
                    out.append((n, v['value']))
        for layout in self.layouts.values():
            for name, value in layout.constants():
                out.append((prefix + name, value))
        return out


def comment_lines(text, lead):
    """text as comment lines starting with lead, wrapped at 79 columns."""
    if not text:
        return []
    words = ' '.join(text.split()).split(' ')
    lines, line = [], lead.rstrip()
    for w in words:
        if len(line) + 1 + len(w) > 79 and line != lead.rstrip():
            lines.append(line)
            line = lead.rstrip()
        line += ' ' + w
    lines.append(line)
    return lines


def jsdoc(text, indent=''):
    if not text:
        return []
    one = '%s/** %s */' % (indent, ' '.join(text.split()))
    if len(one) <= 120:
        return [one]
    return [indent + '/**'] + comment_lines(text, indent + ' *') + [indent + ' */']


# --------------------------------------------------------------------------
# C
# --------------------------------------------------------------------------

def c_constants(s, image):
    """A #define for each constant with image, or without it."""
    out = []
    for name, c in s.constants.items():
        n = name_in(c, 'c', 'AF_' + name)
        if not n or c.get('image', False) != image:
            continue
        out += comment_lines(c.get('comment'), '//')
        value = c['value']
        text = '"%s"' % value if isinstance(value, str) else ('0x%02Xu' % value if c.get('hex') else '%du' % value)
        out.append('#define %s %s' % (n, text))
    return out


def c_image_header(s):
    out = ['// Generated by airfrog-site\'s ci/schema.py from schema.toml. Don\'t edit.', '',
           '// Constants of Airfrog\'s firmware images.', '',
           '#ifndef AIRFROG_IMAGE_H', '#define AIRFROG_IMAGE_H', '']
    out += c_constants(s, True) + ['', '#endif']
    return '\n'.join(out) + '\n'


def c_recovery_header(s):
    """[recovery_constants] as a #define each, with the prefix AF_RECOVERY_,
    which keeps them apart from AWP's names in airfrog_awp.h."""
    out = ['// Generated by airfrog-site\'s ci/schema.py from schema.toml. Don\'t edit.', '']
    table = s.data.get('recovery_constants', {})
    out += comment_lines(table.get('comment'), '//')
    out += ['', '#ifndef AIRFROG_RECOVERY_H', '#define AIRFROG_RECOVERY_H', '']
    for name, c in table.items():
        if name == 'comment' or c.get('c') is False:
            continue
        out += comment_lines(c.get('comment'), '//')
        value = c['value']
        text = '"%s"' % value if isinstance(value, str) else ('0x%02Xu' % value if c.get('hex') else '%du' % value)
        out.append('#define AF_RECOVERY_%s %s' % (name, text))
    out += ['', '#endif']
    return '\n'.join(out) + '\n'


def c_header(s):
    out = ['// Generated by airfrog-site\'s ci/schema.py from schema.toml. Don\'t edit.', '',
           '// The Airfrog WebSocket Protocol\'s constants and layout offsets, as',
           '// airfrog-v2/docs/websocket-protocol.md specifies them.', '',
           '#ifndef AIRFROG_AWP_H', '#define AIRFROG_AWP_H', '']
    out += c_constants(s, False) + ['']
    for e in s.all_enums():
        out += comment_lines(e.comment, '//')
        values = [v for v in e.values if e.c_name(v)]
        if e.c_enum:
            out.append('typedef enum %s {' % e.c_enum)
            for v in values:
                out += comment_lines(v['entry'].get('comment'), '    //')
                out.append('    %s = %s,' % (e.c_name(v), e.number(v, 2)))
            out.append('} %s_t;' % e.c_enum)
        else:
            for v in values:
                out += comment_lines(v['entry'].get('comment'), '//')
                if v['bit'] is not None:
                    text = '(1u << %d)' % v['bit']
                else:
                    text = ('0x%02Xu' % v['value']) if e.hex else '%du' % v['value']
                out.append('#define %s %s' % (e.c_name(v), text))
        out.append('')
    out.append('// Operation IDs, per service. ALL is every operation of a service.')
    for op, value in s.operations.items():
        out.append('#define AF_OP_%s %du' % (op, value))
    out.append('')
    for layout in s.layouts.values():
        if layout.constants():
            out += comment_lines(layout.comment or '%s\'s fields.' % layout.name, '//')
            out += ['#define AF_%s %du' % c for c in layout.constants()] + ['']
    out.append('#endif')
    return '\n'.join(out) + '\n'


def cmake(s):
    keys, url = release_keys()
    return ('# Generated by airfrog-site\'s ci/schema.py from schema.toml. Don\'t edit.\n\n'
            '# The project name ESP-IDF writes into Airfrog\'s firmware images.\n'
            'set(AF_PROJECT "%s")\n\n'
            '# The sites that may frame Airfrog\'s home page, from urls.toml. They are https sites.\n'
            'set(AF_FRAME_HOSTS %s)\n\n'
            '# The release keys\' public halves and the Airfrog manifest\'s address, from\n'
            '# commissioning/release-keys.js.\n'
            'set(AF_RELEASE_KEYS %s)\n'
            'set(AF_AIRFROG_MANIFEST "%s")\n' % (s.project, frame_hosts(), ' '.join(keys), url))


def frame_hosts():
    """The hosts of the sites that may frame Airfrog's home page."""
    hosts = []
    for name in ('AIRFROG_TLD', 'ONEROM_TLD'):
        address = urls.url(name)
        if not address.startswith('https://'):
            raise SchemaError('%s isn\'t an https address' % name)
        hosts.append(address[len('https://'):].rstrip('/'))
    return ' '.join(hosts)


# --------------------------------------------------------------------------
# Rust
# --------------------------------------------------------------------------

def rust_doc(text, indent=''):
    return comment_lines(text, indent + '///')


def rust_module(s):
    out = ['// Generated by airfrog-site\'s ci/schema.py from schema.toml. Don\'t edit.', '',
           '//! AWP\'s constants and layout offsets.', '', '#![allow(dead_code)]', '']
    for name, c in s.constants.items():
        n = name_in(c, 'rust', name)
        if not n:
            continue
        out += rust_doc(c.get('comment'))
        value = c['value']
        type_ = '&str' if c['type'] == 'str' else c['type']
        text = '"%s"' % value if isinstance(value, str) else ('0x%02X' % value if c.get('hex') else str(value))
        out.append('pub const %s: %s = %s;' % (n, type_, text))
    for name, c in s.data['client_constants'].items():
        if c.get('client'):
            out += rust_doc(c.get('comment'))
            out.append('pub const %s: %s = %s;' % (name, c['type'], c['value']))
    out.append('')
    for e in s.all_enums():
        if e.public:
            out += rust_type(e)
            continue
        out += comment_lines(e.comment, '//')
        for v in e.values:
            if e.rust_name(v):
                out += rust_doc(v['entry'].get('comment'))
                out.append('pub const %s: %s = %s;' % (e.rust_name(v), e.rust['type'], e.number(v)))
        out.append('')
    out += rust_operation_type(s)
    out += rust_texts(s)
    out += ['/// Released models\' numbers, GET_HW_INFO\'s model.', 'pub mod model {']
    for v in s.released():
        out.append('    pub const %s: u16 = %d;' % (v['constant'], v['value']))
    out += ['}', '']
    for layout in s.layouts.values():
        if layout.constants():
            out += comment_lines(layout.comment or '%s\'s fields.' % layout.name, '//')
            out += ['pub const %s: usize = %d;' % c for c in layout.constants()] + ['']
    return '\n'.join(out).rstrip('\n') + '\n'


def rust_type(e):
    """A tuple struct around the enum's integer, with an associated const
    each, ALL and name()."""
    out = rust_doc(e.comment)
    out += ['#[repr(transparent)]', '#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]',
            'pub struct %s(pub %s);' % (e.type, e.rust.get('type', 'u16')), '', 'impl %s {' % e.type]
    for v in e.values:
        out += rust_doc(v['entry'].get('comment'), '    ')
        out.append('    pub const %s: Self = Self(%s);' % (v['name'], e.number(v)))
    out += ['', '    /// Every value with a name.']
    items = ['Self::%s' % v['name'] for v in e.values]
    # rustfmt's array_width: an array of up to 60 columns is on one line.
    if len(', '.join(items)) + 2 <= 60:
        out.append('    pub const ALL: &[Self] = &[%s];' % ', '.join(items))
    else:
        out += ['    pub const ALL: &[Self] = &['] + ['        %s,' % i for i in items] + ['    ];']
    out += ['', '    /// The value\'s name, or `None` for a value without one.',
            '    pub const fn name(self) -> Option<&\'static str> {', '        match self.0 {']
    out += ['            %s => Some("%s"),' % (e.number(v), v['name']) for v in e.values]
    out += ['            _ => None,', '        }', '    }', '}', '']
    return out


def rust_operation_type(s):
    out = ['/// Operation IDs, per service. ALL is every operation of a service.', '#[repr(transparent)]',
           '#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]',
           'pub struct %s(pub u16);' % s.operation_type, '', 'impl %s {' % s.operation_type]
    for op, value in s.operations.items():
        out.append('    pub const %s: Self = Self(%d);' % (op, value))
    return out + ['}', '']


def ext_api_module(s):
    """airfrog-ext-api's awp module: the constants, a type around an integer
    for each enum, and the layout offsets."""
    out = ['// Generated by airfrog-site\'s ci/schema.py from schema.toml. Don\'t edit.', '',
           '//! The Airfrog WebSocket Protocol\'s constants, values and layout offsets, as',
           '//! airfrog-v2/docs/websocket-protocol.md specifies them.', '']
    for name, c in s.constants.items():
        if c.get('image'):
            continue
        out += rust_doc(c.get('comment'))
        value = c['value']
        type_ = '&str' if c['type'] == 'str' else c['type']
        text = '"%s"' % value if isinstance(value, str) else ('0x%02X' % value if c.get('hex') else str(value))
        out.append('pub const %s: %s = %s;' % (name, type_, text))
    out.append('')
    for e in s.all_enums():
        out += rust_type(e)
    out += rust_operation_type(s)
    for layout in s.layouts.values():
        if layout.constants():
            out += comment_lines(layout.comment or '%s\'s fields.' % layout.name, '//')
            out += ['pub const %s: usize = %d;' % c for c in layout.constants()] + ['']
    return '\n'.join(out).rstrip('\n') + '\n'


def support_firmware(s):
    """The support firmware manifest's keys."""
    return [c['value'] for c in s.data['recovery_constants'].values()
            if isinstance(c, dict) and c.get('support_firmware')]


def signing_models(s):
    keys = ', '.join('"%s"' % v['key'] for v in s.released())
    support = ''.join('    "%s",\n' % key for key in support_firmware(s))
    numbers = ', '.join(str(v['value']) for v in s.models)
    c = s.constants
    ext = ''.join('pub const %s: usize = %d;\n' % n for n in s.layouts['EXT_IMAGE'].constants())
    return ('// Generated by airfrog-site\'s ci/schema.py from schema.toml. Don\'t edit.\n\n'
            '//! The manifests\' version, the firmware manifests\' keys, and the values that\n'
            '//! identify a firmware image and an extension image.\n\n'
            '/// The version of every manifest\'s schema.\n'
            'pub const MANIFEST_VERSION: u64 = %d;\n\n'
            '/// The released models\' keys. A model\'s Airfrog firmware is airfrog-KEY.\n'
            'pub const MODEL_KEYS: &[&str] = &[%s];\n\n'
            '/// The support firmware manifest\'s keys.\n'
            'pub const SUPPORT_FIRMWARE: &[&str] = &[\n%s];\n\n'
            '/// The project name in a firmware image\'s app description.\n'
            'pub const PROJECT: &str = %s;\n\n'
            '/// %s\n'
            'pub const IMAGE_MODEL_OFFSET: usize = %d;\n\n'
            '/// Every model\'s number, released or not.\n'
            'pub const MODEL_NUMBERS: &[u16] = &[%s];\n\n'
            '/// %s\n'
            'pub const EXT_IMAGE_MAGIC: &str = %s;\n'
            '/// %s\n'
            'pub const EXT_NAME_MAX: usize = %d;\n'
            '/// %s\n'
            'pub const EXT_METADATA_MAX: usize = %d;\n\n'
            '// An extension image\'s header.\n%s'
            % (s.manifest_version, keys, support, rust_string(s.project),
               c['IMAGE_MODEL_OFFSET']['comment'], c['IMAGE_MODEL_OFFSET']['value'], numbers,
               c['EXT_IMAGE_MAGIC']['comment'], rust_string(c['EXT_IMAGE_MAGIC']['value']),
               c['EXT_NAME_MAX']['comment'], c['EXT_NAME_MAX']['value'],
               c['EXT_METADATA_MAX']['comment'], c['EXT_METADATA_MAX']['value'], ext))


# --------------------------------------------------------------------------
# Rust: error texts
# --------------------------------------------------------------------------

def text_table(t):
    return t if isinstance(t, dict) else {'text': t}


def message_text(s, name, where):
    """A message's string, for a reference to it, with its references
    resolved. A function can't be referred to."""
    group, _, key = name.partition('.')
    m = s.messages.get(group)
    if m is None and group in s.firmware_states:
        return s.firmware_states[group]
    if not isinstance(m, dict):
        raise SchemaError('%s refers to %s, which isn\'t a message' % (where, name))
    t = text_table(m['entries'][key]) if key else m
    if 'args' in t or 'text' not in t:
        raise SchemaError('%s refers to %s, which isn\'t a string' % (where, name))
    return ''.join(v for _, v in resolve(s, t['text'], [], where))


def resolve(s, text, args, where):
    """text as ('text', string) and ('arg', name) parts, with references and
    constants replaced by their values."""
    parts = []
    for i, piece in enumerate(PLACEHOLDER.split(text)):
        if i % 2 == 0:
            parts.append(('text', piece))
        elif piece in args:
            parts.append(('arg', piece))
        elif piece in s.constants:
            parts.append(('text', str(s.constants[piece]['value'])))
        elif piece in s.data['client_constants']:
            parts.append(('text', str(s.data['client_constants'][piece]['value'])))
        elif with_args(s, piece, args):
            t = with_args(s, piece, args)
            parts += resolve(s, t['text'], args, where)
        else:
            parts.append(('text', message_text(s, piece, where)))
    return parts


def with_args(s, name, args):
    """The message `name` refers to, where it is a text with args that are
    all args of the text referring to it, which a function can pass on.
    None otherwise."""
    group, _, key = name.partition('.')
    m = s.messages.get(group)
    if not isinstance(m, dict) or not key or key not in m.get('entries', {}):
        return None
    t = text_table(m['entries'][key])
    if 'text' not in t or 'cases' in t or 'lookup' in t or t.get('linked'):
        return None
    wanted = t.get('args')
    return t if wanted and all(a in args for a in wanted) else None


def rust_string(text):
    return '"%s"' % text.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n')


def rust_format(parts):
    """A String expression for parts."""
    if all(kind == 'text' for kind, _ in parts):
        return '%s.to_string()' % rust_string(''.join(v for _, v in parts))
    body = ''.join(v.replace('{', '{{').replace('}', '}}') if kind == 'text'
                   else '{%s}' % v for kind, v in parts)
    return 'format!(%s)' % rust_string(body)


def rust_text(s, key, t, where, indent=4):
    """A const for a text without arguments, otherwise a function. indent is
    the column the item starts at, for rustfmt's 100-column wrapping."""
    t = text_table(t)
    args = t.get('args', [])
    if not args:
        value = rust_string(''.join(v for _, v in resolve(s, t['text'], [], where)))
        line = 'pub const %s: &str = %s;' % (key, value)
        if len(line) + indent > 100:
            return ['pub const %s: &str =' % key, '    %s;' % value]
        return [line]
    types = t.get('rust_args')
    if not types or len(types) != len(args):
        raise SchemaError('%s needs rust_args' % where)
    params = ', '.join('%s: %s' % (a, ty) for a, ty in zip(args, types))
    out = ['pub fn %s(%s) -> String {' % (key.lower(), params)]
    option = types[0].startswith('Option<')
    first = args[0]
    if 'lookup' in t:
        out.append('    if let Some(text) = %s(%s) {' % (t['lookup'].lower(), first))
        out += ['        return text.to_string();', '    }']
    cases = t.get('cases', [{'text': t.get('text')}])
    for c in cases[:-1]:
        if 'is' in c:
            cond = '%s == %s' % (first, 'Some(%s)' % c['is'] if option else c['is'])
        elif c.get('absent'):
            cond = '%s.is_none()' % first
        elif c.get('falsy') and types[0] == '&str':
            cond = '%s.is_empty()' % first
        elif c.get('falsy'):
            cond = '%s.unwrap_or_default() == 0' % first if option else '%s == 0' % first
        else:
            raise SchemaError('%s has a case without a condition' % where)
        out += ['    if %s {' % cond,
                '        return %s;' % rust_format(resolve(s, c['text'], args, where)), '    }']
    last = resolve(s, cases[-1]['text'], args, where)
    if option and any(kind == 'arg' and v == first for kind, v in last):
        out.append('    let %s = %s.unwrap_or_default();' % (first, first))
    body = rust_format(last)
    if body.startswith('format!(') and indent + 4 + len(body) > 100:
        out += ['    format!(', '        %s' % body[len('format!('):-1], '    )', '}']
    else:
        out += ['    %s' % body, '}']
    return out


def rust_texts(s):
    out = ['/// AirfrogError\'s texts, from the schema\'s ERRORS and rust_texts.',
           'pub mod text {']
    lookups = set()
    for name, m in s.messages.items():
        if not (isinstance(m, dict) and m.get('rust') is True):
            continue
        for key, t in m['entries'].items():
            out += ['    ' + line if line else '' for line in rust_text(s, key, t, '%s.%s' % (name, key))]
            if isinstance(t, dict) and 'lookup' in t:
                lookups.add(t['lookup'])
    for key, t in s.data.get('rust_texts', {}).items():
        if key != 'comment':
            out += ['    ' + line for line in rust_text(s, key, t, 'rust_texts.%s' % key)]
    errors = {v['name']: v['value'] for v in s.enum('error').values}
    for name in sorted(lookups):
        out += ['', '    fn %s(key: u16) -> Option<&\'static str> {' % name.lower(), '        match key {']
        for key, t in s.messages[name]['entries'].items():
            out.append('            %d => Some(%s),' % (errors[key], rust_string(t)))
        out += ['            _ => None,', '        }', '    }']
    out += ['}', '']
    return out


def crate_texts(s, crate):
    """A crate's own text module: the messages with `rust = "crate"`."""
    out = ['// Generated by airfrog-site\'s ci/schema.py from schema.toml. Don\'t edit.', '',
           '//! The error texts.', '', '#![allow(dead_code)]', '']
    for name, m in s.messages.items():
        if isinstance(m, dict) and m.get('rust') == crate:
            for key, t in m['entries'].items():
                out += rust_text(s, key, t, '%s.%s' % (name, key), indent=0)
    return '\n'.join(out) + '\n'


def release_keys():
    """commissioning/release-keys.js's release keys and the Airfrog manifest's address."""
    with open(os.path.join(ROOT, 'commissioning', 'release-keys.js')) as f:
        text = f.read()
    keys = re.search(r"RELEASE_KEYS = \[([^\]]*)\]", text)
    url = re.search(r"AIRFROG_MANIFEST = '([^']*)'", text)
    if not keys or not url:
        raise SchemaError('commissioning/release-keys.js has no RELEASE_KEYS or AIRFROG_MANIFEST')
    keys = re.findall(r"'([^']*)'", keys.group(1))
    if not keys or not all(re.fullmatch(r'[0-9a-f]{64}', k) for k in keys):
        raise SchemaError("commissioning/release-keys.js's RELEASE_KEYS isn't keys of 64 lowercase hex digits")
    ids = [k[:16] for k in keys]
    if len(set(ids)) != len(ids):
        raise SchemaError("commissioning/release-keys.js's RELEASE_KEYS has two keys with the same key ID")
    return keys, url.group(1)


def cli_module(s):
    """airfrog-cli's schema module: the firmware image constants,
    [client_constants], the models, chips and firmware, the release keys,
    [recovery_constants] and the CLI's output."""
    out = ['// Generated by airfrog-site\'s ci/schema.py from schema.toml. Don\'t edit.', '',
           '//! Airfrog\'s firmware image constants, models, chips and target firmware, the',
           '//! release keys and the CLI\'s output.', '', '#![allow(dead_code)]', '']
    for name, c in s.constants.items():
        if c.get('image'):
            out += rust_doc(c.get('comment'))
            if c['type'] == 'str':
                out.append('pub const %s: &str = %s;' % (name, rust_string(c['value'])))
            else:
                out.append('pub const %s: %s = %s;' % (name, c['type'], c['value']))
    for name, c in s.data['client_constants'].items():
        out += rust_doc(c.get('comment'))
        out.append('pub const %s: %s = %s;' % (name, c['type'], c['value']))
    out += ['/// The project name in a firmware image\'s app description.',
            'pub const PROJECT: &str = %s;' % rust_string(s.project), '']
    out += ['/// Released models: the firmware manifest\'s key, GET_HW_INFO\'s model and the',
            '/// name, and GET_HW_INFO\'s chip.', 'pub const MODELS: &[(&str, u16, &str, u16)] = &[']
    out += ['    (%s, %d, %s, %d),' % (rust_string(v['key']), v['value'], rust_string(v['name']),
                                      s.chips[v['chip']]['value'])
            for v in s.released()]
    test = s if s.test else load(test=True)
    numbers = lambda models: ', '.join(str(v['value']) for v in models)
    out += ['];', '', '/// Every model\'s number, released or not.', '#[cfg(not(test))]',
            'pub const MODEL_NUMBERS: &[u16] = &[%s];' % numbers(s.models),
            '/// Every model\'s number with airfrog-site\'s test models.', '#[cfg(test)]',
            'pub const MODEL_NUMBERS: &[u16] = &[%s];' % numbers(test.models)]
    out += ['/// airfrog-site\'s test models that aren\'t released.', '#[cfg(test)]',
            'pub const UNRELEASED_TEST_MODELS: &[u16] = &[%s];'
            % numbers(v for v in test.models if not v['released'] and v not in s.models)]
    out += ['', '/// The ESP32s Airfrog is built on: GET_HW_INFO\'s chip and the MCU\'s name',
            '/// and whether Airfrog has PSRAM.',
            'pub const CHIPS: &[(u16, &str, bool)] = &[']
    out += ['    (%d, %s, %s),' % (c['value'], rust_string(c['name']), 'true' if c.get('psram') else 'false')
            for c in s.chips.values()]
    out += ['];', '', '/// The architectures the CLI is released for: the operating system, the',
            '/// architecture or "" for any, and the Rust target.',
            'pub const CLI_TARGETS: &[(&str, &str, &str)] = &[']
    out += ['    (%s, %s, %s),' % tuple(rust_string(t[k]) for k in ('os', 'arch', 'target'))
            for t in s.data['cli_targets']]
    out += ['];', '', '/// Target MCUs: the name, and TARGETID\'s designer and parts.',
            'pub const TARGET_MCUS: &[(&str, u16, &[u16])] = &[']
    out += ['    (%s, 0x%03X, &[%s]),' % (rust_string(name), m['designer'], ', '.join('0x%04X' % p for p in m['parts']))
            for name, m in s.target_mcus.items()]
    out += ['];', '', '/// The states of the target\'s firmware.',
            'pub const RUNNING: &str = %s;' % rust_string(s.data['firmware_states']['RUNNING']),
            'pub const STOPPED: &str = %s;' % rust_string(s.data['firmware_states']['STOPPED'])]
    out += ['', '/// Target firmware: its name in extension metadata, TARGET\'s firmware ID and',
            '/// the name displayed.', 'pub const FIRMWARE: &[(&str, u32, &str)] = &[']
    out += ['    (%s, %d, %s),' % (rust_string(v['name']), v['value'], rust_string(v['entry']['text']))
            for v in s.enum('firmware').values if 'text' in v['entry']]
    keys, url = release_keys()
    out += ['];', '', '/// The release keys\' public halves in hex, from commissioning/release-keys.js.',
            'pub const RELEASE_KEYS: &[&str] = &[%s];' % ', '.join(rust_string(k) for k in keys), '',
            '/// The Airfrog manifest\'s address, from commissioning/release-keys.js.',
            'pub const AIRFROG_MANIFEST: &str = %s;' % rust_string(url), '']
    recovery = s.data.get('recovery_constants', {})
    out += rust_doc(recovery.get('comment'))
    out.append('pub mod recovery {')
    for name, c in recovery.items():
        if name == 'comment':
            continue
        out += ['    ' + line for line in rust_doc(c.get('comment'))]
        value = c['value']
        type_ = '&str' if c['type'] == 'str' else c['type']
        text = rust_string(value) if isinstance(value, str) else ('0x%X' % value if c.get('hex') else str(value))
        out.append('    pub const %s: %s = %s;' % (name, type_, text))
    out += ['}', '']
    output = s.data.get('cli_output', {})
    out += rust_doc(output.get('comment'))
    out.append('pub mod text {')
    first = True
    for group, entries in output.items():
        if group == 'comment':
            continue
        if not first:
            out.append('')
        first = False
        out += ['    ' + line for line in rust_doc(entries.get('comment'))]
        out.append('    pub mod %s {' % group.lower())
        for key, t in entries.items():
            if key == 'comment':
                continue
            if isinstance(t, dict) and t.get('comment'):
                out += ['        ' + line for line in rust_doc(t['comment'])]
            out += ['        ' + line if line else '' for line in
                    rust_text(s, key, t, 'cli_output.%s.%s' % (group, key), indent=8)]
        out.append('    }')
    out += ['}']
    return '\n'.join(out) + '\n'


# --------------------------------------------------------------------------
# Airfrog's home page
# --------------------------------------------------------------------------

def page_texts(s):
    """The texts of messages with `page = true`, and [client_constants], as a
    JS object literal that the firmware build puts in index.html as
    @PAGE_TEXTS@. References are replaced by their texts, as index.html can't
    import js/messages.js."""
    out = ['// Generated by airfrog-site\'s ci/schema.py from schema.toml. Don\'t edit.', '{']
    for name, m in s.messages.items():
        if not (isinstance(m, dict) and m.get('page')):
            continue
        for key, t in m['entries'].items():
            t = text_table(t)
            where = '%s.%s' % (name, key)
            if 'cases' in t or 'lookup' in t or t.get('linked'):
                raise SchemaError('%s is on the home page, which takes only text and args' % where)
            args = t.get('args', [])
            parts = resolve(s, t['text'], args, where)
            if args:
                body = ''.join(v.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')
                               if kind == 'text' else '${%s}' % v for kind, v in parts)
                value = '(%s) => `%s`' % (', '.join(args), body)
            else:
                value = js_string(''.join(v for _, v in parts))
            out.append('    %s: %s,' % (key, value))
    out += ['    %s: %s,' % (name, c['value']) for name, c in s.data['client_constants'].items()]
    out.append('}')
    return '\n'.join(out) + '\n'


# --------------------------------------------------------------------------
# Python
# --------------------------------------------------------------------------

def py_module(s):
    out = ['# Generated by airfrog-site\'s ci/schema.py from schema.toml. Don\'t edit.', '',
           '"""AWP\'s constants and layout offsets."""', '']
    for name, c in s.constants.items():
        n = name_in(c, 'py', name)
        if not n:
            continue
        out += comment_lines(c.get('comment'), '#')
        value = c['value']
        text = repr(value) if isinstance(value, str) else ('0x%02X' % value if c.get('hex') else str(value))
        out.append('%s = %s' % (n, text))
    out.append('')
    for e in s.all_enums():
        out += comment_lines(e.comment, '#')
        for v in e.values:
            if e.py_name(v):
                out.append('%s = %s' % (e.py_name(v), e.number(v)))
        out.append('')
    out.append('# Operation IDs, per service. ALL is every operation of a service.')
    for op, value in s.operations.items():
        out.append('OP_%s = %d' % (op, value))
    out += ['', '# The ESP32s Airfrog is built on: ESP-IDF\'s target to GET_HW_INFO\'s chip.', 'CHIPS = {']
    out += ['    %r: %d,' % (c['target'], c['value']) for c in s.chips.values()]
    out += ['}', '', '# Their names, by GET_HW_INFO\'s chip.', 'CHIP_NAMES = {']
    out += ['    %d: %r,' % (c['value'], c['name']) for c in s.chips.values()]
    out += ['}', '', '# Each model\'s number to its GET_HW_INFO chip.', 'MODEL_CHIPS = {']
    out += ['    %d: %d,' % (v['value'], s.chips[v['chip']]['value']) for v in s.models]
    out += ['}']
    out += ['', '# ERROR\'s codes\' names.', 'ERROR_NAMES = {']
    for v in s.enum('error').values:
        out.append('    %d: %r,' % (v['value'], v['name']))
    out += ['}', '']
    for layout in s.layouts.values():
        if layout.constants():
            out += comment_lines(layout.comment or '%s\'s fields.' % layout.name, '#')
            out += ['%s = %d' % c for c in layout.constants()] + ['']
    return '\n'.join(out).rstrip('\n') + '\n'


# --------------------------------------------------------------------------
# JS: constants and encoding
# --------------------------------------------------------------------------

def js_string(text):
    if "'" in text and '"' not in text:
        return '"%s"' % text.replace('\\', '\\\\')
    return "'%s'" % text.replace('\\', '\\\\').replace("'", "\\'")


def js_schema(s):
    out = ['// Generated by ci/schema.py from schema.toml. Don\'t edit.', '',
           '// AWP\'s constants and each layout\'s encoder and decoder. See',
           '// airfrog-v2/docs/websocket-protocol.md.', '']
    out += jsdoc('Airfrog\'s project name, which ESP-IDF writes into its firmware images.')
    out.append('export const PROJECT = %s;' % js_string(s.project))
    out.append('')
    for name, c in s.constants.items():
        n = name_in(c, 'js', name)
        if not n:
            continue
        out += jsdoc(c.get('comment'))
        value = c['value']
        text = js_string(value) if isinstance(value, str) else ('0x%02X' % value if c.get('hex') else str(value))
        out.append('export const %s = %s;' % (n, text))
    for name, c in s.data['client_constants'].items():
        out += jsdoc(c.get('comment'))
        out.append('export const %s = %s;' % (name, c['value']))
    out.append('')
    objects = {}
    for e in s.all_enums():
        values = [v for v in e.values if e.js_name(v)]
        if e.js.get('object'):
            objects[e.type] = e
            continue
        out += comment_lines(e.comment, '//')
        for v in values:
            out += jsdoc(v['entry'].get('comment'))
            out.append('export const %s = %s;' % (e.js_name(v), e.number(v)))
        out.append('')
        if 'list' in e.js:
            line = 'export const %s = Object.freeze([%s]);' % (e.js['list'], ', '.join(e.js_name(v) for v in values))
            if len(line) > 120:
                line = '\n'.join(['export const %s = Object.freeze([' % e.js['list']]
                                 + ['    %s,' % e.js_name(v) for v in values] + [']);'])
            out += [line, '']
        if 'names' in e.js:
            out += ['/**', ' * @param {number} value',
                    ' * @returns {string|undefined} value\'s name, for example %s' % values[0]['name'], ' */',
                    'export function %s(value) {' % e.js['names'], '    return {']
            out += ['        %s: %s,' % (e.number(v), js_string(v['name'])) for v in values]
            out += ['    }[value];', '}', '']
    for obj, e in objects.items():
        out += jsdoc(e.comment)
        out.append('export const %s = Object.freeze({' % obj)
        for v in e.values:
            if e.js_name(v):
                out += jsdoc(v['entry'].get('comment'), '    ')
                out.append('    %s: %s,' % (e.js_name(v), e.number(v)))
        out += ['});', '']
    out += jsdoc('Operation IDs, per service. ALL is every operation of a service.')
    out.append('export const %s = Object.freeze({' % s.operation_type)
    for op, value in s.operations.items():
        out.append('    %s: %d,' % (op, value))
    out += ['});', '']
    out += js_models(s)
    out += jsdoc('The architectures the Airfrog CLI is released for: each Rust target and its platform\'s name.')
    out += ['export const CLI_TARGETS = Object.freeze({'] + [
        '    %s: %s,' % (js_string(t['target']), js_string(t['platform'])) for t in s.data['cli_targets']] + ['});', '']
    for layout in s.layouts.values():
        if layout.constants():
            out += comment_lines(layout.comment or '%s\'s fields.' % layout.name, '//')
            out += ['export const %s = %d;' % c for c in layout.constants()]
            out += ['export const %s_%s_MAX = 0x%X;' % (layout.prefix.lstrip('_'), f.name.upper(),
                                                        (1 << 8 * SCALARS[f.type]) - 1)
                    for f in layout.fields if f.max] + ['']
    out += JS_CODEC.strip('\n').split('\n')
    out.append('')
    for layout in s.layouts.values():
        out += js_layout(s, layout)
    return '\n'.join(out).rstrip('\n') + '\n'


def js_models(s):
    out = jsdoc('Target MCUs Airfrog\'s rules identify, by TARGET\'s targetid\'s designer and part.')
    out.append('export const TARGET_MCUS = Object.freeze([')
    for name, m in s.target_mcus.items():
        parts = ', '.join('0x%03X' % p for p in m['parts'])
        out.append('    Object.freeze({ name: %s, designer: 0x%03X, parts: Object.freeze([%s]) }),'
                   % (js_string(name), m['designer'], parts))
    out += [']);', '']
    out += jsdoc('The ESP32s Airfrog is built on, by GET_HW_INFO\'s chip.')
    out.append('export const CHIPS = Object.freeze({')
    for c in s.chips.values():
        out.append('    %d: Object.freeze({ name: %s, target: %s, psram: %s }),'
                   % (c['value'], js_string(c['name']), js_string(c['target']), 'true' if c.get('psram') else 'false'))
    out += ['});', '']
    out += jsdoc('Released models\' numbers, GET_HW_INFO\'s model.')
    out.append('export const Model = Object.freeze({')
    for v in s.released():
        out.append('    %s: %d,' % (v['constant'], v['value']))
    out += ['});', '']
    out += jsdoc('Each model by number: its chip, and its name and key, which are null for a model not '
                 'released. The key is its firmware manifest key.')
    out.append('export const MODELS = Object.freeze({')
    for v in s.models:
        chip = s.chips[v['chip']]['value']
        if v['released']:
            out.append('    %d: Object.freeze({ chip: %d, name: %s, key: %s }),'
                       % (v['value'], chip, js_string(v['name']), js_string(v['key'])))
        else:
            out.append('    %d: Object.freeze({ chip: %d, name: null, key: null }),' % (v['value'], chip))
    out += ['});', '']
    return out


JS_CODEC = r'''
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Reads fields in order. A read past the end sets short and returns 0 or empty. */
class FieldReader {
    constructor(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.at = 0;
        this.short = false;
    }

    left() {
        return this.bytes.length - this.at;
    }

    take(n) {
        if (this.short || n > this.left()) {
            this.short = true;
            return null;
        }
        const at = this.at;
        this.at += n;
        return at;
    }

    u8() {
        const at = this.take(1);
        return at === null ? 0 : this.bytes[at];
    }

    i8() {
        const at = this.take(1);
        return at === null ? 0 : this.view.getInt8(at);
    }

    u16() {
        const at = this.take(2);
        return at === null ? 0 : this.view.getUint16(at, true);
    }

    u32() {
        const at = this.take(4);
        return at === null ? 0 : this.view.getUint32(at, true);
    }

    u64() {
        const at = this.take(8);
        return at === null ? 0n : this.view.getBigUint64(at, true);
    }

    bytesOf(n) {
        const at = this.take(n);
        return at === null ? new Uint8Array(0) : this.bytes.slice(at, at + n);
    }

    padded(n) {
        const b = this.bytesOf(n);
        const end = b.indexOf(0);
        return decoder.decode(end < 0 ? b : b.subarray(0, end));
    }

    text() {
        return decoder.decode(this.bytesOf(this.u16()));
    }

    rest() {
        return this.bytesOf(this.left());
    }

    list(count, read) {
        const out = [];
        for (let i = 0; i < count && !this.short; i++) {
            out.push(read());
        }
        return out;
    }

    /** A 2-byte length, then entries of entryLen bytes each. */
    variable(entryLen, read) {
        const n = this.u16();
        if (n % entryLen !== 0) {
            this.short = true;
        }
        return this.list(n / entryLen, read);
    }
}

/** Writes fields in order. */
class FieldWriter {
    constructor() {
        this.parts = [];
    }

    number(size, set, value) {
        const b = new Uint8Array(size);
        set(new DataView(b.buffer), value);
        this.parts.push(b);
    }

    u8(v) {
        this.parts.push(new Uint8Array([v ?? 0]));
    }

    i8(v) {
        this.number(1, (d, x) => d.setInt8(0, x), v ?? 0);
    }

    u16(v) {
        this.number(2, (d, x) => d.setUint16(0, x, true), v ?? 0);
    }

    u32(v) {
        this.number(4, (d, x) => d.setUint32(0, x >>> 0, true), v ?? 0);
    }

    u64(v) {
        this.number(8, (d, x) => d.setBigUint64(0, BigInt(x), true), v ?? 0);
    }

    /** n bytes: b, followed by zero bytes. */
    bytesOf(b, n) {
        const out = new Uint8Array(n);
        if (b) {
            if (b.length > n) {
                throw new RangeError(`${b.length} bytes for a ${n}-byte field`);
            }
            out.set(b);
        }
        this.parts.push(out);
    }

    padded(s, n) {
        this.bytesOf(encoder.encode(s ?? ''), n);
    }

    text(s) {
        const b = encoder.encode(s ?? '');
        this.u16(b.length);
        this.parts.push(b);
    }

    raw(b) {
        this.parts.push(b ?? new Uint8Array(0));
    }

    bytes() {
        const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of this.parts) {
            out.set(p, at);
            at += p.length;
        }
        return out;
    }
}
'''


def js_read(s, f):
    if f.type in SCALARS:
        return 'r.%s()' % f.type
    if f.type == 'bytes':
        return 'r.bytesOf(%d)' % f.size_value
    if f.type == 'padded':
        return 'r.padded(%d)' % f.size_value
    if f.type == 'text':
        return 'r.text()'
    if f.type == 'rest':
        return 'r.rest()'
    if f.type == 'layout':
        return 'read%s(r)' % camel(f.entry)
    if f.type == 'variable':
        entry = s.layouts[f.entry]
        return 'r.variable(%d, () => read%s(r))' % (entry.fixed_len, camel(entry.name))
    if f.type == 'list':
        item = 'r.%s()' % f.entry if f.entry in ('text', 'u16', 'u32') else 'read%s(r)' % camel(f.entry)
        return 'r.list(f.%s, () => %s)' % (lower_camel(f.count), item)
    raise SchemaError(f.type)


def js_min_size(f):
    """The fewest bytes an optional field takes."""
    return f.size_value if f.type in FIXED else 2


def js_write(s, layout, f):
    v = 'f.%s' % lower_camel(f.name) if f.name and f.type != 'reserved' else None
    if f.type in SCALARS:
        counted = [g for g in layout.fields if g.type == 'list' and g.count == f.name]
        if counted:
            v = '%s ?? (f.%s ?? []).length' % (v, lower_camel(counted[0].name))
        return ['w.%s(%s);' % (f.type, v)]
    if f.type == 'reserved':
        return ['w.bytesOf(null, %d);' % f.size_value]
    if f.type == 'bytes':
        return ['w.bytesOf(%s, %d);' % (v, f.size_value)]
    if f.type == 'padded':
        return ['w.padded(%s, %d);' % (v, f.size_value)]
    if f.type == 'text':
        return ['w.text(%s);' % v]
    if f.type == 'rest':
        return ['w.raw(%s);' % v]
    if f.type == 'layout':
        return ['write%s(w, %s ?? {});' % (camel(f.entry), v)]
    if f.type == 'variable':
        entry = s.layouts[f.entry]
        return ['w.u16((%s ?? []).length * %d);' % (v, entry.fixed_len),
                'for (const e of %s ?? []) {' % v, '    write%s(w, e);' % camel(entry.name), '}']
    if f.type == 'list':
        if f.entry in ('text', 'u16', 'u32'):
            item = 'w.%s(e);' % f.entry
        else:
            item = 'write%s(w, e);' % camel(f.entry)
        return ['for (const e of %s ?? []) {' % v, '    %s' % item, '}']
    raise SchemaError(f.type)


def js_layout(s, layout):
    name = camel(layout.name)
    what = layout.comment or '%s\'s fields.' % layout.name
    if what.split()[0] == 'A' or what[1].islower():
        what = what[0].lower() + what[1:]
    read = ['function read%s(r) {' % name, '    const f = {};']
    for f in layout.fields:
        if f.type == 'reserved' and f.optional:
            read.append('    if (r.left() >= %d) {' % f.size_value)
            read.append('        r.bytesOf(%d);' % f.size_value)
            read.append('    }')
        elif f.type == 'reserved':
            read.append('    r.bytesOf(%d);' % f.size_value)
        elif f.optional:
            read.append('    f.%s = r.left() >= %d ? %s : null;' % (lower_camel(f.name), js_min_size(f), js_read(s, f)))
        else:
            read.append('    f.%s = %s;' % (lower_camel(f.name), js_read(s, f)))
    read += ['    return f;', '}', '']
    write = ['function write%s(w, f) {' % name]
    for f in layout.fields:
        write += ['    ' + line for line in js_write(s, layout, f)]
    write += ['}', '']
    api = ['/**', ' * Decodes %s' % what,
           ' * @param {Uint8Array} p',
           ' * @returns {object|null} the fields, null when p is too short for them.',
           ' *          Bytes after them are ignored',
           ' */',
           'export function decode%s(p) {' % name,
           '    const r = new FieldReader(p);',
           '    const f = read%s(r);' % name,
           '    return r.short ? null : f;',
           '}', '',
           '/**', ' * Encodes %s' % what,
           ' * @param {object} f - the fields. A missing field is 0 or empty',
           ' * @returns {Uint8Array}',
           ' */',
           'export function encode%s(f) {' % name,
           '    const w = new FieldWriter();',
           '    write%s(w, f);' % name,
           '    return w.bytes();',
           '}', '']
    return read + write + api


# --------------------------------------------------------------------------
# JS: js/messages.js
# --------------------------------------------------------------------------

class Messages:
    """js/messages.js from [firmware_states], [enums.firmware], [services]
    and [messages]."""

    def __init__(self, s):
        self.s = s
        self.declared = {}

    def check(self):
        self.generate()

    def generate(self):
        s = self.s
        out = ['// Generated by ci/schema.py from schema.toml. Don\'t edit.', '']
        out += comment_lines(s.messages.get('comment'), '//')
        out.append('')
        out += ['/**', ' * A text with a link: strings, and { url } where the link is, which the page',
                ' * displays as the URL.', ' * @typedef {Array<string|{url: string}>} LinkedText', ' */', '']
        firmware = s.enum('firmware')
        out += jsdoc('The firmware Airfrog identifies, by TARGET\'s firmware ID: its name.')
        out.append('export const FIRMWARE = {')
        for v in firmware.values:
            if 'text' in v['entry']:
                out.append('    %d: { name: %s },' % (v['value'], js_string(v['entry']['text'])))
        out += ['};', '']
        out += jsdoc(s.firmware_states.get('comment'))
        for name, text in s.firmware_states.items():
            if name != 'comment':
                out.append('export const %s = %s;' % (name, js_string(text)))
                self.declared[name] = None
        out.append('')
        out += jsdoc(s.data['services'].get('messages_comment'))
        out.append('export const SERVICES = {')
        for name, svc in s.services.items():
            ops = ', '.join('%d: %s' % (v, js_string(k)) for k, v in svc.get('operations', {}).items())
            parts = ['name: %s' % js_string(name), 'operations: { %s }' % ops]
            if 'description' in svc:
                parts.append('description: %s' % js_string(svc['description']))
            out.append('    %d: { %s },' % (svc['value'], ', '.join(parts)))
        out += ['};', '']
        for name, m in s.messages.items():
            if not isinstance(m, dict) or isinstance(m.get('rust'), str):
                continue
            out += self.message(name, m)
        out += ['export { firmwareState, targetState } from \'./target-state.js\';']
        return '\n'.join(out) + '\n'

    def message(self, name, m):
        out = jsdoc(m.get('comment'))
        export = 'export ' if m.get('export', True) else ''
        if 'entries' in m:
            keys = m.get('keys')
            out.append('%sconst %s = {' % (export, name))
            entries = {}
            for key, text in m['entries'].items():
                t = text if isinstance(text, dict) else {'text': text}
                if m.get('functions'):
                    t = dict(t, args=t.get('args', []))
                prop = key
                if keys == 'errors':
                    errors = {v['name']: v['value'] for v in self.s.enum('error').values}
                    if key not in errors:
                        raise SchemaError('%s.%s is not an ERROR code' % (name, key))
                    prop = str(errors[key])
                doc = t.get('comment')
                if t.get('linked'):
                    doc = '@returns {LinkedText}' + (' ' + doc[0].lower() + doc[1:].rstrip('.') if doc else '')
                out += jsdoc(doc, '    ')
                out.append('    %s: %s,' % (prop, self.text(t, '%s.%s' % (name, key))))
                entries[key] = None
            out += ['};', '']
            self.declared[name] = entries
        else:
            out.append('%sconst %s = %s;' % (export, name, self.text(m, name)))
            out.append('')
            self.declared[name] = None
        return out

    def text(self, t, where):
        args = t.get('args')
        if 'cases' in t:
            body = self.cases(t['cases'], args, where)
        else:
            body = self.string(t['text'], args or [], where, t.get('linked'))
            if 'lookup' in t:
                if self.declared.get(t['lookup']) is None:
                    raise SchemaError('%s looks up %s, which isn\'t a message before it' % (where, t['lookup']))
                body = '%s[%s] ?? %s' % (t['lookup'], args[0], body)
        if args is None:
            return body
        return '(%s) => %s' % (', '.join(args), body)

    def cases(self, cases, args, where):
        arg = args[0]
        out = []
        for c in cases[:-1]:
            if 'is' in c:
                cond = '%s === %s' % (arg, c['is'])
            elif c.get('absent'):
                cond = '%s === null || %s === undefined' % (arg, arg)
            elif c.get('falsy'):
                cond = '!%s' % arg
            else:
                raise SchemaError('%s has a case without a condition' % where)
            out.append('%s ? %s' % (cond, self.string(c['text'], args, where)))
        return ' : '.join(out + [self.string(cases[-1]['text'], args, where)])

    def string(self, text, args, where, linked=False):
        if linked:
            if text.count('{url}') != 1:
                raise SchemaError('%s is linked and has {url} other than once' % where)
            before, after = text.split('{url}')
            parts = [self.string(p, args, where) for p in (before, after) if p]
            if before:
                parts.insert(1, '{ url }')
            else:
                parts.insert(0, '{ url }')
            return '[%s]' % ', '.join(parts)
        pieces = []
        whole = PLACEHOLDER.fullmatch(text)
        for i, piece in enumerate(PLACEHOLDER.split(text)):
            if i % 2 == 0:
                pieces.append(('text', piece))
                continue
            if piece in args:
                pieces.append(('expr', piece))
            elif piece in self.s.constants:
                pieces.append(('text', str(self.s.constants[piece]['value'])))
            elif piece in self.s.data['client_constants']:
                pieces.append(('text', str(self.s.data['client_constants'][piece]['value'])))
            else:
                self.reference(piece, where)
                pieces.append(('expr', piece))
        if whole and pieces[1][0] == 'expr':
            return pieces[1][1]
        if all(kind == 'text' for kind, _ in pieces):
            return js_string(''.join(p for _, p in pieces))
        body = ''.join(p.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${') if kind == 'text'
                       else '${%s}' % p for kind, p in pieces)
        return '`%s`' % body

    def reference(self, name, where):
        group, _, key = name.partition('.')
        if group not in self.declared:
            raise SchemaError('%s refers to %s, which isn\'t a message before it' % (where, name))
        if key and (self.declared[group] is None or key not in self.declared[group]):
            raise SchemaError('%s refers to %s, which isn\'t an entry of %s' % (where, name, group))


def js_messages(s):
    return Messages(s).generate()


# --------------------------------------------------------------------------
# docs/websocket-protocol.md
# --------------------------------------------------------------------------

SPEC = 'docs/websocket-protocol.md'
OFFSET_TABLES = ('Offset', 'Entry offset', 'Response offset')
OPERATION = re.compile(r'\b([A-Z][A-Z0-9_]+) \(operation (\d+)\)')


def spec_tables(path):
    """Each heading's tables, as (header, rows) with each row's cells."""
    sections, heading, table = {}, None, None
    with open(path) as f:
        for line in f:
            line = line.rstrip('\n')
            if line.startswith('#'):
                heading, table = line, None
                sections.setdefault(heading, [])
            elif line.startswith('|') and heading:
                cells = [c.strip() for c in line.strip().strip('|').split('|')]
                if table is None:
                    table = (cells, [])
                    sections[heading].append(table)
                elif not all(set(c) <= set('-: ') for c in cells):
                    table[1].append(cells)
            else:
                table = None
    return sections


def spec_table(sections, heading, first, problems, index=1):
    """The rows of heading's index-th table whose first column is one of
    first."""
    tables = [rows for header, rows in sections.get(heading, []) if header[0] in first]
    if len(tables) < index:
        problems.append('%s: no table %d with %s' % (heading, index, ' or '.join(first)))
        return []
    return tables[index - 1]


def spec_name(text):
    """A close code's name in the spec as the schema writes it: Going away
    (WebSocket's) is GOING_AWAY."""
    return re.sub(r'\s*\(.*\)', '', text).strip().upper().replace(' ', '_')


def spec_field(s, f):
    """A layout field's (offset, size, name) as the spec writes them. The
    first field without a fixed size has an offset too."""
    first = next(g for g in f.layout.fields if g.type not in FIXED) if f.layout.variable else None
    offset = str(f.layout.fixed_len) if f is first else '' if f.offset is None else str(f.offset)
    if f.type in FIXED:
        size = str(f.size_value)
    elif f.type in ('text', 'variable', 'layout'):
        size = 'variable'
    elif f.type == 'rest':
        size = 'rest'
    elif f.entry in SCALARS:
        size = '%d each' % SCALARS[f.entry]
    elif f.entry in s.layouts and not s.layouts[f.entry].variable:
        size = '%d each' % s.layouts[f.entry].fixed_len
    else:
        size = 'variable'
    return offset, size, '' if f.type == 'reserved' else f.name


def check_spec(s, path):
    """Where websocket-protocol.md's message, command, error, firmware ID,
    close code, service, operation and layout tables differ from the
    schema."""
    problems = []
    sections = spec_tables(path)

    def compare(what, spec, schema):
        for name, value in spec.items():
            if name not in schema:
                problems.append('%s %s is in the spec but not the schema' % (what, name))
            elif name in schema and schema[name] != value:
                problems.append('%s %s is %s in the spec and %s in the schema' % (what, name, value, schema[name]))
        for name in schema:
            if name not in spec:
                problems.append('%s %s is in the schema but not the spec' % (what, name))

    def values(key):
        return {v['entry'].get('doc', v['name']) if key == 'close' else v['name']: v['value']
                for v in s.enum(key).values}

    rows = spec_table(sections, '## Messages', ('Type',), problems)
    compare('Message type', {r[1]: int(r[0], 16) for r in rows}, values('type'))
    rows = spec_table(sections, '### AIRFROG_CMD', ('Command',), problems)
    compare('Command', {r[1]: int(r[0], 16) for r in rows}, values('command'))
    rows = spec_table(sections, '### ERROR', ('Code',), problems)
    compare('ERROR code', {r[1]: int(r[0]) for r in rows}, values('error'))
    rows = spec_table(sections, '### TARGET', ('ID',), problems)
    compare('Firmware ID', {r[1]: int(r[0]) for r in rows}, values('firmware'))
    for r, v in ((r, v) for r in rows for v in s.enum('firmware').values if v['name'] == r[1]):
        if r[2] != v['entry'].get('text', r[2]):
            problems.append('Firmware ID %s is %s in the spec and %s in the schema' % (v['name'], r[2], v['entry']['text']))
    rows = spec_table(sections, '## Close codes', ('Code',), problems)
    closes = {spec_name(v['entry'].get('doc', v['name'])): v['value'] for v in s.enum('close').values}
    compare('Close code', {spec_name(r[1]): int(r[0]) for r in rows}, closes)
    rows = spec_table(sections, '## Services', ('ID',), problems)
    compare('Service', {r[1]: int(r[0]) for r in rows}, {k: v['value'] for k, v in s.services.items()})

    ops = {}
    for r in spec_table(sections, '### RESET', ('ID',), problems):
        ops[('RESET', r[1])] = int(r[0])
    with open(path) as f:
        text = f.read()
    for heading, body in re.findall(r'^### (\S.*)\n((?:(?!^##).*\n)*)', text, re.M):
        services = [n for n in s.services if n in heading]
        for op, value in OPERATION.findall(body):
            for svc in services:
                ops[(svc, op)] = int(value)
    schema_ops = {(svc, op): v for svc, t in s.services.items() for op, v in t.get('operations', {}).items()}
    compare('Operation', {'%s %s' % k: v for k, v in ops.items()}, {'%s %s' % k: v for k, v in schema_ops.items()})

    for layout in s.layouts.values():
        doc = layout.doc
        if doc is False:
            continue
        if doc is None:
            problems.append('layout %s has no doc' % layout.name)
            continue
        rows = spec_table(sections, doc, OFFSET_TABLES, problems, layout.doc_table)
        spec = [tuple(r[:3]) for r in rows]
        schema = [spec_field(s, f) for f in layout.fields]
        if spec != schema:
            problems.append('%s table %d differs from layout %s: %s against %s'
                            % (doc, layout.doc_table, layout.name, spec, schema))
    return problems


RECOVERY_SPEC = 'docs/recovery-protocol.md'


def mb(size):
    """A size as the docs write it in MB, for example 1.5 MB."""
    return ('%g MB' % (size / (1024 * 1024)))


def check_recovery(s, directory):
    """Where recovery-protocol.md's request header and result tables differ
    from [recovery_constants], and the values the text around them states."""
    c = {k: v['value'] for k, v in s.data.get('recovery_constants', {}).items() if k != 'comment'}
    problems = []

    def rows(sections, first, where, heading=None):
        tables = [r for h in sections if heading in (None, h)
                  for header, r in sections[h] if header[0] == first]
        if len(tables) != 1:
            problems.append('%s: %d tables with %s, expected 1' % (where, len(tables), first))
            return []
        return tables[0]

    def fields(rows, expected, where):
        found = [tuple(r[:3]) for r in rows]
        want = [(str(o), str(n), f) for o, n, f in expected]
        if found != want:
            problems.append('%s: %s against %s' % (where, found, want))

    def cell(rows, field, text, where):
        row = next((r for r in rows if r[2] == field), None)
        if row is None or text not in row[-1]:
            problems.append('%s: %s doesn\'t contain %s' % (where, field or 'a row', text))

    def says(path, text):
        with open(path) as f:
            body = ' '.join(f.read().split())
        if text not in body:
            problems.append('%s doesn\'t contain "%s"' % (os.path.basename(path), text))

    spec = os.path.join(directory, RECOVERY_SPEC)
    sections = spec_tables(spec)
    where = 'recovery-protocol.md request header'
    header = rows(sections, 'Offset', where, '## The request header')
    fields(header, [
        (0, len(c['REQUEST_MAGIC']), 'Magic'),
        (c['REQUEST_VERSION_OFFSET'], 1, 'Version'),
        (c['REQUEST_ACTION_OFFSET'], 1, 'Action'),
        (c['REQUEST_RESULT_OFFSET'], 1, 'Result'),
        (c['REQUEST_ZERO_OFFSET'], 1, ''),
        (c['REQUEST_IMAGE_SIZE_OFFSET'], 4, 'Image size'),
        (c['REQUEST_IMAGE_SHA256_OFFSET'], 32, 'Image SHA-256'),
        (c['REQUEST_RESULT_ADDR_OFFSET'], 4, 'Result address'),
        (c['REQUEST_RESERVED_OFFSET'], c['REQUEST_LEN'] - c['REQUEST_RESERVED_OFFSET'], ''),
    ], where)
    cell(header, 'Magic', '`%s`' % c['REQUEST_MAGIC'], where)
    cell(header, 'Version', str(c['REQUEST_VERSION']), where)
    cell(header, 'Action', '%d reinstall' % c['ACTION_REINSTALL'], where)
    cell(header, 'Action', '%d erase' % c['ACTION_ERASE'], where)
    cell(header, 'Result address', '%d-byte' % c['RESULT_LEN'], where)
    results = {r[0] for r in rows(sections, 'Result', 'recovery-protocol.md results')}
    want = {str(v) for k, v in c.items() if k.startswith('RESULT_') and k not in ('RESULT_ADDR', 'RESULT_LEN')}
    if results != want:
        problems.append('recovery-protocol.md results: %s against %s' % (sorted(results), sorted(want)))
    says(spec, 'the %d-byte header at 0x%X' % (c['REQUEST_LEN'], c['REQUEST_ADDR']))
    says(spec, 'starts at 0x%X and is at most %s' % (c['IMAGE_ADDR'], mb(c['IMAGE_MAX'])))

    return problems


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------

def files(target, directory):
    if target == 'site':
        return directory or ROOT, SITE_FILES
    if target == 'v2' and directory:
        return directory, V2_FILES
    raise SystemExit(__doc__)


def model(s, key, field=None):
    """The model with key key as JSON, or field's value."""
    for v in s.models:
        if v['key'] == key:
            out = {'value': v['value'], 'name': v['name'], 'key': v['key'], 'constant': v['constant'],
                   'released': v['released'], 'target': s.chips[v['chip']]['target']}
            if field is None:
                return json.dumps(out)
            if field not in out:
                raise SchemaError('a model doesn\'t have %s' % field)
            return str(out[field]).lower() if isinstance(out[field], bool) else str(out[field])
    raise SchemaError('no model has the key %s' % key)


def check_names(s, paths):
    """Each file in paths that contains an unreleased model's name after
    "airfrog" and a hyphen, underscore or space, ignoring case, as in its
    release files' names, its manifest key and its display name. The name's
    words may be separated by a space, a hyphen or an underscore. The name
    alone isn't matched, as a short name is also an ordinary word."""
    names = [re.compile(rb'airfrog[-_ ]' + rb'[-_ ]'.join(re.escape(w.lower().encode()) for w in n.split(' '))
                        + rb'(?![a-z0-9])')
             for n in s.unreleased_names()]
    found = []

    def read(path):
        if os.path.realpath(path) in (os.path.realpath(SCHEMA), os.path.realpath(TEST_MODELS)):
            return
        with open(path, 'rb') as f:
            data = f.read().lower()
        if any(n.search(data) for n in names):
            found.append(path)

    for top in paths:
        if os.path.isfile(top):
            read(top)
            continue
        for directory, dirs, names_in in os.walk(top):
            dirs[:] = sorted(d for d in dirs if d not in SKIPPED_DIRS)
            for name in sorted(names_in):
                path = os.path.join(directory, name)
                if os.path.isfile(path):
                    read(path)
    return found


def main(argv):
    test = argv[:1] == ['--test']
    if test:
        argv = argv[1:]
    if argv == ['models']:
        for v in load(test).models:
            print(v['key'])
        return 0
    if len(argv) in (2, 3) and argv[0] == 'model':
        print(model(load(test), *argv[1:]))
        return 0
    if len(argv) >= 3 and argv[:2] == ['check', 'names']:
        found = check_names(load(test), argv[2:])
        for path in found:
            print('%s contains an unreleased model\'s name' % path, file=sys.stderr)
        return 1 if found else 0
    if len(argv) < 2 or argv[0] not in ('write', 'check') or (test and len(argv) < 3):
        raise SystemExit(__doc__)
    directory, generated = files(argv[1], argv[2] if len(argv) > 2 else None)
    s = load(test)
    stale = []
    for path, generate in generated.items():
        full = os.path.join(directory, path)
        text = generate(s)
        if argv[0] == 'write':
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, 'w') as f:
                f.write(text)
            continue
        try:
            with open(full) as f:
                current = f.read()
        except FileNotFoundError:
            current = None
        if current != text:
            stale.append(full)
    for path in stale:
        print('%s differs from schema.toml. Use ci/schema.py write.' % path, file=sys.stderr)
    problems = []
    if argv[0] == 'check' and argv[1] == 'v2':
        problems = ['%s: %s' % (SPEC, p) for p in check_spec(s, os.path.join(directory, SPEC))]
        problems += check_recovery(s, directory)
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if stale or problems else 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (SchemaError, tomllib.TOMLDecodeError) as e:
        print('schema.toml: %s' % e, file=sys.stderr)
        sys.exit(1)
