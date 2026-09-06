//! Stateless bounded scan. No directory enumeration, cache, database or parser.
//! Unusual JS-regex whitespace / cross-line headers defer per file to TS.
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
use std::path::{Component, Path};
use std::time::Instant;

const MAX_REQUEST: u64 = 8 * 1024 * 1024;
const MAX_SOURCE: u64 = 8 * 1024 * 1024;
const MAX_LINE: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: u32, root: String, paths: Vec<String>,
    #[serde(default = "default_workers")]
    workers: usize,
}
fn default_workers() -> usize { 4 }

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Definition {
    name: String, parameters: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    variadic_parameter: Option<String>, replacement: String,
}
#[derive(Serialize, Default, Debug, PartialEq)]
struct Contribution { names: Vec<String>, bodyless: Vec<String>, definitions: Vec<Definition> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Row<'a> {
    protocol: u32, path: &'a str, status: &'static str, reason: &'static str,
    bytes: usize, read_ms: f64, scan_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    contribution: Option<Contribution>,
}
fn ws(c: char) -> bool { matches!(c, ' ' | '\t' | '\r' | '\n') }
fn ident_start(b: u8) -> bool { b == b'_' || b.is_ascii_alphabetic() }
fn ident_part(b: u8) -> bool { ident_start(b) || b.is_ascii_digit() }
fn identifier(s: &str) -> bool {
    s.as_bytes().first().is_some_and(|b| ident_start(*b)) && s.bytes().all(ident_part)
}
fn line_end(s: &str, from: usize) -> usize { s[from..].find('\n').map_or(s.len(), |i| from + i) }
fn physical_end(s: &str, end: usize) -> usize {
    if end > 0 && s.as_bytes()[end - 1] == b'\r' { end - 1 } else { end }
}

/// Name span for a normal single-physical-line header. Do NOT remove comments:
/// the TS oracle's three scans deliberately keep their existing quirks.
fn header(s: &str, start: usize, end: usize) -> Result<Option<(usize, usize)>, &'static str> {
    let b = s.as_bytes();
    let mut i = start;
    while i < end && matches!(b[i], b' ' | b'\t') { i += 1; }
    if i == end || b[i] != b'#' { return Ok(None); }
    i += 1;
    while i < end && matches!(b[i], b' ' | b'\t') { i += 1; }
    if i == end { return Err("crossline-header"); }
    if !s[i..end].starts_with("define") { return Ok(None); }
    i += 6;
    if i == end { return Err("crossline-header"); }
    if !matches!(b[i], b' ' | b'\t') { return Ok(None); }
    while i < end && matches!(b[i], b' ' | b'\t') { i += 1; }
    if i == end { return Err("crossline-header"); }
    if !ident_start(b[i]) { return Ok(None); }
    let begin = i;
    while i < end && ident_part(b[i]) { i += 1; }
    Ok(Some((begin, i)))
}

fn directive_end(s: &str, hash: usize) -> usize {
    let mut from = hash;
    loop {
        let end = line_end(s, from);
        if end == s.len() { return end; }
        let k = physical_end(s, end);
        if k > hash && s.as_bytes()[k - 1] == b'\\' { from = end + 1; }
        else { return end; }
    }
}
fn definition(text: &str) -> Option<Definition> {
    // Match JS replacement of splices by ONE SPACE (not C preprocessing).
    let joined = text.replace("\\\r\n", " ").replace("\\\n", " ");
    let body = joined.strip_prefix('#')?.trim_start_matches(ws).strip_prefix("define")?;
    if !body.chars().next().is_some_and(ws) { return None; }
    let body = body.trim_start_matches(ws);
    let mut i = 0;
    while i < body.len() && ident_part(body.as_bytes()[i]) { i += 1; }
    let name = &body[..i];
    if !identifier(name) { return None; }
    let mut parameters = None;
    let mut variadic_parameter = None;
    if body.as_bytes().get(i) == Some(&b'(') {
        let open = i;
        let mut depth = 1;
        i += 1;
        while i < body.len() && depth > 0 {
            if body.as_bytes()[i] == b'(' { depth += 1; }
            else if body.as_bytes()[i] == b')' { depth -= 1; }
            i += 1;
        }
        if depth != 0 { return None; }
        let mut formals = Vec::new();
        for segment in body[open + 1..i - 1].split(',') {
            let value = segment.trim_matches(ws);
            if value.is_empty() { continue; }
            let formal = if value == "..." {
                variadic_parameter = Some("__VA_ARGS__".to_string()); "__VA_ARGS__"
            } else if let Some(prefix) = value.strip_suffix("...") {
                let prefix = prefix.trim_end_matches(ws);
                if !identifier(prefix) { return None; }
                variadic_parameter = Some(prefix.to_string()); prefix
            } else { if !identifier(value) { return None; } value };
            formals.push(formal.to_string());
        }
        parameters = Some(formals);
    }
    let replacement = body[i..].trim_matches(ws);
    // The legacy constant is named BYTES but its actual limit is UTF-16 units.
    if replacement.encode_utf16().count() > 64 * 1024 { return None; }
    Some(Definition { name: name.to_string(), parameters, variadic_parameter, replacement: replacement.to_string() })
}

fn scan(s: &str) -> Result<Contribution, &'static str> {
    if !s.contains('#') || !s.contains("define") { return Ok(Contribution::default()); }
    // Non-ASCII comments/strings ARE supported. Exotic whitespace, lone CR and
    // JS line separators defer rather than borrowing Rust's different \s set.
    if s.chars().any(|c| (c.is_whitespace() && !ws(c)) || c == '\u{feff}') ||
        s.as_bytes().iter().enumerate().any(|(i, b)| *b == b'\r' && s.as_bytes().get(i + 1) != Some(&b'\n')) {
        return Err("unusual-whitespace");
    }
    let mut out = Contribution::default();
    let mut offset = 0;
    while offset < s.len() {
        let end = line_end(s, offset);
        let line = physical_end(s, end);
        if let Some((begin, name_end)) = header(s, offset, line)? {
            let name = &s[begin..name_end];
            out.names.push(name.to_string());
            if out.names.len() > 100_000 { return Err("record-limit"); }
            let tail = s[name_end..line].trim_start_matches([' ', '\t']);
            let lookahead = s[name_end..].trim_start_matches(ws);
            if !lookahead.starts_with('(') {
                if tail.is_empty() || tail.starts_with("//") { out.bodyless.push(name.to_string()); }
                else if tail.starts_with("/*") {
                    if tail.find("*/").is_some_and(|i| tail[i + 2..].trim_matches([' ', '\t']).is_empty()) {
                        out.bodyless.push(name.to_string());
                    } else { return Err("complex-bodyless-comment"); }
                }
            }
        }
        offset = if end == s.len() { end } else { end + 1 };
    }
    // Separate logical-line pass: unlike the name regex, the definition scan
    // skips EVERY directive's continuation, including #if / #pragma bodies.
    offset = 0;
    while offset < s.len() {
        let end = line_end(s, offset);
        let mut hash = offset;
        while hash < end && matches!(s.as_bytes()[hash], b' ' | b'\t' | b'\r') { hash += 1; }
        if hash < end && s.as_bytes()[hash] == b'#' {
            let logical_end = directive_end(s, hash);
            if let Some((name_begin, _)) = header(s, offset, physical_end(s, end))? {
                // The TS scanner inspects only the first 128 UTF-16 units for
                // #define. Header prefix is ASCII on this fast path.
                let prefix = &s[hash..name_begin];
                let keyword_end = prefix.find("define").unwrap() + 6;
                if keyword_end <= 128 {
                    if let Some(d) = definition(&s[hash..logical_end]) {
                        out.definitions.push(d);
                        if out.definitions.len() > 100_000 { return Err("record-limit"); }
                    }
                }
            }
            offset = if logical_end == s.len() { logical_end } else { logical_end + 1 };
        } else { offset = if end == s.len() { end } else { end + 1 }; }
    }
    Ok(out)
}

fn file_row<'a>(root: &Path, relative: &'a str) -> Row<'a> {
    let mut row = Row { protocol: 1, path: relative, status: "fallback", reason: "read-error",
        bytes: 0, read_ms: 0.0, scan_ms: 0.0, contribution: None };
    let t = Instant::now();
    let read = || -> Result<Vec<u8>, &'static str> {
        let rel = Path::new(relative);
        if relative.is_empty() || relative.contains(':') || !rel.components().all(|c| matches!(c, Component::Normal(_))) { return Err("unsafe-path"); }
        let target = fs::canonicalize(root.join(rel)).map_err(|_| "read-error")?;
        if !target.starts_with(root) { return Err("outside-root"); }
        let file = File::open(target).map_err(|_| "read-error")?;
        let meta = file.metadata().map_err(|_| "read-error")?;
        if !meta.is_file() || meta.len() > MAX_SOURCE { return Err("source-limit"); }
        let mut bytes = Vec::new();
        file.take(MAX_SOURCE + 1).read_to_end(&mut bytes).map_err(|_| "read-error")?;
        if bytes.len() as u64 > MAX_SOURCE { return Err("source-limit"); }
        Ok(bytes)
    };
    let content = read();
    row.read_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    match content {
        Ok(bytes) => {
            row.bytes = bytes.len();
            match std::str::from_utf8(&bytes).map_err(|_| "invalid-utf8").and_then(scan) {
                Ok(c) => { row.status = "ok"; row.reason = "none"; row.contribution = Some(c); }
                Err(reason) => row.reason = reason,
            }
        }
        Err(reason) => row.reason = reason,
    }
    row.scan_ms = t.elapsed().as_secs_f64() * 1000.0;
    row
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().take(MAX_REQUEST + 1).read_to_string(&mut input)?;
    if input.len() as u64 > MAX_REQUEST { return Err("request-limit".into()); }
    let request: Request = serde_json::from_str(&input)?;
    if request.protocol != 1 || request.paths.len() > 250_000 || !(1..=8).contains(&request.workers) { return Err("request-limit".into()); }
    let root = fs::canonicalize(&request.root)?;
    let mut output = BufWriter::new(io::stdout().lock());
    // Bounded long-lived workers, not one OS thread per source file. Each rendezvous
    // channel permits only one pending row; the consumer preserves input order.
    std::thread::scope(|scope| -> Result<(), Box<dyn std::error::Error>> {
        let mut receivers = Vec::new();
        for worker in 0..request.workers {
            let (sender, receiver) = std::sync::mpsc::sync_channel(0);
            receivers.push(receiver);
            let root = &root;
            let paths = &request.paths;
            let workers = request.workers;
            scope.spawn(move || {
                for i in (worker..paths.len()).step_by(workers) {
                    if sender.send(file_row(root, &paths[i])).is_err() { break; }
                }
            });
        }
        for i in 0..request.paths.len() {
            let mut row = receivers[i % request.workers].recv()?;
            let mut json = serde_json::to_vec(&row)?;
            if json.len() > MAX_LINE {
                row.contribution = None; row.status = "fallback"; row.reason = "output-limit";
                json = serde_json::to_vec(&row)?;
            }
            output.write_all(&json)?; output.write_all(b"\n")?;
            output.flush()?;
        }
        Ok(())
    })?;
    Ok(())
}
fn main() {
    if run().is_err() { eprintln!("macro scanner failed"); std::process::exit(1); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn ordinary_and_splices() {
        let c = scan("#define EMPTY\r\n#define F(a, rest...) a + rest\r\n#define TABLE \\\r\n {1, /*中文*/ 2}\r\n").unwrap();
        assert_eq!(c.names, ["EMPTY", "F", "TABLE"]);
        assert_eq!(c.bodyless, ["EMPTY"]);
        assert_eq!(c.definitions[1].variadic_parameter.as_deref(), Some("rest"));
        assert_eq!(c.definitions[2].replacement, "{1, /*中文*/ 2}");
    }
    #[test] fn names_and_definitions_have_distinct_continuation_rules() {
        let c = scan("#if X \\\n#define GHOST 1\n#endif\n#define N\n(x)\n").unwrap();
        assert_eq!(c.names, ["GHOST", "N"]);
        assert!(c.bodyless.is_empty());
        assert_eq!(c.definitions.len(), 1);
    }
    #[test] fn fallbacks() {
        for s in ["#\ndefine A 1", "#define\nA 1", "#define N /*x\n*/", "#define A\u{a0}1", "#define A 1\r"] {
            assert!(scan(s).is_err(), "{s}");
        }
    }
}
