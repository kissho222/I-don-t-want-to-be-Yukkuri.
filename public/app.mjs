import { chooseClockSample, interpolate, ReactionTrial } from './protocol.mjs';
const $=id=>document.getElementById(id);
const labels={false_start:'早押し',focus_lost:'フォーカス喪失',schedule_late:'予定受信が遅い',late_frame:'合図の描画遅延',
  frame_stall:'描画の停止',connection_quality:'同期・接続品質',disconnect:'切断',timeout:'時間切れ',
  prepare_timeout:'準備の応答なし',preparation_cancelled:'準備中の切断',schedule_not_acknowledged:'予定時刻の確認なし',
  bad_report:'不正な計測値',reaction_range:'計測範囲外',connection_stale:'通信の停止'};
let ws,myId=null,state=null,samples=[],pendingPings=new Set(),trial=null,handledPrepare=null,handledArmed=null;
let lastState=0,lastFrame=performance.now(),cursorSeq=0,dirty=false,cursor={x:.5,y:.5,inside:false},lastCursorSent=0;
let history=[];
let disqualifiedRound=null;
const tracks=new Map(),cursorNodes=new Map();
let frames=[],isConnecting=false;
const focused=()=>!document.hidden && document.hasFocus();
const note=s=>{$('notice').textContent=s;};
const send=m=>{if(ws?.readyState===WebSocket.OPEN && ws.bufferedAmount<65536)ws.send(JSON.stringify(m));};
const best=()=>chooseClockSample(samples.filter(s=>performance.now()-s.at<10000));
function metrics(){const s=best();return s?{rtt:s.rtt,samples:samples.length,clockAge:performance.now()-s.at}:null;}
const roomFromHash=new URLSearchParams(location.hash.slice(1)).get('room');
if(roomFromHash)$('room-code').value=roomFromHash;
try{$('name').value=localStorage.getItem('online-lab-name') || '';}catch{}
$('join-form').addEventListener('submit',e=>{
  e.preventDefault();if(isConnecting)return;
  if(ws?.readyState===WebSocket.OPEN)ws.close();
  isConnecting=true;$('join-button').disabled=true;note('');samples=[];pendingPings.clear();myId=null;state=null;history=[];shownResult=null;disqualifiedRound=null;
  const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/socket`);ws=socket;
  socket.addEventListener('open',()=>{
    if(ws!==socket)return;
    isConnecting=false;$('join-button').disabled=false;
    const room=$('room-code').value.trim(),name=$('name').value.trim();
    try{localStorage.setItem('online-lab-name',name);}catch{}
    send({type:room?'join':'create',room,name});ping();
  });
  socket.addEventListener('message',e=>{if(ws!==socket)return;try{receive(JSON.parse(e.data));}catch{note('受信データを処理できませんでした。再接続してください。');}});
  socket.addEventListener('error',()=>{if(ws===socket)note('接続できません。サーバーの起動とURLを確認してください。');});
  socket.addEventListener('close',()=>{
    if(ws!==socket)return;
    isConnecting=false;$('join-button').disabled=false;$('connection').textContent='切断';
    transmit(trial?.invalid('disconnect'));
    $('ready').disabled=true;$('start').disabled=true;
    $('entrance').hidden=false;$('lab').hidden=true;
    note('接続が終了しました。試験中の再接続は同じ参加者として復元しません。終了後に参加し直してください。');
    state=null;myId=null;trial=null;tracks.clear();for(const n of cursorNodes.values())n.remove();cursorNodes.clear();
  });
});
function ping(){if(ws?.readyState!==WebSocket.OPEN)return;const t0=performance.now();pendingPings.add(t0);for(const p of pendingPings)if(t0-p>5000)pendingPings.delete(p);send({type:'ping',t0});}
setInterval(ping,500);
function receive(m){
  const now=performance.now();
  if(m.type==='pong' && pendingPings.delete(m.t0)){
    const rtt=now-m.t0;samples.push({rtt,offset:m.serverAt-(m.t0+now)/2,at:now});samples=samples.slice(-10);
    const s=best();$('rtt').textContent=rtt.toFixed(0);$('uncertainty').textContent=s?(s.rtt/2).toFixed(0):'—';return;
  }
  if(m.type==='error'){note(m.message);return;}
  if(m.type==='joined'){
    myId=m.id;location.hash=new URLSearchParams({room:m.room});$('room-code').value=m.room;
    $('entrance').hidden=true;$('lab').hidden=false;$('arena').focus();return;
  }
  if(m.type!=='state')return;
  state=m;lastState=now;$('connection').textContent='接続中';
  for(const p of m.players){
    if(p.id===myId || !p.cursor)continue;
    const list=tracks.get(p.id)||[];
    if(!list.length || p.cursor.seq!==list.at(-1).seq)list.push({...p.cursor});
    tracks.set(p.id,list.slice(-30));
  }
  const ids=new Set(m.players.map(p=>p.id));
  for(const [pid,node] of cursorNodes)if(!ids.has(pid)){node.remove();cursorNodes.delete(pid);tracks.delete(pid);}
  const r=m.round;
  if(r?.phase==='prepare' && handledPrepare!==r.id){
    handledPrepare=r.id;handledArmed=null;trial=null;
    const q=metrics();
    if(focused() && q?.samples>=3 && q.rtt<=1000)send({type:'ack',roundId:r.id});
    else send({type:'invalid',roundId:r.id,reason:focused()?'connection_quality':'focus_lost'});
    $('target-text').textContent='待って';$('target').className='target';
  }
  if(r?.phase==='armed' && handledArmed!==r.id){
    handledArmed=r.id;const s=best();
    if(s){if(disqualifiedRound!==r.id)trial=new ReactionTrial(r,{...s},now,focused());send({type:'armedAck',roundId:r.id});}
    else send({type:'invalid',roundId:r.id,reason:'connection_quality'});
    if(disqualifiedRound!==r.id){$('target-text').textContent='待って';$('target').className='target';}
  }
  if(r?.phase==='results'){trial=null;renderResults(r);}
  renderControls();
}
function renderControls(){
  if(!state)return;
  const active=['prepare','armed'].includes(state.round?.phase),me=state.players.find(p=>p.id===myId),q=metrics();
  $('player-count').textContent=`${state.players.length} / 8`;
  $('players').replaceChildren(...state.players.map(p=>{
    const li=document.createElement('li'),dot=document.createElement('span'),name=document.createElement('span'),status=document.createElement('span');
    dot.className='dot';dot.style.backgroundColor=p.color;name.className='player-name';
    name.textContent=p.name+(p.id===myId?'（自分）':'')+(p.id===state.hostId?' ★':'');status.className='player-state';status.textContent=p.ready?'準備OK':'待機';
    li.append(dot,name,status);return li;
  }));
  $('ready').disabled=active || !q || q.samples<3 || q.rtt>1000;
  $('ready').textContent=me?.ready?'準備を取り消す':'準備完了';
  $('host-controls').hidden=myId!==state.hostId;
  $('start').disabled=active || state.players.length<2 || !state.players.every(p=>p.ready);
  $('tie').disabled=active;
  $('help').textContent=active?'タブを切り替えず、合図を待ってください。':!q || q.samples<3?'時計を同期しています…':'盤面をクリックしてから準備完了。★ が進行役です。';
  if(state.round?.phase==='prepare'){$('round-status').textContent='全員の画面と接続を確認中';$('signal-label').textContent='READY CHECK';}
  else if(state.round?.phase==='armed' && !trial?.done && trial?.cueAt===null){$('round-status').textContent='緑に変わったら押す！';$('signal-label').textContent='まだ押さないで';}
}
$('ready').addEventListener('click',()=>{
  if(!focused())return note('この画面にフォーカスしてから準備してください。');
  const me=state?.players.find(p=>p.id===myId);send({type:'ready',ready:!me?.ready,metrics:metrics()});note('');
});
$('start').addEventListener('click',()=>send({type:'start',tieMs:Number($('tie').value)}));
function transmit(m){
  if(!m)return;
  if(m.type==='cue'){
    // DOM change and cue timestamp belong to this same pre-paint callback.
    $('target').className='target go';$('target-text').textContent='押せ！';$('signal-label').textContent='GO';$('round-status').textContent='中央ボタン、または Space';
  }else{
    if(m.type==='invalid')disqualifiedRound=m.roundId;
    send(m);$('target').className='target done';$('target-text').textContent=m.type==='result'?`${m.reactionMs.toFixed(0)}`:'無効';
    $('round-status').textContent=m.type==='result'?'ms / 全員の結果を待っています':labels[m.reason]||m.reason;
    $('signal-label').textContent=m.type==='result'?'RECORDED':'INVALID';
  }
}
function press(inputType){
  if(!focused()){transmit(trial?.invalid('focus_lost'));return;}
  if(!trial && state?.round?.phase==='prepare'){
    transmit({type:'invalid',roundId:state.round.id,reason:'false_start'});return;
  }
  transmit(trial?.press(performance.now(),inputType,samples.at(-1)));
}
$('target').addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();press(e.pointerType || 'mouse');});
document.addEventListener('keydown',e=>{
  if(e.code!=='Space' || e.repeat || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))return;
  if(state?.round && ['prepare','armed'].includes(state.round.phase)){e.preventDefault();press('keyboard');}
});
for(const event of ['blur','pagehide'])window.addEventListener(event,()=>transmit(trial?.invalid('focus_lost')));
document.addEventListener('visibilitychange',()=>{if(document.hidden)transmit(trial?.invalid('focus_lost'));});
// Preparation has no trial yet: explicitly disqualify a focus change there too.
window.addEventListener('blur',()=>{if(state?.round?.phase==='prepare')transmit({type:'invalid',roundId:state.round.id,reason:'focus_lost'});});
function move(e){const b=$('arena').getBoundingClientRect();cursor={x:Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.top)/b.height)),inside:true};dirty=true;}
$('arena').addEventListener('pointermove',move);
$('arena').addEventListener('pointerdown',move);
$('arena').addEventListener('pointerleave',()=>{cursor.inside=false;dirty=true;});
setInterval(()=>{if(state && (dirty || performance.now()-lastCursorSent>250)){send({type:'cursor',...cursor,seq:++cursorSeq});dirty=false;lastCursorSent=performance.now();}},50);
function cursorNode(p){
  if(cursorNodes.has(p.id))return cursorNodes.get(p.id);
  const n=document.createElement('div');n.className='remote-cursor';n.style.color=p.color;
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 20 25');
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M1 1 L1 21 L6 16 L10 24 L14 22 L10 14 L18 14 Z');path.setAttribute('fill','currentColor');path.setAttribute('stroke','#0c1320');svg.append(path);
  const name=document.createElement('span');name.textContent=p.name;n.append(svg,name);$('cursors').append(n);cursorNodes.set(p.id,n);return n;
}
function frame(){
  const now=performance.now();
  const gap=now-lastFrame;lastFrame=now;frames.push(gap);if(frames.length>60)frames.shift();
  $('frame').textContent=(frames.reduce((a,b)=>a+b,0)/frames.length).toFixed(1);
  if(state && now-lastState>4000){transmit(trial?.invalid('connection_stale'));$('connection').textContent='通信が停止しています';}
  transmit(trial?.frame(now,focused(),samples.at(-1)));
  const s=best(),ages=[];
  if(state && s){
    const serverNow=now+s.offset,box=$('arena').getBoundingClientRect();
    for(const p of state.players){
      if(p.id===myId)continue;
      const list=tracks.get(p.id),last=list?.at(-1);if(!last)continue;
      const age=Math.max(0,serverNow-last.at),node=cursorNode(p);
      node.hidden=!last.inside || age>2000;
      node.style.opacity=age>500?'.3':'1';
      if(node.hidden)continue;
      const pos=interpolate(list,serverNow-($('smooth').checked?100:0));
      node.style.transform=`translate(${pos.x*box.width}px,${pos.y*box.height}px)`;ages.push(age);
    }
  }
  $('cursor-age').textContent=ages.length?Math.max(...ages).toFixed(0):'—';
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
let shownResult=null;
function renderResults(r){
  if(shownResult===r.id)return;shownResult=r.id;
  history.push({id:r.id,goAt:r.goAt,tieMs:r.tieMs,results:r.results});if(history.length>100)history.shift();
  $('round-number').textContent=`#${state.completedCount} / 同着 ${r.tieMs} ms`;
  $('signal-label').textContent='ROUND COMPLETE';$('target').className='target done';$('target-text').textContent='終了';$('round-status').textContent='準備完了で、もう一回';
  const table=document.createElement('table'),thead=document.createElement('thead'),tbody=document.createElement('tbody');
  const heading=document.createElement('tr');for(const name of ['順位','名前','反応 ms','RTT ms','描画遅れ ms']){const th=document.createElement('th');th.textContent=name;heading.append(th);}thead.append(heading);
  for(const result of r.results){
    const row=document.createElement('tr');if(!result.valid)row.className='invalid';
    const values=result.valid?[result.rank,result.name,result.reactionMs.toFixed(1),result.rtt.toFixed(0),result.renderLateMs.toFixed(1)]:['—',result.name,labels[result.reason]||result.reason,'—','—'];
    for(const value of values){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}tbody.append(row);
  }
  table.append(thead,tbody);$('results').replaceChildren(table);
}
$('invite').addEventListener('click',async()=>{
  const url=location.href;
  try{await navigator.clipboard.writeText(url);note('招待URLをコピーしました。別回線の友達には公開用のHTTPS URLが必要です。');}
  catch{note(`招待URL：${url}`);}
});
$('leave').addEventListener('click',()=>ws?.close());
$('export').addEventListener('click',()=>{
  if(!history.length)return note('まだ結果がありません。');
  const data={format:'yukkuri-online-lab/1',exportedAt:new Date().toISOString(),rounds:history,
    notes:'reactionMs is local draw-callback to input-handler time; RTT is separate; client reports are untrusted; not photon timing'};
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='online-lab-results.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
