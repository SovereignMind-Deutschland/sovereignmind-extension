import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RunSnapshot, StepResult, RunKind, runDir } from './logger';

export interface ViewHost {
    repoRoot(kind: RunKind): string | undefined;
    live(kind: RunKind): RunSnapshot | undefined;
    sonar(): Promise<{ url: string; tokenSource: 'sidebar' | 'env' | 'none'; enabled: boolean; gateHard: boolean }>;
    /** Ergebnis von `--check` je Ziel (leerer Text = nutzbar); undefined, solange die Prüfung noch läuft. */
    platformStatus(): Record<string, string> | undefined;
    /** Ziel und Variante des laufenden Installer-Laufs. */
    runningVariant(): { target: string; variant: string } | undefined;
}

export const PLATFORMS = [
    { id: 'windows', label: 'Windows', icon: 'window' },
    { id: 'debian', label: 'Debian', icon: 'terminal-debian' },
    { id: 'rpm', label: 'RPM', icon: 'terminal-linux' }
];
const VARIANTS = [
    { id: 'full', label: 'Full', tip: 'alle KI-Modelle enthalten, offline installierbar, groß' },
    { id: 'minimal', label: 'Minimal', tip: 'ohne Modelle, lädt beim Installieren nach' }
];

const RESULT_ICON: Record<string, vscode.ThemeIcon> = {
    running: new vscode.ThemeIcon('sync~spin'),
    success: new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green')),
    ok: new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green')),
    failed: new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red')),
    cancelled: new vscode.ThemeIcon('circle-slash'),
    unknown: new vscode.ThemeIcon('question')
};

function paramsText(p?: Record<string, unknown>): string {
    if (!p) { return ''; }
    return [p.target, p.variant, p.mode, p.version].filter(v => typeof v === 'string' && v).join('/');
}

const RESULT_TEXT: Record<string, string> = {
    running: 'Läuft …', success: 'Erfolgreich', failed: 'Fehlgeschlagen', cancelled: 'Abgebrochen', unknown: 'Unbekannt'
};

function readJson(file: string): any | undefined {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function fmtDuration(sec?: number): string {
    if (sec === undefined) { return ''; }
    return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}

function fmtSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = bytes, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export interface LogTarget { logPath: string; line?: number; }

function stepItem(s: StepResult, logPath: string): vscode.TreeItem {
    const item = new vscode.TreeItem(s.name);
    item.iconPath = RESULT_ICON[s.status];
    item.description = fmtDuration(s.durationSec);
    if (s.errorExcerpt) { item.tooltip = s.errorExcerpt; }
    item.command = {
        command: 'sovereignmind.openLogAt', title: 'Log öffnen',
        arguments: [{ logPath, line: s.logRange?.fromLine } as LogTarget]
    };
    return item;
}

function linkItem(link: string): vscode.TreeItem {
    const item = new vscode.TreeItem('Sonar-Dashboard');
    item.iconPath = new vscode.ThemeIcon('link-external');
    item.description = link;
    item.command = { command: 'vscode.open', title: 'Öffnen', arguments: [vscode.Uri.parse(link)] };
    return item;
}

abstract class Provider<T extends vscode.TreeItem> implements vscode.TreeDataProvider<T> {
    private emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;
    constructor(protected host: ViewHost, protected kind: RunKind = 'preflight') {}
    refresh(): void { this.emitter.fire(); }
    getTreeItem(e: T): vscode.TreeItem { return e; }
    abstract getChildren(e?: T): vscode.ProviderResult<T[]>;
}

class CurrentProvider extends Provider<vscode.TreeItem> {
    getChildren(): vscode.TreeItem[] {
        const root = this.host.repoRoot(this.kind);
        if (!root) { return []; }
        const dir = runDir(root, this.kind);
        const live = this.host.live(this.kind);
        const snap: RunSnapshot | undefined = live ?? (() => {
            const j = readJson(path.join(dir, 'last-run.json'));
            return j && { result: j.result, steps: j.steps ?? [], link: j.link, logPath: path.join(dir, 'last-run.log'),
                startedAt: j.startedAt, durationSec: j.durationSec, branch: j.branch };
        })();
        if (!snap) { return []; }
        const head = new vscode.TreeItem(RESULT_TEXT[snap.result] ?? snap.result);
        head.iconPath = RESULT_ICON[snap.result];
        head.description = [this.kind === 'installer' ? undefined : snap.branch, paramsText(snap.params), fmtDuration(snap.durationSec)]
            .filter(Boolean).join(' · ');
        head.command = { command: 'sovereignmind.openLogAt', title: 'Log öffnen', arguments: [{ logPath: snap.logPath } as LogTarget] };
        const items = [head, ...snap.steps.map(s => stepItem(s, snap.logPath))];
        if (snap.link) { items.push(linkItem(snap.link)); }
        return items;
    }
}

class HistoryItem extends vscode.TreeItem {
    constructor(public readonly base: string, public readonly data: any) {
        super(new Date(data.startedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }), vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = RESULT_ICON[data.result] ?? RESULT_ICON.unknown;
        this.description = [data.kind === 'installer' ? paramsText(data.params) : data.branch, fmtDuration(data.durationSec)]
            .filter(Boolean).join(' · ');
        this.tooltip = `${data.kind === 'installer' ? paramsText(data.params) : data.branch ?? data.repo}\n${RESULT_TEXT[data.result] ?? data.result}${data.failedStep ? ` (Schritt: ${data.failedStep})` : ''}`;
        this.contextValue = 'historyRun';
        this.command = { command: 'sovereignmind.openLogAt', title: 'Log öffnen', arguments: [{ logPath: `${base}.log` } as LogTarget] };
    }
}

class HistoryProvider extends Provider<vscode.TreeItem> {
    getChildren(e?: vscode.TreeItem): vscode.TreeItem[] {
        if (e instanceof HistoryItem) {
            return [...(e.data.steps ?? []).map((s: StepResult) => stepItem(s, `${e.base}.log`)),
                ...(e.data.link ? [linkItem(e.data.link)] : [])];
        }
        const root = this.host.repoRoot(this.kind);
        if (!root) { return []; }
        const hist = path.join(runDir(root, this.kind), 'history');
        let files: string[] = [];
        try { files = fs.readdirSync(hist).filter(f => f.endsWith('.json')).sort().reverse(); } catch { /* leer */ }
        return files.flatMap(f => {
            const base = path.join(hist, f.replace(/\.json$/, ''));
            const data = readJson(`${base}.json`);
            return data ? [new HistoryItem(base, data)] : [];
        });
    }
}

class ArtifactItem extends vscode.TreeItem {
    constructor(public readonly filePath: string, public readonly sha: string, size: number) {
        super(path.basename(filePath));
        this.iconPath = new vscode.ThemeIcon('package');
        this.description = fmtSize(size);
        this.tooltip = `${filePath}
SHA-256: ${sha}`;
        this.contextValue = 'artifactFile';
    }
}

class ResultProvider extends Provider<vscode.TreeItem> {
    getChildren(e?: vscode.TreeItem): vscode.TreeItem[] {
        if (e instanceof ArtifactGroup) { return e.files; }
        const root = this.host.repoRoot('installer');
        if (!root) { return []; }
        const data = readJson(path.join(root, 'dist', 'installer', 'last-build.json'));
        if (!data) { return []; }
        const results: any[] = data.results ?? [];
        const items: vscode.TreeItem[] = [];
        const head = new vscode.TreeItem(`Version ${data.version || '?'}`);
        head.iconPath = data.status === 'ok' ? RESULT_ICON.success : RESULT_ICON.failed;
        head.description = [paramsText(data), fmtDuration(data.durationSec)].filter(Boolean).join(' · ');
        head.contextValue = 'artifactFolder';
        head.tooltip = 'Installer-Ordner öffnen';
        head.command = { command: 'sovereignmind.installer.openFolder', title: 'Installer-Ordner öffnen' };
        items.push(head);
        for (const r of results) {
            const files = (r.files ?? []).map((f: any) =>
                new ArtifactItem(path.join(root, ...String(f.path).split('/')), String(f.sha256), Number(f.size) || 0));
            items.push(new ArtifactGroup(`${r.target}/${r.variant}`, r.status, r.durationSec, files));
        }
        return items;
    }
}

class ArtifactGroup extends vscode.TreeItem {
    constructor(label: string, status: string, durationSec: number | undefined, public readonly files: ArtifactItem[]) {
        super(label, files.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        this.iconPath = status === 'ok' ? RESULT_ICON.success : RESULT_ICON.failed;
        this.description = fmtDuration(durationSec);
    }
}

class PlatformItem extends vscode.TreeItem {
    constructor(public readonly target: string, label: string, icon: string, reason: string | undefined) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.id = `platform:${target}`;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.description = reason === undefined ? 'prüfe …' : reason ? `fehlt: ${reason}` : 'bereit';
        if (reason) { this.tooltip = reason; }
    }
}

class VariantItem extends vscode.TreeItem {
    constructor(public readonly target: string, public readonly variant: string, label: string, tip: string,
        state: 'ready' | 'running' | 'disabled', reason: string | undefined) {
        super(label);
        this.id = `variant:${target}:${variant}`;
        this.tooltip = state === 'disabled' ? (reason ?? 'Prüfung läuft noch') : tip;
        if (state === 'running') {
            this.iconPath = new vscode.ThemeIcon('sync~spin');
            this.description = 'läuft';
            this.contextValue = 'installerVariantRunning';
        } else if (state === 'disabled') {
            this.iconPath = new vscode.ThemeIcon('circle-slash');
            this.contextValue = 'installerVariantDisabled';
        } else {
            this.iconPath = new vscode.ThemeIcon('package');
            this.contextValue = 'installerVariant';
        }
    }
}

class PlatformProvider extends Provider<vscode.TreeItem> {
    getChildren(e?: vscode.TreeItem): vscode.TreeItem[] {
        const status = this.host.platformStatus();
        if (e instanceof PlatformItem) {
            const reason = status?.[e.target];
            const run = this.host.runningVariant();
            return VARIANTS.map(v => {
                const isRun = run?.target === e.target && run.variant === v.id;
                const state = isRun ? 'running' : reason === undefined || reason ? 'disabled' : 'ready';
                return new VariantItem(e.target, v.id, v.label, v.tip, state, reason);
            });
        }
        if (e) { return []; }
        if (!this.host.repoRoot('installer')) { return []; }
        return PLATFORMS.map(p => new PlatformItem(p.id, p.label, p.icon, status ? (status[p.id] ?? 'nicht geprüft') : undefined));
    }
}

class SonarProvider extends Provider<vscode.TreeItem> {
    async getChildren(): Promise<vscode.TreeItem[]> {
        const s = await this.host.sonar();
        const url = new vscode.TreeItem('Server');
        url.iconPath = new vscode.ThemeIcon('server');
        url.description = s.url || 'Standard des Skripts';
        const token = new vscode.TreeItem('Token');
        token.iconPath = new vscode.ThemeIcon('key');
        token.description = { sidebar: 'gesetzt (VS Code)', env: 'aus .env des Repos', none: 'nicht gesetzt' }[s.tokenSource];
        for (const i of [url, token]) { i.command = { command: 'sovereignmind.configureSonar', title: 'Sonar einrichten' }; }
        const scan = new vscode.TreeItem('Sonar-Schritt');
        scan.iconPath = new vscode.ThemeIcon(s.enabled ? 'check' : 'circle-slash');
        scan.description = s.enabled ? 'an (SONAR=1)' : 'aus (SONAR=0)';
        scan.command = { command: 'sovereignmind.toggleSonar', title: 'Sonar an/aus' };
        const gate = new vscode.TreeItem('Quality Gate');
        gate.iconPath = new vscode.ThemeIcon(s.gateHard ? 'shield' : 'warning');
        gate.description = s.gateHard ? 'hart (SONAR_GATE=1)' : 'weich (SONAR_GATE=0)';
        gate.command = { command: 'sovereignmind.toggleSonarGate', title: 'Gate hart/weich' };
        return [url, token, scan, gate];
    }
}

export class PrepushViews {
    private current: CurrentProvider;
    private history: HistoryProvider;
    private sonar: SonarProvider;
    private instCurrent: CurrentProvider;
    private instHistory: HistoryProvider;
    private instResult: ResultProvider;
    private instPlatforms: PlatformProvider;

    constructor(host: ViewHost, context: vscode.ExtensionContext) {
        this.instPlatforms = new PlatformProvider(host, 'installer');
        this.current = new CurrentProvider(host);
        this.history = new HistoryProvider(host);
        this.sonar = new SonarProvider(host);
        this.instCurrent = new CurrentProvider(host, 'installer');
        this.instHistory = new HistoryProvider(host, 'installer');
        this.instResult = new ResultProvider(host, 'installer');
        context.subscriptions.push(
            vscode.window.registerTreeDataProvider('sovereignmind.current', this.current),
            vscode.window.registerTreeDataProvider('sovereignmind.history', this.history),
            vscode.window.registerTreeDataProvider('sovereignmind.sonar', this.sonar),
            vscode.window.registerTreeDataProvider('sovereignmind.installer.platforms', this.instPlatforms),
            vscode.window.registerTreeDataProvider('sovereignmind.installer.current', this.instCurrent),
            vscode.window.registerTreeDataProvider('sovereignmind.installer.history', this.instHistory),
            vscode.window.registerTreeDataProvider('sovereignmind.installer.result', this.instResult)
        );
    }

    refresh(): void {
        for (const p of [this.current, this.history, this.sonar, this.instCurrent, this.instHistory, this.instResult, this.instPlatforms]) { p.refresh(); }
    }

    private lastLive = 0;
    private liveTimer: NodeJS.Timeout | undefined;
    /** Drosselt die Aktualisierung (Installer-Läufe dauern Stunden und melden viele Marker). */
    refreshLive(kind: RunKind): void {
        const p = kind === 'installer' ? this.instCurrent : this.current;
        const wait = 1000 - (Date.now() - this.lastLive);
        if (wait <= 0) { this.lastLive = Date.now(); p.refresh(); return; }
        if (this.liveTimer) { return; }
        this.liveTimer = setTimeout(() => { this.liveTimer = undefined; this.lastLive = Date.now(); p.refresh(); }, wait);
    }
}

export async function openLogAt(t: LogTarget): Promise<void> {
    if (!fs.existsSync(t.logPath)) { vscode.window.showInformationMessage('Log nicht gefunden.'); return; }
    const doc = await vscode.workspace.openTextDocument(t.logPath);
    const line = Math.max(0, (t.line ?? 1) - 1);
    const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
}

export async function openJsonForLog(item: vscode.TreeItem): Promise<void> {
    const base = (item as any).base as string | undefined;
    if (base) { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(`${base}.json`)); }
}

export function artifactPath(item: vscode.TreeItem): string | undefined {
    return (item as ArtifactItem).filePath;
}

export function artifactSha(item: vscode.TreeItem): string | undefined {
    return (item as ArtifactItem).sha;
}
