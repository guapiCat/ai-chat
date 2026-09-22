// 用 Claude Code 完全相同的方式启动 MCP server：spawn('cmd', ['/c','npx',...])
// 绕开 git bash 的参数处理，这才是真实路径
import { spawn } from 'node:child_process';

const child = spawn('cmd', ['/c', 'npx', '-y', '@playwright/mcp@latest'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => {
  out += d.toString();
  if (out.includes('"id":2')) {
    const tools = out.match(/"name":"browser_[a-z_]+"/g) || [];
    console.log('HANDSHAKE OK');
    console.log('tools found:', tools.length);
    console.log(tools.slice(0, 25).join('\n'));
    child.kill();
    process.exit(0);
  }
});

let err = '';
child.stderr.on('data', (d) => { err += d.toString(); });

const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'probe', version: '1.0' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

setTimeout(() => {
  console.log('TIMEOUT after 180s');
  console.log('stdout so far:', out.slice(0, 600));
  console.log('stderr so far:', err.slice(0, 600));
  child.kill();
  process.exit(1);
}, 180000);
