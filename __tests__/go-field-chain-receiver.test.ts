import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
describe('Go field-chain receiver calls (#1276)', () => {
    // `target.conn.Exec(...)` where `conn *sql.DB` used to emit a BARE `Exec`
    // ref, which exact-matched the only local `Exec` — an unrelated
    // interface's method — fabricating an internal dependency. Chained Go
    // receivers now resolve exclusively via validated field-hop inference:
    // external field types produce NO edge; in-project ones produce the
    // correct edge (new recall).
    it('external receiver types produce no edge; in-project field chains resolve correctly', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1276-'));
      try {
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/app\n\ngo 1.22\n');
        fs.mkdirSync(path.join(tmpDir, 'flow'));
        fs.writeFileSync(
          path.join(tmpDir, 'flow', 'flow.go'),
          `package flow

import "database/sql"

type InternalStore interface {
	Exec(string, ...any) (sql.Result, error)
	QueryRow(string, ...any) *sql.Row
}

type Target struct{ conn *sql.DB }

func (target *Target) Write() error {
	_, err := target.conn.Exec("insert")
	return err
}

func (target *Target) Read() *sql.Row {
	return target.conn.QueryRow("select")
}

type Store struct{}

func (s *Store) Put(key string) {}

type Repo struct{ db *Store }

func (r *Repo) Save() {
	r.db.Put("k")
}
`
        );

        const cg = CodeGraph.initSync(tmpDir);
        await cg.indexAll();

        // The unrelated local interface's methods have NO callers — the
        // external sql.DB calls must not bind to them.
        const execDecl = (await cg.searchNodes('Exec', { limit: 10 })).find(
          (r) => r.node.kind === 'method'
        );
        if (execDecl) {
          const execCallers = await cg.getCallers(execDecl.node.id);
          expect(execCallers.map((c) => c.node.name)).not.toContain('Write');
        }
        const qrDecl = (await cg.searchNodes('QueryRow', { limit: 10 })).find(
          (r) => r.node.kind === 'method'
        );
        if (qrDecl) {
          const qrCallers = await cg.getCallers(qrDecl.node.id);
          expect(qrCallers.map((c) => c.node.name)).not.toContain('Read');
        }

        // The in-project field chain resolves (validated), gaining an edge the
        // bare-name era never produced.
        const put = (await cg.searchNodes('Put', { limit: 10 })).find(
          (r) => r.node.kind === 'method' && r.node.qualifiedName?.includes('Store')
        );
        expect(put).toBeDefined();
        const putCallers = await cg.getCallers(put!.node.id);
        expect(putCallers.map((c) => c.node.name)).toContain('Save');
        cg.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 30000);

    it('unexported field types resolve; stdlib-qualified types never bind a same-named local decoy', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1276b-'));
      try {
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/b\n\ngo 1.22\n');
        fs.writeFileSync(
          path.join(tmpDir, 'm.go'),
          `package m

import "net/http"

type node struct{}

func (n *node) InsertRoute(path string) {}

// A local type sharing the stdlib interface's name — the decoy the
// package-qualifier gate exists for.
type Handler func()

func (h Handler) ServeHTTP() {}

type Mux struct {
	// the tree router lives below this comment (the comment must not
	// donate a field type)
	handler http.Handler
	tree    *node
}

func (mx *Mux) handle(path string) {
	mx.tree.InsertRoute(path)
}

func (mx *Mux) dispatch() {
	mx.handler.ServeHTTP(nil, nil)
}
`
        );

        const cg = CodeGraph.initSync(tmpDir);
        await cg.indexAll();

        // Unexported in-package field type: chain resolves (chi's mx.tree shape),
        // and the doc comment above the field donates nothing.
        const insert = (await cg.searchNodes('InsertRoute', { limit: 5 })).find(
          (r) => r.node.kind === 'method'
        );
        expect(insert).toBeDefined();
        const insertCallers = await cg.getCallers(insert!.node.id);
        expect(insertCallers.map((c) => c.node.name)).toContain('handle');

        // `handler http.Handler` is stdlib — the call must NOT bind to the
        // local decoy `Handler.ServeHTTP`.
        const serve = (await cg.searchNodes('ServeHTTP', { limit: 5 })).find(
          (r) => r.node.kind === 'method'
        );
        if (serve) {
          const serveCallers = await cg.getCallers(serve.node.id);
          expect(serveCallers.map((c) => c.node.name)).not.toContain('dispatch');
        }
        cg.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 30000);
  });
