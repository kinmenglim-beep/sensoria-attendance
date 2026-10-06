// Tiny HTML templating: every interpolated value is escaped unless it is
// itself the result of html`` (or raw()).

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(render).join('');
  if (v instanceof Raw) return v.s;
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

export const raw = (s) => new Raw(s);

export const FLAG_LABELS = {
  'in:no_location': 'No GPS at check-in',
  'out:no_location': 'No GPS at check-out',
  'in:outside_area': 'Checked in outside area',
  'out:outside_area': 'Checked out outside area',
  'in:off_network': 'Check-in not on venue WiFi',
  'out:off_network': 'Check-out not on venue WiFi',
  'in:unregistered_device': 'Not their registered phone',
  'out:unregistered_device': 'Checked out on an unregistered phone',
  'in:many_devices': 'Many different phones lately',
  'out:many_devices': 'Many different phones lately',
  'in:new_device': 'New device at check-in',
  'out:new_device': 'New device at check-out',
  'in:shared_device': 'Device also used by another worker',
  'out:shared_device': 'Check-out device also used by another worker',
  'out:device_changed': 'Clocked out on a different device',
  no_checkout: 'Never clocked out',
  manual: 'Added by supervisor',
  edited: 'Times edited',
};

// Device flags are only shown to supervisors.
const SUPERVISOR_ONLY = (f) => f.includes('device');

export function flagList(flags, { forWorker = false } = {}) {
  const list = String(flags || '').split(',').filter((f) => f && !(forWorker && SUPERVISOR_ONLY(f)));
  if (!list.length) return '';
  const content = html`${list.map((f) => html`<span class="flag">${FLAG_LABELS[f] || f}</span>`)}`;
  return forWorker ? html`<div>${content}</div>` : content;
}

export function statusBadge(shift) {
  if (!shift.check_out_at) return html`<span class="badge badge-open">Working</span>`;
  const cls = { pending: 'badge-pending', approved: 'badge-approved', rejected: 'badge-rejected' }[shift.status];
  const label = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' }[shift.status];
  return html`<span class="badge ${cls}">${label}</span>`;
}

export const fmtHours = (h) => (Math.round(h * 100) / 100).toFixed(2);
export const fmtMoney = (n) => (n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function nav(user, active) {
  if (!user) return '';
  const link = (href, label, key) => html`<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`;
  const links = user.role === 'supervisor'
    ? [
      link('/admin', 'Dashboard', 'dashboard'),
      link('/admin/pending', 'Approvals', 'pending'),
      link('/admin/export', 'Export', 'export'),
      link('/admin/people', 'People', 'people'),
      link('/admin/settings', 'Settings', 'settings'),
    ]
    : [link('/', 'Clock in/out', 'home'), link('/me', 'My hours', 'me')];
  return html`
    <nav class="nav">
      <div class="nav-inner">
        <a class="brand" href="${user.role === 'supervisor' ? '/admin' : '/'}">Attendance</a>
        <div class="nav-links">${links}</div>
        <form method="post" action="/logout" class="nav-logout">
          <span class="nav-user">${user.name}</span>
          <button type="submit" class="btn-link">Log out</button>
        </form>
      </div>
    </nav>`;
}

export function layout({ title, user = null, active = '', flash = null, error = null, body, scripts = [] }) {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0f766e">
  <title>${title} · Attendance</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
</head>
<body>
  ${nav(user, active)}
  <main class="container">
    ${flash ? html`<div class="alert alert-ok" role="status">${flash}</div>` : ''}
    ${error ? html`<div class="alert alert-error" role="alert">${error}</div>` : ''}
    ${body}
  </main>
  <script src="/app.js" defer></script>
  ${scripts.map((s) => html`<script src="${s}" defer></script>`)}
</body>
</html>`.s;
}

