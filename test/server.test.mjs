import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLab } from '../server.mjs';

// In-memory sockets exercise the real server state machine without downloading
// dependencies, opening ports, or claiming that a network connection was tested.
class FakeServer extends EventEmitter {
  constructor(){super();this.clients=new Set();}
  close(){}
}
class FakeSocket extends EventEmitter {
  readyState=1;bufferedAmount=0;messages=[];
  send(m){this.messages.push(JSON.parse(m));}
  ping(){this.emit('pong');}
  close(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
  terminate(){this.close();}
  message(m){this.emit('message',Buffer.from(JSON.stringify(m)));}
  latest(type='state'){return this.messages.filter(m=>m.type===type).at(-1);}
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=1800){const deadline=performance.now()+ms;while(performance.now()<deadline){const v=fn();if(v)return v;await sleep(10);}throw Error('condition timed out');}
async function setup(t,count=3){
  const app=await createLab({transport:{WebSocketServer:FakeServer,WebSocket:{OPEN:1}},
    leadMs:350,randomWaitMs:0,ackMarginMs:100,prepareMs:300,responseMs:700});
  t.after(()=>app.close());
  const clients=[];
  for(let i=0;i<count;i++){
    const ws=new FakeSocket();app.transportServer.clients.add(ws);app.transportServer.emit('connection',ws);clients.push(ws);
    ws.message(i?{type:'join',room:clients[0].latest('joined').room,name:'P'+i}:{type:'create',name:'P0'});
  }
  const room=app.rooms.values().next().value;
  return {app,clients,room};
}
function ready(clients){for(const c of clients)c.message({type:'ready',ready:true,metrics:{rtt:20,samples:3,clockAge:0}});}
async function arm(clients,room){
  ready(clients);clients[0].message({type:'start',tieMs:10});const rid=room.round.id;
  for(const c of clients)c.message({type:'ack',roundId:rid});
  for(const c of clients)c.message({type:'armedAck',roundId:rid});
  await until(()=>performance.now()>room.round.goAt);return rid;
}
const result=(roundId,reactionMs)=>({type:'result',roundId,reactionMs,renderLateMs:5,frameGapMs:17,rtt:40,clockAge:500,inputType:'mouse'});
test('8 synthetic participants: ready, prepare, rank by report instead of arrival, duplicate and stale rejection',async t=>{
  const {clients,room}=await setup(t,8);const rid=await arm(clients,room);
  for(let i=7;i>=0;i--)clients[i].message(result(rid,150+i*20));
  assert.equal(room.round.phase,'results');assert.equal(room.round.results[0].name,'P0');
  assert.equal(room.round.results.length,8);assert.equal(room.round.results[0].reactionMs,150);
  clients[0].message(result(rid,0));assert.equal(room.round.results[0].reactionMs,150);
  ready(clients);clients[0].message({type:'start'});clients[0].message(result(rid,0));
  assert.equal(Object.keys(room.round.reports).length,0);
});
test('capacity, room isolation, private state, coordinates, and progress rights',async t=>{
  const {app,clients,room}=await setup(t,8);
  const extra=new FakeSocket();app.transportServer.emit('connection',extra);extra.message({type:'join',room:room.code,name:'nine'});
  assert.match(extra.latest('error').message,/8人/);
  clients[1].message({type:'start'});assert.equal(room.round,null);
  clients[0].message({type:'cursor',x:.25,y:.75,seq:1});
  clients[0].message({type:'cursor',x:200,y:-5,seq:2});
  await sleep(70);const s=clients[1].latest();assert.equal(s.players[0].cursor.x,.25);
  assert.ok(!JSON.stringify(s).includes('"ws"'));assert.ok(!('reports' in s));
  extra.message({type:'create',name:'other'});assert.equal(app.rooms.size,2);assert.equal(extra.latest().players.length,1);
});
test('missing ready, prepare timeout, and disconnect invalidate rather than winning',async t=>{
  const {clients,room}=await setup(t);clients[0].message({type:'start'});assert.equal(room.round,null);
  ready(clients);clients[0].message({type:'start'});
  await until(()=>room.round.phase==='results');assert.ok(room.round.results.every(r=>!r.valid));
  const rid=await arm(clients,room);clients[1].close();
  clients[0].message(result(rid,300));clients[2].message(result(rid,200));
  assert.equal(room.round.results.find(r=>r.name==='P1').reason,'disconnect');
  clients[0].close();assert.equal(room.hostId,clients[2].latest('joined').id);
});
test('missing schedule ack cancels all; untrusted numeric reports are rejected',async t=>{
  const {clients,room}=await setup(t);ready(clients);clients[0].message({type:'start'});
  const rid=room.round.id;for(const c of clients)c.message({type:'ack',roundId:rid});
  clients[0].message({type:'armedAck',roundId:rid});
  await until(()=>room.round.phase==='results');assert.ok(room.round.results.every(r=>!r.valid));
  const rid2=await arm(clients,room);clients[0].message({...result(rid2,200),renderLateMs:90});
  clients[1].message({type:'invalid',roundId:rid2,reason:'focus_lost'});clients[2].message(result(rid2,250));
  assert.equal(room.round.results.find(r=>r.name==='P0').reason,'late_frame');
  assert.equal(room.round.results[0].name,'P2');
});
