import { describe, it, expect } from 'vitest';

import {
  normalizePath,
  denormalizePath,
  sha1Text,
  sha1Bytes,
  makeSymbolId,
  guessLanguage,
  isTestPath,
  safeInt,
  safeFloat,
  safeJsonParse,
  generateSessionKey,
  parseClientType,
  nowSeconds,
  secondsToDate,
  dateToSeconds,
} from 'graphd/utils.js';

// ============================================
// normalizePath
// ============================================

describe('normalizePath', () => {
  it('converts_absolute_path_to_repo_relative', () => {
    expect(normalizePath('/repo/src/foo.ts', '/repo')).toBe('src/foo.ts');
  });

  it('keeps_already_relative_path_unchanged', () => {
    expect(normalizePath('src/foo.ts', '/repo')).toBe('src/foo.ts');
  });

  it('returns_empty_string_for_empty_input', () => {
    expect(normalizePath('', '/repo')).toBe('');
  });

  it('resolves_dotdot_segments_in_absolute_path', () => {
    expect(normalizePath('/repo/src/../lib/bar.ts', '/repo')).toBe('lib/bar.ts');
  });

  it('resolves_dotdot_segments_in_relative_path', () => {
    expect(normalizePath('src/../lib/bar.ts', '/repo')).toBe('lib/bar.ts');
  });

  it('produces_dotdot_prefix_when_file_is_outside_root', () => {
    expect(normalizePath('/other/file.ts', '/repo')).toBe('../other/file.ts');
  });

  it('returns_empty_string_when_path_equals_root', () => {
    // posix.relative('/repo', '/repo') => ''
    expect(normalizePath('/repo', '/repo')).toBe('');
  });

  it('handles_deeply_nested_paths', () => {
    expect(normalizePath('/repo/a/b/c/d/e.ts', '/repo')).toBe('a/b/c/d/e.ts');
  });

  it('strips_trailing_slash_on_root', () => {
    // posix.resolve normalizes trailing slashes
    expect(normalizePath('/repo/src/x.ts', '/repo/')).toBe('src/x.ts');
  });
});

// ============================================
// denormalizePath
// ============================================

describe('denormalizePath', () => {
  it('joins_relative_path_with_root', () => {
    expect(denormalizePath('src/foo.ts', '/repo')).toBe('/repo/src/foo.ts');
  });

  it('returns_absolute_path_unchanged', () => {
    expect(denormalizePath('/abs/path/file.ts', '/repo')).toBe('/abs/path/file.ts');
  });

  it('returns_empty_string_for_empty_input', () => {
    expect(denormalizePath('', '/repo')).toBe('');
  });

  it('resolves_dotdot_segments', () => {
    expect(denormalizePath('src/../lib/bar.ts', '/repo')).toBe('/repo/lib/bar.ts');
  });

  it('handles_single_filename', () => {
    expect(denormalizePath('README.md', '/repo')).toBe('/repo/README.md');
  });
});

// ============================================
// sha1Text
// ============================================

describe('sha1Text', () => {
  it('returns_40_char_hex_digest', () => {
    const hash = sha1Text('hello');
    expect(hash.length).toBe(40);
  });

  it('matches_known_sha1_for_hello', () => {
    // SHA1("hello") = aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
    expect(sha1Text('hello')).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
  });

  it('produces_different_hashes_for_different_inputs', () => {
    expect(sha1Text('a')).not.toBe(sha1Text('b'));
  });

  it('is_deterministic_across_calls', () => {
    expect(sha1Text('test')).toBe(sha1Text('test'));
  });

  it('handles_empty_string', () => {
    // SHA1("") = da39a3ee5e6b4b0d3255bfef95601890afd80709
    expect(sha1Text('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('handles_unicode_content', () => {
    const hash = sha1Text('こんにちは');
    expect(hash.length).toBe(40);
    // Must differ from ASCII
    expect(hash).not.toBe(sha1Text('hello'));
  });

  it('handles_multiline_content', () => {
    const hash = sha1Text('line1\nline2\n');
    expect(hash.length).toBe(40);
    expect(hash).not.toBe(sha1Text('line1line2'));
  });
});

// ============================================
// sha1Bytes
// ============================================

describe('sha1Bytes', () => {
  it('matches_known_sha1_for_hello_bytes', () => {
    expect(sha1Bytes(Buffer.from('hello'))).toBe(
      'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
    );
  });

  it('handles_empty_buffer', () => {
    expect(sha1Bytes(Buffer.alloc(0))).toBe(
      'da39a3ee5e6b4b0d3255bfef95601890afd80709',
    );
  });

  it('handles_binary_data_with_null_bytes', () => {
    const buf = Buffer.from([0x00, 0xff, 0x00, 0xff]);
    const hash = sha1Bytes(buf);
    expect(hash.length).toBe(40);
    // Null-containing buffer must not equal empty
    expect(hash).not.toBe(sha1Bytes(Buffer.alloc(0)));
  });

  it('matches_sha1Text_for_same_utf8_content', () => {
    const text = 'same content';
    expect(sha1Bytes(Buffer.from(text, 'utf8'))).toBe(sha1Text(text));
  });
});

// ============================================
// makeSymbolId
// ============================================

describe('makeSymbolId', () => {
  it('returns_exactly_16_characters', () => {
    const id = makeSymbolId('src/foo.ts', 'function', 'bar', 10, 50);
    expect(id.length).toBe(16);
  });

  it('is_deterministic_for_same_inputs', () => {
    const a = makeSymbolId('src/foo.ts', 'function', 'bar', 10, 50);
    const b = makeSymbolId('src/foo.ts', 'function', 'bar', 10, 50);
    expect(a).toBe(b);
  });

  it('changes_when_file_path_differs', () => {
    const a = makeSymbolId('src/a.ts', 'function', 'bar', 10, 50);
    const b = makeSymbolId('src/b.ts', 'function', 'bar', 10, 50);
    expect(a).not.toBe(b);
  });

  it('changes_when_kind_differs', () => {
    const a = makeSymbolId('src/a.ts', 'function', 'bar', 10, 50);
    const b = makeSymbolId('src/a.ts', 'class', 'bar', 10, 50);
    expect(a).not.toBe(b);
  });

  it('changes_when_name_differs', () => {
    const a = makeSymbolId('src/a.ts', 'function', 'bar', 10, 50);
    const b = makeSymbolId('src/a.ts', 'function', 'baz', 10, 50);
    expect(a).not.toBe(b);
  });

  it('changes_when_span_start_differs', () => {
    const a = makeSymbolId('src/a.ts', 'function', 'bar', 10, 50);
    const b = makeSymbolId('src/a.ts', 'function', 'bar', 11, 50);
    expect(a).not.toBe(b);
  });

  it('changes_when_span_end_differs', () => {
    const a = makeSymbolId('src/a.ts', 'function', 'bar', 10, 50);
    const b = makeSymbolId('src/a.ts', 'function', 'bar', 10, 51);
    expect(a).not.toBe(b);
  });

  it('is_prefix_of_full_sha1', () => {
    const id = makeSymbolId('src/foo.ts', 'function', 'bar', 10, 50);
    const full = sha1Text('src/foo.ts:function:bar:10:50');
    expect(full.startsWith(id)).toBe(true);
  });

  it('contains_only_hex_characters', () => {
    const id = makeSymbolId('src/foo.ts', 'class', 'Widget', 0, 100);
    expect(/^[0-9a-f]{16}$/.test(id)).toBe(true);
  });
});

// ============================================
// guessLanguage
// ============================================

describe('guessLanguage', () => {
  it('detects_typescript_from_ts_extension', () => {
    expect(guessLanguage('src/foo.ts')).toBe('typescript');
  });

  it('detects_typescript_from_tsx_extension', () => {
    expect(guessLanguage('components/App.tsx')).toBe('typescript');
  });

  it('detects_javascript_from_js_extension', () => {
    expect(guessLanguage('index.js')).toBe('javascript');
  });

  it('detects_javascript_from_jsx_extension', () => {
    expect(guessLanguage('App.jsx')).toBe('javascript');
  });

  it('detects_python_from_py_extension', () => {
    expect(guessLanguage('main.py')).toBe('python');
  });

  it('detects_go_from_go_extension', () => {
    expect(guessLanguage('main.go')).toBe('go');
  });

  it('detects_rust_from_rs_extension', () => {
    expect(guessLanguage('lib.rs')).toBe('rust');
  });

  it('detects_java_from_java_extension', () => {
    expect(guessLanguage('Main.java')).toBe('java');
  });

  it('detects_c_from_c_extension', () => {
    expect(guessLanguage('main.c')).toBe('c');
  });

  it('detects_c_from_h_extension', () => {
    expect(guessLanguage('header.h')).toBe('c');
  });

  it('detects_cpp_from_cpp_extension', () => {
    expect(guessLanguage('main.cpp')).toBe('cpp');
  });

  it('detects_cpp_from_hpp_extension', () => {
    expect(guessLanguage('header.hpp')).toBe('cpp');
  });

  it('detects_ruby_from_rb_extension', () => {
    expect(guessLanguage('Gemfile.rb')).toBe('ruby');
  });

  it('detects_shell_from_sh_extension', () => {
    expect(guessLanguage('run.sh')).toBe('shell');
  });

  it('detects_shell_from_bash_extension', () => {
    expect(guessLanguage('run.bash')).toBe('shell');
  });

  it('detects_shell_from_zsh_extension', () => {
    expect(guessLanguage('run.zsh')).toBe('shell');
  });

  it('detects_json_from_json_extension', () => {
    expect(guessLanguage('package.json')).toBe('json');
  });

  it('detects_yaml_from_yml_extension', () => {
    expect(guessLanguage('config.yml')).toBe('yaml');
  });

  it('detects_yaml_from_yaml_extension', () => {
    expect(guessLanguage('config.yaml')).toBe('yaml');
  });

  it('detects_toml_from_toml_extension', () => {
    expect(guessLanguage('Cargo.toml')).toBe('toml');
  });

  it('detects_markdown_from_md_extension', () => {
    expect(guessLanguage('README.md')).toBe('markdown');
  });

  it('detects_sql_from_sql_extension', () => {
    expect(guessLanguage('schema.sql')).toBe('sql');
  });

  it('detects_html_from_html_extension', () => {
    expect(guessLanguage('index.html')).toBe('html');
  });

  it('detects_css_from_css_extension', () => {
    expect(guessLanguage('style.css')).toBe('css');
  });

  it('detects_scss_from_scss_extension', () => {
    expect(guessLanguage('style.scss')).toBe('scss');
  });

  it('detects_less_from_less_extension', () => {
    expect(guessLanguage('style.less')).toBe('less');
  });

  it('detects_javascript_from_mjs_extension', () => {
    expect(guessLanguage('utils.mjs')).toBe('javascript');
  });

  it('detects_javascript_from_cjs_extension', () => {
    expect(guessLanguage('config.cjs')).toBe('javascript');
  });

  it('detects_typescript_from_mts_extension', () => {
    expect(guessLanguage('types.mts')).toBe('typescript');
  });

  it('detects_typescript_from_cts_extension', () => {
    expect(guessLanguage('config.cts')).toBe('typescript');
  });

  it('returns_unknown_for_unrecognized_extension', () => {
    expect(guessLanguage('data.parquet')).toBe('unknown');
  });

  it('returns_unknown_for_no_extension', () => {
    expect(guessLanguage('Makefile')).toBe('unknown');
  });

  it('is_case_insensitive', () => {
    expect(guessLanguage('FOO.TS')).toBe('typescript');
  });

  it('handles_dotfiles_with_no_real_extension', () => {
    // .gitignore -> ext is ".gitignore", which is not in the map
    expect(guessLanguage('.gitignore')).toBe('unknown');
  });

  it('uses_last_extension_for_double_dot_files', () => {
    // posix.extname("foo.test.ts") => ".ts"
    expect(guessLanguage('foo.test.ts')).toBe('typescript');
  });
});

// ============================================
// isTestPath
// ============================================

describe('isTestPath', () => {
  // --- happy paths (detected as test) ---

  it('detects_file_inside_tests_directory', () => {
    expect(isTestPath('src/tests/foo.ts')).toBe(true);
  });

  it('detects_file_starting_with_tests_directory', () => {
    expect(isTestPath('tests/foo.ts')).toBe(true);
  });

  it('detects_test_underscore_prefix_python', () => {
    expect(isTestPath('test_utils.py')).toBe(true);
  });

  it('detects_underscore_test_suffix_python', () => {
    expect(isTestPath('utils_test.py')).toBe(true);
  });

  it('detects_underscore_spec_suffix_python', () => {
    expect(isTestPath('utils_spec.py')).toBe(true);
  });

  it('detects_dot_test_dot_ts_suffix', () => {
    expect(isTestPath('foo.test.ts')).toBe(true);
  });

  it('detects_dot_test_dot_js_suffix', () => {
    expect(isTestPath('foo.test.js')).toBe(true);
  });

  it('detects_dot_spec_dot_ts_suffix', () => {
    expect(isTestPath('foo.spec.ts')).toBe(true);
  });

  it('detects_dot_spec_dot_js_suffix', () => {
    expect(isTestPath('foo.spec.js')).toBe(true);
  });

  it('detects_tests_directory_case_insensitively', () => {
    expect(isTestPath('src/Tests/Foo.ts')).toBe(true);
  });

  it('detects_test_prefix_case_insensitively', () => {
    expect(isTestPath('Test_Foo.py')).toBe(true);
  });

  it('normalizes_backslashes_before_matching', () => {
    expect(isTestPath('src\\tests\\foo.ts')).toBe(true);
  });

  // --- sad paths (not detected as test) ---

  it('rejects_file_with_test_in_name_but_wrong_pattern', () => {
    expect(isTestPath('src/testing/utils.ts')).toBe(false);
  });

  it('rejects_file_with_test_substring_in_filename', () => {
    expect(isTestPath('src/contest.ts')).toBe(false);
  });

  it('rejects_normal_source_file', () => {
    expect(isTestPath('src/utils.ts')).toBe(false);
  });

  it('rejects_test_dot_ts_without_dot_test_suffix', () => {
    // "test.ts" -> basename is "test.ts", doesn't start with "test_" nor end with patterns
    expect(isTestPath('src/test.ts')).toBe(false);
  });

  it('rejects_testimony_file', () => {
    expect(isTestPath('src/testimony.py')).toBe(false);
  });

  it('detects_tsx_spec_files', () => {
    expect(isTestPath('foo.spec.tsx')).toBe(true);
  });

  it('detects_tsx_test_files', () => {
    expect(isTestPath('foo.test.tsx')).toBe(true);
  });

  it('detects_jsx_test_files', () => {
    expect(isTestPath('App.test.jsx')).toBe(true);
  });

  it('detects_jsx_spec_files', () => {
    expect(isTestPath('App.spec.jsx')).toBe(true);
  });

  it('detects_mjs_test_files', () => {
    expect(isTestPath('foo.test.mjs')).toBe(true);
  });

  it('detects_mts_test_files', () => {
    expect(isTestPath('foo.test.mts')).toBe(true);
  });

  it('detects_files_in_dunder_tests_directory', () => {
    expect(isTestPath('src/__tests__/foo.ts')).toBe(true);
  });

  it('does_not_match_test_suffix_for_non_python', () => {
    // _test.ts is NOT a recognized pattern (only _test.py)
    expect(isTestPath('foo_test.ts')).toBe(false);
  });
});

// ============================================
// safeInt
// ============================================

describe('safeInt', () => {
  it('parses_valid_integer_string', () => {
    expect(safeInt('42')).toBe(42);
  });

  it('parses_negative_integer', () => {
    expect(safeInt('-7')).toBe(-7);
  });

  it('truncates_float_string_to_integer', () => {
    expect(safeInt('3.99')).toBe(3);
  });

  it('returns_default_for_null', () => {
    expect(safeInt(null)).toBe(0);
  });

  it('returns_default_for_undefined', () => {
    expect(safeInt(undefined)).toBe(0);
  });

  it('returns_default_for_non_numeric_string', () => {
    expect(safeInt('abc')).toBe(0);
  });

  it('returns_custom_default_for_non_numeric', () => {
    expect(safeInt('abc', -1)).toBe(-1);
  });

  it('returns_custom_default_for_null', () => {
    expect(safeInt(null, 99)).toBe(99);
  });

  it('returns_default_for_empty_string', () => {
    expect(safeInt('')).toBe(0);
  });

  it('parses_zero', () => {
    expect(safeInt('0')).toBe(0);
  });

  it('parses_string_with_leading_whitespace', () => {
    // parseInt trims leading whitespace
    expect(safeInt('  42')).toBe(42);
  });

  it('parses_string_with_trailing_non_numeric_chars', () => {
    // parseInt("42px") => 42
    expect(safeInt('42px')).toBe(42);
  });

  it('returns_default_for_hex_prefix', () => {
    // parseInt("0x1f", 10) => 0 (stops at 'x')
    expect(safeInt('0x1f')).toBe(0);
  });
});

// ============================================
// safeFloat
// ============================================

describe('safeFloat', () => {
  it('parses_valid_float_string', () => {
    expect(safeFloat('3.14')).toBe(3.14);
  });

  it('parses_integer_string_as_float', () => {
    expect(safeFloat('42')).toBe(42);
  });

  it('parses_negative_float', () => {
    expect(safeFloat('-2.5')).toBe(-2.5);
  });

  it('returns_default_for_null', () => {
    expect(safeFloat(null)).toBe(0);
  });

  it('returns_default_for_undefined', () => {
    expect(safeFloat(undefined)).toBe(0);
  });

  it('returns_default_for_non_numeric_string', () => {
    expect(safeFloat('abc')).toBe(0);
  });

  it('returns_custom_default_for_non_numeric', () => {
    expect(safeFloat('xyz', -1.5)).toBe(-1.5);
  });

  it('returns_custom_default_for_null', () => {
    expect(safeFloat(null, 99.9)).toBe(99.9);
  });

  it('returns_default_for_empty_string', () => {
    expect(safeFloat('')).toBe(0);
  });

  it('parses_scientific_notation', () => {
    expect(safeFloat('1e3')).toBe(1000);
  });

  it('parses_leading_dot', () => {
    expect(safeFloat('.5')).toBe(0.5);
  });

  it('parses_zero', () => {
    expect(safeFloat('0')).toBe(0);
  });

  it('parses_string_with_trailing_garbage', () => {
    // parseFloat("3.14abc") => 3.14
    expect(safeFloat('3.14abc')).toBe(3.14);
  });
});

// ============================================
// safeJsonParse
// ============================================

describe('safeJsonParse', () => {
  it('parses_valid_json_object', () => {
    expect(safeJsonParse('{"a":1}', {})).toStrictEqual({ a: 1 });
  });

  it('parses_valid_json_array', () => {
    expect(safeJsonParse('[1,2,3]', [])).toStrictEqual([1, 2, 3]);
  });

  it('parses_json_string', () => {
    expect(safeJsonParse('"hello"', '')).toBe('hello');
  });

  it('parses_json_number', () => {
    expect(safeJsonParse('42', 0)).toBe(42);
  });

  it('parses_json_boolean', () => {
    expect(safeJsonParse('true', false)).toBe(true);
  });

  it('parses_json_null_literal', () => {
    expect(safeJsonParse('null', 'fallback')).toBe(null);
  });

  it('returns_default_for_null_input', () => {
    expect(safeJsonParse(null, { fallback: true })).toStrictEqual({
      fallback: true,
    });
  });

  it('returns_default_for_undefined_input', () => {
    expect(safeJsonParse(undefined, 'default')).toBe('default');
  });

  it('returns_default_for_empty_string', () => {
    // empty string is falsy, triggers early return
    expect(safeJsonParse('', 'default')).toBe('default');
  });

  it('returns_default_for_invalid_json', () => {
    expect(safeJsonParse('{bad json}', [])).toStrictEqual([]);
  });

  it('returns_default_for_truncated_json', () => {
    expect(safeJsonParse('{"a":', null)).toBe(null);
  });

  it('returns_default_for_single_quote_json', () => {
    expect(safeJsonParse("{'a': 1}", {})).toStrictEqual({});
  });

  it('preserves_nested_structure_in_parsed_output', () => {
    const input = '{"a":{"b":[1,2,{"c":3}]}}';
    const parsed = safeJsonParse(input, {});
    expect(parsed).toStrictEqual({ a: { b: [1, 2, { c: 3 }] } });
  });
});

// ============================================
// generateSessionKey
// ============================================

describe('generateSessionKey', () => {
  it('starts_with_default_tui_client_type', () => {
    const key = generateSessionKey();
    expect(key.startsWith('tui_')).toBe(true);
  });

  it('starts_with_specified_client_type', () => {
    const key = generateSessionKey('cockpit');
    expect(key.startsWith('cockpit_')).toBe(true);
  });

  it('has_three_underscore_delimited_segments_for_simple_client_type', () => {
    const key = generateSessionKey('tui');
    const parts = key.split('_');
    expect(parts.length).toBe(3);
  });

  it('second_segment_is_unix_timestamp', () => {
    const before = Math.floor(Date.now() / 1000);
    const key = generateSessionKey();
    const after = Math.floor(Date.now() / 1000);
    const timestamp = parseInt(key.split('_')[1]!, 10);
    expect(timestamp >= before).toBe(true);
    expect(timestamp <= after).toBe(true);
  });

  it('third_segment_is_8_char_uuid_prefix', () => {
    const key = generateSessionKey();
    const uid = key.split('_')[2]!;
    expect(uid.length).toBe(8);
  });

  it('third_segment_contains_only_hex_and_dashes', () => {
    const key = generateSessionKey();
    const uid = key.split('_')[2]!;
    // UUID prefix chars: hex digits and possibly a dash at position 8 won't appear in first 8
    expect(/^[0-9a-f]{8}$/.test(uid)).toBe(true);
  });

  it('generates_unique_keys_across_calls', () => {
    const a = generateSessionKey();
    const b = generateSessionKey();
    expect(a).not.toBe(b);
  });

  it('handles_empty_string_client_type', () => {
    const key = generateSessionKey('');
    expect(key.startsWith('_')).toBe(true);
  });

  it('handles_client_type_containing_underscores', () => {
    const key = generateSessionKey('my_app');
    // "my_app" as client type means the key has 4 underscore-delimited parts
    expect(key.startsWith('my_app_')).toBe(true);
    const parts = key.split('_');
    expect(parts.length).toBe(4);
  });
});

// ============================================
// parseClientType
// ============================================

describe('parseClientType', () => {
  it('extracts_tui_from_standard_session_key', () => {
    expect(parseClientType('tui_1700000000_abcd1234')).toBe('tui');
  });

  it('extracts_cockpit_from_cockpit_key', () => {
    expect(parseClientType('cockpit_1700000000_abcd1234')).toBe('cockpit');
  });

  it('roundtrips_client_type_with_underscores', () => {
    // client type "my_app" + timestamp + uuid = "my_app_1700000000_abcd1234"
    expect(parseClientType('my_app_1700000000_abcd1234')).toBe('my_app');
  });


  it('returns_empty_string_for_leading_underscore', () => {
    // '_1700000000_abcd1234'.split('_') => ['', '1700000000', 'abcd1234']
    // slice(0, -2) => [''], join('_') => ''
    expect(parseClientType('_1700000000_abcd1234')).toBe('');
  });

  it('returns_whole_string_for_single_segment', () => {
    // No underscores at all — parts.length < 3, fallback to parts[0]
    expect(parseClientType('nounderscore')).toBe('nounderscore');
  });

  it('returns_first_part_for_two_segments', () => {
    // 'foo_bar' has length 2, less than 3, so returns parts[0]
    expect(parseClientType('foo_bar')).toBe('foo');
  });

  it('returns_unknown_for_empty_string', () => {
    // ''.split('_') => [''], parts.length=1 < 3, returns parts[0] => ''
    expect(parseClientType('')).toBe('');
  });

  it('roundtrips_with_generateSessionKey_for_simple_client_type', () => {
    const key = generateSessionKey('api');
    expect(parseClientType(key)).toBe('api');
  });

  it('roundtrips_with_generateSessionKey_for_underscored_client_type', () => {
    const key = generateSessionKey('web_app');
    expect(parseClientType(key)).toBe('web_app');
  });

  it('roundtrips_with_generateSessionKey_for_multi_underscore_client_type', () => {
    const key = generateSessionKey('my_cool_app');
    expect(parseClientType(key)).toBe('my_cool_app');
  });
});

// ============================================
// nowSeconds
// ============================================

describe('nowSeconds', () => {
  it('returns_a_value_close_to_current_unix_time', () => {
    const before = Date.now() / 1000;
    const result = nowSeconds();
    const after = Date.now() / 1000;
    expect(result >= before).toBe(true);
    expect(result <= after).toBe(true);
  });

  it('returns_fractional_seconds', () => {
    const result = nowSeconds();
    // Date.now() has ms precision, so dividing by 1000 yields fractional
    expect(result % 1 !== 0).toBe(true);
  });
});

// ============================================
// secondsToDate
// ============================================

describe('secondsToDate', () => {
  it('converts_epoch_zero_to_1970_01_01', () => {
    const date = secondsToDate(0);
    expect(date.toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('converts_known_timestamp_to_correct_date', () => {
    // 1700000000 seconds = 2023-11-14T22:13:20.000Z
    const date = secondsToDate(1700000000);
    expect(date.toISOString()).toBe('2023-11-14T22:13:20.000Z');
  });

  it('handles_fractional_seconds', () => {
    const date = secondsToDate(1700000000.5);
    expect(date.getMilliseconds()).toBe(500);
  });

  it('handles_negative_seconds_for_pre_epoch', () => {
    const date = secondsToDate(-86400);
    expect(date.toISOString()).toBe('1969-12-31T00:00:00.000Z');
  });
});

// ============================================
// dateToSeconds
// ============================================

describe('dateToSeconds', () => {
  it('converts_epoch_date_to_zero', () => {
    expect(dateToSeconds(new Date(0))).toBe(0);
  });

  it('converts_known_date_to_correct_timestamp', () => {
    const date = new Date('2023-11-14T22:13:20.000Z');
    expect(dateToSeconds(date)).toBe(1700000000);
  });

  it('preserves_millisecond_precision_as_fractional_seconds', () => {
    const date = new Date(1700000000500); // +500ms
    expect(dateToSeconds(date)).toBe(1700000000.5);
  });

  it('roundtrips_with_secondsToDate', () => {
    const original = 1700000000.123;
    expect(dateToSeconds(secondsToDate(original))).toBe(original);
  });

  it('handles_pre_epoch_dates', () => {
    const date = new Date('1969-12-31T00:00:00.000Z');
    expect(dateToSeconds(date)).toBe(-86400);
  });
});
