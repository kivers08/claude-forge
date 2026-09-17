#!/usr/bin/env node
'use strict';
// Direct unit tests for lib/redact.js's scrubSecrets, independent of any
// hook that calls it. memory-redact.test.js already exercises scrubSecrets
// end-to-end through the hook (payload -> file on disk); this file covers
// the salvaged scrubber itself so it has its own coverage regardless of
// which hook(s) end up calling it (see the D28.4 unit 4 note in redact.js).
const assert = require('assert');
const redact = require('../lib/redact');

let failed = 0;
let ran = 0;

function t(name, fn) {
  ran++;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${e.message}`);
  }
}

t('AWS access key is redacted', () => {
  const { text, redactions } = redact.scrubSecrets('key AKIAABCDEFGHIJKLMNOP end');
  assert.ok(text.includes('[REDACTED:aws-access-key]'), text);
  assert.ok(!text.includes('AKIAABCDEFGHIJKLMNOP'), text);
  assert.strictEqual(redactions.length, 1);
  assert.strictEqual(redactions[0].kind, 'aws-access-key');
});

t('GitHub token (ghp_) is redacted', () => {
  const { text } = redact.scrubSecrets('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end');
  assert.ok(text.includes('[REDACTED:github-token]'), text);
  assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), text);
});

t('GitHub fine-grained PAT (github_pat_) is redacted', () => {
  const { text } = redact.scrubSecrets('token github_pat_' + 'A'.repeat(30) + ' end');
  assert.ok(text.includes('[REDACTED:github-token]'), text);
  assert.ok(!text.includes('github_pat_' + 'A'.repeat(30)), text);
});

t('a PEM private key block is redacted', () => {
  const before = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n';
  const { text, redactions } = redact.scrubSecrets(before);
  assert.ok(text.includes('[REDACTED:pem]'), text);
  assert.ok(!text.includes('MIIEpAIBAAKCAQEA'), text);
  assert.strictEqual(redactions.length, 1);
  assert.strictEqual(redactions[0].kind, 'pem');
});

t('an encrypted PEM private key block is still recognized as a private key', () => {
  const before = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END ENCRYPTED PRIVATE KEY-----\n';
  const { text } = redact.scrubSecrets(before);
  assert.ok(text.includes('[REDACTED:pem]'), text);
  assert.ok(!text.includes('MIIEpAIBAAKCAQEA'), text);
});

t('a Slack token is redacted', () => {
  const { text } = redact.scrubSecrets('xoxb-1234567890-abcdefghij');
  assert.ok(text.includes('[REDACTED:slack-token]'), text);
});

t('an Anthropic-style api key is redacted', () => {
  const { text } = redact.scrubSecrets('sk-ant-' + 'a'.repeat(24));
  assert.ok(text.includes('[REDACTED:api-key]'), text);
});

t('a Bearer token is redacted but the "Bearer" keyword is preserved', () => {
  const { text } = redact.scrubSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
  assert.ok(text.includes('Bearer [REDACTED:bearer-token]'), text);
});

t('an unquoted secret-assignment is redacted without adding quotes', () => {
  const { text, redactions } = redact.scrubSecrets('DEPLOY_SECRET=supersecretvalue123\n');
  assert.ok(text.includes('DEPLOY_SECRET=[REDACTED:secret-assignment]'), text);
  assert.ok(!text.includes('supersecretvalue123'), text);
  assert.strictEqual(redactions[0].kind, 'secret-assignment');
});

t('a double-quoted secret-assignment preserves both surrounding quotes', () => {
  const { text } = redact.scrubSecrets('FOO_SECRET="abc123def456"\n');
  assert.ok(text.includes('FOO_SECRET="[REDACTED:secret-assignment]"'), text);
  assert.ok(!text.includes('abc123def456'), text);
  // No orphaned trailing quote and no dropped opening quote.
  assert.ok(!text.includes('[REDACTED:secret-assignment]"\n"'), text);
});

t('a colon-separated secret-assignment (YAML-style) is redacted', () => {
  const { text } = redact.scrubSecrets('api_key: abcdef123456\n');
  assert.ok(text.includes('api_key: [REDACTED:secret-assignment]'), text);
});

t('a single-quoted secret-assignment preserves both surrounding single quotes', () => {
  const { text } = redact.scrubSecrets("FOO_SECRET='abc123def456'\n");
  assert.ok(text.includes("FOO_SECRET='[REDACTED:secret-assignment]'"), text);
  assert.ok(!text.includes('abc123def456'), text);
  // No orphaned trailing quote and no dropped opening quote.
  assert.ok(!text.includes("[REDACTED:secret-assignment]'\n'"), text);
});

t('prose using the word "secret" as a plain English noun is left unchanged', () => {
  const before = 'the secret: sauce is the special ingredient\n';
  const { text, redactions } = redact.scrubSecrets(before);
  assert.strictEqual(text, before);
  assert.strictEqual(redactions.length, 0);
});

t('prose using the word "password" as a plain English noun is left unchanged', () => {
  const before = 'password: is a bad idea to reuse across sites\n';
  const { text, redactions } = redact.scrubSecrets(before);
  assert.strictEqual(text, before);
  assert.strictEqual(redactions.length, 0);
});

t('an ALL-CAPS secret-assignment keyword is still redacted despite the prose tightening', () => {
  const { text } = redact.scrubSecrets('FOO_SECRET=hunter2hunter2\n');
  assert.ok(text.includes('FOO_SECRET=[REDACTED:secret-assignment]'), text);
});

t('a colon-separated ALL-CAPS token assignment is still redacted', () => {
  const { text } = redact.scrubSecrets('API_TOKEN: abc123abc123\n');
  assert.ok(text.includes('API_TOKEN: [REDACTED:secret-assignment]'), text);
});

t('a lowercase-with-underscore secret-assignment keyword is still redacted', () => {
  const { text } = redact.scrubSecrets("aws_secret_key='xxxxxxxxxxxx'\n");
  assert.ok(text.includes("aws_secret_key='[REDACTED:secret-assignment]'"), text);
  assert.ok(!text.includes('xxxxxxxxxxxx'), text);
});

t('a secret-assignment value already redacted by a more specific pattern is not double-counted', () => {
  const before = 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n';
  const { text, redactions } = redact.scrubSecrets(before);
  const kinds = redactions.map((r) => r.kind);
  assert.deepStrictEqual(kinds, ['github-token']);
  assert.ok(text.includes('GITHUB_TOKEN=[REDACTED:github-token]'), text);
});

t('plain text with no secrets is left byte-identical', () => {
  const before = 'Just some plain notes about the project, nothing sensitive here.\n';
  const { text, redactions } = redact.scrubSecrets(before);
  assert.strictEqual(text, before);
  assert.strictEqual(redactions.length, 0);
});

t('null/undefined input does not throw', () => {
  assert.strictEqual(redact.scrubSecrets(null).text, '');
  assert.strictEqual(redact.scrubSecrets(undefined).text, '');
});

t('a prose near-match that declines redaction records zero redactions', () => {
  const before = 'the secret: sauceology tastes great\n';
  const { text, redactions } = redact.scrubSecrets(before);
  assert.strictEqual(text, before);
  assert.strictEqual(redactions.length, 0);
});

t('a real secret-assignment still records exactly one redaction of the right kind', () => {
  const { text, redactions } = redact.scrubSecrets('DEPLOY_SECRET=supersecretvalue123\n');
  assert.ok(text.includes('DEPLOY_SECRET=[REDACTED:secret-assignment]'), text);
  assert.strictEqual(redactions.length, 1);
  assert.strictEqual(redactions[0].kind, 'secret-assignment');
});

t('a file with both a real secret and a prose near-match records exactly one redaction', () => {
  const before = 'DEPLOY_SECRET=supersecretvalue123\nthe secret: sauceology tastes great\n';
  const { text, redactions } = redact.scrubSecrets(before);
  assert.ok(text.includes('DEPLOY_SECRET=[REDACTED:secret-assignment]'), text);
  assert.ok(text.includes('the secret: sauceology tastes great'), text);
  assert.strictEqual(redactions.length, 1);
  assert.strictEqual(redactions[0].kind, 'secret-assignment');
});

t('a long run of secret-assignment-keyword-class characters with no match does not hang (ReDoS regression)', () => {
  const input = 'a-'.repeat(262144); // 512 KiB, all in [A-Za-z0-9_-], no keyword present
  const start = process.hrtime.bigint();
  const { text, redactions } = redact.scrubSecrets(input);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.strictEqual(text, input);
  assert.strictEqual(redactions.length, 0);
  assert.ok(elapsedMs < 1000, `expected < 1000ms, took ${elapsedMs}ms`);
});

t('an unterminated PEM BEGIN block does not scan to EOF (ReDoS regression)', () => {
  const input = '-----BEGIN RSA PRIVATE KEY-----\n' + 'M'.repeat(200 * 1024) + '\n';
  const start = process.hrtime.bigint();
  const { text, redactions } = redact.scrubSecrets(input);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.strictEqual(text, input, 'unterminated PEM block must be left unchanged');
  assert.strictEqual(redactions.length, 0);
  assert.ok(elapsedMs < 1000, `expected < 1000ms, took ${elapsedMs}ms`);
});

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
