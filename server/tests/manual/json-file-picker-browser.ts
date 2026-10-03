/**
 * Browser regression for byte-preserving JSON uploads and MCP Apps sandboxes.
 * Run from the repository root in Docker with Chrome/Chromium installed:
 *   CHROME_BINARY=/usr/bin/chromium npx tsx server/tests/manual/json-file-picker-browser.ts
 * Uses synthetic fixtures, an in-memory native MCP connection, and published
 * schemas. Artifacts go to .context/json-file-picker; no live Claude login.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import puppeteer from 'puppeteer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createUnifiedMCPServer } from '../../src/mcp/server.js';
import { createJsonValidationRouter } from '../../src/routes/json-validation.js';
import { csrfProtection } from '../../src/middleware/csrf.js';

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createUnifiedMCPServer();
const client = new Client({ name: 'mcp-app-browser-test', version: '1' }, { capabilities: {} });
await server.connect(serverTransport);
await client.connect(clientTransport);
const resources = await client.listResources();
assert(resources.resources.some((resource) => resource.uri === 'ui://addie/json-validator.html'));
const resource = await client.readResource({ uri: 'ui://addie/json-validator.html' });
const html = resource.contents[0].text as string;
const tools = await client.listTools();
assert.deepEqual(tools.tools.find((tool) => tool.name === 'validate_json_upload')?._meta?.ui, { visibility: ['app'] });
const calls: any[] = [];
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(csrfProtection);
app.use('/api', createJsonValidationRouter());
app.get('/adagents/validator', (_req, res) => res.sendFile(process.cwd() + '/server/public/json-validator-app.html'));
app.get('/design-system.css', (_req, res) => res.sendFile(process.cwd() + '/server/public/design-system.css'));
app.post('/rpc', async (req, res) => {
  const args = req.body.arguments;
  calls.push(args);
  res.json(await client.callTool({ name: req.body.name, arguments: args }));
});
app.get('/host', (_req, res) => res.send(`<!doctype html><html><body>
<iframe id="view" sandbox="allow-scripts allow-same-origin" src="http://127.0.0.1:${viewPort}/view" style="width:850px;height:1000px;border:0"></iframe>
<iframe id="sibling" src="http://127.0.0.1:${viewPort}/sibling"></iframe>
<script>
window.modelContexts=[];
window.openedLinks=[];
window.hostMode='normal';
window.addEventListener('message', async event => {
 if(event.source !== document.getElementById('view').contentWindow) return;
 const m=event.data;
 function answer(result) { event.source.postMessage({jsonrpc:'2.0', id:m.id, result}, '*'); }
 if(m.method==='ui/initialize') answer({protocolVersion:'2026-01-26', hostCapabilities:{serverTools:{},openLinks:{}},hostInfo:{name:'test-host',version:'1'}});
 else if(m.method==='ui/notifications/initialized') event.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{schema_path:'adagents.json'}}},'*');
 else if(m.method==='tools/call') {
  if(window.hostMode==='altered') m.params.arguments.content_base64=btoa('{"ext":{}}');
  const csrf=document.cookie.split('; ').find(x=>x.startsWith('csrf-token=')).slice(11);
  const result=await (await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(m.params)})).json();
  if(window.hostMode==='bad-receipt'&&result.structuredContent) result.structuredContent.sha256='0'.repeat(64);
  answer(result);
 } else if(m.method==='ui/update-model-context') {window.modelContexts.push(m.params);answer({});}
 else if(m.method==='ui/open-link') {window.openedLinks.push(m.params.url);answer({});}
});
</script></body></html>`));
const iframeApp = express();
iframeApp.get('/view', (_req, res) => res.send(html));
iframeApp.get('/sibling', (_req, res) => res.send('<!doctype html><html><body>Sibling frame</body></html>'));
const frameListener = iframeApp.listen(0, '127.0.0.1');
await new Promise<void>(resolve => frameListener.once('listening', resolve));
const viewPort = (frameListener.address() as import('node:net').AddressInfo).port;
const listener = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => listener.once('listening', resolve));
const hostPort = (listener.address() as import('node:net').AddressInfo).port;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BINARY ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1024, height: 1000 });
const errors: string[] = [];
page.on('pageerror', error => errors.push(String(error)));
const report: any[] = [];
const fixtureDir = process.cwd() + '/.context/json-file-picker';
await mkdir(fixtureDir, { recursive: true });
for (const kind of ['valid', 'invalid']) {
  await writeFile(`${fixtureDir}/${kind}-adagents.json`, JSON.stringify({
    $schema: 'https://adcontextprotocol.org/schemas/3.2.1/adagents.json',
    ext: { reproduction_padding: Array.from({ length: 500 }, () => 'x'.repeat(60)) },
    authoritative_location: `${kind === 'valid' ? 'https' : 'http'}://publisher.example.com/adagents.json`,
  }, null, 2) + '\n');
}
try {
  for (const mode of ['standalone', 'mcp-app']) {
    await page.goto(`http://127.0.0.1:${hostPort}/${mode === 'standalone' ? 'adagents/validator' : 'host'}`);
    const frame = mode === 'standalone' ? page.mainFrame() : await page.waitForFrame(frame => frame.url().endsWith('/view'));
    await frame.waitForFunction(() => !(document.getElementById('submit') as HTMLButtonElement).disabled);
    for (const kind of ['valid', 'invalid']) {
      const file = `${fixtureDir}/${kind}-adagents.json`;
      const original = await readFile(file);
      const sha256 = createHash('sha256').update(original).digest('hex');
      const picker = await frame.$('input[type=file]');
      await picker!.uploadFile(file);
      // The fixture filenames differ from adagents.json; select its schema explicitly.
      await frame.$eval('#schema', (input) => { (input as HTMLInputElement).value = 'adagents.json'; });
      await frame.click('#submit');
      await frame.waitForFunction(() => !(document.getElementById('submit') as HTMLButtonElement).disabled && !(document.getElementById('receipt') as HTMLElement).hidden, { timeout: 60000 });
      const text = await frame.$eval('#receipt', element => element.textContent!);
      assert(text.includes(`${original.length} bytes`));
      assert(text.includes(sha256));
      assert(text.includes(kind === 'valid' ? 'Valid!' : '/authoritative_location: must match pattern'));
      assert(!text.includes('x'.repeat(60)));
      if (mode === 'mcp-app') {
        const args = calls.at(-1);
        assert(Buffer.from(args.content_base64, 'base64').equals(original));
        assert.equal(JSON.parse(original.toString()).ext.reproduction_padding.length, 500);
        assert.equal(args.expected_file_sha256, sha256);
        assert.equal(args.expected_byte_count, original.length);
        const context = await page.evaluate(() => (window as any).modelContexts.at(-1));
        assert.equal(context.structuredContent.sha256, sha256);
        assert(!JSON.stringify(context).includes('content_base64'));
      }
      report.push({ mode, kind, byte_count: original.length, sha256, passed: true });
      await page.screenshot({ path: `${fixtureDir}/${mode}-${kind}-picker.png`, fullPage: true });
    }
    if (mode === 'mcp-app') {
      await frame.click('#fallback a');
      await page.waitForFunction(() => (window as any).openedLinks.includes('https://agenticadvertising.org/adagents/validator'));
      report.push({ mode, sandbox_link_opened_through_host: true });
      const sibling = await page.waitForFrame(frame => frame.url().endsWith('/sibling'));
      // A sibling cannot supply a forged response to a pending app request.
      await sibling.evaluate(() => {
        parent.frames[0].postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { schema_path: 'forged.json' } } }, '*');
      });
      assert.equal(await frame.$eval('#schema', element => (element as HTMLInputElement).value), 'adagents.json');
      report.push({ mode, sibling_message_rejected: true });
      for (const failure of ['altered', 'bad-receipt']) {
        await page.evaluate(value => { (window as any).hostMode = value; }, failure);
        await frame.click('#submit');
        await frame.waitForFunction(() => !(document.getElementById('submit') as HTMLButtonElement).disabled);
        assert.equal(await frame.$eval('#status', element => (element as HTMLElement).dataset.error), 'true');
        assert.equal(await frame.$eval('#receipt', element => (element as HTMLElement).hidden), true);
        assert.equal(await page.evaluate(() => (window as any).modelContexts.at(-1).structuredContent.status), 'pending');
        report.push({ mode, failure, rejected: true });
      }
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(`${fixtureDir}/file-picker-results.json`, JSON.stringify({ report, page_errors: errors, actual_claude_host_tested: false }, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  listener.close(); frameListener.close(); await client.close(); await server.close();
}
