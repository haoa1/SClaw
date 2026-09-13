(function(){
/* 开关自检（v2·采样版）：勾选「显示全部逐笔」→ .full 元素必须由 display:none 变可见（且可逆）
   背景：v1 的 `#alltrades:checked ~ .wrap .full` 兄弟选择器永不匹配
        （#alltrades 在 .tgbar>label 内，.wrap 是 .tgbar 的兄弟）⇒ 开关是死的。
   ⚠️ 全量 getComputedStyle(1608 个元素) 会打爆 CDP Runtime.evaluate（超时）⇒ 只采样前 40 个。
   判据：offShown=0 且 onShown=样本数 且 backToOffShown=0 */
var a=document.getElementById('alltrades');
var nodes=document.querySelectorAll('svg.chart .full');
var N=Math.min(nodes.length,40);
function shownSample(){
  var s=0;
  for(var i=0;i<N;i++){ if(getComputedStyle(nodes[i]).display!=='none') s++; }
  return s;
}
function set(v){ a.checked=v; a.dispatchEvent(new Event('change',{bubbles:true})); }
set(false); var off=shownSample();
set(true);  var on=shownSample();
set(false); var back=shownSample();
var all=document.querySelectorAll('.full').length;
var inSvg=nodes.length;
var bodyCls=document.body.getAttribute('class')||'';
return 'fullTotal='+all+' inSvg='+inSvg+' sample='+N
  +' offShown='+off+' onShown='+on+' backToOffShown='+back
  +' bodyClass="'+bodyCls+'"'
  +' | verdict='+(((off===0)&&(on===N)&&(back===0))?'PASS':'FAIL');
})()
