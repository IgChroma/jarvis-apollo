// Catálogo de intenciones del router.
//
// Cada turno viajaba con los esquemas de las 41 herramientas (42 KB), se usaran
// o no: medido en la Pi, hasta un turno SIN herramientas tardaba 15 s de LLM
// (mediana), contra 1,5-2,3 s cuando había pocas conectadas. El router elige la
// intención antes de llamar al modelo y le pasa solo las herramientas de esa
// intención.
//
// Las herramientas se reconocen por patrón y no por nombre exacto: las de MCP
// llevan el id del servidor y un hash (`mcp_9386143d_create_event_cd2e3216`),
// que cambian si se reconecta el servidor. El nombre legible del medio no.
//
// Las descripciones son lo que lee Jev para decidir: se ajustan mirando los
// pares que confunde (ver `learn.ts`), no a ojo.

// La red de seguridad: con herramientas recortadas, el modelo puede necesitar
// una que no le pasamos. En vez de contestar "no puedo", pide todas y el turno
// sigue con la lista completa. Cuesta una ronda solo cuando el router se
// equivocó, y cada vez que pasa queda anotado como error para aprender.
export const ROUTER_ESCAPE_TOOL_NAME = 'usar_todas_las_herramientas';

// Siempre disponible cuando se acota: es liviana y los turnos que se apoyan en
// lo hablado antes ("¿y para ir a César?") la necesitan sin importar la
// intención. recall_memory NO: con ella a mano, "leeme la lista de pendientes"
// se contestó con datos viejos de la memoria en vez de leer la lista real.
// send_whatsapp también: "mandame la lista por WhatsApp" es pendientes + WhatsApp,
// y ninguna intención sola cubre las dos. Su esquema es un solo campo.
// confirmar_mensaje también: el "sí" que confirma un mensaje a un contacto puede
// caer en cualquier intención, y sin la herramienta el mensaje no sale. No
// tiene parámetros y el envío lo valida el código (tools/message.ts).
export const ROUTER_ALWAYS_TOOL_PATTERN_LIST: readonly RegExp[] = [
  /^recall_conversation$/,
  /^send_whatsapp$/,
  /^confirmar_mensaje$/,
];

export type RouterIntentId =
  | 'hora'
  | 'casa'
  | 'clima'
  | 'agenda_leer'
  | 'agenda_crear'
  | 'recordatorio'
  | 'pendientes'
  | 'viaje'
  | 'dolar'
  | 'deportes'
  | 'busqueda_web'
  | 'memoria'
  | 'notion'
  | 'mensaje'
  | 'dispositivo'
  | 'charla'
  | 'seguimiento'
  | 'otro';

export type RouterIntent = {
  readonly id: RouterIntentId;
  readonly description: string;
  // Herramientas que se habilitan con esta intención. `undefined` = todas: la
  // intención no alcanza para saber qué hace falta.
  readonly toolPatternList: readonly RegExp[] | undefined;
  // Vía rápida: la intención se resuelve sin herramientas de escritura, así que
  // equivocarse cuesta poco. Opcionalmente se ejecuta antes una herramienta de
  // solo lectura sin argumentos y el modelo solo redacta.
  readonly fastPath?: {
    readonly preExecuteToolName?: string;
    // Sin herramienta de escape: para lo que el modelo ya tiene en el prompt.
    // Medido: con la hora en el prompt y el escape disponible, DeepSeek igual
    // pidió todas las herramientas y el turno tardó 13,7 s.
    readonly withoutEscape?: boolean;
  };
};

function mcpTool(readableName: string): RegExp {
  return new RegExp(`^mcp_[A-Za-z0-9]+_${readableName}_[0-9a-f]{8}$`);
}

function nativeTool(name: string): RegExp {
  return new RegExp(`^${name}$`);
}

export const ROUTER_INTENT_LIST: readonly RouterIntent[] = [
  {
    id: 'hora',
    description: 'preguntar la hora, el día o la fecha de hoy',
    // La hora ya viaja en el prompt (buildCurrentTimePromptNote). La
    // herramienta de hora del calendario tardaba 8 s por consulta.
    toolPatternList: [],
    fastPath: { withoutEscape: true },
  },
  // Antes que clima y dispositivo: cuando el modelo usa una herramienta casa_*,
  // la etiqueta para aprender es esta (ver resolveIntentForUsedToolList).
  {
    id: 'casa',
    description:
      'prender, apagar o consultar luces, enchufes o ventiladores de la casa, o la calefacción, losa radiante o aire de un ambiente: ponerle una temperatura, subirla, bajarla o ver cómo está',
    toolPatternList: [
      nativeTool('casa_controlar'),
      nativeTool('casa_estado'),
      nativeTool('casa_listar'),
    ],
  },
  {
    id: 'clima',
    description: 'preguntar el clima, la temperatura o el pronóstico',
    toolPatternList: [
      nativeTool('weather_now'),
      nativeTool('set_weather_location'),
      // "¿Qué temperatura hay en el cuarto de los chicos?" también puede caer
      // acá: la lectura de la casa es liviana y evita una ronda de escape.
      nativeTool('casa_estado'),
    ],
  },
  {
    id: 'agenda_leer',
    description: 'consultar qué eventos o compromisos hay en el calendario o la agenda',
    toolPatternList: [
      // Agenda v2: los calendarios de Home Assistant (solo existe con HA).
      nativeTool('agenda_listar'),
      mcpTool('list_events'),
      mcpTool('search_events'),
      nativeTool('list_reminders'),
    ],
  },
  {
    id: 'agenda_crear',
    description:
      'agregar, agendar, mover o borrar un evento en el calendario, o contar que va a ir a algún lado a una hora',
    toolPatternList: [
      // Agenda v2: con Home Assistant, la agenda es el calendario de la casa
      // (tools/agenda.ts). Sin HA estas no existen y quedan las de Google
      // Calendar por MCP, para quien lo tenga configurado.
      nativeTool('agenda_agregar'),
      nativeTool('agenda_listar'),
      nativeTool('agenda_borrar'),
      mcpTool('create_event'),
      mcpTool('delete_event'),
      mcpTool('list_events'),
      mcpTool('search_events'),
      // avisar_para_salir YA NO va acá (2026-10-19). Antes vivía en esta
      // intención a propósito: Jev manda "voy a ir al dentista a las tres" a
      // agenda_crear (0,66) y no a viaje (0,17), y la idea era ofrecer la hora
      // de salida en ese caso implícito. El dueño decidió lo contrario: agendar
      // es "día y hora y listo", sin preguntar cómo va a ir ni ofrecer la
      // salida. Si quiere el aviso lo pide ("avisame cuándo salir"), y eso cae
      // en viaje (0,78 a 1,0), donde la herramienta sigue estando.
      // Si el calendario está caído, el modelo deja un recordatorio local.
      nativeTool('set_reminder'),
    ],
  },
  {
    id: 'recordatorio',
    description:
      'pedir que le avisen o le recuerden algo a una hora, dentro de un rato o todos los días; ver o cancelar avisos',
    toolPatternList: [
      nativeTool('set_reminder'),
      nativeTool('set_recurring_reminder'),
      // Tambien vive aca: "avisame para ir al dentista" suena a recordatorio y
      // el router puede clasificarlo de las dos formas.
      nativeTool('avisar_para_salir'),
      nativeTool('list_reminders'),
      nativeTool('cancel_reminder'),
      nativeTool('set_timer'),
      // "Recordame el partido del lunes" también lo agenda: para el usuario la
      // agenda es calendario + recordatorios. Visto en 5 de los turnos
      // históricos.
      mcpTool('create_event'),
      nativeTool('agenda_agregar'),
    ],
  },
  {
    id: 'pendientes',
    description: 'ver, agregar o quitar ítems de la lista de pendientes o de compras',
    toolPatternList: [
      nativeTool('read_list'),
      nativeTool('add_to_list'),
      nativeTool('remove_from_list'),
    ],
  },
  {
    id: 'viaje',
    description:
      'cuánto se tarda en llegar a un lugar, cómo ir, direcciones, datos de un lugar como su dirección u horario, o avisar a qué hora hay que salir cuando dice que va a ir a algún lado a una hora',
    toolPatternList: [
      mcpTool('maps_distance_matrix'),
      mcpTool('maps_directions'),
      mcpTool('maps_search_places'),
      mcpTool('maps_geocode'),
      // "Voy al dentista a las 3" cae en viaje, no en recordatorio: lo que
      // define el aviso es el tiempo de viaje, no la hora que dijo.
      nativeTool('avisar_para_salir'),
      // Horarios de apertura y tiempos a pie salen de la web (4 turnos
      // históricos).
      nativeTool('web_search'),
    ],
  },
  {
    id: 'dolar',
    description: 'cotización del dólar (blue, oficial, MEP, tarjeta)',
    toolPatternList: [nativeTool('dollar_rate')],
    fastPath: { preExecuteToolName: 'dollar_rate' },
  },
  {
    id: 'deportes',
    description: 'resultados, partidos o torneos de fútbol, pádel u otros deportes',
    toolPatternList: [nativeTool('web_search')],
  },
  {
    id: 'busqueda_web',
    description: 'buscar en internet un dato actual, una noticia o algo que hay que investigar',
    toolPatternList: [nativeTool('web_search'), nativeTool('start_research')],
  },
  {
    id: 'memoria',
    description:
      'recordar algo que se habló antes o un dato guardado del usuario, o pedir que guarde un dato',
    toolPatternList: [
      nativeTool('recall_memory'),
      nativeTool('recall_conversation'),
      nativeTool('resume_conversation'),
      nativeTool('remember_fact'),
    ],
  },
  {
    id: 'notion',
    description: 'buscar, leer o editar páginas en Notion',
    toolPatternList: [
      mcpTool('API_post_search'),
      mcpTool('API_retrieve_page_markdown'),
      mcpTool('API_post_page'),
      mcpTool('API_update_page_markdown'),
    ],
  },
  {
    id: 'mensaje',
    description:
      'mandarle o decirle algo a otra persona (por ejemplo a Ana), escribirle un mensaje a alguien, o confirmar que se mande',
    toolPatternList: [nativeTool('mandar_mensaje'), nativeTool('confirmar_mensaje')],
  },
  {
    id: 'dispositivo',
    description:
      'volumen, brillo, estado del aparato, el parlante externo o modo parlante, modo foco, pomodoro o temporizador',
    toolPatternList: [
      nativeTool('set_volume'),
      nativeTool('set_brightness'),
      nativeTool('device_status'),
      nativeTool('parlante'),
      nativeTool('set_focus'),
      nativeTool('clear_focus'),
      nativeTool('start_pomodoro'),
      nativeTool('set_timer'),
      // El 2026-10-18 "poné la temperatura de losa cuarto chicos en 25" cayó
      // acá (p=0,56), antes de que existiera la intención casa. La cabeza local
      // del router (head.ts) no conoce casa hasta reentrenarse, y Jev puede
      // seguir mandando la casa a "aparatos": las herramientas viajan también acá.
      nativeTool('casa_controlar'),
      nativeTool('casa_estado'),
      nativeTool('casa_listar'),
    ],
  },
  {
    id: 'charla',
    description:
      'saludo, charla, opinión, o una pregunta de conocimiento general o explicación que se responde sin buscar nada',
    toolPatternList: [],
    fastPath: {},
  },
  {
    id: 'seguimiento',
    description:
      'respuesta corta que solo tiene sentido con el turno anterior (sí, dale, hacelo, eso, el otro)',
    // Se resuelve con las herramientas del turno anterior (ver plan.ts).
    toolPatternList: undefined,
  },
  {
    id: 'otro',
    description: 'cualquier otro pedido: mandar un email, traducir, programar, correr código',
    toolPatternList: undefined,
  },
];

export const ROUTER_INTENT_BY_ID: ReadonlyMap<RouterIntentId, RouterIntent> = new Map(
  ROUTER_INTENT_LIST.map((intent) => [intent.id, intent]),
);

export function isRouterIntentId(value: string): value is RouterIntentId {
  return ROUTER_INTENT_BY_ID.has(value as RouterIntentId);
}

export function matchIntentToolNameList(
  intent: RouterIntent,
  availableToolNameList: readonly string[],
): readonly string[] | undefined {
  if (intent.toolPatternList === undefined) {
    return undefined;
  }
  const patternList = intent.toolPatternList;
  return availableToolNameList.filter((toolName) =>
    patternList.some((pattern) => pattern.test(toolName)),
  );
}

// Al revés: qué intención explica una herramienta que el modelo usó. Es la
// etiqueta "plateada" con la que aprende el router — si el modelo terminó
// llamando a `maps_distance_matrix`, el turno era de viaje. Una herramienta
// puede pertenecer a varias (set_reminder está en recordatorio y en
// agenda_crear); gana la primera del catálogo salvo que la predicha también la
// tenga, porque entonces el router no se equivocó.
export function resolveIntentForUsedToolList(
  usedToolNameList: readonly string[],
  predictedIntentId: RouterIntentId | undefined,
): RouterIntentId | undefined {
  const toolIntentList = usedToolNameList
    .filter((toolName) => toolName !== ROUTER_ESCAPE_TOOL_NAME)
    .map((toolName) => {
      const owningIntentList = ROUTER_INTENT_LIST.filter(
        (intent) =>
          intent.toolPatternList !== undefined &&
          intent.toolPatternList.some((pattern) => pattern.test(toolName)),
      );
      return owningIntentList;
    })
    .filter((owningIntentList) => owningIntentList.length > 0);
  if (toolIntentList.length === 0) {
    return undefined;
  }
  if (
    predictedIntentId !== undefined &&
    toolIntentList.every((owningIntentList) =>
      owningIntentList.some((intent) => intent.id === predictedIntentId),
    )
  ) {
    return predictedIntentId;
  }
  return toolIntentList[0][0].id;
}
