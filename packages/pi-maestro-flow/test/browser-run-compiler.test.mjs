import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { compileRunCode, BrowserManager } = await jiti.import('../src/tools/browser/manager.ts');
const { createBrowserTool } = await jiti.import('../src/tools/browser-tool.ts');

test('browser run loaded through Jiti supports host dynamic imports', async () => {
  const execute = compileRunCode("return typeof (await import('node:fs/promises')).writeFile;");
  assert.equal(await execute(), 'function');
});

test('browser run imports resolve relative to its cwd without creating a runner file', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-browser-import-'));
  try {
    await writeFile(join(cwd, 'helper.mjs'), 'export const value = 42;\n');
    assert.equal(await compileRunCode("return (await import('./helper.mjs')).value;", cwd)(), 42);
    await assert.rejects(access(join(cwd, '__pi_browser_run__.js')), { code: 'ENOENT' });
    await assert.rejects(compileRunCode("return import('./missing.mjs');", cwd)(), { code: 'ERR_MODULE_NOT_FOUND' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('managed browser run supports imports and open-scoped JavaScript dialog policies', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-browser-managed-import-'));
  const manager = new BrowserManager();
  try {
    await writeFile(join(cwd, 'helper.mjs'), 'export const value = 42;\n');
    await manager.open({ name: 'imports', channel: 'managed', cwd, dialogs: 'accept', url: 'data:text/html,<title>Imports</title>', timeoutMs: 15000 });
    const result = await manager.run('imports', `
      const fs = await import('node:fs/promises');
      return { imported: typeof fs.writeFile === 'function', value: (await import('./helper.mjs')).value,
        confirmed: await page.evaluate(() => confirm('test dialog')), title: await page.title() };
    `, cwd, undefined, 5000);
    assert.deepEqual(result.returnValue, { imported: true, value: 42, confirmed: true, title: 'Imports' });
    await manager.open({ name: 'imports', channel: 'managed', cwd, dialogs: 'dismiss', timeoutMs: 5000 });
    assert.equal((await manager.run('imports', "return await page.evaluate(() => confirm('test dialog'));", cwd, undefined, 5000)).returnValue, false);
  } finally {
    await manager.closeAll();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('dialog callback protocol failure is a tool error, not a process crash, and the next run works', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-browser-dialog-error-'));
  const manager = new BrowserManager();
  const tool = createBrowserTool(manager);
  try {
    await manager.open({ name: 'dialogs', channel: 'managed', cwd, timeoutMs: 15000 });
    const result = await tool.execute('dialog-error', { action: 'run', name: 'dialogs', timeout: 5, code: `
      print('before dialog');
      page.on('dialog', async (dialog) => {
        dialog.accept = async () => { throw new Error('Protocol error (Page.handleJavaScriptDialog): No dialog is showing'); };
        await dialog.accept();
      });
      await page.evaluate(() => confirm('test dialog'));
    ` }, undefined, undefined, { cwd });
    assert.equal(result.isError, true);
    assert.match(result.details.error.message, /Page.handleJavaScriptDialog.*No dialog is showing/);
    assert.match(result.details.error.message, /page.dialog handler failed/);
    assert.match(result.details.diagnostics.partialText, /before dialog/);
    assert.equal(manager.has('dialogs'), false);
    await manager.open({ name: 'dialogs', channel: 'managed', cwd, dialogs: 'dismiss', timeoutMs: 15000 });
    assert.equal((await manager.run('dialogs', "return await page.evaluate(() => confirm('next run'));", cwd, undefined, 5000)).returnValue, false);
    const custom = await manager.open({ name: 'dialogs', channel: 'managed', cwd, timeoutMs: 5000 });
    assert.equal(custom.reused, true);
    assert.equal((await manager.run('dialogs', `
      page.once('dialog', async (dialog) => { await dialog.accept(); });
      return await page.evaluate(() => confirm('custom handler'));
    `, cwd, undefined, 5000)).returnValue, true);
    // A successful custom listener must not persist into the next run.
    await manager.open({ name: 'dialogs', channel: 'managed', cwd, dialogs: 'dismiss', timeoutMs: 5000 });
    assert.equal((await manager.run('dialogs', "return await page.evaluate(() => confirm('no stale listeners'));", cwd, undefined, 5000)).returnValue, false);
  } finally {
    await manager.closeAll();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('browser run VM compiler preserves helper shadowing and per-run lexical scope', async () => {
  const execute = compileRunCode('const page = 4; const wait = 2; function assert() { return 1; } return page + wait + assert();');
  assert.equal(await execute({ original: true }), 7);
  await compileRunCode('const localOnly = 1;')();
  await assert.rejects(compileRunCode('return localOnly;')(), { name: 'ReferenceError' });
  assert.throws(() => compileRunCode('const x = ;'), { name: 'SyntaxError' });
});
