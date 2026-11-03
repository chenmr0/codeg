import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from validation import check_frozen_inputs, checked_source, extract_source

class ValidationTests(unittest.TestCase):
    def test_trusted_frozen_input(self):
        check_frozen_inputs(Path(__file__).parent)

    def test_gold_and_self_reported_digest_tampered_together(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp); raw=b'[]'
            (p/'queries-gold.json').write_bytes(raw)
            (p/'FREEZE.json').write_text(json.dumps({'sha256':hashlib.sha256(raw).hexdigest()}))
            with self.assertRaises(ValueError): check_frozen_inputs(p)

    def test_source_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'root'; root.mkdir()
            (root/'ok.cpp').write_text('ok')
            (root/'untracked.cpp').write_text('bad')
            outside=Path(tmp)/'outside.cpp'; outside.write_text('secret')
            (root/'link.cpp').symlink_to(outside)
            tracked={'ok.cpp','link.cpp'}
            self.assertEqual(checked_source(root,'ok.cpp',tracked),root/'ok.cpp')
            for path in ['../outside.cpp',str(outside),'untracked.cpp','link.cpp']:
                with self.subTest(path=path), self.assertRaises(ValueError): checked_source(root,path,tracked)

    def test_conflicting_duplicate_rejected(self):
        text='**Source Code**\n**`x.cpp`**\n```cpp\n1\tWRONG\n```\n```cpp\n1\tRIGHT\n```'
        with self.assertRaises(ValueError): extract_source(text,lambda _:None)

    def test_identical_duplicate_allowed(self):
        text='**Source Code**\n**`x.cpp`**\n```cpp\n1\tok\n1\tok\n```'
        self.assertEqual(extract_source(text,lambda _:None),{('x.cpp',1):'ok'})

    def test_echo_is_not_source(self):
        self.assertEqual(extract_source('**`x.cpp`**\n```cpp\n1\tok\n```',lambda _:None),{})

    def test_unclosed_fence_rejected(self):
        with self.assertRaises(ValueError): extract_source('**Source Code**\n**`x.cpp`**\n```cpp\n1\tok',lambda _:None)

    def test_header_without_lines_still_checked(self):
        def reject(_): raise ValueError('bad path')
        with self.assertRaises(ValueError): extract_source('**Source Code**\n**`../secret`**',reject)

if __name__=='__main__': unittest.main()
