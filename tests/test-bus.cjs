const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
(async () => {
  const browser = await chromium.launch({headless: true});
  const timeout = setTimeout(() => { console.error('Test timed out'); process.exit(1); }, 60000);
  timeout.unref();
  const page = await browser.newPage({viewport: {width: 1500, height: 1000}});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(__dirname + '/../index.html').href);
  async function apply(doc) {
    await page.locator('#codeViewBtn').click();
    await page.locator('#code').fill(JSON.stringify(doc));
    await page.locator('#applyBtn').click();
  }
  async function wave() { return JSON.parse(await page.locator('#code').inputValue()).signal[0]; }
  async function clickCell(i) {
    const box = await page.locator('#diagram').boundingBox();
    await page.mouse.click(box.x + 150 + (i + .5) * 44, box.y + 106);
  }
  await apply({signal: [{name: 'data', wave: '=.=.', data: ['0x12','0x34']}]});
  assert.deepEqual(await page.locator('[data-bus-label]').allTextContents(), ['0x12','0x34']);
  await clickCell(2);
  await page.locator('#propBusValue').fill('0x56');
  await page.locator('#propBusValue').press('Tab');
  assert.deepEqual((await wave()).data, ['0x12','0x56']);
  assert.equal((await wave()).wave, '=.=.');
  await page.locator('#undoBtn').click();
  assert.deepEqual((await wave()).data, ['0x12','0x34']);
  await page.locator('#redoBtn').click();
  assert.deepEqual((await wave()).data, ['0x12','0x56']);
  await apply({signal: [{name: 'data', wave: '=...', data: ['SAME']}]});
  await clickCell(1);
  await page.locator('#propBusValue').fill('MULTI');
  await page.locator('#propBusValue').press('Tab');
  assert.equal((await wave()).wave, '=...');
  assert.deepEqual((await wave()).data, ['MULTI']);
  await page.locator('#undoBtn').click();
  await clickCell(2);
  await page.locator('#toggleBusBreak').click();
  assert.equal((await wave()).wave, '=.=.');
  assert.deepEqual(await page.locator('[data-bus-label]').allTextContents(), ['SAME','SAME']);
  const saved = JSON.parse(await page.locator('#code').inputValue());
  await apply(saved);
  assert.equal(await page.locator('[data-edge="2"]').count(), 1);
  await page.reload();
  assert.equal((await wave()).wave, '=.=.');
  // Move a same-value manual split; its labels and split must remain independent.
  let box = await page.locator('#diagram').boundingBox();
  await page.mouse.move(box.x + 238, box.y + 106);
  await page.mouse.down();
  await page.mouse.move(box.x + 238 + 44, box.y + 106, {steps: 5});
  await page.mouse.up();
  assert.equal((await wave()).wave, '=..=');
  assert.deepEqual(await page.locator('[data-bus-label]').evaluateAll(elements => elements.map(el => el.getAttribute('data-full-value'))), ['SAME','SAME']);
  assert.deepEqual((await wave()).data, ['SAME','SAME']);
  // Copy/paste a split along with its value and verify export contains the values.
  await page.evaluate(async () => {
    selected = {row: 0, cell: 3}; selectedRange = {row: 0, start: 0, end: 3};
    await copySelection(); selected = {row: 0, cell: 0}; await pasteSelection();
  });
  assert.equal((await wave()).wave, '=..=');
  assert.ok(await page.evaluate(() => svgText().includes('SAME')));
  await page.locator('[data-tool="busBreak"]').click();
  box = await page.locator('#diagram').boundingBox();
  await page.mouse.click(box.x + 282, box.y + 106);
  assert.equal((await wave()).wave, '=...');
  await page.locator('[data-tool="select"]').click();
  await page.mouse.dblclick(box.x + 216, box.y + 106);
  assert.equal(await page.locator('#propBusValue').evaluate(el => document.activeElement === el), true);
  await page.locator('#propBusValue').fill('整段数据');
  await page.locator('#propBusValue').press('Tab');
  assert.deepEqual((await wave()).data, ['整段数据']);
  // Adjacent cycles have distinct labels and an automatic crossover.
  await apply({signal: [{name: 'data', wave: '==', data: ['A','B']}]});
  assert.deepEqual(await page.locator('[data-bus-label]').allTextContents(), ['A','B']);
  assert.equal(await page.locator('[data-edge="1"]').count(), 1);
  require('node:fs').mkdirSync(__dirname + '/../test-results', {recursive: true});
  await page.screenshot({path: __dirname + '/../test-results/bus-verification.png'});
  assert.deepEqual(errors, []);
  console.log('PASS: values, adjacent cycles, manual splits, drag, undo/redo, JSON/local storage, clipboard, SVG, double-click editing');
  await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
