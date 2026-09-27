import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCreate, validateMessage } from '../src/http/routes.js';

test('a message needs text or an attachment', () => {
  assert.throws(() => validateMessage({}), /Nothing to send/);
  assert.equal(validateMessage({ text: '  hi ' }).text, 'hi');
});

test('an attachment without content is refused by name', () => {
  assert.throws(
    () => validateMessage({ text: 'x', attachments: [{ name: 'shot.png' }] }),
    /shot\.png arrived without any content/,
  );
});

test('attachments alone get a default sentence', () => {
  const out = validateMessage({ attachments: [{ name: 'a.txt', mediaType: 'text/plain', data: 'aGk=' }] });
  assert.equal(out.text, 'See the attached file.');
  assert.equal(out.attachments.length, 1);
});

test('creating a session validates task, project and mode', () => {
  assert.throws(() => validateCreate({ projectId: 'p' }), /something to do/);
  assert.throws(() => validateCreate({ task: 't' }), /project to run in/);
  const req = validateCreate({ task: 't', projectId: 'p', permissionMode: 'bogus', model: '' });
  assert.equal(req.permissionMode, 'ask');
  assert.equal(req.model, 'sonnet');
  assert.equal(validateCreate({ task: 't', projectId: 'p', permissionMode: 'plan' }).permissionMode, 'plan');
});
