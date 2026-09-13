(function(){
var svg=document.querySelector('svg.chart');
var sr=svg.getBoundingClientRect();
var ts=svg.querySelectorAll('text');
var months=[],leg=[],sb=[];
for(var i=0;i<ts.length;i++){
  var t=ts[i],tx=t.textContent,r=t.getBoundingClientRect();
  if(/^[0-9][0-9]月$/.test(tx))months.push([tx,r.left,r.right,r.top,r.bottom]);
  if(tx.indexOf('买点')>=0||tx.indexOf('卖点')>=0||tx.indexOf('持仓连线')>=0)leg.push([tx,r.left,r.right,r.top,r.bottom]);
  if(tx==='累计贡献'||tx==='成交量')sb.push(tx+' x:'+Math.round(r.left)+'..'+Math.round(r.right)+(r.right<=sr.right+0.5?'[in]':'[OUT]'));
}
function ov(a,b){return !(a[4]<=b[3]||b[4]<=a[3]||a[2]<=b[1]||b[2]<=a[1]);}
var hits=0,pairs='';
for(var i=0;i<months.length;i++)for(var j=0;j<leg.length;j++)if(ov(months[i],leg[j])){hits++;if(pairs.length<90)pairs+=' '+months[i][0]+'x'+leg[j][0];}
return svg.getAttribute('viewBox')+' | monthLabels='+months.length+' legendLabels='+leg.length+' overlapPairs='+hits+pairs
  +' | svgRightCSS='+Math.round(sr.right)+' | panel: '+sb.join(' ; ')
  +' | yBand: month='+Math.round(months[0][3])+'..'+Math.round(months[0][4])+' legend='+Math.round(leg[0][3])+'..'+Math.round(leg[0][4]);
})()
