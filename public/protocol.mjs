export function rankResults(reports,tieMs=10) {
  const valid=reports.filter(r=>r.valid).sort((a,b)=>a.reactionMs-b.reactionMs);
  let anchor=-Infinity,rank=0;
  return [...valid.map((r,i)=>{
    if (r.reactionMs-anchor>tieMs) {anchor=r.reactionMs;rank=i+1;}
    return {...r,rank};
  }),...reports.filter(r=>!r.valid).map(r=>({...r,rank:null}))];
}
export function validateReport(m) {
  const fields=['reactionMs','renderLateMs','frameGapMs','rtt','clockAge'];
  if (!fields.every(k=>Number.isFinite(m[k]))) return {valid:false,reason:'bad_report'};
  let reason=null;
  if (m.reactionMs<0 || m.reactionMs>5000) reason='reaction_range';
  else if (m.renderLateMs<0 || m.renderLateMs>80) reason='late_frame';
  else if (m.frameGapMs>100 || m.frameGapMs<0) reason='frame_stall';
  else if (m.rtt>1000 || m.rtt<0 || m.clockAge>10000 || m.clockAge<0) reason='connection_quality';
  return {valid:!reason,reason,...Object.fromEntries(fields.map(k=>[k,m[k]])),
    inputType:['mouse','touch','pen','keyboard'].includes(m.inputType)?m.inputType:'unknown'};
}
export function chooseClockSample(samples) {
  return [...samples].sort((a,b)=>a.rtt-b.rtt)[0] || null;
}
export function interpolate(samples,target) {
  if (!samples.length) return null;
  let a=samples[0],b=a;
  for (const s of samples) {if(s.at<=target)a=s;if(s.at>=target){b=s;break;}b=s;}
  const t=b.at>a.at ? Math.max(0,Math.min(1,(target-a.at)/(b.at-a.at))) : 0;
  return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
}

// Both cueAt and pressAt use performance.now() in the browser. No event.timeStamp
// or requestAnimationFrame callback timestamp is subtracted from this clock.
export class ReactionTrial {
  constructor(round,sample,receivedAt,focused=true) {
    this.roundId=round.id;this.targetAt=round.goAt-sample.offset;
    this.sample=sample;this.cueAt=null;this.done=false;this.maxGap=0;this.lastFrame=receivedAt;
    this.initialReason=!focused?'focus_lost':this.targetAt-receivedAt<1000?'schedule_late':null;
  }
  invalid(reason) {if(this.done)return null;this.done=true;return {type:'invalid',roundId:this.roundId,reason};}
  frame(now,focused=true,quality=this.sample) {
    if(this.done)return null;
    this.maxGap=Math.max(this.maxGap,now-this.lastFrame);this.lastFrame=now;
    const reason=this.initialReason || (!focused?'focus_lost':this.maxGap>100?'frame_stall':null);
    if(reason)return this.invalid(reason);
    if(this.cueAt===null && now>=this.targetAt) {
      if(now-this.targetAt>80)return this.invalid('late_frame');
      if(now-quality.at>10000 || quality.rtt>1000)return this.invalid('connection_quality');
      this.cueAt=now;return {type:'cue'};
    }
    if(this.cueAt!==null && now-this.cueAt>5000)return this.invalid('timeout');
    return null;
  }
  press(now,inputType,quality=this.sample) {
    if(this.done)return null;
    if(this.cueAt===null)return this.invalid('false_start');
    const m={type:'result',roundId:this.roundId,reactionMs:now-this.cueAt,
      renderLateMs:this.cueAt-this.targetAt,frameGapMs:Math.max(this.maxGap,now-this.lastFrame),
      clockAge:now-quality.at,rtt:quality.rtt,inputType};
    const v=validateReport(m);this.done=true;
    return v.valid?m:{type:'invalid',roundId:this.roundId,reason:v.reason};
  }
}
