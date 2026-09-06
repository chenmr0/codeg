//! Read-only, one-request/one-response prototype. No database, source parsing,
//! persistent cache, global Git excludes, or unbounded parallelism.
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

const PROTOCOL: u32 = 1;
const MAX_REQUEST: u64 = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 1_000_000;
const MAX_FILES: usize = 250_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol: u32,
    root: String,
    root_rules: Vec<String>,
    extensions: Vec<String>,
    data_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSnapshot {
    path: String,
    size: u64,
    mtime_ms: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Counters {
    directories: usize,
    entries: usize,
    metadata: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    protocol: u32,
    ok: bool,
    reason: String,
    files: Vec<FileSnapshot>,
    counters: Counters,
    elapsed_ms: u128,
}

type ScanResult<T> = Result<T, &'static str>;

fn validate_rule(line: &str) -> ScanResult<()> {
    let text = line.trim_end_matches('\r');
    if text.is_empty() || text.starts_with('#') { return Ok(()); }
    // First prototype deliberately excludes escape/class/brace and Unicode
    // folding differences between the JS ignore matcher and globset.
    if !text.is_ascii() || text.bytes().any(|c| c == 0 || c == b'\\' || b"[]{}".contains(&c)) {
        return Err("unsupported-rule");
    }
    if text.trim() != text || text.contains("//") || text.split('/').any(|s| s == "." || s == "..") {
        return Err("unsupported-rule");
    }
    Ok(())
}

fn matcher(root: &Path, lines: &[String]) -> ScanResult<Gitignore> {
    let mut builder = GitignoreBuilder::new(root);
    builder.case_insensitive(true).map_err(|_| "ignore-build")?;
    builder.allow_unclosed_class(false);
    for group in lines {
        for line in group.split('\n') {
            let line = line.trim_end_matches('\r');
            validate_rule(line)?;
            builder.add_line(None, line).map_err(|_| "ignore-build")?;
        }
    }
    builder.build().map_err(|_| "ignore-build")
}

fn source_file(relative: &str, extensions: &HashSet<String>) -> bool {
    if relative == "conf/routes" || relative.ends_with("/conf/routes") || relative.ends_with(".routes") {
        return true;
    }
    let lower = relative.to_ascii_lowercase();
    if lower.ends_with(".json") {
        let segments: Vec<&str> = lower.split('/').collect();
        for (i, segment) in segments.iter().enumerate() {
            if (*segment == "templates" || *segment == "sections") &&
                segments[i + 1..].join("/").len() > 5 { return true; }
        }
    }
    relative.rfind('.').is_some_and(|dot| extensions.contains(&relative[dot..].to_ascii_lowercase()))
}

struct Scanner<'a> {
    request: &'a Request,
    root: PathBuf,
    extensions: HashSet<String>,
    files: Vec<FileSnapshot>,
    seen_files: HashSet<String>,
    counters: Counters,
}

impl Scanner<'_> {
    fn walk(&mut self, directory: &Path, relative: &str, matchers: &mut Vec<Gitignore>, depth: usize) -> ScanResult<()> {
        if depth > 256 { return Err("depth-limit"); }
        self.counters.directories += 1;
        // Unlike a partial filesystem walk, an I/O failure cannot produce an
        // apparently complete empty subtree. Discard the entire native result.
        let entries: Vec<_> = fs::read_dir(directory).map_err(|_| "read-directory")?
            .collect::<Result<Vec<_>, _>>().map_err(|_| "read-directory")?;
        // libuv's Unix scandir sorts by name; Windows preserves filesystem
        // enumeration order. Sorting Windows entries changes mixed-case order.
        // Non-ASCII names defer below; verify mode checks the full sequence.
        #[cfg(not(windows))]
        let entries = {
            let mut entries = entries;
            entries.sort_by_key(|entry| entry.file_name());
            entries
        };
        self.counters.entries += entries.len();
        if self.counters.entries > MAX_ENTRIES { return Err("entry-limit"); }
        let has_ignore = !relative.is_empty() && entries.iter().any(|e| e.file_name() == ".gitignore");
        if has_ignore {
            let content = fs::read_to_string(directory.join(".gitignore")).map_err(|_| "read-ignore")?;
            matchers.push(matcher(directory, &[content])?);
        }
        for entry in entries {
            let name = entry.file_name().into_string().map_err(|_| "non-utf8-path")?;
            if name == ".git" || name == ".codegraph" || name == self.request.data_dir || name.starts_with(".codegraph-") {
                continue;
            }
            let kind = entry.file_type().map_err(|_| "file-type")?;
            if kind.is_symlink() { return Err("symlink"); }
            let rel = if relative.is_empty() { name.clone() } else { format!("{relative}/{name}") };
            // An ordinary non-source file cannot affect traversal or symbols.
            // Only skip when the suffix is ASCII: JS Unicode case folding can
            // turn e.g. .Kt into the supported .kt extension. Directories, links
            // and possible sources still pass through the conservative gate.
            if kind.is_file() && rel.rfind('.').is_some_and(|dot| rel[dot..].is_ascii()) &&
                !source_file(&rel, &self.extensions) { continue; }
            if !name.is_ascii() { return Err("non-ascii-path"); }
            let full = entry.path();
            let is_dir = kind.is_dir();
            if matchers.iter().any(|ig| ig.matched_path_or_any_parents(&full, is_dir).is_ignore()) { continue; }
            if is_dir {
                self.walk(&full, &rel, matchers, depth + 1)?;
            } else if kind.is_file() && source_file(&rel, &self.extensions) {
                let identity = if cfg!(windows) { rel.to_ascii_lowercase() } else { rel.clone() };
                if !self.seen_files.insert(identity) { return Err("case-collision"); }
                let metadata = entry.metadata().map_err(|_| "file-metadata")?;
                if !metadata.is_file() { return Err("file-changed"); }
                self.counters.metadata += 1;
                let modified = metadata.modified().map_err(|_| "mtime")?
                    .duration_since(UNIX_EPOCH).map_err(|_| "mtime-before-epoch")?;
                // Match Node's floating-point milliseconds followed by the
                // existing Math.floor prefilter, including sub-ms rounding.
                let millis = (modified.as_secs() as f64 * 1000.0 +
                    modified.subsec_nanos() as f64 / 1_000_000.0).floor() as u64;
                if metadata.len() > 9_007_199_254_740_991 || millis > 9_007_199_254_740_991 { return Err("number-range"); }
                self.files.push(FileSnapshot { path: rel, size: metadata.len(), mtime_ms: millis });
                if self.files.len() > MAX_FILES { return Err("file-limit"); }
            }
        }
        if has_ignore { matchers.pop(); }
        Ok(())
    }
}

fn scan(request: &Request) -> ScanResult<(Vec<FileSnapshot>, Counters)> {
    if request.protocol != PROTOCOL { return Err("protocol"); }
    if !Path::new(&request.root).is_absolute() || !request.root.is_ascii() { return Err("unsupported-root"); }
    let root = fs::canonicalize(&request.root).map_err(|_| "root-path")?;
    let initial = matcher(&root, &request.root_rules)?;
    let mut scanner = Scanner { request, root: root.clone(), extensions: request.extensions.iter().cloned().collect(),
        files: Vec::new(), seen_files: HashSet::new(), counters: Counters::default() };
    let root = scanner.root.clone();
    scanner.walk(&root, "", &mut vec![initial], 0)?;
    Ok((scanner.files, scanner.counters))
}

fn main() {
    let start = Instant::now();
    let result = (|| {
        let mut input = String::new();
        io::stdin().take(MAX_REQUEST + 1).read_to_string(&mut input).map_err(|_| "input")?;
        if input.len() as u64 > MAX_REQUEST { return Err("request-limit"); }
        let request: Request = serde_json::from_str(&input).map_err(|_| "request-json")?;
        scan(&request)
    })();
    let (ok, reason, files, counters) = match result {
        Ok((files, counters)) => (true, "".to_string(), files, counters),
        Err(reason) => (false, reason.to_string(), Vec::new(), Counters::default()),
    };
    let response = Response { protocol: PROTOCOL, ok, reason, files, counters, elapsed_ms: start.elapsed().as_millis() };
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    if serde_json::to_writer(&mut stdout, &response).is_err() || stdout.flush().is_err() { std::process::exit(1); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_selection() {
        let extensions = HashSet::from([".c".to_string(), ".h".to_string()]);
        for file in ["x.c", "x.H", "app/conf/routes", "templates/x.json", "a/sections/group.json"] {
            assert!(source_file(file, &extensions), "{file}");
        }
        for file in ["x.json", "conf/Routes", "templates/.json", "foo.c/readme"] {
            assert!(!source_file(file, &extensions), "{file}");
        }
    }
    #[test]
    fn unsupported_rules_defer() {
        for rule in ["*.c", "!/src/", "**/foo*", "# comment", "name with space/"] { assert!(validate_rule(rule).is_ok()); }
        for rule in ["[ab].c", "a\\ b", "中文/", " trailing", "foo/../bar/"] { assert!(validate_rule(rule).is_err()); }
    }
    #[test]
    fn explicit_expansion_and_case_matching() {
        let root = std::env::current_dir().unwrap();
        let ig = matcher(&root, &["/*\n!/a/\n/a/*\n!/a/b/".to_string()]).unwrap();
        assert!(!ig.matched_path_or_any_parents(root.join("A"), true).is_ignore());
        assert!(!ig.matched_path_or_any_parents(root.join("A/b/x.c"), false).is_ignore());
        assert!(ig.matched_path_or_any_parents(root.join("other/x.c"), false).is_ignore());
    }
}
