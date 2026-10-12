const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen, dialog, safeStorage, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const dataDir = () => app.getPath('userData');
const notesFile = () => path.join(dataDir(), 'notes.json');
const settingsFile = () => path.join(dataDir(), 'settings.json');

const DEFAULT_SETTINGS = {
  provider: 'ollama',
  ollamaModel: 'qwen2.5vl:3b',
  claudeModel: 'claude-sonnet-5-5',
  claudeKeyEnc: '',
  opacity: 1,
};

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

let win;
let tray; // module-level so it isn't garbage collected

function createWindow(query) {
  const w = new BrowserWindow({
    width: 380,
    height: 560,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true, // the taskbar button is drawn by Windows and would show in a screen share
    show: false,       // protection must be on before the window is ever shown
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  w.setContentProtection(true); // WDA_EXCLUDEFROMCAPTURE: hidden from screen share and screenshots
  w.setAlwaysOnTop(true, 'screen-saver');
  w.loadFile('index.html', query ? { query } : undefined);
  if (query) w.once('ready-to-show', () => w.showInactive()); // pop-outs show themselves
  return w;
}

async function captureScreen() {
  const { width, height } = screen.getPrimaryDisplay().size;
  const sf = screen.getPrimaryDisplay().scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * sf), height: Math.round(height * sf) },
  });
  if (!sources.length) throw new Error('No screen source found');
  const img = sources[0].thumbnail;
  // Downscale for speed (the model is the bottleneck), and make a tiny signature to detect "nothing changed".
  const small = img.getSize().width > 1280 ? img.resize({ width: 1280 }) : img;
  return { b64: small.toPNG().toString('base64'), sig: img.resize({ width: 32, height: 18 }).toBitmap() };
}

function sameScreen(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return diff / a.length < 3; // mean per-byte difference; ~0 when the screen is unchanged
}

const PROMPT = `You are a note-taking assistant. Read this screenshot and make short study notes.
Reply with ONLY a JSON object, no other text, in this shape:
{"title": "short title", "emoji": "one emoji", "summary": "1-2 sentence summary", "bullets": ["3 to 6 key points"], "terms": ["up to 5 key terms"]}`;

function parseNote(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('Model did not return JSON');
  const o = JSON.parse(text.slice(start, end + 1));
  return {
    title: String(o.title || 'Untitled'),
    emoji: String(o.emoji || '📝'),
    summary: String(o.summary || ''),
    bullets: Array.isArray(o.bullets) ? o.bullets.map(String) : [],
    terms: Array.isArray(o.terms) ? o.terms.map(String) : [],
  };
}

// b64 is optional: omitted for the text-only merge step.
async function summarizeOllama(prompt, b64, s) {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: s.ollamaModel,
      stream: false,
      format: 'json',
      messages: [{ role: 'user', content: prompt, ...(b64 && { images: [b64] }) }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return parseNote((await res.json()).message.content);
}

async function summarizeClaude(prompt, b64, s) {
  if (!s.claudeKeyEnc) throw new Error('No Claude API key set in settings');
  const key = safeStorage.decryptString(Buffer.from(s.claudeKeyEnc, 'base64'));
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: s.claudeModel,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          ...(b64 ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }] : []),
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  return parseNote((await res.json()).content[0].text);
}

const CAPTURE_EVERY_MS = 30000;

const mergePrompt = (snippets) => `Below are notes taken from consecutive screenshots of one working session, as JSON.
Merge them into ONE set of notes: drop repeats, keep the order of events, keep the most important points.
Reply with ONLY a JSON object, no other text, in this shape:
{"title": "short title", "emoji": "one emoji", "summary": "2-3 sentence summary", "bullets": ["up to 8 key points"], "terms": ["up to 6 key terms"]}

${JSON.stringify(snippets)}`;

const summarize = (prompt, b64) => {
  const s = readJson(settingsFile(), DEFAULT_SETTINGS);
  return s.provider === 'claude' ? summarizeClaude(prompt, b64, s) : summarizeOllama(prompt, b64, s);
};

// One recording session: capture on a timer, summarize frames one at a time in the background,
// merge on stop into a draft that is only stored when the user saves it.
const session = { active: false, merging: false, timer: null, snippets: [], lastSig: null, pending: null, working: null, captures: 0, draft: null, error: null };

function pushState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('session:state', {
    recording: session.active,
    merging: session.merging,
    working: !!session.working,
    captures: session.captures,
    snippets: session.snippets.length,
    draft: session.draft,
    error: session.error,
  });
}

// Only the newest unprocessed frame is kept: if the model is slower than the timer, stale frames are dropped.
function pump() {
  if (session.working || !session.pending) return;
  const frame = session.pending;
  session.pending = null;
  session.working = summarize(PROMPT, frame)
    .then((n) => session.snippets.push(n))
    .catch((e) => { session.error = e.message; })
    .finally(() => { session.working = null; pushState(); pump(); });
  pushState();
}

async function tick() {
  try {
    const { b64, sig } = await captureScreen();
    if (sameScreen(sig, session.lastSig)) return;
    session.lastSig = sig;
    session.captures++;
    session.pending = b64;
    pump();
  } catch (e) {
    session.error = e.message;
  }
  pushState();
}

function startTimer() {
  session.active = true;
  session.error = null;
  tick();
  session.timer = setInterval(tick, CAPTURE_EVERY_MS);
  pushState();
}

function startSession() {
  if (session.active || session.merging) return;
  Object.assign(session, { snippets: [], lastSig: null, pending: null, captures: 0, draft: null });
  startTimer();
}

async function stopSession() {
  if (!session.active) return;
  clearInterval(session.timer);
  session.active = false;
  session.merging = true;
  pushState();
  await tick(); // one last look at the screen
  while (session.working || session.pending) { pump(); await session.working; }
  try {
    const sn = session.snippets;
    if (!sn.length) throw new Error(session.error || 'Nothing was captured');
    session.draft = sn.length === 1 ? sn[0] : await summarize(mergePrompt(sn), null);
  } catch (e) {
    session.error = e.message;
  }
  session.merging = false;
  pushState();
  win.showInactive();
}

function saveDraft() {
  if (!session.draft) return;
  const notes = readJson(notesFile(), []);
  notes.unshift({ id: Date.now().toString(36), createdAt: new Date().toISOString(), ...session.draft });
  writeJson(notesFile(), notes);
  discardDraft();
}

function continueDraft() {
  if (!session.draft || session.active) return;
  session.draft = null;
  startTimer(); // keeps the snippets already collected
}

function discardDraft() {
  Object.assign(session, { draft: null, snippets: [], lastSig: null, pending: null, captures: 0, error: null });
  pushState();
}

ipcMain.handle('notes:list', () => readJson(notesFile(), []));
ipcMain.handle('notes:delete', (_e, id) => {
  writeJson(notesFile(), readJson(notesFile(), []).filter((n) => n.id !== id));
});
ipcMain.handle('session:start', startSession);
ipcMain.handle('session:stop', stopSession);
ipcMain.handle('session:get', pushState);
ipcMain.handle('draft:save', saveDraft);
ipcMain.handle('draft:continue', continueDraft);
ipcMain.handle('draft:discard', discardDraft);
ipcMain.handle('notes:popout', (_e, id) => { createWindow({ note: id }); });
ipcMain.handle('notes:export', async () => {
  const { filePath } = await dialog.showSaveDialog(win, { defaultPath: 'notes-backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!filePath) return false;
  writeJson(filePath, readJson(notesFile(), []));
  return true;
});

ipcMain.handle('settings:get', () => {
  const { claudeKeyEnc, ...rest } = { ...DEFAULT_SETTINGS, ...readJson(settingsFile(), {}) };
  return { ...rest, hasClaudeKey: !!claudeKeyEnc, openAtLogin: app.getLoginItemSettings().openAtLogin };
});
ipcMain.handle('settings:set', (_e, patch) => {
  const s = { ...DEFAULT_SETTINGS, ...readJson(settingsFile(), {}) };
  const { claudeKey, openAtLogin, ...rest } = patch;
  if (typeof openAtLogin === 'boolean') app.setLoginItemSettings({ openAtLogin });
  Object.assign(s, rest);
  if (claudeKey) s.claudeKeyEnc = safeStorage.encryptString(claudeKey).toString('base64');
  writeJson(settingsFile(), s);
  if (typeof s.opacity === 'number' && win) win.setOpacity(s.opacity);
});

ipcMain.handle('win:close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w === win) w.hide(); else w.close(); // main window keeps running in the background
});

if (!app.requestSingleInstanceLock()) app.quit(); // never run two copies fighting over the hotkeys

app.whenReady().then(() => {
  // The renderer is fully local: block every request that isn't a local file.
  const { session } = require('electron');
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    cb({ cancel: !(details.url.startsWith('file://') || details.url.startsWith('devtools://')) });
  });

  win = createWindow();
  const s = readJson(settingsFile(), DEFAULT_SETTINGS);
  // First run of the packaged app: start with the OS (the user can turn it off in settings).
  if (app.isPackaged && !s.autostartInit) {
    app.setLoginItemSettings({ openAtLogin: true });
    writeJson(settingsFile(), { ...s, autostartInit: true });
  }
  if (typeof s.opacity === 'number') win.setOpacity(s.opacity);

  // Everything runs with the window hidden; it only appears (without stealing focus) when a draft is ready.
  const toggleWindow = () => { if (win.isVisible()) win.hide(); else win.showInactive(); };

  // CommandOrControl = Cmd on macOS, Ctrl on Windows/Linux
  globalShortcut.register('CommandOrControl+Shift+S', startSession);
  globalShortcut.register('CommandOrControl+Shift+E', stopSession);
  globalShortcut.register('CommandOrControl+Shift+H', toggleWindow);
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());

  // macOS: menu bar icon, no Dock icon. (Skipped on Windows: a tray icon would show in a screen share.)
  if (process.platform === 'darwin') {
    app.dock.hide();
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle('📝');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Start taking notes', accelerator: 'Cmd+Shift+S', click: startSession },
      { label: 'Stop and show notes', accelerator: 'Cmd+Shift+E', click: stopSession },
      { label: 'Show / hide notes', accelerator: 'Cmd+Shift+H', click: toggleWindow },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'Cmd+Shift+Q', click: () => app.quit() },
    ]));
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
