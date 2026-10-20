#ifndef JARVIS_DASHBOARD_DISPLAY_H
#define JARVIS_DASHBOARD_DISPLAY_H

#include "lcd_display.h"

#include <esp_timer.h>

#include <string>
#include <vector>


// Tablero informativo para la pantalla de 800x480 (Waveshare 4.3C, panel RGB)
// o de 1024x600 (Waveshare P4-7B, panel MIPI-DSI): el reparto se escala al ancho.
//
// Reemplaza la UI de chat de LcdDisplay por dos vistas que se cambian con las
// pestañas de la barra o deslizando el dedo (docs/vistas-tablero.md):
//
//   +--------------------------------------------------------+
//   | 21:04  sab 18 oct     [Inicio] [Casa]       wifi  82%  |
//   +----------------+----------------+----------------------+
//   | AGENDA         | < PENDIENTES > | OCTUBRE 2026         |
//   | o Nico · 18:00 | - Mejorar UI   | L  M  M  J  V  S  D  |
//   | o Dentista · ..| - Scheduler    | ...  (18)  ...       |
//   |                | AL CENTRO 24'  | 18:30 Dentista       |
//   +----------------+----------------+                      |
//   | Escuchando...                   | 21° Nublado Blue $1. |
//   | lo que oyo o dice Jarvis,       |                      |
//   | hasta cuatro renglones...       | [Hablar]  [Enviar]   |
//   +---------------------------------+----------------------+
//
// Casa: una grilla de hasta 12 mosaicos de Home Assistant (4x3) y una franja
// con el dólar blue abajo.
//
// Los datos llegan en el mensaje `dashboard` del protocolo, ya recortados por
// el servidor: aca solo se dibujan.
// Lo único que cambia entre las dos placas es cómo se conecta LVGL al panel,
// y eso lo resuelve la clase base.
#if CONFIG_IDF_TARGET_ESP32P4
using JarvisDashboardBase = MipiLcdDisplay;
#else
using JarvisDashboardBase = RgbLcdDisplay;
#endif

class JarvisDashboardDisplay : public JarvisDashboardBase {
public:
    // Detalle de un evento (Agenda v2): lo que muestra el modal. Todo
    // opcional; sin detalle el modal muestra titulo y cuando.
    struct AgendaDetail {
        std::string full_title;
        std::string date_label;
        std::string time_label;
        std::string location;
        std::string description;
        std::string source_label;
    };

    struct AgendaEntry {
        std::string id;
        std::string title;
        std::string icon;  // categoria de la lista cerrada; vacio = sin icono
        std::string when_label;
        bool has_detail = false;
        AgendaDetail detail;
    };

    // Una lista de la tarjeta del medio: `pending` (pendientes de Jarvis) o
    // `shopping` (lista de compras de Home Assistant). Misma forma.
    struct TodoList {
        bool present = false;  // vino la clave
        bool has_count = false;
        int count = 0;
        std::string list_name;
        std::vector<std::string> item_list;
    };

    struct CalendarEvent {
        std::string time_label;
        std::string title;
    };

    enum class HomeTileKind { kToggle, kSensor, kClimate };

    // Un mosaico de la vista Casa. Los campos que no son del tipo quedan en su
    // valor por defecto y no se dibujan.
    struct HomeTile {
        std::string entity_id;
        std::string name;
        HomeTileKind kind = HomeTileKind::kSensor;
        bool available = false;
        bool is_on = false;  // interruptor
        std::string value;   // sensor, ya recortado por el servidor
        std::string unit;    // sensor, opcional
        bool has_current = false;  // clima
        float current_c = 0;
        bool has_target = false;
        float target_c = 0;
        std::string hvac_mode;
    };

    struct DashboardData {
        // "Trajo la clave" es distinto de "la clave vino vacia". Hay DOS
        // emisores del mensaje `dashboard`: el de upstream manda solo reloj y
        // clima cada 30 min, y sin esta distincion borraba la agenda y los
        // pendientes cada vez que pasaba. Lo mismo vale para el calendario y
        // la vista Casa: un servidor viejo no los manda y eso no es "vacío".
        bool weather_present = false;
        bool agenda_present = false;
        bool travel_present = false;
        bool month_calendar_present = false;
        bool home_present = false;

        bool has_weather = false;
        int temperature_c = 0;
        std::string condition_label;
        std::string place_label;
        // Opcionales del clima de Home Assistant: con open-meteo no vienen.
        std::string condition_code;
        bool has_min = false;
        int min_c = 0;
        bool has_max = false;
        int max_c = 0;
        bool has_humidity = false;
        int humidity_percent = 0;

        std::vector<AgendaEntry> agenda_list;

        // `pending` ausente = este emisor no sabe de listas. Con `pending`
        // presente, `shopping` ausente SI es "no hay lista de compras".
        TodoList pending;
        TodoList shopping;

        bool has_travel = false;
        std::string travel_label;
        int travel_minutes = 0;

        // Calendario del mes. Viaja armado (dia de la semana del 1, cantidad
        // de dias): la placa no hace aritmetica de fechas.
        bool has_month_calendar = false;
        int calendar_year = 0;
        int calendar_month = 0;          // 1-12
        int calendar_today_day = 0;
        int calendar_first_weekday = 0;  // 0 = lunes ... 6 = domingo
        int calendar_day_count = 0;
        std::vector<int> calendar_event_day_list;
        std::vector<CalendarEvent> calendar_today_event_list;

        std::vector<HomeTile> home_tile_list;
        bool has_dollar_blue = false;
        double dollar_buy = 0;
        double dollar_sell = 0;
        std::string dollar_updated_label;
    };

    JarvisDashboardDisplay(esp_lcd_panel_io_handle_t panel_io, esp_lcd_panel_handle_t panel,
                           int width, int height, int offset_x, int offset_y, bool mirror_x,
                           bool mirror_y, bool swap_xy);

    virtual void SetupUI() override;
    virtual void SetStatus(const char* status) override;
    virtual void SetChatMessage(const char* role, const char* content) override;
    virtual void SetEmotion(const char* emotion) override;
    virtual void SetAccentColor(const char* color) override;
    virtual void SetTheme(Theme* theme) override;

    // Aplica el ultimo mensaje `dashboard` recibido del servidor.
    void SetDashboardData(const DashboardData& data);

    // Agenda v2 (docs/vistas-tablero.md). Todo seguro desde cualquier tarea.
    //
    // Abre la vista de un dia del calendario del mes en "Cargando..." y
    // devuelve la fecha ("2026-10-23") que hay que pedirle al servidor. Falso
    // si ese dia ya no esta en el calendario que se ve.
    bool OpenDayView(int day, std::string* date);
    // Respuesta `agenda_day`. Se ignora si no es la del dia que se esta viendo.
    void SetAgendaDay(const std::string& date, const std::string& date_label,
                      const std::vector<AgendaEntry>& entry_list);
    // Hay un detalle o una vista de dia abiertos: deslizar y las pestañas no
    // actuan debajo.
    bool IsAgendaOverlayOpen();

    // Recordatorio a pantalla completa.
    //
    // Es lo contrario de ShowNotification, que se borra sola a los 3 segundos:
    // esto SE QUEDA hasta que alguien lo descarte. Un recordatorio que se
    // desvanece mientras estas en otra habitacion no es un recordatorio.
    void ShowReminder(const char* message);
    void DismissReminder();
    bool IsReminderVisible();

    // Vistas. Se cambian en la placa (pestañas o deslizar): no viajan al
    // servidor.
    enum class View { kOverview = 0, kHouse = 1 };
    static constexpr int kViewCount = 2;
    void ShowView(View view);
    // +1 la siguiente, -1 la anterior; da la vuelta en los extremos.
    void ShowAdjacentView(int step);

    // El touch no pasa por LVGL: la tarea de gestos de la placa pregunta qué
    // quedó bajo el dedo, en coordenadas de pantalla.
    enum class TouchTargetKind {
        kNone,
        kTalk,          // boton Hablar (JARVIS_SCREEN_TALK_BUTTONS)
        kSend,          // boton Enviar
        kTab,           // pestaña `index`
        kTileToggle,    // mosaico interruptor `index`
        kClimateDown,   // boton - del mosaico de clima `index`
        kClimateUp,     // boton + del mosaico de clima `index`
        kAgendaRow,     // evento `index` de la agenda de Inicio
        kCalendarDay,   // dia `index` (1-31) del calendario del mes
        kListSwitch,    // flecha de la tarjeta Pendientes/Compras (-1 / +1)
        kModalClose,    // Cerrar del detalle (o un toque fuera de la tarjeta)
        kDayCancel,     // Cancelar de la vista de un dia
        kDayRow,        // evento `index` de la vista de un dia
        kOverlayBlock,  // dentro de un overlay pero sobre nada: no hace nada
    };
    struct TouchTarget {
        TouchTargetKind kind = TouchTargetKind::kNone;
        int index = -1;
    };
    TouchTarget HitTest(int x, int y);
    // Resuelve el toque de un mosaico: pinta el cambio en el acto (optimista,
    // hasta el proximo `dashboard`) y devuelve que mandarle al servidor. Falso
    // si el mosaico ya no es el que estaba bajo el dedo (llego un tablero
    // nuevo entre que se apoyo y se levanto) o no esta disponible.
    bool ApplyTileAction(const TouchTarget& target, std::string* entity_id, const char** action);
    // Los blancos de la agenda que no salen de la placa: abrir el detalle de
    // un evento, cerrarlo, cerrar la vista de un dia y cambiar de lista en la
    // tarjeta del medio. Corre en la tarea principal.
    void ApplyAgendaTouch(const TouchTarget& target);

    // Con el microfono abierto, Hablar ofrece reiniciar la ventana y Enviar se
    // enciende; en reposo Enviar queda apagado.
    void SetTalkButtonsListening(bool listening);

private:
    static constexpr int kAgendaSlotCount = 6;
    static constexpr int kPendingSlotCount = 4;
    static constexpr int kTodayEventSlotCount = 4;
    static constexpr int kWeekdayCount = 7;
    static constexpr int kHomeTileSlotCount = 12;
    static constexpr int kDayEntrySlotCount = 12;
    static constexpr int kDayColumnCount = 2;
    static constexpr int kTodoListCount = 2;

    // Un renglon de agenda: icono (o marca de color) + titulo + "· cuando".
    // El mismo armado sirve para Inicio y para la vista de un dia.
    struct AgendaRowWidgets {
        lv_obj_t* row = nullptr;
        lv_obj_t* icon = nullptr;   // label con la fuente de iconos
        lv_obj_t* dot = nullptr;    // marca de color, hija del icono
        lv_obj_t* title = nullptr;
        lv_obj_t* when = nullptr;
        int painted_icon = -1;      // categoria pintada (cache del estilo)
        int title_width = -1;       // ancho fijado al titulo (cache)
    };

    enum class DayViewState { kClosed, kLoading, kLoaded, kFailed };
    enum class TodoListKind { kPending = 0, kShopping = 1 };

    // Un mosaico de Casa: se crea una vez con todas sus piezas y despues solo
    // se muestran, esconden o cambian de texto segun el tipo.
    struct HomeTileWidgets {
        lv_obj_t* tile = nullptr;
        lv_obj_t* name_label = nullptr;
        lv_obj_t* value_label = nullptr;
        lv_obj_t* detail_label = nullptr;
        lv_obj_t* minus_button = nullptr;
        lv_obj_t* plus_button = nullptr;
        // Ultimo aspecto pintado: el estilo solo se toca si cambia, porque en
        // el panel RGB cada cambio repinta la pantalla entera.
        int painted_look = -1;
    };

    void BuildStatusBar(lv_obj_t* parent);
    void BuildOverviewView(lv_obj_t* parent);
    void BuildAgendaColumn(lv_obj_t* parent);
    void BuildPendingColumn(lv_obj_t* parent);
    void BuildSideColumn(lv_obj_t* parent);
    void BuildCalendarTile(lv_obj_t* parent);
    void BuildWeatherTile(lv_obj_t* parent);
    void BuildConversationStrip(lv_obj_t* parent);
    void BuildTalkButtons(lv_obj_t* parent);
    void BuildHouseView(lv_obj_t* parent);
    void BuildHomeTile(lv_obj_t* parent, int slot);
    void BuildDollarStrip(lv_obj_t* parent);
    void BuildReminderOverlay(lv_obj_t* parent);
    void BuildDayView(lv_obj_t* parent);
    void BuildEventModal(lv_obj_t* parent);
    void BuildAgendaRow(lv_obj_t* parent, AgendaRowWidgets& widgets);
    void PaintAgendaRow(AgendaRowWidgets& widgets, const AgendaEntry& entry, int row_width);
    lv_obj_t* MakeOverlayButton(lv_obj_t* parent, uint32_t accent, const char* text);
    void ShowEventModal(const AgendaEntry& entry);
    void CloseEventModal();
    void CloseDayView();
    void CloseAgendaOverlays();
    void SetDayViewMessage(const char* message);
    void PaintTodoCard();
    void OnDayTimeout();
    lv_obj_t* MakeTalkButton(lv_obj_t* parent, uint32_t accent, const char* text,
                             lv_obj_t** label_out);
    lv_obj_t* MakeTile(lv_obj_t* parent, lv_color_t accent, const char* heading);
    lv_obj_t* MakeTransparentBox(lv_obj_t* parent, lv_flex_flow_t flow);

    void RefreshClockLabel();
    void PaintTabs();
    void ApplyWeather(const DashboardData& data);
    void ApplyMonthCalendar(const DashboardData& data);
    void ApplyHome(const DashboardData& data);
    void PaintHomeTile(int slot);
    int TodayEventCapacity();
    int AgendaCapacity();
    int ConversationLineCapacity();
    int AgendaRowHeight();
    int DayRowCapacity();
    TodoListKind ShownTodoList();

    // Barra superior
    lv_obj_t* clock_label_ = nullptr;
    lv_obj_t* date_label_ = nullptr;
    lv_obj_t* tab_label_list_[kViewCount] = {};

    View current_view_ = View::kOverview;
    lv_obj_t* overview_view_ = nullptr;
    lv_obj_t* house_view_ = nullptr;

    // Tarjetas de Inicio.
    // Las filas se crean UNA VEZ y despues solo se les cambia el texto. Antes
    // se hacia lv_obj_clean + recrear en cada actualizacion: el flex recalculaba
    // todo el arbol y las cajas saltaban y parpadeaban.
    lv_obj_t* agenda_body_ = nullptr;
    AgendaRowWidgets agenda_row_list_[kAgendaSlotCount];
    // Lo que se ve en cada renglon, con su detalle: el toque abre el modal
    // con esto.
    std::vector<AgendaEntry> agenda_entry_list_;
    int agenda_shown_count_ = 0;

    // Tarjeta del medio: Pendientes o Compras, con flechas para alternar
    // cuando vinieron las dos. La eleccion dura hasta reiniciar.
    lv_obj_t* pending_row_list_[kPendingSlotCount] = {};
    lv_obj_t* pending_count_label_ = nullptr;
    lv_obj_t* pending_title_label_ = nullptr;
    lv_obj_t* list_prev_arrow_ = nullptr;
    lv_obj_t* list_next_arrow_ = nullptr;
    TodoList todo_list_list_[kTodoListCount];
    TodoListKind active_todo_list_ = TodoListKind::kPending;
    lv_obj_t* travel_tile_ = nullptr;
    lv_obj_t* travel_head_label_ = nullptr;
    lv_obj_t* travel_value_label_ = nullptr;

    lv_obj_t* weather_temp_label_ = nullptr;
    lv_obj_t* weather_cond_label_ = nullptr;
    lv_obj_t* weather_detail_label_ = nullptr;
    // Promedio del dolar blue al lado de la condicion; viene en `home`.
    lv_obj_t* weather_dollar_label_ = nullptr;
    lv_obj_t* side_column_ = nullptr;

    // Calendario: una etiqueta por columna (dia de la semana) con los numeros
    // uno por renglon, en vez de 49 etiquetas sueltas. Hoy se marca con un
    // recuadro que vive dentro de la columna que le toca.
    lv_obj_t* calendar_month_label_ = nullptr;
    lv_obj_t* calendar_column_list_[kWeekdayCount] = {};
    lv_obj_t* calendar_today_marker_ = nullptr;
    lv_obj_t* today_event_area_ = nullptr;
    lv_obj_t* today_event_list_[kTodayEventSlotCount] = {};
    int calendar_row_pitch_ = 0;
    int calendar_marker_row_ = -1;
    // Lo necesario para saber que dia se toco (y armar su fecha).
    bool calendar_valid_ = false;
    int calendar_year_ = 0;
    int calendar_month_ = 0;
    int calendar_first_weekday_ = 0;
    int calendar_day_count_ = 0;
    // Lo ultimo pintado en cada columna: el calendario cambia una vez por dia
    // y el tablero llega cada 10 s.
    std::string calendar_column_text_list_[kWeekdayCount];

    // Franja de conversacion (reemplaza a Einstein): a lo ancho de agenda y
    // pendientes, debajo de las dos.
    lv_obj_t* conversation_strip_ = nullptr;
    lv_obj_t* conversation_say_label_ = nullptr;
    bool showing_thinking_ = false;

    // Vista Casa
    HomeTileWidgets home_tile_widget_list_[kHomeTileSlotCount];
    HomeTile home_tile_list_[kHomeTileSlotCount];
    int home_tile_count_ = 0;
    lv_obj_t* home_empty_label_ = nullptr;
    lv_obj_t* dollar_strip_ = nullptr;
    lv_obj_t* dollar_buy_label_ = nullptr;
    lv_obj_t* dollar_sell_label_ = nullptr;
    lv_obj_t* dollar_updated_label_ = nullptr;

    // Recordatorio a pantalla completa. Vive colgado de `screen`, no del
    // container_, para quedar POR ENCIMA del tablero en vez de competir por un
    // lugar en el flex.
    lv_obj_t* reminder_overlay_ = nullptr;
    lv_obj_t* reminder_message_label_ = nullptr;

    // Vista de un dia (Agenda v2): pantalla completa, como el recordatorio.
    // Dos columnas de hasta seis renglones, para que los 12 entren tambien en
    // la 4.3C.
    lv_obj_t* day_view_ = nullptr;
    lv_obj_t* day_heading_label_ = nullptr;
    lv_obj_t* day_message_label_ = nullptr;
    lv_obj_t* day_list_area_ = nullptr;
    lv_obj_t* day_column_list_[kDayColumnCount] = {};
    lv_obj_t* day_cancel_button_ = nullptr;
    AgendaRowWidgets day_row_list_[kDayEntrySlotCount];
    std::vector<AgendaEntry> day_entry_list_;
    // Que evento muestra cada renglon (-1 = escondido): las columnas se
    // llenan una despues de la otra segun cuantos renglones entren.
    int day_slot_entry_list_[kDayEntrySlotCount] = {-1, -1, -1, -1, -1, -1,
                                                    -1, -1, -1, -1, -1, -1};
    int day_shown_count_ = 0;
    // Medidos una vez en SetupUI (la vista arranca escondida).
    int day_row_width_ = 0;
    int agenda_row_width_ = 0;
    DayViewState day_view_state_ = DayViewState::kClosed;
    std::string day_view_date_;
    int64_t day_request_started_us_ = 0;
    esp_timer_handle_t day_timeout_timer_ = nullptr;

    // Detalle de un evento: tarjeta centrada sobre un fondo oscuro. Va por
    // encima de la vista de un dia, que tambien lo abre.
    lv_obj_t* event_modal_ = nullptr;
    lv_obj_t* event_card_ = nullptr;
    lv_obj_t* event_icon_label_ = nullptr;
    lv_obj_t* event_icon_dot_ = nullptr;
    lv_obj_t* event_category_label_ = nullptr;
    lv_obj_t* event_source_label_ = nullptr;
    lv_obj_t* event_title_label_ = nullptr;
    lv_obj_t* event_when_label_ = nullptr;
    lv_obj_t* event_location_label_ = nullptr;
    lv_obj_t* event_description_label_ = nullptr;
    lv_obj_t* event_close_button_ = nullptr;
    int event_text_width_ = 0;  // ancho de los textos dentro de la tarjeta

    lv_obj_t* talk_button_ = nullptr;
    lv_obj_t* talk_button_label_ = nullptr;
    lv_obj_t* send_button_ = nullptr;
    lv_obj_t* send_button_label_ = nullptr;
    bool talk_buttons_listening_ = false;

    // El reloj lo dibuja la placa con su propio RTC: el servidor no tiene por
    // que mandar la hora cuatro veces por minuto solo para que avance.
    esp_timer_handle_t clock_timer_ = nullptr;
    lv_color_t accent_color_;
};

#endif  // JARVIS_DASHBOARD_DISPLAY_H
