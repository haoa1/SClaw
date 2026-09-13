(function(){
/* 几何量测 v2（2026-09-13 筹码/MACD 补丁后）
   1) 首图：月份刻度行 × 图例行(两行) 重叠对数
   2) 首图：右面板标签(累计贡献/成交量/获利盘/偏离成本/MACD) 是否越出 viewBox
   3) 全 18 图：任意两个 text 元素的包围盒两两重叠审计（最强的重叠检测，任一处文字压文字都算）
   4) 全 18 图：文字右缘是否越出 svg 边界
   判据：overlapPairs=0 且 textOverlapTotal=0 且 rightOutTotal=0 且左面板标签全 [in] */
var svgs=document.querySelectorAll('svg.chart');
var first=svgs[0], sr=first.getBoundingClientRect(), ts=first.querySelectorAll('text');
var months=[],leg=[],sb=[];
for(var i=0;i<ts.length;i++){
  var t=ts[i],tx=t.textContent,r=t.getBoundingClientRect();
  if(/^[0-9][0-9]月$/.test(tx))months.push([tx,r.left,r.right,r.top,r.bottom]);
  if(tx.indexOf('买点')>=0||tx.indexOf('卖点')>=0||tx.indexOf('持仓连线')>=0)leg.push([tx,r.left,r.right,r.top,r.bottom]);
  if(tx==='累计贡献'||tx==='成交量'||tx==='MACD'||tx.indexOf('获利盘')>=0||tx.indexOf('偏离')>=0||tx==='仓位')
    sb.push(tx+' x:'+Math.round(r.left)+'..'+Math.round(r.right)+(r.right<=sr.right+0.5?'[in]':'[OUT]'));
}
function ov(a,b){return !(a[4]<=b[3]||b[4]<=a[3]||a[2]<=b[1]||b[2]<=a[1]);}
var hits=0,pairs='';
for(var i=0;i<months.length;i++)for(var j=0;j<leg.length;j++)if(ov(months[i],leg[j])){hits++;if(pairs.length<90)pairs+=' '+months[i][0]+'x'+leg[j][0];}

/* 3) 全图文字重叠审计 */
var tot=0, samples='', rightOut=0, routSamples='';
for(var k=0;k<svgs.length;k++){
  var s=svgs[k], r0=s.getBoundingClientRect(), els=s.querySelectorAll('text'), bs=[];
  for(var i2=0;i2<els.length;i2++){
    var tx2=els[i2].textContent; if(!tx2||!tx2.trim())continue;
    var rr=els[i2].getBoundingClientRect(); if(rr.width<=0||rr.height<=0)continue;
    if(rr.right>r0.right+0.5){rightOut++;if(routSamples.length<80)routSamples+=' #'+(k+1)+':'+tx2.slice(0,10)+'@'+Math.round(rr.right-r0.right);}
    bs.push([tx2,rr.left,rr.right,rr.top,rr.bottom]);
  }
  for(var a=0;a<bs.length;a++)for(var b=a+1;b<bs.length;b++){
    if(!(bs[a][4]<=bs[b][3]||bs[b][4]<=bs[a][3]||bs[a][2]<=bs[b][1]||bs[b][2]<=bs[a][1])){}
    else continue;
    /* 同一 y 带才算真压字：两框都必须有明显重叠面积 */
    var ox=Math.min(bs[a][2],bs[b][2])-Math.max(bs[a][1],bs[b][1]);
    var oy=Math.min(bs[a][4],bs[b][4])-Math.max(bs[a][3],bs[b][3]);
    if(ox>1&&oy>1){tot++;if(samples.length<120)samples+=' #'+(k+1)+'['+bs[a][0].slice(0,8)+'|'+bs[b][0].slice(0,8)+']';}
  }
}
return svgs.length+' charts | '+(first.getAttribute('viewBox')||'?')
  +' | monthLabels='+months.length+' legendLabels='+leg.length+' overlapPairs='+hits+pairs
  +' | yBand: month='+Math.round(months[0][3])+'..'+Math.round(months[0][4])+' legend='+Math.round(leg[0][3])+'..'+Math.round(leg[0][4])
  +' | panel: '+sb.join(' ; ')
  +' | textOverlapTotal='+tot+samples
  +' | rightOutTotal='+rightOut+routSamples;
})()
