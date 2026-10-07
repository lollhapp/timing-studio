const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const timeout = setTimeout(() => { console.error('Test timed out'); process.exit(1); }, 60000);
  timeout.unref();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
    assert.equal(await page.locator('#canvasViewBtn').getAttribute('aria-pressed'), 'true');
    await page.locator('#codeViewBtn').click();
    const doc = { head: { text: '导出验证' }, signal: [{ name: 'data', wave: '==', data: ['A', 'B'] }] };
    await page.locator('#code').fill(JSON.stringify(doc));
    await page.locator('#canvasViewBtn').click();
    assert.deepEqual(await page.locator('[data-bus-label]').allTextContents(), ['A', 'B']);
    await page.locator('#codeViewBtn').click();
    await page.locator('#code').fill('{invalid');
    await page.locator('#canvasViewBtn').click();
    assert.equal(await page.locator('#codeViewBtn').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#code').inputValue(), '{invalid');
    await page.locator('#code').fill(JSON.stringify(doc));
    await page.locator('#applyBtn').click();
    for (const [button, extension] of [['saveBtn', 'json'], ['svgBtn', 'svg'], ['pngBtn', 'png']]) {
      const pending = page.waitForEvent('download');
      await page.locator('#' + button).click();
      const download = await pending;
      assert.equal(download.suggestedFilename(), '导出验证.' + extension);
      assert.equal(await download.failure(), null);
      const stream = await download.createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const data = Buffer.concat(chunks);
      assert.ok(data.length > 0);
      if (extension === 'json') assert.deepEqual(JSON.parse(data).signal, doc.signal);
      if (extension === 'svg') assert.match(data.toString(), /<svg/);
      if (extension === 'png') assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: view switching, invalid draft protection, JSON/SVG/PNG exports');
  } finally {
    await browser.close();
    clearTimeout(timeout);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
