import * as vscode from 'vscode';

export interface InstallerOptions { versionOn: boolean; version: string; fetch: boolean; keepStaging: boolean; }

export const OPTIONS_KEY = 'sovereignmind.installer.options';
export const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d{4}$/;
export const VERSION_FORMAT = 'JJJJ.MM.TT.HHMM';

const DEFAULTS: InstallerOptions = { versionOn: false, version: '', fetch: false, keepStaging: false };

export function loadOptions(state: vscode.Memento): InstallerOptions {
    return { ...DEFAULTS, ...state.get<Partial<InstallerOptions>>(OPTIONS_KEY, {}) };
}

/** Ist `--version` angehakt, muss das Feld dem Format entsprechen; sonst gibt es einen Hinweistext. */
export function optionsError(o: InstallerOptions): string | undefined {
    return o.versionOn && !VERSION_PATTERN.test(o.version) ? `--version braucht das Format ${VERSION_FORMAT}` : undefined;
}

/** Nur angehakte Optionen werden zu Argumenten. */
export function buildOptionArgs(o: InstallerOptions): string[] {
    const args: string[] = [];
    if (o.versionOn) { args.push('--version', o.version); }
    if (o.fetch) { args.push('--fetch'); }
    if (o.keepStaging) { args.push('--keep-staging'); }
    return args;
}

export class OptionsViewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'sovereignmind.installer.options';
    private view?: vscode.WebviewView;
    private locked = false;

    constructor(private readonly state: vscode.Memento) { }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this.html();
        view.webview.onDidReceiveMessage((m: { type: string; options?: InstallerOptions }) => {
            if (m.type === 'change' && m.options) { void this.state.update(OPTIONS_KEY, { ...DEFAULTS, ...m.options }); }
            if (m.type === 'ready') { this.sendInit(); }
        });
        view.onDidDispose(() => { if (this.view === view) { this.view = undefined; } });
    }

    private sendInit(): void {
        void this.view?.webview.postMessage({ type: 'init', options: loadOptions(this.state), locked: this.locked });
    }

    setLocked(locked: boolean): void {
        this.locked = locked;
        void this.view?.webview.postMessage({ type: 'locked', locked });
    }

    focus(): void {
        this.view?.show?.(false);
        void this.view?.webview.postMessage({ type: 'focusVersion' });
    }

    private html(): string {
        const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
        const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
        return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 6px 12px; }
.row { display: flex; align-items: center; gap: 6px; margin: 6px 0; flex-wrap: wrap; }
label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
code { font-family: var(--vscode-editor-font-family); }
.hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 0 0 0 24px; width: 100%; }
input[type=text] { flex: 1; min-width: 120px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); padding: 3px 5px; font-family: var(--vscode-editor-font-family); }
input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); }
input[type=text].invalid { border-color: var(--vscode-inputValidation-errorBorder); outline-color: var(--vscode-inputValidation-errorBorder); }
input:disabled { opacity: 0.5; cursor: default; }
.error { color: var(--vscode-errorForeground); font-size: 0.9em; margin: 0 0 0 24px; width: 100%; }
.error[hidden] { display: none; }
</style></head><body>
<div class="row">
  <label><input type="checkbox" id="versionOn"><code>--version</code></label>
  <input type="text" id="version" placeholder="${VERSION_FORMAT}" aria-label="Version" spellcheck="false">
  <div class="error" id="versionError" role="alert" hidden>Format ${VERSION_FORMAT}, z. B. 2026.10.31.1200</div>
</div>
<div class="row">
  <label><input type="checkbox" id="fetch"><code>--fetch</code></label>
  <div class="hint">fehlende Modelle für Full laden</div>
</div>
<div class="row">
  <label><input type="checkbox" id="keepStaging"><code>--keep-staging</code></label>
  <div class="hint">wirkt nur im Sammellauf, belegt ca. 13 GB</div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const re = /^\\d{4}\\.\\d{2}\\.\\d{2}\\.\\d{4}$/;
let locked = false;
function render() {
  const bad = $('versionOn').checked && !re.test($('version').value);
  $('version').classList.toggle('invalid', bad);
  $('versionError').hidden = !bad;
  for (const id of ['versionOn', 'version', 'fetch', 'keepStaging']) { $(id).disabled = locked; }
}
function send() {
  render();
  vscode.postMessage({ type: 'change', options: {
    versionOn: $('versionOn').checked, version: $('version').value.trim(),
    fetch: $('fetch').checked, keepStaging: $('keepStaging').checked } });
}
for (const id of ['versionOn', 'version', 'fetch', 'keepStaging']) { $(id).addEventListener('input', send); }
window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'init') {
    const o = m.options;
    $('versionOn').checked = o.versionOn; $('version').value = o.version;
    $('fetch').checked = o.fetch; $('keepStaging').checked = o.keepStaging;
    locked = m.locked;
  }
  if (m.type === 'locked') { locked = m.locked; }
  if (m.type === 'focusVersion') { $('version').focus(); }
  render();
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
    }
}
