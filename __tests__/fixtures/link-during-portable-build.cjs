const path = require('node:path');
const fs = require('node:fs');
const { isMainThread } = require('node:worker_threads');
if (isMainThread && path.basename(process.argv[1] ?? '') === 'publisher-worker.js') {
  const send = process.send;
  process.send = function (message, ...args) {
    if (message?.progress?.phase === 'parsing' && message.progress.current === 0) {
      process.send = send;
      fs.symlinkSync(process.env.TEST_PUBLICATION_LINK_ROOT, path.join(process.argv[2], 'linked'), 'junction');
    }
    return send.call(this, message, ...args);
  };
}
