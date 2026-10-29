import test from 'node:test';
import assert from 'node:assert/strict';
import { createLab } from '../server.mjs';
let transport;
try {transport=await import('ws');}catch{}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,ms=4000){const end=performance.now()+ms;while(performance.now()<end){const v=fn();if(v)return v;await sleep(10);}throw Error('Network wait timed out');}
test('real loopback HTTP + 3 WebSocket clients + delayed upload ranking + cursor + disconnect',
  {skip:!transport && 'ws installation requires approval; no real network verification'},async t=>{
    const app=await createLab({port:0,leadMs:1200,randomWaitMs:0,ackMarginMs:300});
    t.after(()=>app.close());const address=await app.listen(),base=`http://127.0.0.1:${address.port}`;
    const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/ONLINE LAB/);
    assert.equal((await fetch(base+'/server.mjs')).status,404);
    const clients=[];
    for(let i=0;i<3;i++){
      const socket=new transport.WebSocket(base.replace('http:','ws:')+'/socket'),messages=[];
      socket.on('message',m=>messages.push(JSON.parse(m)));await new Promise((res,rej)=>{socket.on('open',res);socket.on('error',rej);});
      const c={socket,messages,send:m=>socket.send(JSON.stringify(m)),latest:type=>messages.filter(m=>m.type===type).at(-1)};
      clients.push(c);c.send({type:i?'join':'create',room:clients[0].latest('joined')?.room,name:'Network'+i});
      await wait(()=>c.latest('joined'));
    }
    for(const c of clients)c.send({type:'ready',ready:true,metrics:{rtt:10,samples:3,clockAge:0}});
    await wait(()=>clients[0].latest('state')?.players.length===3 && clients[0].latest('state').players.every(p=>p.ready));
    clients[0].send({type:'start'});await wait(()=>clients.every(c=>c.latest('state')?.round?.phase==='prepare'));
    const rid=clients[0].latest('state').round.id;
    for(const c of clients)c.send({type:'ack',roundId:rid});
    await wait(()=>clients.every(c=>c.latest('state')?.round?.phase==='armed'));
    for(const c of clients)c.send({type:'armedAck',roundId:rid});
    await wait(()=>performance.now()>clients[0].latest('state').round.goAt);
    for(const i of [2,1,0]){
      clients[i].send({type:'result',roundId:rid,reactionMs:200+i*30,renderLateMs:10,frameGapMs:17,rtt:10,clockAge:500,inputType:'mouse'});
      await sleep(30);
    }
    await wait(()=>clients[2].latest('state')?.round.phase==='results');
    assert.equal(clients[2].latest('state').round.results[0].name,'Network0');
    clients[0].send({type:'cursor',x:.2,y:.8,seq:1});
    await wait(()=>clients[1].latest('state')?.players[0].cursor?.x===.2);
    clients[0].socket.close();await wait(()=>clients[1].latest('state')?.players.length===2);
    assert.equal(clients[1].latest('state').hostId,clients[1].latest('joined').id);
  });
