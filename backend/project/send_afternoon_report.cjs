const fs = require('fs');
const path = require('path');
const { sendEmail } = require('../dist/email.js');

const html = fs.readFileSync('/root/sclaw/data/afternoon_report_20260810.html', 'utf8');
const to = '18380462320@163.com, 1273396450@qq.com, 2163009526@qq.com, 1075518595@qq.com, 18628109518@163.com, 996807554@qq.com, keyppeng@163.com, 18380458856@163.com';
const subject = '🦀 SClaw 缠论·筹码·量价 午盘分析 2026-08-10 (一买+二买+三买 · ML v12 交叉验证)';
const text = 'SClaw 午盘缠论·筹码·量价深度分析报告 2026-08-10\n请以HTML格式查看完整报告。\n\n核心结论: 日线缠论买点0命中, 启用chan-5filters-main兜底(27只) + ML v12 Top30交叉验证。\n30分钟买点29个信号覆盖22只, 优先关注18只/观察4只/回避0只。\n🔥元琛科技(ML第1+二买90) 综合82.6分最高。\n\n仅供参考, 不构成投资建议。';

sendEmail({ to, subject, text, html }).then(ok => {
  console.log(ok ? 'EMAIL_SENT_OK' : 'EMAIL_SEND_FAILED');
}).catch(e => {
  console.error('EMAIL_ERROR', e.message);
  process.exit(1);
});
