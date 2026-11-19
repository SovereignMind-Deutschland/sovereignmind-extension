// Baut die Extension mit Copyright-Banner (docs/pläne/code-schutz-ki im Repo sovereignmind, Phase 2).
// Der Text liegt im Support-Repo: ../support/legal/ausgabe-hinweis.txt (Nachbar unter repos/, oder SM_HINWEIS_DATEI).
// `/*!` bleibt auch beim Minify erhalten (minify: true, code-schutz-ki Phase 3). Aufruf: node scripts/banner.mjs [--watch]
// Phase 4: nach dem esbuild-Lauf läuft javascript-obfuscator über dist/extension.js (nur eigene Datei, kein --watch-Lauf,
// siehe obfuskieren() unten). stringArray bleibt aus: esbuild (minify:true) entfernt gewöhnliche Kommentare, daher
// lassen sich einzelne Hotpaths im Quelltext nicht mit javascript-obfuscator:disable/:enable markieren - global aus
// ist die robuste Wahl statt eines Markers, der im gebündelten Code gar nicht mehr ankommt.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";
import JavaScriptObfuscator from "javascript-obfuscator";

const hier = dirname(fileURLToPath(import.meta.url));
const textDatei = process.env.SM_HINWEIS_DATEI ?? resolve(hier, "../../support/legal/ausgabe-hinweis.txt");
let text;
try {
  text = readFileSync(textDatei, "utf8").trim();
} catch {
  console.error(`Hinweistext fehlt: ${textDatei}\nRepo support daneben auschecken (repos/support) oder SM_HINWEIS_DATEI setzen.`);
  process.exit(1);
}
if (!text || text.includes("*/")) { console.error(`Ungültiger Hinweistext in ${textDatei}`); process.exit(1); }

const optionen = {
  entryPoints: ["src/extension.ts"], bundle: true, platform: "node", external: ["vscode"],
  outfile: "dist/extension.js", banner: { js: `/*! ${text} */` },
  // Phase 3: minifiziert, ohne Source Map; `/*!`- und Lizenzkommentare bleiben stehen.
  minify: true, legalComments: "inline", sourcemap: false,
};

// Phase 4: javascript-obfuscator über das esbuild-Ergebnis. Läuft nur im --build-Lauf (nicht im --watch, dort
// würde jede Speicherung erneut obfuskieren - unnötig langsam beim Entwickeln).
function obfuskieren() {
  const datei = resolve(hier, "../dist/extension.js");
  const inhalt = readFileSync(datei, "utf8");
  const bannerEnde = inhalt.indexOf("*/") + 2;
  const banner = inhalt.slice(0, bannerEnde);
  const code = inhalt.slice(bannerEnde).replace(/^\n/, "");
  const ergebnis = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    sourceMap: false,
    // Ausdrücklich NICHT: selfDefending (Vorgabe code-schutz-ki Phase 4) und debugProtection/disableConsoleOutput
    // (Support muss die Ausgabe weiter lesen und debuggen können).
    selfDefending: false,
    debugProtection: false,
    disableConsoleOutput: false,
    // renameProperties bleibt aus: der CommonJS-Export (Object.defineProperty mit den Schlüsseln "activate" und
    // "deactivate") wird sonst unbrauchbar - VS Code sucht diese Namen beim Laden der Extension.
    renameProperties: false,
    identifierNamesGenerator: "hexadecimal",
    controlFlowFlattening: false, // kein messbarer Nutzen hier, nur Laufzeit-Overhead in einer kleinen Extension
    deadCodeInjection: false, // bläht die Bundle-Datei nur auf
    // stringArray mit einfacher Kodierung (kein RC4/Self-Defending-Unterbau): die einzige Hotpath-Funktion
    // (stdout/stderr-Zeilenpuffer) hat praktisch keine String-Literale, der Overhead ist vernachlässigbar.
    stringArray: true,
    stringArrayEncoding: ["base64"],
    stringArrayThreshold: 0.75,
    stringArrayWrappersCount: 1,
    stringArrayWrappersType: "variable",
    rotateStringArray: true,
  });
  writeFileSync(datei, banner + "\n" + ergebnis.getObfuscatedCode());
}
if (process.argv.includes("--watch")) { await (await context(optionen)).watch(); } else { await build(optionen); obfuskieren(); }
