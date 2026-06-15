export function $(id) { return document.getElementById(id); }

export function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '–';
}

export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function showToast(msg, type = 'info', duration = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast hidden'; }, duration);
}
