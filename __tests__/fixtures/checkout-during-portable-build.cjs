const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isMainThread } = require('node:worker_threads');

// Switch in the actual builder. A parent-side progress observer races parsing
// and can deliver its last edit after candidate validation instead.
if (isMainThread && path.basename(process.argv[1] ?? '') === 'publisher-worker.js') {
  const send = process.send;
  process.send = function (message, ...args) {
    const progress = message?.progress;
    const switchNow = process.env.TEST_CHECKOUT_AFTER_RESOLUTION === '1'
      ? progress?.phase === 'resolving' && progress.current === progress.total && progress.total > 0
      : progress?.phase === 'parsing' && progress.current === 0;
    if (switchNow) {
      process.send = send;
      execFileSync('git', ['switch', '--quiet', process.env.TEST_CHECKOUT_TARGET || 'latest'], { cwd: process.argv[2] });
    }
    return send.call(this, message, ...args);
  };
}
