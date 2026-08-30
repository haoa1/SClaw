const path = require('path');
process.chdir('/root/sclaw/backend');
require('tsx/cjs');

(async () => {
  const pluginPath = '/root/sclaw/plugins/users/2/limit-up-pullback-macd/index.ts';
  delete require.cache[require.resolve(pluginPath)];
  const mod = require(pluginPath);
  const plugin = mod.default || mod;
  console.log('PLUGIN:', plugin.id, plugin.version);

  const strat = plugin.strategies[0];
  const { DataFetcher } = require('/root/sclaw/backend/dist/data/data-fetcher.js');
  const df = new DataFetcher();

  // 检查智度股份 000676 + 华天酒店 000428 + 凯撒文化 002425 + 魅视科技 001229
  const codes = ['000676','000428','002425','001229','003032','002354'];
  for (const code of codes) {
    const mkt = code.startsWith('6') ? 'SH' : 'SZ';
    const { data: daily } = await df.fetchKLine(code, mkt, 120);
    const stock = { code, name: code, market: mkt, kline: daily };
    const r = strat.execute([stock], {lookbackDays:20, minStreak:3, pullbackMin:8, pullbackMax:45, shrinkDays:1, nearZeroAbs:0.6});
    console.log('---', code, 'shrinkDays=1 nearZero=0.6 ->', r.length ? JSON.stringify(r[0]) : 'NO MATCH');
    // 打印最近8根MACD柱
    const closes = daily.map(k=>k.close);
    const ema=(arr,p)=>{const r=[];const m=2/(p+1);for(let i=0;i<arr.length;i++){if(i===0)r.push(arr[i]);else r.push((arr[i]-r[i-1])*m+r[i-1]);}return r;};
    const ef=ema(closes,12), es=ema(closes,26);
    const dif=ef.map((v,i)=>v-es[i]);
    const dea=ema(dif,9);
    const hist=dif.map((v,i)=>2*(v-dea[i]));
    console.log('   last hist:', hist.slice(-8).map(h=>h.toFixed(3)).join(' '));
  }
})().catch(e => { console.error('ERR', e); process.exit(1); });
