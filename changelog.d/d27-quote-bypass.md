section: Security
- Close the D27 guard bypass: quoting a single word of a merge command (`gh "pr" merge`, `git "merge"`, `me""rge`) no longer evades the merge gate or any other guard. Fixed in both the tokenizer (`lib/segment-split.js`, cosmetic quotes no longer mark a token as data) and the PreToolUse dispatcher (`pre-bash.js`, the prefilter now also tests the quote-stripped token stream).
