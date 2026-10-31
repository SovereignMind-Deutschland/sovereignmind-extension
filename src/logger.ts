import * as fs from 'fs';
import * as path from 'path';

const HISTORY_LIMIT = 20;
/** Logobergrenze: Kopf und Ende bleiben, die Mitte entfällt (Installer-Läufe dauern Stunden). */
const LOG_LIMIT_BYTES = 50 * 1024 * 1024;
const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|KEY)/i;

export type RunKind = 'preflight' | 'installer';

export interface StepResult {
    name: string;
    status: 'ok' | 'failed' | 'running';
    durationSec?: number;
    logRange?: { fromLine: number; toLine: number };
    errorExcerpt?: string;
}

export interface RunSnapshot {
    result: RunResult | 'running';
    steps: StepResult[];
    link?: string;
    logPath: string;
    startedAt?: string;
    durationSec?: number;
    branch?: string;
    params?: Record<string, unknown>;
}

export type RunResult = 'success' | 'failed' | 'cancelled' | 'unknown';

/** Liest Secret-Werte aus einer .env-Datei, damit sie vor dem Schreiben maskiert werden. */
export function loadSecrets(scriptDir: string, file = '.env'): string[] {
    try {
        return fs.readFileSync(path.join(scriptDir, file), 'utf8')
            .split('\n')
            .map(l => l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/))
            .filter((m): m is RegExpMatchArray => !!m && SECRET_KEY.test(m[1]))
            .map(m => m[2].trim().replace(/^["']|["']$/g, ''))
            .filter(v => v.length >= 4);
    } catch {
        return [];
    }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'bin', 'obj', '.next']);

/** Secrets aus allen *.env-Dateien (z. B. ionos.env, .env) unter `dir`, begrenzt in der Tiefe. */
export function loadSecretsDeep(dir: string, depth = 5): string[] {
    const out: string[] = [];
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.isDirectory()) {
            if (depth > 0 && !SKIP_DIRS.has(e.name)) { out.push(...loadSecretsDeep(path.join(dir, e.name), depth - 1)); }
        } else if (e.name === '.env' || e.name.endsWith('.env') || e.name.startsWith('.env.')) {
            out.push(...loadSecrets(dir, e.name));
        }
    }
    return out;
}

/** Ordner `.prepush/<art>` im Repo. */
export function runDir(repoRoot: string, kind: RunKind): string {
    return path.join(repoRoot, '.prepush', kind);
}

/** Verschiebt den alten Preflight-Pfad `.prepush/last-run.*` und `history/` einmalig nach `.prepush/preflight/`. */
export function migrateLegacyLayout(repoRoot: string): void {
    const base = path.join(repoRoot, '.prepush');
    const dest = runDir(repoRoot, 'preflight');
    try {
        const legacy = ['last-run.log', 'last-run.json', 'history'].filter(n => fs.existsSync(path.join(base, n)));
        if (!legacy.length) { return; }
        fs.mkdirSync(dest, { recursive: true });
        for (const n of legacy) {
            const target = path.join(dest, n);
            if (!fs.existsSync(target)) { fs.renameSync(path.join(base, n), target); }
        }
    } catch { /* Migration ist optional */ }
}

export interface FinishExtra {
    params?: Record<string, unknown>;
    artifacts?: unknown;
}

export class RunLogger {
    /** Kopf des Logs, solange das Limit nicht erreicht ist. */
    private head: string[] = [];
    private headBytes = 0;
    /** Ende des Logs, sobald der Kopf voll ist (älteste Zeilen fallen heraus). */
    private tail: string[] = [];
    private tailBytes = 0;
    private dropped = 0;
    private total = 0;
    private recent: string[] = [];
    private steps: StepResult[] = [];
    private stepStart = new Map<string, { at: number; line: number }>();
    private link: string | undefined;
    private readonly startedAt = new Date();
    private readonly dir: string;

    constructor(private repoRoot: string, private script: string, private secrets: string[], private kind: RunKind = 'preflight',
        private params?: Record<string, unknown>) {
        migrateLegacyLayout(repoRoot);
        this.dir = runDir(repoRoot, kind);
        fs.mkdirSync(path.join(this.dir, 'history'), { recursive: true });
    }

    mask(text: string): string {
        let out = text;
        for (const s of this.secrets) { out = out.split(s).join('***'); }
        return out
            .replace(/(sonar\.token[=:]\s*)\S+/gi, '$1***')
            .replace(/(Authorization:\s*)\S.*/gi, '$1***');
    }

    /** Eine Ausgabezeile aufnehmen (Zeitstempel, Maskierung, Schritt-Marker). */
    addLine(raw: string): void {
        const line = this.mask(raw.replace(/\r$/, ''));
        const n = this.push(`${new Date().toISOString()} ${line}`);
        const m = line.match(/^##prepush\[(step:start|step:ok|step:fail|link)\]\s*(.*)$/);
        if (!m) { return; }
        this.applyMarker(m[1], m[2], n);
        this.onUpdate?.();
    }

    /** Hängt eine Zeile an; liefert die laufende Zeilennummer (1-basiert, vor Kürzung). */
    private push(entry: string): number {
        const size = Buffer.byteLength(entry) + 1;
        this.total++;
        this.recent.push(entry);
        if (this.recent.length > 60) { this.recent.shift(); }
        const half = LOG_LIMIT_BYTES / 2;
        if (this.tail.length === 0 && this.headBytes + size <= half) {
            this.head.push(entry);
            this.headBytes += size;
            return this.total;
        }
        this.tail.push(entry);
        this.tailBytes += size;
        while (this.tailBytes > half && this.tail.length > 1) {
            const old = this.tail.shift()!;
            this.tailBytes -= Buffer.byteLength(old) + 1;
            this.dropped++;
        }
        return this.total;
    }

    /** Zeilennummer im Lauf -> Zeilennummer in der geschriebenen Datei (mit Kürzungshinweis). */
    private fileLine(n: number): number {
        if (this.dropped === 0) { return n; }
        const h = this.head.length;
        if (n <= h) { return n; }
        if (n <= h + this.dropped) { return h + 1; }
        return n - this.dropped + 1;
    }

    private applyMarker(kind: string, arg: string, n: number): void {
        if (kind === 'link') { this.link = arg.trim(); return; }
        const name = arg.trim();
        if (kind === 'step:start') {
            this.stepStart.set(name, { at: Date.now(), line: n });
            this.steps.push({ name, status: 'running' });
            return;
        }
        const step = this.steps.find(s => s.name === name && s.status === 'running');
        const start = this.stepStart.get(name);
        if (!step || !start) { return; }
        step.status = kind === 'step:ok' ? 'ok' : 'failed';
        step.durationSec = Math.round((Date.now() - start.at) / 1000);
        step.logRange = { fromLine: start.line, toLine: n };
        if (step.status === 'failed') {
            const count = Math.min(40, n - start.line - 1);
            step.errorExcerpt = count > 0 ? this.recent.slice(-1 - count, -1).join('\n') : '';
        }
    }

    onUpdate?: () => void;

    snapshot(): RunSnapshot {
        return { result: 'running', steps: this.steps.map(s => ({ ...s })), link: this.link, logPath: this.logPath, params: this.params };
    }

    get logPath(): string { return path.join(this.dir, 'last-run.log'); }
    get jsonPath(): string { return path.join(this.dir, 'last-run.json'); }

    finish(result: RunResult, exitCode: number | null, branch: string, commit: string, extra: FinishExtra = {}): void {
        const failedStep = this.steps.find(s => s.status === 'failed')?.name;
        const steps = this.steps.map(s => s.logRange
            ? { ...s, logRange: { fromLine: this.fileLine(s.logRange.fromLine), toLine: this.fileLine(s.logRange.toLine) } }
            : s);
        const summary = {
            kind: this.kind,
            startedAt: this.startedAt.toISOString(),
            durationSec: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
            repo: path.basename(this.repoRoot),
            branch, commit,
            script: this.script,
            result, exitCode, failedStep,
            params: extra.params ?? this.params,
            artifacts: extra.artifacts,
            truncatedLines: this.dropped || undefined,
            steps,
            link: this.link,
            env: { os: process.platform }
        };
        const body = this.dropped > 0
            ? [...this.head, `... ${this.dropped} Zeilen aus der Mitte entfallen (Loggrenze ${LOG_LIMIT_BYTES / 1024 / 1024} MB) ...`, ...this.tail]
            : this.head.concat(this.tail);
        const log = body.join('\n') + '\n';
        const json = JSON.stringify(summary, null, 2);
        fs.writeFileSync(this.logPath, log);
        fs.writeFileSync(this.jsonPath, json);
        const stamp = this.startedAt.toISOString().replace(/[:.]/g, '-');
        const base = path.join(this.dir, 'history', `${stamp}_${branch.replace(/[^\w.-]/g, '-')}`);
        fs.writeFileSync(`${base}.log`, log);
        fs.writeFileSync(`${base}.json`, json);
        this.rotate();
    }

    private rotate(): void {
        const hist = path.join(this.dir, 'history');
        const runs = fs.readdirSync(hist).filter(f => f.endsWith('.json')).sort();
        for (const f of runs.slice(0, Math.max(0, runs.length - HISTORY_LIMIT))) {
            for (const ext of ['.json', '.log']) {
                fs.rmSync(path.join(hist, f.replace(/\.json$/, ext)), { force: true });
            }
        }
    }
}
