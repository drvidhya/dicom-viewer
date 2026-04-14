export function updateStatus(msg: string, state: 'loading' | 'ready' | 'error'): void {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  if (dot) dot.className = `dot ${state}`;
  if (txt) txt.textContent = msg;
}

export function updateProgress(msg: string): void {
  const el = document.getElementById('progress');
  if (el) el.textContent = msg;
}

export function hideOverlay(): void {
  const el = document.getElementById('overlay');
  if (el) el.classList.add('hidden');
}

export function showError(msg: string): void {
  const el = document.getElementById('overlay');
  if (el) el.innerHTML = `<p class="error">${msg}</p>`;
  updateStatus('Error', 'error');
}
