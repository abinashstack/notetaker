const $ = (id) => document.getElementById(id);
const popId = new URLSearchParams(location.search).get('note');

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function cardHtml(n) {
  return `<div class="card" data-id="${n.id}">
    <h2>${esc(n.emoji)} ${esc(n.title)}</h2>
    <p class="sum">${esc(n.summary)}</p>
    <ul>${n.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    <div class="terms">${n.terms.map((t) => `<span>${esc(t)}</span>`).join('')}</div>
    <div class="row"><span>${new Date(n.createdAt).toLocaleString()}</span>
      <span><button data-act="pop">📌 Pop out</button> <button data-act="del">🗑</button></span></div>
  </div>`;
}

async function render() {
  let notes = await api.listNotes();
  if (popId) notes = notes.filter((n) => n.id === popId);
  $('list').innerHTML = notes.length ? notes.map(cardHtml).join('') : '<div class="empty">No notes yet.<br>Press Ctrl+Shift+S to start taking notes, Ctrl+Shift+E to stop.</div>';
}

let recording = false;

function draftHtml(n) {
  return `<div class="card">
    <h2>${esc(n.emoji)} ${esc(n.title)}</h2>
    <p class="sum">${esc(n.summary)}</p>
    <ul>${n.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    <div class="terms">${n.terms.map((t) => `<span>${esc(t)}</span>`).join('')}</div>
    <div class="actions">
      <button class="primary" data-draft="save">💾 Save</button>
      <button data-draft="continue">▶ Continue</button>
      <button data-draft="discard">🗑 Discard</button>
    </div>
  </div>`;
}

$('draft').addEventListener('click', async (e) => {
  const act = e.target.dataset.draft;
  if (!act) return;
  if (act === 'save') { await api.saveDraft(); render(); }
  if (act === 'continue') await api.continueDraft();
  if (act === 'discard') await api.discardDraft();
});

$('list').addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  const id = e.target.closest('.card').dataset.id;
  if (act === 'del') { await api.deleteNote(id); render(); }
  if (act === 'pop') api.popout(id);
});

$('scan').onclick = () => (recording ? api.stopSession() : api.startSession());
$('close').onclick = () => api.closeWindow();
api.onSessionState((s) => {
  recording = s.recording;
  $('scan').textContent = s.recording ? 'Stop & show' : 'Start notes';
  $('scan').disabled = s.merging;
  $('draft').innerHTML = s.draft ? draftHtml(s.draft) : '';
  $('status').textContent = s.merging ? 'Putting your notes together…'
    : s.recording ? `🔴 Taking notes · ${s.captures} captures · ${s.snippets} summarized${s.working ? ' · reading…' : ''}`
    : s.error ? '⚠ ' + s.error
    : s.draft ? 'Save, continue, or discard?' : '';
});
api.getSession();

$('gear').onclick = async () => {
  const box = $('settings');
  if (box.style.display === 'flex') { box.style.display = 'none'; return; }
  const s = await api.getSettings();
  $('provider').value = s.provider;
  $('ollamaModel').value = s.ollamaModel;
  $('opacity').value = s.opacity;
  $('openAtLogin').checked = s.openAtLogin;
  $('claudeKey').value = '';
  box.style.display = 'flex';
};
$('save').onclick = async () => {
  await api.setSettings({
    provider: $('provider').value,
    ollamaModel: $('ollamaModel').value.trim(),
    opacity: Number($('opacity').value),
    openAtLogin: $('openAtLogin').checked,
    claudeKey: $('claudeKey').value.trim(),
  });
  $('settings').style.display = 'none';
  $('status').textContent = 'Settings saved';
};
$('export').onclick = async () => {
  $('status').textContent = (await api.exportNotes()) ? 'Backup exported ✓' : 'Export cancelled';
};

if (popId) {
  $('scan').style.display = 'none';
  $('gear').style.display = 'none';
}
render();
