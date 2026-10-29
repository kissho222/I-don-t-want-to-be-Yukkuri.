import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rankResults, validateReport } from './public/protocol.mjs';

const colors = ['#ffcb6b','#82d9ff','#ff9dbb','#a6ec94','#c7acff','#ffab78','#72e2ce','#ecdc94'];
const active = r => r && ['prepare','armed'].includes(r.phase);
const id = () => randomBytes(12).toString('base64url');

export async function createLab({ host = '127.0.0.1', port = 8787, leadMs = 3000, randomWaitMs = 2000,
  responseMs = 5000, prepareMs = 4000, ackMarginMs = 1000, transport } = {}) {
  const { WebSocketServer, WebSocket } = transport || await import('ws');
  const rooms = new Map();
  const now = () => performance.now();
  const server = http.createServer(async (req, res) => {
    const assets = new Map([['/', ['index.html','text/html']], ['/app.mjs',['app.mjs','text/javascript']],
      ['/protocol.mjs',['protocol.mjs','text/javascript']], ['/style.css',['style.css','text/css']]]);
    const asset = assets.get(new URL(req.url, 'http://localhost').pathname);
    if (!asset || req.method !== 'GET') { res.writeHead(404).end(); return; }
    try {
      const bytes = await readFile(new URL('./public/' + asset[0], import.meta.url));
      res.writeHead(200, {'Content-Type': asset[1] + '; charset=utf-8', 'Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'"});
      res.end(bytes);
    } catch { res.writeHead(500).end(); }
  });
  const wss = new WebSocketServer({ noServer:true, maxPayload:4096, perMessageDeflate:false });
  server.on('upgrade', (req,socket,head) => {
    let validOrigin = true;
    try { if (req.headers.origin) validOrigin = new URL(req.headers.origin).host === req.headers.host; }
    catch { validOrigin = false; }
    if (req.url !== '/socket' || !validOrigin || wss.clients.size >= 128) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req,socket,head, ws => wss.emit('connection',ws));
  });
  function send(ws, msg) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024*1024) { ws.terminate(); return; }
    if (ws.bufferedAmount < 65536) ws.send(JSON.stringify(msg));
  }
  function finish(room, reason) {
    const r = room.round;
    if (!active(r)) return;
    for (const pid of r.participants) if (!r.reports[pid]) r.reports[pid] = {id:pid,valid:false,reason:reason || 'timeout'};
    r.phase = 'results';
    r.results = rankResults(Object.values(r.reports),r.tieMs).map(result => ({...result,name:r.names[result.id]}));
    room.history.push({id:r.id,goAt:r.goAt,tieMs:r.tieMs,results:r.results});
    if (room.history.length > 100) room.history.shift();
    for (const p of room.players.values()) p.ready = false;
  }
  function report(room,p,data) {
    const r = room.round;
    if (!active(r) || data.roundId !== r.id || !r.participants.includes(p.id) || r.reports[p.id]) return;
    const verdict = validateReport(data);
    if (data.type === 'invalid') { verdict.valid=false; verdict.reason=String(data.reason || 'invalid').slice(0,80); }
    if (data.type === 'result' && (!r.goAt || now() < r.goAt)) { verdict.valid=false; verdict.reason='false_start'; }
    r.reports[p.id] = {id:p.id,...verdict,arrivalAfterGoMs:r.goAt ? now()-r.goAt : null};
    if (r.participants.every(pid => r.reports[pid])) finish(room);
  }
  function publicState(room) {
    const r = room.round;
    return {type:'state',serverAt:now(),room:room.code,hostId:room.hostId,
      players:[...room.players.values()].map(p => ({id:p.id,name:p.name,color:p.color,ready:p.ready,
        cursor:p.cursor,rtt:p.metrics?.rtt ?? null})),
      round:r ? {id:r.id,phase:r.phase,participants:r.participants,goAt:r.goAt,
        prepareDeadline:r.prepareDeadline,deadline:r.deadline,tieMs:r.tieMs,
        results:r.phase === 'results' ? r.results : null} : null,
      completedCount:room.history.length};
  }
  wss.on('connection', ws => {
    let room, player;
    ws.alive=true;
    ws.born=now();
    ws.on('pong', () => {ws.alive=true;});
    let rateAt=now(), count=0;
    ws.on('message', bytes => {
      if (now()-rateAt > 1000) {rateAt=now();count=0;}
      if (++count > 80) {ws.close(1008,'rate limit'); return;}
      let m;
      try {m=JSON.parse(bytes.toString());} catch {send(ws,{type:'error',message:'メッセージ形式が不正です'});return;}
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      if (m.type === 'ping') {
        if (Number.isFinite(m.t0)) send(ws,{type:'pong',t0:m.t0,serverAt:now()});
        return;
      }
      if (!player) {
        if (!['create','join'].includes(m.type)) return;
        const name=String(m.name || '').trim().slice(0,20);
        if (!name) {send(ws,{type:'error',message:'名前を入力してください'});return;}
        if (m.type === 'create') {
          if (rooms.size >= 20) {send(ws,{type:'error',message:'部屋がいっぱいです'});return;}
          const code=id();room={code,players:new Map(),hostId:null,round:null,history:[]};rooms.set(code,room);
        } else {
          room=rooms.get(String(m.room));
          if (!room) {send(ws,{type:'error',message:'部屋が見つかりません。主催者にURLを確認してください'});return;}
          if (room.players.size >= 8 || active(room.round)) {send(ws,{type:'error',message:'8人上限、または試験中です。終了後に参加してください'});return;}
        }
        const used=new Set([...room.players.values()].map(p=>p.color));
        player={id:id(),name,color:colors.find(c=>!used.has(c)),ws,ready:false,cursor:null};
        ws.joined=true;
        room.players.set(player.id,player);room.hostId ||= player.id;
        send(ws,{type:'joined',id:player.id,room:room.code});
        send(ws,publicState(room));return;
      }
      if (m.type === 'cursor') {
        if (![m.x,m.y,m.seq].every(Number.isFinite) || m.x<0 || m.x>1 || m.y<0 || m.y>1) return;
        if (m.seq <= (player.cursor?.seq ?? -1) || now()-(player.cursor?.at ?? -1000)<40) return;
        player.cursor={x:m.x,y:m.y,seq:m.seq,at:now(),inside:m.inside !== false};return;
      }
      if (m.type === 'ready' && !active(room.round)) {
        const q=m.metrics;
        if (m.ready && (!q || !Number.isFinite(q.rtt) || q.rtt>1000 || q.rtt<0 || !Number.isFinite(q.samples) || q.samples<3 || !Number.isFinite(q.clockAge) || q.clockAge<0 || q.clockAge>10000)) {
          send(ws,{type:'error',message:'時計同期を待ち、接続を確認してください'});return;
        }
        player.ready=!!m.ready;player.metrics=q;return;
      }
      if (m.type === 'start') {
        if (room.hostId !== player.id || active(room.round)) return;
        if (room.players.size < 2 || ![...room.players.values()].every(p=>p.ready)) {
          send(ws,{type:'error',message:'2〜8人で全員が準備完了にしてください（本試験は3〜8人推奨）'});return;
        }
        const participants=[...room.players.keys()];
        room.round={id:id(),phase:'prepare',participants,names:Object.fromEntries([...room.players.values()].map(p=>[p.id,p.name])),
          ack:new Set(),armedAck:new Set(),reports:{},goAt:null,prepareDeadline:now()+prepareMs,
          tieMs:[0,10,30,80].includes(m.tieMs)?m.tieMs:10};return;
      }
      const r=room.round;
      if (!active(r) || m.roundId !== r.id || !r.participants.includes(player.id)) return;
      if (m.type === 'ack' && r.phase==='prepare') {
        r.ack.add(player.id);
        if (r.participants.every(pid=>r.ack.has(pid))) {
          r.phase='armed';r.goAt=now()+leadMs+(randomWaitMs ? randomInt(randomWaitMs) : 0);r.deadline=r.goAt+responseMs;
        }
      } else if (m.type==='armedAck' && r.phase==='armed') r.armedAck.add(player.id);
      else if (['result','invalid'].includes(m.type)) report(room,player,m);
    });
    ws.on('error',()=>{});
    ws.on('close',()=>{
      if (!player || !room) return;
      const r=room.round;
      if (active(r) && r.participants.includes(player.id) && !r.reports[player.id]) {
        r.reports[player.id]={id:player.id,valid:false,reason:'disconnect'};
        // A missing preparation participant cancels the entire round.
        if (r.phase==='prepare') finish(room,'preparation_cancelled');
        else if (r.participants.every(pid=>r.reports[pid])) finish(room);
      }
      room.players.delete(player.id);
      if (room.hostId===player.id) room.hostId=room.players.keys().next().value;
      if (!room.players.size) rooms.delete(room.code);
    });
  });
  const tick=setInterval(()=>{
    for (const room of rooms.values()) {
      const r=room.round;
      if (r?.phase==='prepare' && now()>r.prepareDeadline) finish(room,'prepare_timeout');
      if (r?.phase==='armed') {
        if (now()>r.goAt-ackMarginMs && !r.participants.every(pid=>r.armedAck.has(pid))) finish(room,'schedule_not_acknowledged');
        else if (now()>r.deadline) finish(room,'timeout');
      }
      const msg=publicState(room);
      for (const p of room.players.values()) send(p.ws,msg);
    }
  },50);
  const heartbeat=setInterval(()=>{
    for (const ws of wss.clients) {
      if (!ws.alive || (!ws.joined && now()-ws.born>15000)) {ws.terminate();continue;}
      ws.alive=false;ws.ping();
    }
  },5000);
  return {
    server, rooms, transportServer:wss,
    async listen() {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});return server.address();},
    async close() {clearInterval(tick);clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>server.close(resolve));wss.close();}
  };
}
export function serverConfig(env=process.env) {
  const host=env.LAB_HOST || (env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1');
  const rawPort=env.PORT ?? env.LAB_PORT ?? '8787';
  const port=Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535) throw Error('PORT must be an integer between 0 and 65535');
  return {host,port};
}
if (process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const app=await createLab(serverConfig());
  const address=await app.listen();
  console.log(`Online Lab: http://127.0.0.1:${address.port} (bind ${address.address})`);
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>app.close().then(()=>process.exit()));
}
