import test from 'node:test';
import assert from 'node:assert/strict';
import {ReactionTrial,rankResults,validateReport,chooseClockSample,interpolate} from '../public/protocol.mjs';

const sample={offset:400,rtt:80,at:0};
const round={id:'round-A',goAt:2400};
function advance(t,from,to){for(let n=from;n<to;n+=16)t.frame(n);return t.frame(to);}
test('cue and press use a local clock; RTT is not subtracted',()=>{
  const t=new ReactionTrial(round,sample,0);advance(t,16,1990);t.frame(2010);
  assert.equal(t.cueAt,2010);
  advance(t,2026,2200);
  const m=t.press(2240,'mouse');assert.equal(m.reactionMs,230);assert.equal(m.renderLateMs,10);
  assert.equal(m.rtt,80);assert.equal(m.roundId,'round-A');assert.equal(t.press(2300,'mouse'),null);
});
test('early, late, stale, unfocused, and stalled trials are invalid',()=>{
  assert.equal(new ReactionTrial(round,sample,0).press(1800,'mouse').reason,'false_start');
  assert.equal(new ReactionTrial(round,sample,1200).frame(1216).reason,'schedule_late');
  assert.equal(new ReactionTrial(round,sample,0,false).frame(16).reason,'focus_lost');
  const t=new ReactionTrial(round,sample,0);assert.equal(t.frame(200).reason,'frame_stall');
  const late=new ReactionTrial(round,sample,0);advance(late,16,1990);assert.equal(late.frame(2085).reason,'late_frame');
  const stale=new ReactionTrial({...round,goAt:12400},sample,0);assert.equal(advance(stale,16,12000).reason,'connection_quality');
});
test('8 clients with different offsets and upload delays keep local reaction order',()=>{
  const reports=Array.from({length:8},(_,i)=>{
    const offset=1000+i*222,goAt=5000,t=new ReactionTrial({id:'eight',goAt},{offset,rtt:20+i*70,at:0},0);
    const cue=goAt-offset;advance(t,16,cue);advance(t,cue+16,cue+100+i*25);
    return {...validateReport(t.press(cue+100+i*25,'keyboard')),id:String(i),arrivalAfterGoMs:900-i*50};
  });
  const ranked=rankResults(reports.reverse(),10);assert.deepEqual(ranked.map(r=>r.id),['0','1','2','3','4','5','6','7']);
  assert.deepEqual(ranked.map(r=>r.rank),[1,2,3,4,5,6,7,8]);
});
test('tie window anchors at group leader; invalid reports never rank',()=>{
  const list=[{id:'a',valid:true,reactionMs:100},{id:'b',valid:true,reactionMs:175},{id:'c',valid:true,reactionMs:250},{id:'d',valid:false}];
  assert.deepEqual(rankResults(list,80).map(r=>r.rank),[1,1,3,null]);
  assert.equal(validateReport({reactionMs:NaN}).reason,'bad_report');
});
test('minimum RTT sample selection and normalized cursor interpolation',()=>{
  assert.equal(chooseClockSample([{rtt:90},{rtt:20},{rtt:50}]).rtt,20);
  const s=[{x:0,y:1,at:100},{x:1,y:0,at:200}];
  assert.deepEqual(interpolate(s,150),{x:.5,y:.5});assert.deepEqual(interpolate(s,500),{x:1,y:0});
  assert.deepEqual(interpolate(s,0),{x:0,y:1});
});
test('scheduled offset stays frozen while connection freshness uses ongoing pongs',()=>{
  const t=new ReactionTrial({id:'long',goAt:12400},sample,5000);
  for(let n=5016;n<12000;n+=16)t.frame(n,true,{rtt:35,at:n-20});
  assert.equal(t.frame(12000,true,{rtt:35,at:11980}).type,'cue');
  assert.equal(t.cueAt,12000);
  for(let n=12016;n<15000;n+=16)t.frame(n,true,{rtt:35,at:n-20});
  const report=t.press(15000,'mouse',{rtt:35,at:14980});
  assert.equal(report.type,'result');assert.equal(report.reactionMs,3000);
  assert.equal(report.clockAge,20);assert.equal(report.rtt,35);assert.equal(t.targetAt,12000);
});
