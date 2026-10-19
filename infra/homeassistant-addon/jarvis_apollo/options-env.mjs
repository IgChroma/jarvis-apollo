// Traduce las opciones del add-on (/data/options.json, las escribe el Supervisor
// con lo que cargaste en la UI) a las variables de entorno que lee Apollo, las
// mismas que el .dev.vars de scripts/push-secrets.sh.
//
//   bun options-env.mjs /data/options.json      → líneas `export NOMBRE='valor'` por stdout
//
// run.sh hace `eval` de la salida. Por stderr solo salen NOMBRES, nunca valores.
// Sale con 1 si falta algo obligatorio.
import { existsSync, readFileSync } from 'node:fs';

const optionsPath = process.argv[2] ?? '/data/options.json';

// opción del add-on → variable de Apollo, tal cual (texto).
const TEXT_OPTIONS = {
  device_shared_secret: 'DEVICE_SHARED_SECRET',
  dashboard_shared_secret: 'DASHBOARD_SHARED_SECRET',
  openrouter_api_key: 'OPENROUTER_API_KEY',
  device_name: 'APOLLO_DEVICE_NAME',
  openrouter_model: 'OPENROUTER_MODEL',
  openrouter_stt_model: 'OPENROUTER_STT_MODEL',
  openrouter_embedding_model: 'OPENROUTER_EMBEDDING_MODEL',
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  claude_model_fast: 'CLAUDE_MODEL_FAST',
  claude_model_reasoning: 'CLAUDE_MODEL_REASONING',
  claude_model_hard: 'CLAUDE_MODEL_HARD',
  claude_budget_usd: 'CLAUDE_BUDGET_USD',
  claude_budget_cycle_day: 'CLAUDE_BUDGET_CYCLE_DAY',
  claude_min_remaining_percent: 'CLAUDE_MIN_REMAINING_PERCENT',
  tts_provider: 'TTS_PROVIDER',
  azure_speech_key: 'AZURE_SPEECH_KEY',
  azure_speech_region: 'AZURE_SPEECH_REGION',
  azure_speech_voice: 'AZURE_SPEECH_VOICE',
  elevenlabs_api_key: 'ELEVENLABS_API_KEY',
  router_mode: 'ROUTER_MODE',
  router_reasoning_explore: 'ROUTER_REASONING_EXPLORE',
  football_team: 'FOOTBALL_TEAM',
  billing_skip_concepts: 'BILLING_SKIP_CONCEPTS',
  tavily_api_key: 'TAVILY_API_KEY',
  resend_api_key: 'RESEND_API_KEY',
  google_maps_api_key: 'GOOGLE_MAPS_API_KEY',
  notion_token: 'NOTION_TOKEN',
  notion_lists_database_id: 'NOTION_LISTS_DATABASE_ID',
  gmail_user: 'GMAIL_USER',
  gmail_app_password: 'GMAIL_APP_PASSWORD',
  apollo_owner_email: 'APOLLO_OWNER_EMAIL',
  idle_travel_origin: 'IDLE_TRAVEL_ORIGIN',
  idle_travel_destination: 'IDLE_TRAVEL_DESTINATION',
  idle_travel_label: 'IDLE_TRAVEL_LABEL',
  waha_url: 'WAHA_URL',
  waha_session: 'WAHA_SESSION',
  waha_api_key: 'WAHA_API_KEY',
  whatsapp_to: 'WHATSAPP_TO',
  whatsapp_contacts: 'WHATSAPP_CONTACTS',
  speaker_url: 'SPEAKER_URL',
  speaker_route: 'SPEAKER_ROUTE',
  speaker_token: 'SPEAKER_TOKEN',
};

// Interruptores: true/false de la UI → on/off, como en server/config.env.
const SWITCH_OPTIONS = {
  claude_enabled: 'CLAUDE_ENABLED',
  conversation_mode: 'CONVERSATION_MODE',
  personajes: 'PERSONAJES',
  departure_alerts: 'DEPARTURE_ALERTS',
  reminder_alarm: 'REMINDER_ALARM',
  event_watches: 'EVENT_WATCHES',
};

const REQUIRED = ['DEVICE_SHARED_SECRET', 'DASHBOARD_SHARED_SECRET', 'OPENROUTER_API_KEY'];
// Las fija el add-on: la base vive en /data/apollo y el puerto es el publicado.
// SUPERVISOR_TOKEN la inyecta el Supervisor (homeassistant_api: true) y llega a
// Apollo sola, por el entorno heredado: no pasa por acá ni se puede pisar.
const RESERVED = new Set(['APOLLO_DATA_DIRECTORY', 'APOLLO_HOST_PORT', 'SUPERVISOR_TOKEN']);
const NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

let options;
try {
  options = JSON.parse(readFileSync(optionsPath, 'utf8'));
} catch (error) {
  fail(`No pude leer ${optionsPath}: ${error instanceof Error ? error.message : error}`);
}

const environment = new Map();
const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

for (const [option, name] of Object.entries(TEXT_OPTIONS)) {
  const value = options[option];
  if (!isBlank(value)) environment.set(name, String(value).trim());
}
for (const [option, name] of Object.entries(SWITCH_OPTIONS)) {
  if (typeof options[option] === 'boolean') environment.set(name, options[option] ? 'on' : 'off');
}
if (options.mock_voice === true) environment.set('MOCK_VOICE', '1');

// Piper viene en la imagen (/opt/piper, con es_MX-ald-medium). piper_directory
// solo hace falta para usar un Piper propio (por ejemplo en /share/piper); si ahí
// no hay binario, se usa el de la imagen. Una voz que no está en ningún lado la
// baja run.sh a /data/piper-voices al arrancar (JARVIS_PIPER_VOICE_DOWNLOAD).
const BUILTIN_PIPER_DIRECTORY = '/opt/piper';
const DOWNLOADED_VOICES_DIRECTORY = '/data/piper-voices';
const requestedPiperDirectory = isBlank(options.piper_directory)
  ? BUILTIN_PIPER_DIRECTORY
  : String(options.piper_directory).trim().replace(/\/+$/, '');
const piperDirectory = existsSync(`${requestedPiperDirectory}/piper/piper`)
  ? requestedPiperDirectory
  : BUILTIN_PIPER_DIRECTORY;
let piperVoice = isBlank(options.piper_voice) ? 'es_MX-ald-medium.onnx' : String(options.piper_voice).trim();
if (!piperVoice.endsWith('.onnx')) piperVoice += '.onnx';
if (!/^[a-z]{2,3}_[A-Z]{2}-[A-Za-z0-9_]+-(x_low|low|medium|high)\.onnx$/.test(piperVoice)) {
  fail(`piper_voice: "${piperVoice}" no tiene la forma idioma_PAÍS-nombre-calidad.onnx (ej. es_AR-daniela-high.onnx)`);
}
const piperVoicePath =
  [`${piperDirectory}/voices/${piperVoice}`, `${BUILTIN_PIPER_DIRECTORY}/voices/${piperVoice}`,
    `${DOWNLOADED_VOICES_DIRECTORY}/${piperVoice}`].find((path) => existsSync(path)) ??
  `${DOWNLOADED_VOICES_DIRECTORY}/${piperVoice}`;
if (!existsSync(piperVoicePath)) environment.set('JARVIS_PIPER_VOICE_DOWNLOAD', piperVoice);
environment.set('PIPER_BINARY', `${piperDirectory}/piper/piper`);
environment.set('PIPER_LIBRARY_DIR', `${piperDirectory}/piper`);
environment.set('PIPER_VOICE_MODEL', piperVoicePath);

// Variables extra (lo que no tiene opción propia: ROUTER_JEV_MODEL,
// REMINDER_ALARM_VOLUME, FIRMWARE_PUSH_DISABLED...). Pisan a las de arriba.
const extraNames = [];
for (const entry of Array.isArray(options.extra_env) ? options.extra_env : []) {
  const name = String(entry?.name ?? '').trim();
  if (!NAME_PATTERN.test(name)) fail(`extra_env: nombre inválido "${name}"`);
  if (RESERVED.has(name)) fail(`extra_env: ${name} lo fija el add-on, sacalo de la lista`);
  environment.set(name, String(entry?.value ?? ''));
  extraNames.push(name);
}

const missing = REQUIRED.filter((name) => isBlank(environment.get(name)));
if (missing.length > 0) {
  fail(`Faltan opciones obligatorias: ${missing.join(', ')}. Cargalas en la pestaña Configuración del add-on.`);
}

// Comillas simples de shell: lo único a escapar es la propia comilla.
const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
for (const [name, value] of environment) {
  process.stdout.write(`export ${name}=${quote(value)}\n`);
}
process.stdout.write(`export JARVIS_ADDON_LOG_TO_FILE=${options.log_to_file === false ? 'off' : 'on'}\n`);

// Resumen para el log del add-on: qué está prendido, sin valores.
const has = (name) => !isBlank(environment.get(name));
const feature = (label, enabled) => `${label}: ${enabled ? 'sí' : 'no'}`;
// Claude: misma regla que el servidor (claude/config.ts). Sin valores, solo el
// presupuesto, que no es secreto.
const claudeSwitchedOff = ['off', 'false', '0', 'no'].includes(
  String(environment.get('CLAUDE_ENABLED') ?? '').trim().toLowerCase(),
);
const claudeOn = has('ANTHROPIC_API_KEY') && !claudeSwitchedOff;
const readSummaryNumber = (name, fallback) => {
  const value = Number(environment.get(name));
  return isBlank(environment.get(name)) || !Number.isFinite(value) ? fallback : value;
};
const claudeBudget = readSummaryNumber('CLAUDE_BUDGET_USD', 50);
const claudeMargin = readSummaryNumber('CLAUDE_MIN_REMAINING_PERCENT', 0);
const claudeLimit = Math.round(claudeBudget * (1 - claudeMargin / 100) * 100) / 100;
const claudeSummary = claudeOn
  ? `Claude: sí (usa Claude hasta gastar US$${claudeLimit} en el período` +
    `${claudeMargin > 0 ? ` de US$${claudeBudget}, margen ${claudeMargin} %` : ''}; después OpenRouter)`
  : `Claude: no${has('ANTHROPIC_API_KEY') ? ' (apagado con claude_enabled)' : ''} (todo por OpenRouter)`;
console.error(
  [
    `Dispositivo: ${environment.get('APOLLO_DEVICE_NAME') ?? 'desk'}`,
    claudeSummary,
    `Voz: ${environment.get('TTS_PROVIDER') ?? 'elevenlabs'}${environment.get('TTS_PROVIDER') === 'azure' && !has('AZURE_SPEECH_KEY') ? ' (sin AZURE_SPEECH_KEY: usa Piper)' : ''}`,
    feature('Búsqueda web', has('TAVILY_API_KEY')),
    feature('Google Maps', has('GOOGLE_MAPS_API_KEY')),
    feature('Notion', has('NOTION_TOKEN') && has('NOTION_LISTS_DATABASE_ID')),
    feature('Vencimientos Gmail', has('GMAIL_USER') && has('GMAIL_APP_PASSWORD')),
    feature('WhatsApp', has('WAHA_API_KEY')),
    feature('Parlante externo', has('SPEAKER_URL') && has('SPEAKER_TOKEN')),
    // Vistas Inicio/Casa: el token del Supervisor (o HA_URL + HA_TOKEN por extra_env).
    feature(
      'Home Assistant',
      !isBlank(process.env.SUPERVISOR_TOKEN) || (has('HA_URL') && has('HA_TOKEN')),
    ),
    feature('MOCK_VOICE', has('MOCK_VOICE')),
  ].join(' · '),
);
if (extraNames.length > 0) console.error(`extra_env: ${extraNames.join(', ')}`);
