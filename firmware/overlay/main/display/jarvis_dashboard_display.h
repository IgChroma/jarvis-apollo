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
//   | AGENDA         | PENDIENTES  4  | OCTUBRE 2026         |
//   | Reunion Nico   | - Mejorar UI   | L  M  M  J  V  S  D  |
//   | en 40 minutos  | - Scheduler    | ...  (18)  ...       |
//   |                | - Localhost    | 18:30 Dentista       |
//   |                |                | 21°  Nublado         |
//   |                |                | Escuchando...        |
//   |                | AL CENTRO 24'  | [Hablar]  [Enviar]   |
//   +----------------+----------------+----------------------+
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
    struct AgendaEntry {
        std::string title;
        std::string when_label;
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
        bool pending_present = false;
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

        bool has_pending = false;
        int pending_count = 0;
        std::vector<std::string> pending_item_list;

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

    // Con el microfono abierto, Hablar ofrece reiniciar la ventana y Enviar se
    // enciende; en reposo Enviar queda apagado.
    void SetTalkButtonsListening(bool listening);

private:
    static constexpr int kAgendaSlotCount = 6;
    static constexpr int kPendingSlotCount = 4;
    static constexpr int kTodayEventSlotCount = 4;
    static constexpr int kWeekdayCount = 7;
    static constexpr int kHomeTileSlotCount = 12;

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
    void BuildConversationTile(lv_obj_t* parent);
    void BuildTalkButtons(lv_obj_t* parent);
    void BuildHouseView(lv_obj_t* parent);
    void BuildHomeTile(lv_obj_t* parent, int slot);
    void BuildDollarStrip(lv_obj_t* parent);
    void BuildReminderOverlay(lv_obj_t* parent);
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
    lv_obj_t* agenda_title_list_[kAgendaSlotCount] = {};
    lv_obj_t* agenda_when_list_[kAgendaSlotCount] = {};
    lv_obj_t* pending_row_list_[kPendingSlotCount] = {};
    lv_obj_t* pending_count_label_ = nullptr;
    lv_obj_t* travel_tile_ = nullptr;
    lv_obj_t* travel_head_label_ = nullptr;
    lv_obj_t* travel_value_label_ = nullptr;

    lv_obj_t* weather_temp_label_ = nullptr;
    lv_obj_t* weather_cond_label_ = nullptr;
    lv_obj_t* weather_detail_label_ = nullptr;

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
    // Lo ultimo pintado en cada columna: el calendario cambia una vez por dia
    // y el tablero llega cada 10 s.
    std::string calendar_column_text_list_[kWeekdayCount];

    // Franja de conversacion (reemplaza a Einstein).
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
