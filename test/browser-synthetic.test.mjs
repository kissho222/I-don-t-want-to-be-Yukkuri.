import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('synthetic DOM: join, clock sync, prepare, draw, input, results and focus loss',async()=>{
  // This is a deterministic DOM/clock simulation, NOT a browser render test.
  let clock=0;const intervals=[],raf=[];
  class Element {
    handlers={};children=[];style={};value='';textContent='';hidden=false;checked=true;tagName='DIV';
    addEventListener(e,f){(this.handlers[e] ||= []).push(f);}
    fire(e,data={}){for(const f of this.handlers[e]||[])f({preventDefault(){},target:this,...data});}
    append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}
    setAttribute(){}focus(){}remove(){}click(){this.fire('click');}
    getBoundingClientRect(){return {left:0,top:0,width:1000,height:680};}
  }
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
  const document=new Element();document.getElementById=id=>{assert.ok(nodes.has(id),id);return nodes.get(id);};
  document.createElement=document.createElementNS=()=>new Element();document.hasFocus=()=>true;document.hidden=false;
  const window=new Element();
  class Socket extends Element {
    static OPEN=1;static last;
    readyState=1;bufferedAmount=0;messages=[];
    constructor(){super();Socket.last=this;}
    send(m){this.messages.push(JSON.parse(m));}
    close(){this.readyState=3;this.fire('close');}
    receive(m){this.fire('message',{data:JSON.stringify(m)});}
  }
  const originals=new Map();
  const fakeGlobals={document,window,WebSocket:Socket,location:{hash:'',protocol:'http:',host:'localhost',href:'http://localhost/'},
    localStorage:{getItem(){return '';},setItem(){}},performance:{now:()=>clock},
    requestAnimationFrame:f=>raf.push(f),setInterval:f=>intervals.push(f)};
  for(const [key,value] of Object.entries(fakeGlobals)){originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});}
  try{
    let source=await readFile(new URL('../public/app.mjs',import.meta.url),'utf8');
    source=source.replace("'./protocol.mjs'",JSON.stringify(new URL('../public/protocol.mjs',import.meta.url).href));
    await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    nodes.get('name').value='Tester';nodes.get('join-form').fire('submit');
    const ws=Socket.last;ws.fire('open');assert.equal(ws.messages[0].type,'create');
    ws.receive({type:'joined',id:'self',room:'sample'});
    assert.equal(nodes.get('lab').hidden,false);
    for(let i=0;i<3;i++){
      clock+=500;intervals[0]();const ping=ws.messages.at(-1);clock+=10;ws.receive({type:'pong',t0:ping.t0,serverAt:clock-5});
    }
    const players=[{id:'self',name:'Tester',ready:true,color:'#fff'},{id:'friend',name:'<friend>',ready:true,color:'#f00',cursor:{seq:1,x:.5,y:.5,at:clock,inside:true}}];
    const state={type:'state',serverAt:clock,hostId:'self',room:'sample',players,completedCount:0,round:null};
    ws.receive(state);assert.equal(nodes.get('ready').disabled,false);
    ws.receive({...state,round:{id:'one',phase:'prepare'}});assert.equal(ws.messages.at(-1).type,'ack');
    const goAt=clock+2000;ws.receive({...state,round:{id:'one',phase:'armed',goAt}});
    assert.equal(ws.messages.at(-1).type,'armedAck');
    function tick(n){clock=n;const f=raf.shift();assert.ok(f);f();}
    for(let n=clock+16;n<goAt;n+=16)tick(n);tick(goAt);
    assert.equal(nodes.get('target').className,'target go');
    for(let n=clock+16;n<goAt+240;n+=16)tick(n);
    clock=goAt+240;nodes.get('target').fire('pointerdown',{button:0,pointerType:'mouse'});
    const report=ws.messages.at(-1);assert.equal(report.type,'result');assert.equal(report.reactionMs,240);assert.equal(report.renderLateMs,0);
    ws.receive({...state,completedCount:1,round:{id:'one',phase:'results',tieMs:10,results:[{...report,id:'self',name:'Tester',valid:true,rank:1}]}});
    assert.equal(nodes.get('results').children[0].children[1].children.length,1);
    ws.receive({...state,round:{id:'two',phase:'prepare'}});ws.receive({...state,round:{id:'two',phase:'armed',goAt:clock+2000}});
    window.fire('blur');assert.equal(ws.messages.at(-1).reason,'focus_lost');
    assert.equal(nodes.get('target-text').textContent,'無効');
  }finally{
    for(const [key,desc] of originals)if(desc)Object.defineProperty(globalThis,key,desc);else delete globalThis[key];
  }
});
