import test from 'node:test';
import assert from 'node:assert/strict';
import {serverConfig} from '../server.mjs';
test('Render port and bind, safe local default, and invalid ports',()=>{
  assert.deepEqual(serverConfig({}),{host:'127.0.0.1',port:8787});
  assert.deepEqual(serverConfig({RENDER:'true',PORT:'10000'}),{host:'0.0.0.0',port:10000});
  assert.deepEqual(serverConfig({RENDER:'true',PORT:'12345',LAB_PORT:'8787',LAB_HOST:'127.0.0.1'}),{host:'127.0.0.1',port:12345});
  for(const port of ['-1','65536','1.5','abc',''])assert.throws(()=>serverConfig({PORT:port}));
});
