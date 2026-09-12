import urllib.request, json, ssl, time
from collections import Counter

def detect_market(code):
    if code.startswith('6') or code.startswith('9'):
        return 'SH'
    if code.startswith('0') or code.startswith('3'):
        return 'SZ'
    if code.startswith('8') or code.startswith('4') or code.startswith('92'):
        return 'BJ'
    return 'SZ'

ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
HDR = {
 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
 'Accept':'application/json, text/plain, */*',
 'Accept-Language':'zh-CN,zh;q=0.9',
 'Referer':'https://quote.eastmoney.com/',
}
HOST = 'https://push2delay.eastmoney.com'
BASE = HOST + '/api/qt/clist/get?pn={pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12' \
        '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f12,f14'

def fetch_page(pn):
    url = BASE.format(pn=pn)
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=HDR)
            with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
                data = json.loads(r.read().decode('utf-8','replace'))
            d = data.get('data') or {}
            return d.get('total'), d.get('diff') or []
        except Exception as e:
            if attempt == 2:
                raise
            time.sleep(2)

records=[]; seen=set(); total=None; pn=1
while True:
    t, diff = fetch_page(pn)
    if total is None:
        total = t
        print('TOTAL(reported):', total, flush=True)
    if not diff:
        break
    for item in diff:
        code = str(item.get('f12','')).strip()
        name = str(item.get('f14','')).strip()
        if not code or len(code)!=6 or not code.isdigit():
            continue
        if code in seen:
            continue
        seen.add(code)
        records.append({'code':code,'name':name,'market':detect_market(code)})
    print('pn',pn,'got',len(diff),'cum',len(records),flush=True)
    if len(records) >= (total or 0) or len(diff)<100:
        break
    pn += 1
    time.sleep(0.4)

counts = Counter(r['market'] for r in records)
print('COLLECTED:', len(records), 'byMarket:', dict(counts))
out='/root/sclaw/backend/data/stock_list.json'
with open(out,'w',encoding='utf-8') as f:
    json.dump(records, f, ensure_ascii=False, indent=1)
print('wrote', out, len(records), 'records')
