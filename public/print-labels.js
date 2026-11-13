// Trang in nhãn QR: vẽ mã QR trên trình duyệt (file riêng để tuân thủ Content-Security-Policy, không dùng script nội tuyến)
import { qrSvg } from '/qr.js';

for (const el of document.querySelectorAll('.qr[data-url]')) el.innerHTML = qrSvg(el.dataset.url, { ecl: 'Q', scale: 3 });
document.getElementById('btn-print')?.addEventListener('click', () => window.print());
