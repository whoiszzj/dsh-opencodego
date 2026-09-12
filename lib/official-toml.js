/**
 * A TOML reader for the subset models.dev actually writes.
 *
 * Why hand-rolled instead of a dependency: this repository has no runtime
 * dependencies and no lockfile, and the plugin's published artifact is a
 * faithful copy of `src/` — pulling a parser in would change both facts for a
 * file format we read exactly one way. The subset below is therefore defined by
 * what appears in `anomalyco/models.dev`, and nothing else:
 *
 *   - comments (`#`), including block comments used as the HTTP contract notes
 *   - bare / quoted / dotted keys, `[table]` and `[[array of tables]]`
 *   - basic and literal strings, multi-line strings, integers with `_`
 *     separators, floats, booleans, arrays (including multi-line), inline tables
 *
 * Everything else (dates, exotic escapes) degrades to the raw text rather than
 * throwing: a value this reader cannot type is still a value a caller can see,
 * and a hard failure here would take the whole baseline down over a field we
 * do not read.
 *
 * Correctness is established by differential testing, not by inspection:
 * `tests/official-toml.test.mjs` parses every TOML in a checkout of the real
 * repository and compares the fields this plugin consumes against Python's
 * `tomllib`.
 *
 * @module dsh-opencodego/official-toml
 */

/**
 * Characters that end a bare key.
 *
 * Written as a predicate rather than a character class on purpose: the class
 * this replaced (`/[\s=.\]}[\]]/`) *looked* right and was, but the sibling used
 * for values (`/[\s,\]}]#/`) silently closed at the `]` and matched only a
 * delimiter followed by `]#` — so it never stopped and swallowed every
 * following statement. Escaping rules inside a class are exactly the kind of
 * subtle that costs a silent data corruption, so nothing here depends on them.
 */
function isBareKeyEnd(ch) {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
    || ch === '=' || ch === '.' || ch === ',' || ch === '#' || ch === '[' || ch === ']'
}

/** Characters that end a bare (unquoted) scalar value. */
function isValueEnd(ch) {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
    || ch === ',' || ch === '#' || ch === '[' || ch === ']' || ch === '}'
}

/**
 * Read one TOML document.
 *
 * @param {string} text - the file contents.
 * @returns {{ data: Record<string, unknown>, problems: string[] }} the parsed
 *   document plus any statement this reader skipped, named rather than hidden.
 */
export function parseToml(text) {
  const data = {}
  const problems = []
  let i = 0
  const n = text.length
  let current = data

  const fail = (why) => {
    // Skip to the next line so one unreadable statement costs one statement.
    while (i < n && text[i] !== '\n') i += 1
    i += 1
    problems.push(why)
  }

  const skipTrivia = () => {
    for (;;) {
      while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === '\n')) i += 1
      if (i < n && text[i] === '#') {
        while (i < n && text[i] !== '\n') i += 1
        continue
      }
      return
    }
  }

  const parseBasicString = (multiline) => {
    i += multiline ? 3 : 1
    let out = ''
    for (;;) {
      if (i >= n) throw new Error('unterminated string')
      const ch = text[i]
      if (ch === '\\') {
        const next = text[i + 1]
        if (next === 'n') out += '\n'
        else if (next === 't') out += '\t'
        else if (next === 'r') out += '\r'
        else if (next === 'b') out += '\b'
        else if (next === 'f') out += '\f'
        else if (next === '"') out += '"'
        else if (next === '\\') out += '\\'
        else if (next === 'u' || next === 'U') {
          const width = next === 'u' ? 4 : 8
          out += String.fromCodePoint(Number.parseInt(text.slice(i + 2, i + 2 + width), 16))
          i += 2 + width
          continue
        } else out += next ?? ''
        i += 2
        continue
      }
      if (multiline) {
        if (ch === '"' && text.startsWith('"""', i)) {
          i += 3
          // A trailing backslash eats the newline that follows it.
          if (text[i] === '\n') i += 1
          return out
        }
      } else if (ch === '"') {
        i += 1
        return out
      }
      out += ch
      i += 1
    }
  }

  const parseLiteralString = (multiline) => {
    i += multiline ? 3 : 1
    if (multiline) {
      const end = text.indexOf("'''", i)
      if (end === -1) throw new Error('unterminated multi-line literal string')
      const out = text.slice(i, end)
      i = end + 3
      return out
    }
    const end = text.indexOf("'", i)
    if (end === -1) throw new Error('unterminated literal string')
    const out = text.slice(i, end)
    i = end + 1
    return out
  }

  const parseNumberOrWord = () => {
    const start = i
    while (i < n && !isValueEnd(text[i])) i += 1
    const raw = text.slice(start, i).trim()
    if (raw === 'true') return true
    if (raw === 'false') return false
    const numeric = raw.replace(/_/gu, '')
    if (/^[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+)$/u.test(raw)) return Number(numeric)
    if (/^[+-]?\d+$/u.test(numeric)) return Number(numeric)
    if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/u.test(numeric)) return Number(numeric)
    // Dates and anything else stay as written rather than becoming a guess.
    return raw
  }

  const parseValue = () => {
    const ch = text[i]
    if (ch === '"') {
      if (text.startsWith('"""', i)) return parseBasicString(true)
      return parseBasicString(false)
    }
    if (ch === "'") {
      if (text.startsWith("'''", i)) return parseLiteralString(true)
      return parseLiteralString(false)
    }
    if (ch === '[') {
      i += 1
      const out = []
      for (;;) {
        skipTrivia()
        if (i >= n) throw new Error('unterminated array')
        if (text[i] === ']') {
          i += 1
          return out
        }
        out.push(parseValue())
        skipTrivia()
        if (text[i] === ',') i += 1
      }
    }
    if (ch === '{') {
      i += 1
      const out = {}
      for (;;) {
        skipTrivia()
        if (i >= n) throw new Error('unterminated inline table')
        if (text[i] === '}') {
          i += 1
          return out
        }
        const key = parseKey()
        skipTrivia()
        if (text[i] === '=') i += 1
        skipTrivia()
        assign(out, key, parseValue())
        skipTrivia()
        if (text[i] === ',') i += 1
      }
    }
    return parseNumberOrWord()
  }

  const parseKeyPart = () => {
    const ch = text[i]
    if (ch === '"') return parseBasicString(false)
    if (ch === "'") return parseLiteralString(false)
    const start = i
    while (i < n && !isBareKeyEnd(text[i])) i += 1
    return text.slice(start, i)
  }

  const parseKey = () => {
    const parts = [parseKeyPart()]
    for (;;) {
      while (i < n && (text[i] === ' ' || text[i] === '\t')) i += 1
      if (text[i] !== '.') break
      i += 1
      while (i < n && (text[i] === ' ' || text[i] === '\t')) i += 1
      parts.push(parseKeyPart())
    }
    return parts
  }

  while (i < n) {
    skipTrivia()
    if (i >= n) break
    const ch = text[i]
    if (ch === '[') {
      const arrayOfTables = text[i + 1] === '['
      i += arrayOfTables ? 2 : 1
      let path
      try {
        path = parseKey()
      } catch (error) {
        fail(`table header: ${error.message}`)
        continue
      }
      skipTrivia()
      if (text[i] !== ']') {
        fail(`table header ${path.join('.')}: missing "]"`)
        continue
      }
      i += 1
      if (arrayOfTables) {
        if (text[i] === ']') i += 1
      }
      try {
        current = tableAt(data, path, arrayOfTables)
      } catch (error) {
        fail(`table header ${path.join('.')}: ${error.message}`)
      }
      continue
    }
    let key
    try {
      key = parseKey()
    } catch (error) {
      fail(`key: ${error.message}`)
      continue
    }
    skipTrivia()
    if (text[i] !== '=') {
      fail(`key ${key.join('.')}: expected "="`)
      continue
    }
    i += 1
    // Only spaces and tabs may separate `=` from its value: TOML's `keyval-sep`
    // is `ws`, and `ws` excludes newlines. Skipping newlines here would let an
    // empty value silently swallow the NEXT line's key as its own value.
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i += 1
    if (i >= n || text[i] === '\n' || text[i] === '\r') {
      fail(`key ${key.join('.')}: missing value`)
      continue
    }
    let value
    try {
      value = parseValue()
    } catch (error) {
      fail(`key ${key.join('.')}: ${error.message}`)
      continue
    }
    try {
      assign(current, key, value)
    } catch (error) {
      fail(`key ${key.join('.')}: ${error.message}`)
    }
  }

  return { data, problems }
}

/** Follow a dotted key from a table, creating intermediate tables. */
function assign(table, path, value) {
  let node = table
  for (let k = 0; k < path.length - 1; k += 1) {
    const key = path[k]
    let next = node[key]
    if (Array.isArray(next)) next = next[next.length - 1]
    if (next === undefined || next === null || typeof next !== 'object') {
      next = {}
      node[key] = next
    }
    node = next
  }
  node[path[path.length - 1]] = value
}

/** Resolve (and create) the table one `[path]` or `[[path]]` header names. */
function tableAt(root, path, arrayOfTables) {
  let node = root
  for (let k = 0; k < path.length; k += 1) {
    const key = path[k]
    const last = k === path.length - 1
    if (last) {
      if (arrayOfTables) {
        if (!Array.isArray(node[key])) node[key] = []
        const created = {}
        node[key].push(created)
        return created
      }
      const existing = node[key]
      if (existing !== undefined && (existing === null || typeof existing !== 'object')) {
        throw new Error(`"${key}" is already a value`)
      }
      if (existing === undefined) node[key] = {}
      return node[key]
    }
    let next = node[key]
    if (Array.isArray(next)) next = next[next.length - 1]
    if (next === undefined) {
      next = {}
      node[key] = next
    }
    if (next === null || typeof next !== 'object') throw new Error(`"${key}" is already a value`)
    node = next
  }
  throw new Error('empty table path')
}

/**
 * Every comment block in a document, in order, each joined into one line.
 *
 * models.dev puts the real HTTP contract here — field names, allowed values, the
 * source URL and the date it was read. Those notes are the difference between a
 * declaration and a guess, so they are extracted verbatim rather than dropped by
 * a parser that only returns data.
 *
 * @param {string} text - the file contents.
 * @returns {string[]} one string per block.
 */
export function commentBlocks(text) {
  const out = []
  let buffer = []
  const flush = () => {
    if (buffer.length > 0) {
      out.push(buffer.join(' '))
      buffer = []
    }
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) buffer.push(trimmed.replace(/^#+\s?/u, '').trim())
    else flush()
  }
  flush()
  return out.filter((block) => block.length > 0)
}
