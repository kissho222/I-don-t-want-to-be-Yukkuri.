import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createLab} from '../server.mjs';
class StubTransport extends EventEmitter {clients=new Set();close(){}}
test('actual loopback HTTP serves only public assets with expected content and headers',async t=>{
  const app=await createLab({port:0,transport:{WebSocketServer:StubTransport,WebSocket:{OPEN:1}}});
  t.after(()=>app.close());const address=await app.listen(),base=`http://127.0.0.1:${address.port}`;
  for(const path of ['/','/app.mjs','/protocol.mjs','/style.css']){
    const res=await fetch(base+path);assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
    assert.match(res.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    const text=await res.text();assert.ok(text.length>100);
    if(path==='/')assert.match(text,/ゆっくりにはなりたくない/);
  }
  for(const path of ['/server.mjs','/package.json','/README_JA.md','/.git/config'])assert.equal((await fetch(base+path)).status,404);
  assert.equal((await fetch(base,{method:'POST'})).status,404);
});
