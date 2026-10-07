const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({headless: true});
  const timeout = setTimeout(() => { console.error('Test timed out'); process.exit(1); }, 60000);
  timeout.unref();
  try {
    const page = await browser.newPage({viewport:{width:1500,height:1000}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const url = pathToFileURL(__dirname + '/../index.html').href;
    await page.goto(url);
    const originalTitle = await page.locator('.tab-name').textContent();
    const originalDoc = JSON.parse(await page.locator('#code').inputValue());
    const dirtyDraft = '{"signal":';
    await page.locator('#codeViewBtn').click();
    await page.locator('#code').fill(dirtyDraft);
    const inputName = '拖入后的新画布';
    const doc = {head:{text:inputName},signal:[{name:'data',wave:'==',data:['A','B']}]};
    async function drop(files, target='#diagram') {
      const transfer = await page.evaluateHandle(files => {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(new File([f.text],f.name,{type:f.type||''}));
        return dt;
      }, files);
      await page.locator(target).dispatchEvent('dragenter',{dataTransfer:transfer});
      await page.locator('#fileDropHint').waitFor({state:'visible'});
      const blocked = await page.evaluate(dt => !document.dispatchEvent(
        new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true})), transfer);
      assert.equal(blocked,true,'必须阻止浏览器将文件作为页面打开');
      await page.locator(target).dispatchEvent('drop',{dataTransfer:transfer});
      await page.evaluate(() => fileOpenQueue);
      await page.locator('#fileDropHint').waitFor({state:'hidden'});
      await transfer.dispose();
      assert.equal(page.url(),url);
    }
    await drop([{name:'正常.WAVEJSON',text:JSON.stringify(doc)}]);
    assert.equal(await page.locator('.tab-name').count(),2);
    assert.equal(await page.locator('.canvas-tab.active .tab-name').textContent(),inputName);
    assert.deepEqual(JSON.parse(await page.locator('#code').inputValue()).signal,doc.signal);
    await page.locator('.tab-name').filter({hasText:originalTitle}).click();
    assert.equal(await page.locator('#code').inputValue(),dirtyDraft,'未应用草稿不能被覆盖');
    const before = await page.evaluate(() => localStorage.getItem('timing-studio-tabs-v1'));
    await drop([{name:'损坏.wavejson',text:'invalid json'}],'#code');
    assert.equal(await page.locator('.tab-name').count(),2);
    assert.equal(await page.locator('#code').inputValue(),dirtyDraft);
    assert.equal(await page.evaluate(() => localStorage.getItem('timing-studio-tabs-v1')),before);
    assert.match(await page.locator('#codeMessage').textContent(),/损坏.wavejson/);
    await drop([{name:'first.json',text:JSON.stringify({head:{text:'第一个'},signal:originalDoc.signal})},
                {name:'second.wavejson',text:JSON.stringify({head:{text:'第二个'},signal:doc.signal})},
                {name:'not-a-wave.txt',text:'text'}]);
    assert.equal(await page.locator('.tab-name').count(),4);
    assert.deepEqual((await page.locator('.tab-name').allTextContents()).slice(-2),['第一个','第二个']);
    assert.match(await page.locator('#codeMessage').textContent(),/not-a-wave.txt/);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'timing-file-picker-'));
    const picked = path.join(directory,'picker.wavejson');
    fs.writeFileSync(picked,JSON.stringify({head:{text:'选择文件'},signal:doc.signal}));
    await page.locator('#fileInput').setInputFiles(picked);
    await page.evaluate(() => fileOpenQueue);
    assert.equal(await page.locator('.tab-name').count(),5);
    assert.equal(await page.locator('#fileInput').inputValue(),'');
    fs.rmSync(directory, {recursive: true, force: true});
    await page.reload();
    assert.equal(await page.locator('.tab-name').count(),5);
    assert.equal(await page.locator('.canvas-tab.active .tab-name').textContent(),'选择文件');
    assert.deepEqual(await page.locator('[data-bus-label]').allTextContents(),['A','B']);
    assert.equal(await page.locator('[data-bus-boundary]').count(),1,'保留已安装版本的总线绘制修复');
    assert.deepEqual(errors,[]);
    console.log('PASS: file drop, WaveJSON/JSON, multiple files, invalid file, preserved draft, file picker, reload and bus rendering');
  } finally {await browser.close();}
})().catch(e => {console.error(e);process.exitCode=1;});
