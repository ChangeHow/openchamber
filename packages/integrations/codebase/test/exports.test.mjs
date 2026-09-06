import assert from 'node:assert/strict';
import test from 'node:test';
import * as root from '@openchamber-plugin/codebase';
import * as server from '@openchamber-plugin/codebase/server';
import * as web from '@openchamber-plugin/codebase/web';
import * as i18n from '@openchamber-plugin/codebase/i18n';

test('public exports load without host runtime requirements', () => {
  assert.ok(root.parseCodebaseRemoteUrl);
  assert.ok(server.createCodebaseHandler);
  assert.ok(web.createCodebaseClient);
  assert.equal(i18n.codebaseMessages.id, 'codebase');
  assert.equal(root.codebaseIntegration.id, 'codebase');
  assert.equal(root.codebaseIntegration.createClient, web.createCodebaseClient);
  assert.equal(root.codebaseIntegration.i18n, i18n.codebaseMessages);
  assert.equal(root.codebaseIntegration.parseRemoteUrl, root.parseCodebaseRemoteUrl);
  assert.equal(root.codebaseIntegration.getMergeRequestSource, root.getCodebaseMergeRequestSource);
  assert.equal('createCodebaseHandler' in root, false);
});
