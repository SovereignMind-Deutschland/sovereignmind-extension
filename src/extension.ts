import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile, execFileSync, ChildProcess } from 'child_process';
import { RunLogger, loadSecrets, loadSecretsDeep, RunResult, RunKind, runDir, migrateLegacyLayout } from './logger';
import { OptionsViewProvider, loadOptions, optionsError, buildOptionArgs } from './optionsView';
import { PrepushViews, openLogAt, openJsonForLog, artifactPath, artifactSha } from './views';

interface Repo { folder: vscode.WorkspaceFolder; script: string; }

let running: { proc: ChildProcess; cancelled: boolean; kind: RunKind; params?: Record<string, unknown> } | undefined;
let output: vscode.OutputChannel;
const lastRepo: Partial<Record<RunKind, Repo>> = {};
let secrets: vscode.SecretStorage;
let views: PrepushViews;
let extPath = '';
let refreshAvailable: () => void = () => undefined;
const liveLogger: Partial<Record<RunKind, RunLogger>> = {};
let state: vscode.Memento;
let optionsView: OptionsViewProvider;

const TOKEN_KEY = 'sovereignmind.sonarToken';

const LEGACY_TOKEN_KEY = 'prepush.sonarToken';

async function sonarEnv(): Promise<{ url: string; token: string }> {
    const token = (await secrets.get(TOKEN_KEY)) ?? (await secrets.get(LEGACY_TOKEN_KEY)) ?? '';
    return { url: cfg().get<string>('sonarHostUrl', '').trim(), token };
}

/** Übernimmt vom Nutzer gesetzte prepush.*-Werte einmalig; alte Werte bleiben unberührt. */
async function migrateLegacySettings(): Promise<void> {
    const old = vscode.workspace.getConfiguration('prepush');
    const map: Array<[string, string]> = [
        ['scriptPath', 'preflight.scriptPath'], ['shell', 'shell'], ['sonarHostUrl', 'sonarHostUrl']
    ];
    for (const [from, to] of map) {
        const o = old.inspect<string>(from);
        const n = cfg().inspect<string>(to);
        if (o?.globalValue !== undefined && n?.globalValue === undefined) {
            await cfg().update(to, o.globalValue, vscode.ConfigurationTarget.Global);
        }
        if (o?.workspaceValue !== undefined && n?.workspaceValue === undefined) {
            await cfg().update(to, o.workspaceValue, vscode.ConfigurationTarget.Workspace);
        }
    }
}

async function toggleSetting(key: string): Promise<void> {
    await cfg().update(key, !cfg().get<boolean>(key, true), vscode.ConfigurationTarget.Global);
    views.refresh();
}

/** Unter Windows landet `bash` sonst bei WSL; die Skripte brauchen Git Bash. */
function resolveShell(): string {
    const configured = cfg().get<string>('shell', 'bash');
    if (configured !== 'bash' || process.platform !== 'win32') { return configured; }
    const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
    for (const b of bases) {
        if (!b) { continue; }
        const exe = path.join(b, 'Git', 'bin', 'bash.exe');
        if (fs.existsSync(exe)) { return exe; }
    }
    return configured;
}

async function configureSonar(): Promise<void> {
    const cur = cfg().get<string>('sonarHostUrl', '');
    const url = await vscode.window.showInputBox({
        title: 'Sonar-Server', prompt: 'URL, z. B. http://localhost:9000 oder https://sonarcloud.io. Leer = Standard des Skripts.',
        value: cur, ignoreFocusOut: true
    });
    if (url === undefined) { return; }
    await cfg().update('sonarHostUrl', url.trim(), vscode.ConfigurationTarget.Global);
    const token = await vscode.window.showInputBox({
        title: 'Sonar-Token', prompt: 'Wird verschlüsselt in VS Code gespeichert. Leer = bestehenden Token behalten.',
        password: true, ignoreFocusOut: true
    });
    if (token) { await secrets.store(TOKEN_KEY, token); }
    views.refresh();
}

const GITIGNORE_LINES = ['scripts/.env', '.prepush/'];

/** Legt scripts/ mit den mitgelieferten Vorlagen an. Bestehende Dateien werden nie überschrieben. */
async function initTemplate(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) { vscode.window.showWarningMessage('Kein Ordner geöffnet.'); return; }
    let folder = folders[0];
    if (folders.length > 1) {
        const pick = await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, f })), { placeHolder: 'Repo für die Vorlage wählen' });
        if (!pick) { return; }
        folder = pick.f;
    }
    const root = folder.uri.fsPath;
    const srcDir = path.join(extPath, 'templates', 'scripts');
    const destDir = path.join(root, 'scripts');
    fs.mkdirSync(destDir, { recursive: true });

    const created: string[] = [];
    const skipped: string[] = [];
    for (const name of fs.readdirSync(srcDir)) {
        const dest = path.join(destDir, name);
        if (fs.existsSync(dest)) { skipped.push(name); continue; }
        fs.copyFileSync(path.join(srcDir, name), dest);
        if (name.endsWith('.sh')) { fs.chmodSync(dest, 0o755); }
        created.push(name);
    }

    const gi = path.join(root, '.gitignore');
    const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    const have = new Set(existing.split(/\r?\n/).map(l => l.trim()));
    const missing = GITIGNORE_LINES.filter(l => !have.has(l));
    if (missing.length) {
        const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
        fs.writeFileSync(gi, `${existing}${sep}\n# SovereignMind Preflight\n${missing.join('\n')}\n`);
    }

    refreshAvailable();
    views.refresh();
    const script = path.join(destDir, 'prepush.sh');
    if (fs.existsSync(script)) { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(script)); }
    vscode.window.showInformationMessage(
        `Vorlage angelegt: ${created.join(', ') || 'nichts Neues'}${skipped.length ? ` (vorhanden, übersprungen: ${skipped.join(', ')})` : ''}. ` +
        'Passe scripts/prepush.sh an die Schritte des Repos an.');
}

async function clearToken(): Promise<void> {
    await secrets.delete(TOKEN_KEY);
    views.refresh();
    vscode.window.showInformationMessage('Sonar-Token aus VS Code entfernt.');
}

function cfg() { return vscode.workspace.getConfiguration('sovereignmind'); }

const LEGACY_SCRIPT = 'scripts/prepush.sh';

/** Workspace-Ordner mit Skript der Art: konfigurierter Pfad (Preflight zusätzlich scripts/prepush.sh für andere Repos). */
function findRepos(kind: RunKind = 'preflight'): Repo[] {
    const rel = kind === 'installer'
        ? cfg().get<string>('installer.scriptPath', 'Support/scripts/create_installer/create-installer.sh')
        : cfg().get<string>('preflight.scriptPath', 'Support/scripts/pre-push.sh');
    const candidates = kind === 'installer' ? [rel] : [rel, LEGACY_SCRIPT];
    return (vscode.workspace.workspaceFolders ?? []).flatMap(folder => {
        const script = candidates
            .map(r => path.join(folder.uri.fsPath, r))
            .find(f => fs.existsSync(f));
        return script ? [{ folder, script }] : [];
    });
}

async function pickRepo(kind: RunKind): Promise<Repo | undefined> {
    const repos = findRepos(kind);
    if (repos.length <= 1) { return repos[0]; }
    const pick = await vscode.window.showQuickPick(
        repos.map(r => ({ label: r.folder.name, repo: r })),
        { placeHolder: kind === 'installer' ? 'Repo für Installer wählen' : 'Repo für Preflight wählen' });
    return pick?.repo;
}

const KIND_TEXT: Record<RunKind, string> = { preflight: 'Preflight', installer: 'Installer' };

/** Beendet das Script samt Kindprozessen (Windows: taskkill, sonst Prozessgruppe). */
function killTree(proc: ChildProcess): void {
    if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']); } catch { proc.kill(); }
        return;
    }
    try { process.kill(-proc.pid!, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
}

function git(cwd: string, ...args: string[]): string {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); } catch { return ''; }
}

function allSecrets(root: string, script: string, sonarToken: string): string[] {
    return [...loadSecrets(path.dirname(script)), ...loadSecrets(path.join(root, '.git', 'prepush-tools'), 'sonar.env'),
        ...loadSecretsDeep(path.join(root, 'Support')), ...(sonarToken ? [sonarToken] : [])];
}

function busyHint(): boolean {
    if (!running) { return false; }
    vscode.window.showWarningMessage(
        `Es läuft bereits ein ${KIND_TEXT[running.kind]}-Lauf (CPU, Docker und Platz werden geteilt). Erst stoppen oder abwarten.`);
    return true;
}

async function run(): Promise<void> {
    if (running) {
        if (running.kind === 'preflight') { running.cancelled = true; killTree(running.proc); } else { busyHint(); }
        return;
    }
    const repo = await pickRepo('preflight');
    if (!repo) {
        vscode.window.showWarningMessage('Kein Preflight-Skript (Support/scripts/pre-push.sh oder scripts/prepush.sh) im Workspace gefunden.');
        return;
    }
    const root = repo.folder.uri.fsPath;
    const sonar = await sonarEnv();
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        PREPUSH_ALL: '1', PREPUSH_MARKERS: '1',
        SONAR: cfg().get<boolean>('preflight.sonar', true) ? '1' : '0',
        SONAR_GATE: cfg().get<boolean>('preflight.sonarGate', true) ? '1' : '0'
    };
    if (sonar.url) { env.SONAR_HOST_URL = sonar.url; }
    if (sonar.token) { env.SONAR_TOKEN = sonar.token; }
    startRun('preflight', repo, [], env, allSecrets(root, repo.script, sonar.token));
}

/** Startet ein Skript, schreibt Log und JSON und meldet das Ende. Nur ein Lauf gleichzeitig. */
function startRun(kind: RunKind, repo: Repo, args: string[], env: NodeJS.ProcessEnv, secretValues: string[],
    params?: Record<string, unknown>, onDone?: (result: RunResult) => Record<string, unknown> | void): void {
    lastRepo[kind] = repo;
    const root = repo.folder.uri.fsPath;
    const logger = new RunLogger(root, path.relative(root, repo.script), secretValues, kind, params);
    liveLogger[kind] = logger;
    logger.onUpdate = () => views.refreshLive(kind);

    output.clear();
    output.show(true);
    views.refresh();

    // Relativer Pfad mit '/': Git Bash muss so keine Backslashes und Leerzeichen des Windows-Pfads auflösen.
    const rel = path.relative(root, repo.script).split(path.sep).join('/');
    if (args.length) {
        const head = `Lauf: ${rel} ${args.join(' ')}`;
        logger.addLine(head);
        output.appendLine(logger.mask(head));
    }
    const proc = spawn(resolveShell(), [rel, ...args], { cwd: root, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const self = { proc, cancelled: false, kind, params };
    running = self;
    void vscode.commands.executeCommand('setContext', 'sovereignmind.running', true);
    optionsView.setLocked(true);

    let buf = '';
    const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const line of parts) { logger.addLine(line); output.appendLine(logger.mask(line)); }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);

    const done = (result: RunResult, code: number | null) => {
        if (running !== self) { return; }
        running = undefined;
        liveLogger[kind] = undefined;
        void vscode.commands.executeCommand('setContext', 'sovereignmind.running', false);
        optionsView.setLocked(false);
        if (buf) { logger.addLine(buf); output.appendLine(logger.mask(buf)); buf = ''; }
        const extra = onDone?.(result);
        logger.finish(result, code, git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), git(root, 'rev-parse', '--short', 'HEAD'),
            { params, ...(extra ?? {}) });
        views.refresh();
        const name = KIND_TEXT[kind];
        if (result === 'failed') {
            vscode.window.showErrorMessage(`${name} fehlgeschlagen.`, 'Log öffnen', 'Für KI kopieren').then(a => {
                if (a === 'Log öffnen') { void openLog(kind); }
                if (a === 'Für KI kopieren') { void copyForAI(kind); }
            });
        } else if (result === 'success') {
            if (kind === 'installer' && !params?.dryRun) {
                vscode.window.showInformationMessage('Installer erfolgreich erstellt.', 'Ordner öffnen').then(a => {
                    if (a) { void openInstallerFolder(); }
                });
            } else {
                vscode.window.showInformationMessage(`${name} erfolgreich${params?.dryRun ? ' (Trockenlauf)' : ''}.`);
            }
        }
    };
    proc.on('error', e => { logger.addLine(`Start fehlgeschlagen: ${e.message}`); done('failed', null); });
    proc.on('close', code => done(self.cancelled ? 'cancelled' : code === 0 ? 'success' : 'failed', code));
}

// ---------------------------------------------------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------------------------------------------------

const LEGACY_CHOICE_KEY = 'sovereignmind.installer.lastChoice';

/** `--check` je Ziel: Gründe für nicht nutzbare Ziele (leerer Text = nutzbar). Blockiert den Extension Host nicht (unter WSL dauert die Prüfung Sekunden). */
function checkTargetsAsync(repo: Repo, mode: string): Promise<Record<string, string>> {
    const root = repo.folder.uri.fsPath;
    return new Promise(resolve => {
        execFile(resolveShell(), [path.relative(root, repo.script).split(path.sep).join('/'), '--check', '--mode', mode],
            { cwd: root, encoding: 'utf8', timeout: 120000 },
            (_err, stdout) => resolve(parseCheck(`${stdout ?? ''}`)));   // Exit 1 bei Lücken ist normal
    });
}

function parseCheck(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    let cur = '';
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^check (\w+): (ok|fehlt)/);
        if (m) { cur = m[1]; out[cur] = m[2] === 'ok' ? '' : 'fehlt'; continue; }
        const r = line.match(/^\s+- (.*)$/);
        if (r && cur && out[cur] !== undefined) { out[cur] = out[cur] === 'fehlt' ? r[1] : `${out[cur]}, ${r[1]}`; }
    }
    return out;
}

let platformStatus: Record<string, string> | undefined;
let platformLoading = false;

/** Lädt `--check` einmal beim Aktivieren und bei „Aktualisieren“; bis dahin zeigt der Baum „prüfe …“. */
async function loadPlatformStatus(): Promise<void> {
    const repo = findRepos('installer')[0];
    if (!repo || platformLoading) { return; }
    platformLoading = true;
    platformStatus = undefined;
    views.refresh();
    try { platformStatus = await checkTargetsAsync(repo, 'full'); } finally { platformLoading = false; }
    views.refresh();
}

const MIN_FREE_GB = { full: ['minFreeGbFull', 60], minimal: ['minFreeGbMinimal', 25] } as const;

/** Wahr, wenn gestartet werden darf. Schlägt die Abfrage fehl, wird ohne Meldung gestartet. */
async function enoughSpace(root: string, variant: 'full' | 'minimal'): Promise<boolean> {
    const [key, def] = MIN_FREE_GB[variant];
    const needGb = cfg().get<number>(`installer.${key}`, def);
    let freeGb: number;
    try {
        const dist = path.join(root, 'dist');
        const dir = fs.existsSync(dist) ? dist : root;
        const s = fs.statfsSync(dir);
        freeGb = Number(s.bavail) * Number(s.bsize) / 1024 ** 3;
    } catch { return true; }
    if (freeGb >= needGb) { return true; }
    const a = await vscode.window.showWarningMessage(
        `Nur ${freeGb.toFixed(0)} GB frei, ${needGb} GB empfohlen.`, 'Trotzdem starten', 'Abbrechen');
    return a === 'Trotzdem starten';
}

/** Play in der Plattformliste: fester Lauf `--mode full --yes`, ohne Rückfragen. */
async function playInstaller(item?: { target?: string; variant?: string }): Promise<void> {
    const { target, variant } = item ?? {};
    if (!target || (variant !== 'full' && variant !== 'minimal')) { return; }
    if (busyHint()) { return; }
    const repo = await pickRepo('installer');
    if (!repo) {
        vscode.window.showWarningMessage('Kein Installer-Skript (Support/scripts/create_installer/create-installer.sh) im Workspace gefunden.');
        return;
    }
    const dryRun = cfg().get<boolean>('installer.dryRun', false);
    const root = repo.folder.uri.fsPath;
    // Gespeicherte Werte gelten auch, wenn die Optionen-Ansicht nie geöffnet wurde.
    const opts = loadOptions(state);
    const optError = optionsError(opts);
    if (optError) {
        vscode.window.showWarningMessage(optError);
        optionsView.focus();
        return;
    }
    if (!dryRun && !(await enoughSpace(root, variant))) { return; }
    if (busyHint()) { return; }   // während des Dialogs kann ein anderer Lauf gestartet sein

    const args = ['--yes', '--target', target, '--mode', 'full', '--variant', variant, ...buildOptionArgs(opts)];
    if (dryRun) { args.push('--dry-run'); }
    const sonar = await sonarEnv();
    const startedMs = Date.now();
    startRun('installer', repo, args, { ...process.env, PREPUSH_MARKERS: '1' }, allSecrets(root, repo.script, sonar.token),
        { target, variant, mode: 'full', version: opts.versionOn ? opts.version : undefined,
            fetch: opts.fetch, keepStaging: opts.keepStaging, dryRun },
        () => {
            if (dryRun) { return; }
            try {
                const j = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'installer', 'last-build.json'), 'utf8'));
                if (new Date(j.startedAt).getTime() >= startedMs - 60000) { return { artifacts: j }; }
            } catch { /* kein Ergebnis */ }
        });
}

function stopInstaller(): void {
    if (running?.kind === 'installer') { running.cancelled = true; killTree(running.proc); }
}

function installerRoot(): string | undefined {
    return (lastRepo.installer ?? findRepos('installer')[0])?.folder.uri.fsPath;
}

async function openInstallerFolder(): Promise<void> {
    const root = installerRoot();
    const dir = root && path.join(root, 'dist', 'installer');
    if (!dir || !fs.existsSync(dir)) { vscode.window.showInformationMessage('Noch kein Installer-Ordner vorhanden.'); return; }
    await vscode.env.openExternal(vscode.Uri.file(dir));
}

function dirSize(dir: string): number {
    let total = 0;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        try { total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } catch { /* verschwunden */ }
    }
    return total;
}

async function cleanStaging(): Promise<void> {
    if (busyHint()) { return; }
    const root = installerRoot();
    const dir = root && path.join(root, 'dist', 'staging');
    if (!dir || !fs.existsSync(dir)) { vscode.window.showInformationMessage('Kein Staging vorhanden.'); return; }
    const gb = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Staging-Größe wird ermittelt …' },
        async () => dirSize(dir) / 1024 ** 3);
    const ok = await vscode.window.showWarningMessage(`Staging (${gb.toFixed(1)} GB) unter dist/staging löschen? „Nur Paket“ braucht es danach neu.`,
        { modal: true }, 'Löschen');
    if (ok !== 'Löschen') { return; }
    await fs.promises.rm(dir, { recursive: true, force: true });
    vscode.window.showInformationMessage('Staging gelöscht.');
}

function logFile(kind: RunKind, name: string): string | undefined {
    const root = (lastRepo[kind] ?? findRepos(kind)[0])?.folder.uri.fsPath;
    if (root && kind === 'preflight') { migrateLegacyLayout(root); }
    return root ? path.join(runDir(root, kind), name) : undefined;
}

async function openLog(kind: RunKind = 'preflight'): Promise<void> {
    const p = logFile(kind, 'last-run.log');
    if (!p || !fs.existsSync(p)) { vscode.window.showInformationMessage(`Noch kein ${KIND_TEXT[kind]}-Log vorhanden.`); return; }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(p));
}

async function copyLogPath(kind: RunKind = 'preflight'): Promise<void> {
    const p = logFile(kind, 'last-run.log');
    if (p) { await vscode.env.clipboard.writeText(p); vscode.window.showInformationMessage('Log-Pfad kopiert.'); }
}

async function copyForAI(kind: RunKind = 'preflight'): Promise<void> {
    const text = kind === 'installer'
        ? 'Der Installer-Build (Support/scripts/create_installer/create-installer.sh) ist fehlgeschlagen. Analysiere .prepush/installer/last-run.json und bei Bedarf den Bereich logRange in .prepush/installer/last-run.log und behebe die Ursache.'
        : 'Der Preflight-Check (Support/scripts/pre-push.sh) ist fehlgeschlagen. Analysiere .prepush/preflight/last-run.json und bei Bedarf den Bereich logRange in .prepush/preflight/last-run.log und behebe die Ursache.';
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage('Anweisung für KI kopiert.');
}

export function activate(context: vscode.ExtensionContext): void {
    secrets = context.secrets;
    extPath = context.extensionPath;
    state = context.workspaceState;
    output = vscode.window.createOutputChannel('SovereignMind Preflight');
    optionsView = new OptionsViewProvider(state);
    void state.update(LEGACY_CHOICE_KEY, undefined);   // Rest der früheren QuickPick-Auswahl
    views = new PrepushViews({
        platformStatus: () => platformStatus,
        runningVariant: () => running?.kind === 'installer' && typeof running.params?.target === 'string'
            ? { target: running.params.target, variant: String(running.params.variant) } : undefined,
        repoRoot: kind => (lastRepo[kind] ?? findRepos(kind)[0])?.folder.uri.fsPath,
        live: kind => liveLogger[kind]?.snapshot(),
        sonar: async () => {
            const s = await sonarEnv();
            const repo = lastRepo.preflight ?? findRepos()[0];
            const envHas = !!repo && (loadSecrets(path.dirname(repo.script)).length > 0 ||
                loadSecrets(path.join(repo.folder.uri.fsPath, '.git', 'prepush-tools'), 'sonar.env').length > 0);
            return {
                url: s.url, tokenSource: s.token ? 'sidebar' : envHas ? 'env' : 'none',
                enabled: cfg().get<boolean>('preflight.sonar', true), gateHard: cfg().get<boolean>('preflight.sonarGate', true)
            };
        }
    }, context);
    refreshAvailable = () => {
        void vscode.commands.executeCommand('setContext', 'sovereignmind.available', findRepos().length > 0);
        void vscode.commands.executeCommand('setContext', 'sovereignmind.installer.available', findRepos('installer').length > 0);
    };
    const refresh = refreshAvailable;
    refresh();
    void migrateLegacySettings();
    void loadPlatformStatus();
    const watcher = vscode.workspace.createFileSystemWatcher('**/{pre-push,prepush,create-installer}.sh');
    watcher.onDidCreate(() => { refresh(); views.refresh(); });
    watcher.onDidDelete(() => { refresh(); views.refresh(); });
    context.subscriptions.push(
        output, watcher,
        vscode.window.registerWebviewViewProvider(OptionsViewProvider.viewType, optionsView),
        vscode.workspace.onDidChangeWorkspaceFolders(refresh),
        vscode.commands.registerCommand('sovereignmind.initTemplate', initTemplate),
        vscode.commands.registerCommand('sovereignmind.configureSonar', configureSonar),
        vscode.commands.registerCommand('sovereignmind.clearToken', clearToken),
        vscode.commands.registerCommand('sovereignmind.toggleSonar', () => toggleSetting('preflight.sonar')),
        vscode.commands.registerCommand('sovereignmind.toggleSonarGate', () => toggleSetting('preflight.sonarGate')),
        vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('sovereignmind')) { views.refresh(); } }),
        vscode.commands.registerCommand('sovereignmind.openLogAt', openLogAt),
        vscode.commands.registerCommand('sovereignmind.openJson', openJsonForLog),
        vscode.commands.registerCommand('sovereignmind.refresh', () => views.refresh()),
        vscode.commands.registerCommand('sovereignmind.run', run),
        vscode.commands.registerCommand('sovereignmind.openLog', () => openLog('preflight')),
        vscode.commands.registerCommand('sovereignmind.copyLogPath', () => copyLogPath('preflight')),
        vscode.commands.registerCommand('sovereignmind.copyForAI', () => copyForAI('preflight')),
        vscode.commands.registerCommand('sovereignmind.installer.focus', () => vscode.commands.executeCommand('sovereignmind.installer.platforms.focus')),
        vscode.commands.registerCommand('sovereignmind.installer.play', playInstaller),
        vscode.commands.registerCommand('sovereignmind.installer.stop', stopInstaller),
        vscode.commands.registerCommand('sovereignmind.installer.recheck', loadPlatformStatus),
        vscode.commands.registerCommand('sovereignmind.installer.openLog', () => openLog('installer')),
        vscode.commands.registerCommand('sovereignmind.installer.copyLogPath', () => copyLogPath('installer')),
        vscode.commands.registerCommand('sovereignmind.installer.copyForAI', () => copyForAI('installer')),
        vscode.commands.registerCommand('sovereignmind.installer.openFolder', openInstallerFolder),
        vscode.commands.registerCommand('sovereignmind.installer.cleanStaging', cleanStaging),
        vscode.commands.registerCommand('sovereignmind.installer.copyPath', async (item: vscode.TreeItem) => {
            const p = artifactPath(item);
            if (p) { await vscode.env.clipboard.writeText(p); vscode.window.showInformationMessage('Pfad kopiert.'); }
        }),
        vscode.commands.registerCommand('sovereignmind.installer.copySha', async (item: vscode.TreeItem) => {
            const h = artifactSha(item);
            if (h) { await vscode.env.clipboard.writeText(h); vscode.window.showInformationMessage('SHA-256 kopiert.'); }
        }),
        vscode.commands.registerCommand('sovereignmind.installer.reveal', (item: vscode.TreeItem) => {
            const p = artifactPath(item);
            if (p) { void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p)); }
        })
    );
}

export function deactivate(): void {
    if (running) { killTree(running.proc); }
}
