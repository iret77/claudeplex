/**
 * Tiny i18n layer for the dashboard. Locale is resolved once at startup
 * (CD_LANG env > persisted config > $LANG auto-detect), can be flipped live
 * with the L key, and is persisted to ~/.config/claude-dashboard/config.json.
 *
 * Translatable text lives in the catalogs below; the render code keeps all
 * ANSI/formatting and only swaps the words via t(). German is the source
 * locale (values verbatim from the original hardcode); English mirrors it.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export type Locale = "de" | "en";

const CONFIG_DIR = join(homedir(), ".config", "claude-dashboard");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

let current: Locale = "de";

/** Map an environment locale string (de_DE.UTF-8, en-US, …) to a supported locale. */
function fromEnv(v: string | undefined): Locale | null {
  if (!v) return null;
  if (/^de/i.test(v)) return "de";
  if (/^en/i.test(v)) return "en";
  return null;
}

/**
 * Auto-detect from the shell locale. en_* → English, de_* → German; an
 * unspecified/POSIX locale (C, C.UTF-8, empty) falls back to German, the app's
 * native catalog. Override anytime with CD_LANG or the live L toggle.
 */
export function detectLocale(): Locale {
  return (
    fromEnv(process.env.CD_LANG) ??
    fromEnv(process.env.LC_ALL) ??
    fromEnv(process.env.LC_MESSAGES) ??
    fromEnv(process.env.LANG) ??
    "de"
  );
}

interface Config { lang?: Locale; [k: string]: unknown; }

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
  } catch {
    return {};
  }
}

/**
 * Resolve the active locale at startup. Precedence: explicit CD_LANG env
 * (always wins, non-persisted override) > persisted config > $LANG detect.
 */
export function loadLocale(): Locale {
  const envForced = fromEnv(process.env.CD_LANG);
  if (envForced) return (current = envForced);
  const saved = readConfig().lang;
  current = saved === "de" || saved === "en" ? saved : detectLocale();
  return current;
}

export function getLocale(): Locale {
  return current;
}

/** Set + persist the locale (best-effort write; rendering never blocks on it). */
export function setLocale(l: Locale): void {
  current = l;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const cfg = readConfig();
    cfg.lang = l;
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
  } catch {
    /* read-only home / no permissions — keep the in-memory choice */
  }
}

/** Flip DE ↔ EN and persist; returns the new locale. */
export function toggleLocale(): Locale {
  setLocale(current === "de" ? "en" : "de");
  return current;
}

type Catalog = Record<string, string>;

const de: Catalog = {
  // states (also used as inline tags)
  "state.aktiv": "aktiv",
  "state.monitor": "monitor",
  "state.wartet": "wartet",
  "state.stale": "stale",
  // empty / placeholder
  untitled: "(ohne Titel)",
  noSessions: "keine Sessions",
  noSession: "keine Session",
  none: "keine",
  noRealSessions: "keine echten Sessions auf dieser Instanz",
  noSessionGenerating: "keine Session generiert gerade",
  noSessionWaiting: "keine Session wartet gerade auf Input",
  noAgentsWaiting: "keine Agents und keine wartenden Sessions.",
  noSuggestions: "keine Vorschläge",
  noInstances: "keine Instanzen",
  noFolderHistory: "keine Ordner-Historie",
  emptyFolders: "Feld leeren zeigt alle Ordner",
  // nouns / labels
  folder: "Ordner",
  folders: "Ordner",
  instance: "Instanz",
  instances: "Instanzen",
  running: "laufend",
  active: "aktiv",
  recent: "zuletzt",
  further: "weitere",
  more: "mehr",
  working: "working",
  sessionsLive: "Sessions live",
  tok: "tok",
  cards: "Karten",
  openQuestions: "Offene Fragen",
  uses: "Nutzungen",
  last: "zuletzt",
  fromHistory: "aus History",
  open: "offen",
  // folder validity
  folderExists: "Ordner existiert",
  folderMissing: "Ordner existiert nicht",
  existsShort: "existiert nicht",
  // column headers
  colTitle: "TITEL",
  colPath: "PFAD",
  colLast: "LETZTE NACHRICHT",
  // verbs / hint words
  select: "wählen",
  openVerb: "öffnen",
  rename: "umbenennen",
  close: "schließen",
  back: "zurück",
  quit: "beenden",
  area: "Bereich",
  mode: "Modus",
  send: "senden",
  start: "starten",
  here: "hier",
  all: "alle",
  new: "neu",
  switch: "wechseln",
  switches: "wechselt",
  type: "Tippen",
  filter: "filtern",
  takeover: "übernehmen",
  override: "override",
  adoptShort: "übern.",
  scroll: "scrollen",
  pagewise: "seitenweise",
  save: "speichern",
  cancel: "abbrechen",
  input: "Eingabe",
  list: "Liste",
  question: "Frage",
  sessions: "Sessions",
  // phrases
  answerCockpit: "antworten → Cockpit",
  closeSession: "Session schließen",
  startAgent: "Agent starten",
  startAll: "alle starten",
  pasteImage: "Bild einfügen",
  downQuestions: "↓ Fragen",
  adoptSend: "übernehmen & senden",
  toInput: "→ Eingabe",
  toList: "→ Liste",
  agentStopped: "Agent beendet",
  waitingForInput: "wartet auf Eingabe",
  renameLabel: "Umbenennen:",
  saveCancel: "⏎ speichern · Esc abbrechen",
  closeConfirm: "schließen? [x] bestätigen · andere Taste = abbrechen",
  transcriptLast: "Transcript (letzte 200 Zeilen)",
  startHere: "hier starten",
  modeFolderToInstance: "Ordner → Instanz",
  modeInstanceToFolder: "Instanz → Ordner",
  usedThisFolder: "✓ = hatte den Ordner",
  newAgent: "Neuer Agent",
  closeShort: "zu",
  recentFirst: "zuletzt benutzt zuerst · Tippen filtert Unterordner",
  typePath: "Pfad tippen, Tab vervollständigt",
  intakeAdopt: "Session übernehmen → Cockpit",
  instanceStatusline: "Instanz (Statusline)",
  statuslineLoading: "Statusline lädt … (↑/↓ wechselt Instanz)",
  waitingForYou: "WARTET AUF DICH",
  switchInstances1to3: "Tab / 1-3 wechseln",
  sessionsWaiting: "Sessions warten",
  statuslineNoOutput: "statusline: keine Ausgabe",
  workingFolder: "Working-Folder",
  // quick-issue flow
  issueTitle: "Quick Issue",
  issueRepoHdr: "REPO",
  issueRepoShort: "Repo",
  issueDescHdr: "WORUM GEHT ES?",
  issueDescShort: "Beschreibung",
  issueDescHint: "frei tippen — die Instanz schreibt ein sauberes englisches Issue",
  issuePickTag: "Repo + Beschreibung",
  issueDraftVerb: "entwerfen",
  issueDrafting: "Entwurf auf",
  issueCreating: "lege Issue via gh an …",
  issueWorking: "Moment …",
  issueRewriteHdr: "Rewrite — was soll sich ändern?",
  issueRedraft: "neu entwerfen",
  issueCreate: "anlegen",
  issueRewrite: "rewrite",
  issueCreated: "Issue angelegt",
  issueErr: "Issue konnte nicht angelegt werden",
  issueRetry: "erneut",
};

const en: Catalog = {
  "state.aktiv": "active",
  "state.monitor": "monitor",
  "state.wartet": "waiting",
  "state.stale": "stale",
  untitled: "(untitled)",
  noSessions: "no sessions",
  noSession: "no session",
  none: "none",
  noRealSessions: "no real sessions on this instance",
  noSessionGenerating: "no session is generating right now",
  noSessionWaiting: "no session is waiting for input right now",
  noAgentsWaiting: "no agents and no waiting sessions.",
  noSuggestions: "no suggestions",
  noInstances: "no instances",
  noFolderHistory: "no folder history",
  emptyFolders: "clear the field to show all folders",
  folder: "folder",
  folders: "folders",
  instance: "instance",
  instances: "instances",
  running: "running",
  active: "active",
  recent: "recent",
  further: "more",
  more: "more",
  working: "working",
  sessionsLive: "sessions live",
  tok: "tok",
  cards: "Cards",
  openQuestions: "Open Questions",
  uses: "uses",
  last: "last",
  fromHistory: "from history",
  open: "open",
  folderExists: "folder exists",
  folderMissing: "folder does not exist",
  existsShort: "does not exist",
  colTitle: "TITLE",
  colPath: "PATH",
  colLast: "LAST MESSAGE",
  select: "select",
  openVerb: "open",
  rename: "rename",
  close: "close",
  back: "back",
  quit: "quit",
  area: "area",
  mode: "mode",
  send: "send",
  start: "start",
  here: "here",
  all: "all",
  new: "new",
  switch: "switch",
  switches: "switches",
  type: "type",
  filter: "filter",
  takeover: "take over",
  override: "override",
  adoptShort: "adopt",
  scroll: "scroll",
  pagewise: "page",
  save: "save",
  cancel: "cancel",
  input: "input",
  list: "list",
  question: "question",
  sessions: "sessions",
  answerCockpit: "answer → cockpit",
  closeSession: "close session",
  startAgent: "start agent",
  startAll: "start all",
  pasteImage: "paste image",
  downQuestions: "↓ questions",
  adoptSend: "adopt & send",
  toInput: "→ input",
  toList: "→ list",
  agentStopped: "agent stopped",
  waitingForInput: "waiting for input",
  renameLabel: "Rename:",
  saveCancel: "⏎ save · Esc cancel",
  closeConfirm: "close? [x] confirm · any other key = cancel",
  transcriptLast: "transcript (last 200 lines)",
  startHere: "start here",
  modeFolderToInstance: "Folder → Instance",
  modeInstanceToFolder: "Instance → Folder",
  usedThisFolder: "✓ = used this folder",
  newAgent: "New Agent",
  closeShort: "esc",
  recentFirst: "most recent first · type filters subfolders",
  typePath: "type a path, Tab completes",
  intakeAdopt: "adopt session → cockpit",
  instanceStatusline: "instance (statusline)",
  statuslineLoading: "statusline loading … (↑/↓ switches instance)",
  waitingForYou: "WAITING FOR YOU",
  switchInstances1to3: "Tab / 1-3 switch",
  sessionsWaiting: "sessions waiting",
  statuslineNoOutput: "statusline: no output",
  workingFolder: "Working-Folder",
  // quick-issue flow
  issueTitle: "Quick Issue",
  issueRepoHdr: "REPO",
  issueRepoShort: "repo",
  issueDescHdr: "WHAT'S THE ISSUE ABOUT?",
  issueDescShort: "description",
  issueDescHint: "type freely — the instance writes a clean English issue",
  issuePickTag: "repo + description",
  issueDraftVerb: "draft",
  issueDrafting: "drafting on",
  issueCreating: "creating issue via gh …",
  issueWorking: "working …",
  issueRewriteHdr: "Rewrite — what should change?",
  issueRedraft: "redraft",
  issueCreate: "create",
  issueRewrite: "rewrite",
  issueCreated: "Issue created",
  issueErr: "Issue creation failed",
  issueRetry: "retry",
};

const catalogs: Record<Locale, Catalog> = { de, en };

/** Translate a key for the active locale (falls back to German, then the key). */
export function t(key: string): string {
  return catalogs[current][key] ?? de[key] ?? key;
}

/** Localized label for a session state value (aktiv/monitor/wartet/stale). */
export function stateLabel(state: string): string {
  return t(`state.${state}`);
}

/** BCP-47 tag for Intl/toLocale* formatting. */
export function localeTag(): string {
  return current === "de" ? "de-DE" : "en-US";
}
