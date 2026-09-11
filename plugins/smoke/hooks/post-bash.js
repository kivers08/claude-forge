#!/usr/bin/env node
'use strict';
// PostToolUse Bash: return additionalContext with a distinctive sentence.
// Proves: PostToolUse-on-Bash additionalContext is visible to the model next
// turn (check 5, the D7 rules-injector mechanism). Fails open: on any problem
// it prints nothing and exits 0.
const { readStdin, parsePayload } = require('./lib/io');

const payload = parsePayload(readStdin());
if (payload.hook_event_name && payload.hook_event_name !== 'PostToolUse') process.exit(0);
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: 'SMOKE-CONTEXT-4b2d: the smoke plugin post-bash hook injected this sentence after a Bash call.',
  },
}));
process.exit(0);
