import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { webUri } from '../../core/web';

describe('webUri', () => {
  it('lets http and https through as a URL', () => {
    assert.equal(webUri('https://linear.app/t/ABC-1')?.href, 'https://linear.app/t/ABC-1');
    assert.equal(webUri('http://localhost:3000')?.href, 'http://localhost:3000/');
    assert.equal(webUri('http://[::1]:5173/')?.href, 'http://[::1]:5173/');
  });

  it('refuses the schemes openExternal would honour besides the web', () => {
    // The invariant this module exists for: vscode.env.openExternal treats
    // `command:` and `vscode:` as first-class, so a URL that round-tripped
    // through the webview cannot be handed over on scheme alone.
    assert.equal(webUri('command:workbench.action.files.newUntitledFile'), undefined);
    assert.equal(webUri('vscode://file/tmp/secret'), undefined);
    assert.equal(webUri('vscode:extension/foo'), undefined);
    assert.equal(webUri('file:///etc/passwd'), undefined);
    assert.equal(webUri('javascript:alert(1)'), undefined);
    assert.equal(webUri('data:text/html,hi'), undefined);
  });

  it('refuses a string that is not a URL, instead of throwing', () => {
    assert.equal(webUri(''), undefined);
    assert.equal(webUri('not a url'), undefined);
    assert.equal(webUri('https://'), undefined);
    assert.equal(webUri('/relative'), undefined);
  });
});
