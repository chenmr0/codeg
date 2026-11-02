# Published 1765271f database fixture

`codegraph.db.gz` is a gzip-compressed **actual database produced by** commit
`1765271fb05042d23237f83786ce83950a794124`, not a current database with old
metadata. The fixture contains only the adjacent synthetic `published.c` file.

Generation used Node 24.22.1 / native `node:sqlite` on Linux:

1. `git archive 1765271f | tar -x -C <isolated-directory>`.
2. Build that checkout with its package dependencies (`npm run build`).
3. Copy `published.c` into an otherwise empty temporary project.
4. Invoke that checkout's `CodeGraph.init(project, { index: true })`, then
   `graph.close()` before reading `.codegraph-wx/codegraph.db`.
5. Compress the unmodified database with Node's `zlib.gzipSync`.

Uncompressed SHA-256:
`7e0c362f471a3cb2f911a30e00052d090c574079546cc2d6b4367a95f97a9b18`.
It has 3 nodes, 3 edges, one source file, extraction version 36, schema version
matching that release, and persistent WAL mode. It has no portable coordination
files/identity or generation `CURRENT` pointer. Timestamps are historical fixture
values; regenerate only intentionally, updating the checksum and provenance.

The regression restores the complete historical database, including FTS indexes
and metadata. Its first use therefore exercises real legacy enrollment rather
than creating a current database and removing selected fields. Existing unrelated
benchmark fixtures and checkouts are not involved.
