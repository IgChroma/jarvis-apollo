#include "jarvis_dashboard_display.h"

// lcd_display.h no arrastra el tema: LvglTheme vive en su propio header, igual
// que lo incluye lcd_display.cc.
#include "lvgl_theme.h"
#include "application.h"
#include "assets/lang_config.h"

#include <material_symbols.h>

#include <esp_heap_caps.h>
#include <esp_log.h>
#include <esp_timer.h>
#include <time.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>

#define TAG "JarvisDashboard"

// Fuente grande para los numeros que se leen de lejos (temperatura, valores de
// los mosaicos, dolar). Es la Noto Sans de 30 px que ya trae el componente
// xiaozhi-fonts; el linker solo suma ese objeto (unos 240 KB de flash).
//
// Es la UNICA fuente que el tablero fija en el estilo local, y es a proposito:
// la regla de "heredar siempre" existe porque Assets::Apply LIBERA la fuente
// del tema al cambiarla, y un label que la apuntaba queda colgando. Esta vive
// en flash, es `const` y nadie la libera nunca: no tiene ese problema.
LV_FONT_DECLARE(font_noto_sans_basic_30_4);
// La fuente de iconos de la barra (Material Symbols 16 px en las dos placas,
// la misma que eligen CMake y LcdDisplay). Tambien vive en flash y nadie la
// libera: es la segunda excepcion a "heredar siempre", por el mismo motivo
// que BigFont. No suma flash, ya esta linkeada por la barra de estado.
LV_FONT_DECLARE(BUILTIN_ICON_FONT);

namespace {

// Paleta del tablero. Son los mismos acentos que usa el servidor por familia de
// herramienta (overrides/turn/caption.ts), para que la pantalla y los carteles
// hablen el mismo idioma de color.
constexpr uint32_t kColorScreen = 0x0B1015;
constexpr uint32_t kColorTile = 0x1B2A33;
constexpr uint32_t kColorTileLine = 0x35505C;
constexpr uint32_t kColorInk = 0xF2F7F6;
constexpr uint32_t kColorDim = 0xA8BFBC;
constexpr uint32_t kColorTurquoise = 0x2DD4BF;  // la respuesta escribiendose
constexpr uint32_t kColorTangerine = 0xF97316;  // agenda y recordatorios
constexpr uint32_t kColorViolet = 0xA855F7;     // memoria y listas
constexpr uint32_t kColorGreen = 0x22C55E;      // lugares, viajes y plata
constexpr uint32_t kColorSky = 0x38BDF8;        // clima
constexpr uint32_t kColorAmber = 0xFACC15;      // un interruptor prendido
constexpr uint32_t kColorTileOn = 0x3A3416;     // fondo del mosaico prendido

constexpr int kClockTickPeriodMicroseconds = 10 * 1000 * 1000;

// Anchos del reparto, en pixeles del panel de 800. En otros anchos se escalan
// (ScaledWidth); la columna de la derecha se queda con el resto. Agenda y
// pendientes ceden lugar respecto del reparto con Einstein: la derecha apila
// calendario, clima y botones, y la franja de conversacion va debajo de agenda
// y pendientes, con el ancho de las dos.
constexpr int kAgendaColumnWidth = 230;
constexpr int kPendingColumnWidth = 230;
constexpr int kDesignWidth = 800;
constexpr int kGap = 9;
constexpr int kOuterPad = 10;
constexpr int kStatusBarHeight = 34;

// Las fuentes NO escalan con el panel (16 px en las dos placas), asi que el
// alto no se reparte en proporcion: la 4.3C (480 de alto) va apretada y la
// P4-7B (600) tiene aire. Por debajo de este alto se usa el reparto compacto.
constexpr int kCompactScreenMaxHeight = 560;
// Botones Hablar y Enviar: a la altura de un dedo, no de un cursor.
constexpr int kTalkButtonHeight = 64;
constexpr int kTalkButtonCompactHeight = 52;
// Interlineado de la grilla del mes: en la 4.3C los renglones se pisan un poco
// (los numeros no tienen descendentes) para que entre el resto de la columna.
constexpr int kCalendarLineSpaceCompact = -4;
// Renglones de lo que oyo o dice Jarvis, debajo del estado. Alto fijo: una
// respuesta larga se corta con puntos suspensivos y no le roba lugar a la
// agenda ni a los pendientes (que se quedan con el resto del alto).
constexpr int kConversationTextLineCount = 4;
// Botones - y + de los mosaicos de clima, y cuanto mas alla del borde se acepta
// el dedo. Los objetivos chicos se agrandan al tocar, no al dibujar.
constexpr int kClimateButtonSize = 44;
constexpr int kClimateButtonHitMargin = 8;
// Zona de toque de las pestañas: a los costados y hacia abajo de la barra.
constexpr int kTabHitMargin = 28;
constexpr int kTabHitMarginBelow = 24;
constexpr int kFallbackLineHeight = 23;

// Aspecto de un mosaico de Casa; se cachea para no tocar estilos sin cambio.
constexpr int kTileLookNormal = 0;
constexpr int kTileLookOn = 1;
constexpr int kTileLookUnavailable = 2;

constexpr int kHomeGridColumnCount = 4;
// LVGL guarda el puntero a los descriptores de la grilla: tienen que vivir
// mientras viva el objeto, por eso son estaticos.
const int32_t kHomeGridColumnList[] = {LV_GRID_FR(1), LV_GRID_FR(1), LV_GRID_FR(1),
                                       LV_GRID_FR(1), LV_GRID_TEMPLATE_LAST};
const int32_t kHomeGridRowList[] = {LV_GRID_FR(1), LV_GRID_FR(1), LV_GRID_FR(1),
                                    LV_GRID_TEMPLATE_LAST};

const char* kMonthAbbreviationList[] = {"ene", "feb", "mar", "abr", "may", "jun",
                                        "jul", "ago", "sep", "oct", "nov", "dic"};
const char* kMonthNameList[] = {"ENERO",      "FEBRERO", "MARZO",     "ABRIL",
                                "MAYO",       "JUNIO",   "JULIO",     "AGOSTO",
                                "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"};
const char* kWeekdayAbbreviationList[] = {"dom", "lun", "mar", "mie", "jue", "vie", "sab"};
// La grilla del mes arranca el lunes, como el calendario argentino.
const char* kCalendarWeekdayInitialList[] = {"L", "M", "M", "J", "V", "S", "D"};
const char* kViewTabTextList[] = {"Inicio", "Casa"};
const char* kThinkingStatusText = "Pensando...";

// Ancho del diseño de 800 px llevado al panel real (1024 en la P4-7B).
int ScaledWidth(int design_px) {
    return design_px * LV_HOR_RES / kDesignWidth;
}

bool IsCompactScreen() {
    return LV_VER_RES < kCompactScreenMaxHeight;
}

const lv_font_t* BigFont() {
    return &font_noto_sans_basic_30_4;
}

// Solo color: la fuente se HEREDA de la pantalla a proposito.
//
// `Assets::Apply` cambia la fuente de texto al arrancar y LIBERA la anterior.
// Cualquier label con la fuente fijada en su estilo local queda apuntando a
// memoria liberada, y el siguiente layout la desreferencia: crash en
// lv_font_get_glyph_dsc, dentro de la tarea de LVGL. Pasaba con los titulos de
// las tarjetas, que se crean en MakeTile y de los que no se guarda puntero.
//
// Heredando, actualizar la fuente de la pantalla en SetTheme alcanza para todos.
// (La unica excepcion es BigFont, que vive en flash: ver arriba.)
void StyleTileText(lv_obj_t* label, uint32_t color) {
    if (label == nullptr) {
        return;
    }
    lv_obj_set_style_text_color(label, lv_color_hex(color), 0);
}

// El tema no siempre trae cargadas todas las fuentes: con los assets por
// defecto `large_icon_font` viene vacia, y desreferenciarla revienta. Solo
// `text_font` e `icon_font` las usa LcdDisplay sin condicion, asi que son las
// unicas en las que se puede confiar.
const lv_font_t* SafeFont(const std::shared_ptr<LvglFont>& font) {
    return font == nullptr ? nullptr : font->font();
}

// En el panel RGB (direct_mode + full_refresh) cualquier invalidacion repinta
// la pantalla ENTERA, y el tablero llega cada 10 s casi siempre igual. Poner
// el mismo texto o el mismo flag igual invalida, asi que se compara antes.
void SetLabelText(lv_obj_t* label, const char* text) {
    if (label == nullptr) {
        return;
    }
    const char* shown = text == nullptr ? "" : text;
    const char* current = lv_label_get_text(label);
    if (current != nullptr && strcmp(current, shown) == 0) {
        return;
    }
    lv_label_set_text(label, shown);
}

void SetHidden(lv_obj_t* object, bool hidden) {
    if (object == nullptr || lv_obj_has_flag(object, LV_OBJ_FLAG_HIDDEN) == hidden) {
        return;
    }
    if (hidden) {
        lv_obj_add_flag(object, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_remove_flag(object, LV_OBJ_FLAG_HIDDEN);
    }
}

bool IsHidden(lv_obj_t* object) {
    return object == nullptr || lv_obj_has_flag(object, LV_OBJ_FLAG_HIDDEN);
}

// Coordenadas de pantalla; `margin` agranda el blanco para el dedo.
bool IsInside(lv_obj_t* object, int x, int y, int margin) {
    if (object == nullptr || IsHidden(object)) {
        return false;
    }
    lv_area_t area;
    lv_obj_get_coords(object, &area);
    return x >= area.x1 - margin && x <= area.x2 + margin && y >= area.y1 - margin &&
           y <= area.y2 + margin;
}

int LineHeightOf(lv_obj_t* object) {
    const lv_font_t* font = lv_obj_get_style_text_font(object, LV_PART_MAIN);
    return font == nullptr ? kFallbackLineHeight : lv_font_get_line_height(font);
}

// "21:04": lo que UpdateStatusBar pone en el estado mientras la placa reposa.
bool IsClockText(const char* text) {
    return text != nullptr && strlen(text) == 5 && isdigit((unsigned char)text[0]) &&
           isdigit((unsigned char)text[1]) && text[2] == ':' &&
           isdigit((unsigned char)text[3]) && isdigit((unsigned char)text[4]);
}

// 22.5 -> "22.5". Sin printf de flotantes: no depende de como se compilo newlib.
std::string FormatTenths(float value) {
    long tenths = lroundf(value * 10.0f);
    const bool negative = tenths < 0;
    tenths = labs(tenths);
    char text[16];
    snprintf(text, sizeof(text), "%s%ld.%ld", negative ? "-" : "", tenths / 10, tenths % 10);
    return text;
}

// 1180 -> "$1.180", con el punto de miles de aca.
std::string FormatPesos(double value) {
    long amount = lround(value);
    const bool negative = amount < 0;
    std::string digits = std::to_string(labs(amount));
    std::string grouped;
    for (size_t index = 0; index < digits.size(); index++) {
        if (index > 0 && (digits.size() - index) % 3 == 0) {
            grouped += '.';
        }
        grouped += digits[index];
    }
    return std::string(negative ? "-$" : "$") + grouped;
}

const char* HvacModeLabel(const std::string& mode) {
    if (mode == "off") return "Apagado";
    if (mode == "heat") return "Calor";
    if (mode == "cool") return "Frío";
    if (mode == "heat_cool" || mode == "auto") return "Auto";
    if (mode == "dry") return "Seco";
    if (mode == "fan_only") return "Ventilador";
    return mode.c_str();
}

// La fuente no tiene iconos de clima: la condicion tiñe la temperatura.
uint32_t WeatherColorFor(const std::string& condition_code) {
    if (condition_code == "sunny") {
        return kColorAmber;
    }
    if (condition_code == "rainy" || condition_code == "pouring" ||
        condition_code == "lightning" || condition_code == "lightning-rainy" ||
        condition_code == "hail" || condition_code == "snowy" ||
        condition_code == "snowy-rainy") {
        return kColorSky;
    }
    return kColorInk;
}

// ---- Agenda v2 -------------------------------------------------------------

// Renglon de agenda: un solo renglon (icono, titulo, "· cuando") con aire
// arriba y abajo para que sea un blanco de dedo, y una raya fina abajo.
constexpr int kAgendaRowPadVer = 5;
constexpr int kAgendaRowGap = 6;
constexpr int kAgendaIconWidth = 18;
constexpr int kAgendaDotSize = 9;
// Botones Cerrar / Cancelar y cuanto mas alla del borde se acepta el dedo.
constexpr int kOverlayButtonHitMargin = 10;
// Flechas de la tarjeta Pendientes/Compras: el glifo mide 16 px; con este
// margen el blanco es de unos 40 px.
constexpr int kListArrowHitMargin = 12;
constexpr int64_t kDayRequestTimeoutMicroseconds = 5 * 1000 * 1000;
// Renglones que se le permiten al titulo y la descripcion en el detalle.
constexpr int kEventTitleMaxLines = 2;
constexpr int kEventDescriptionMaxLines = 4;
constexpr int kEventLocationMaxLines = 2;

constexpr uint32_t kColorRose = 0xF87171;
constexpr uint32_t kColorLime = 0x84CC16;
constexpr uint32_t kColorPink = 0xF472B6;

// Lista cerrada de categorias del contrato. Las fuentes no tienen emoji: cada
// una va a un glifo que EXISTE en font_material_symbols_16_4 (verificado
// contra su lista de codepoints) o, si no hay ninguno que se parezca, a una
// marca de color. Una categoria desconocida o ausente cae en "otro".
struct AgendaCategory {
    const char* name;
    const char* glyph;  // nullptr = marca de color
    uint32_t color;
    const char* heading;  // encabezado del detalle, ya en mayusculas
};
const AgendaCategory kAgendaCategoryList[] = {
    {"salud", MATERIAL_SYMBOLS_FAVORITE, kColorRose, "SALUD"},
    {"auto", MATERIAL_SYMBOLS_NAVIGATION, kColorSky, "AUTO"},
    {"cumple", MATERIAL_SYMBOLS_STAR, kColorAmber, "CUMPLEAÑOS"},
    {"compras", nullptr, kColorViolet, "COMPRAS"},
    {"casa", MATERIAL_SYMBOLS_HOME, kColorTurquoise, "CASA"},
    {"pago", nullptr, kColorGreen, "PAGO"},
    {"viaje", MATERIAL_SYMBOLS_LANGUAGE, kColorGreen, "VIAJE"},
    {"trabajo", nullptr, kColorSky, "TRABAJO"},
    {"escuela", MATERIAL_SYMBOLS_EDIT_SQUARE, kColorAmber, "ESCUELA"},
    {"deporte", nullptr, kColorLime, "DEPORTE"},
    {"comida", nullptr, kColorTangerine, "COMIDA"},
    {"mascota", nullptr, kColorPink, "MASCOTA"},
    {"reunion", MATERIAL_SYMBOLS_PERSON, kColorViolet, "REUNIÓN"},
    {"otro", nullptr, kColorDim, "EVENTO"},
};
constexpr int kAgendaCategoryCount = sizeof(kAgendaCategoryList) / sizeof(kAgendaCategoryList[0]);
constexpr int kAgendaCategoryOther = kAgendaCategoryCount - 1;

int AgendaCategoryIndex(const std::string& icon) {
    for (int index = 0; index < kAgendaCategoryCount; index++) {
        if (icon == kAgendaCategoryList[index].name) {
            return index;
        }
    }
    return kAgendaCategoryOther;
}

const lv_font_t* IconFont() {
    return &BUILTIN_ICON_FONT;
}

// Para la fecha provisoria de la vista de un dia, hasta que llegue la del
// servidor (mismo formato: "jueves 23 de octubre"). 0 = lunes.
const char* kWeekdayNameList[] = {"lunes", "martes", "miércoles", "jueves",
                                  "viernes", "sábado", "domingo"};
const char* kMonthLowerNameList[] = {"enero",  "febrero", "marzo",     "abril",
                                     "mayo",   "junio",   "julio",     "agosto",
                                     "septiembre", "octubre", "noviembre", "diciembre"};

int TextWidth(lv_obj_t* label, const char* text) {
    const lv_font_t* font = lv_obj_get_style_text_font(label, LV_PART_MAIN);
    if (font == nullptr || text == nullptr || text[0] == '\0') {
        return 0;
    }
    lv_point_t size;
    lv_text_get_size(&size, text, font, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    return (int)size.x;
}

// Texto que corta de palabra en `width` px y se queda en `max_lines`
// renglones (con "..." al final si no entra). El alto se fija solo cuando
// hace falta recortar: si entra, el label mide lo que mide el texto.
void SetClampedText(lv_obj_t* label, const std::string& text, int width, int max_lines) {
    SetLabelText(label, text.c_str());
    SetHidden(label, text.empty());
    const lv_font_t* font = lv_obj_get_style_text_font(label, LV_PART_MAIN);
    if (font == nullptr || text.empty()) {
        return;
    }
    const int line_height = std::max(1, (int)lv_font_get_line_height(font));
    lv_point_t size;
    lv_text_get_size(&size, text.c_str(), font, 0, 0, width, LV_TEXT_FLAG_NONE);
    const int32_t height =
        size.y > max_lines * line_height ? max_lines * line_height : LV_SIZE_CONTENT;
    if (lv_obj_get_style_height(label, LV_PART_MAIN) != height) {
        lv_obj_set_height(label, height);
    }
}

// "Compras" -> "COMPRAS" para el encabezado, como los demas rotulos. Solo
// ASCII: tocar los bytes de una letra acentuada en UTF-8 la romperia.
std::string UpperAscii(const std::string& text) {
    std::string result = text;
    for (char& character : result) {
        if (character >= 'a' && character <= 'z') {
            character = (char)(character - 'a' + 'A');
        }
    }
    return result;
}

}  // namespace

JarvisDashboardDisplay::JarvisDashboardDisplay(esp_lcd_panel_io_handle_t panel_io,
                                               esp_lcd_panel_handle_t panel, int width,
                                               int height, int offset_x, int offset_y,
                                               bool mirror_x, bool mirror_y, bool swap_xy)
    : JarvisDashboardBase(panel_io, panel, width, height, offset_x, offset_y, mirror_x, mirror_y,
                    swap_xy),
      accent_color_(lv_color_hex(kColorTurquoise)) {}

lv_obj_t* JarvisDashboardDisplay::MakeTransparentBox(lv_obj_t* parent, lv_flex_flow_t flow) {
    lv_obj_t* box = lv_obj_create(parent);
    lv_obj_set_style_bg_opa(box, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(box, 0, 0);
    lv_obj_set_style_radius(box, 0, 0);
    lv_obj_set_style_pad_all(box, 0, 0);
    lv_obj_set_flex_flow(box, flow);
    lv_obj_set_scrollbar_mode(box, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(box, LV_OBJ_FLAG_SCROLLABLE);
    return box;
}

lv_obj_t* JarvisDashboardDisplay::MakeTile(lv_obj_t* parent, lv_color_t accent,
                                           const char* heading) {
    lv_obj_t* tile = lv_obj_create(parent);
    lv_obj_set_width(tile, LV_PCT(100));
    lv_obj_set_style_bg_color(tile, lv_color_hex(kColorTile), 0);
    lv_obj_set_style_border_color(tile, lv_color_hex(kColorTileLine), 0);
    lv_obj_set_style_border_width(tile, 1, 0);
    lv_obj_set_style_radius(tile, 9, 0);
    lv_obj_set_style_pad_all(tile, 11, 0);
    lv_obj_set_style_pad_row(tile, 5, 0);
    lv_obj_set_flex_flow(tile, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scrollbar_mode(tile, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(tile, LV_OBJ_FLAG_SCROLLABLE);

    if (heading != nullptr) {
        // Encabezado: un cuadradito del color de la familia mas el rotulo. El
        // color es lo que distingue las tarjetas de un vistazo, ahora que la
        // fuente no dibuja emojis.
        lv_obj_t* head = MakeTransparentBox(tile, LV_FLEX_FLOW_ROW);
        lv_obj_set_size(head, LV_PCT(100), LV_SIZE_CONTENT);
        lv_obj_set_style_pad_column(head, 7, 0);
        lv_obj_set_flex_align(head, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                              LV_FLEX_ALIGN_CENTER);

        lv_obj_t* swatch = lv_obj_create(head);
        lv_obj_set_size(swatch, 7, 7);
        lv_obj_set_style_bg_color(swatch, accent, 0);
        lv_obj_set_style_border_width(swatch, 0, 0);
        lv_obj_set_style_radius(swatch, 2, 0);

        lv_obj_t* title = lv_label_create(head);
        lv_label_set_text(title, heading);
        StyleTileText(title, kColorDim);
    }
    return tile;
}

void JarvisDashboardDisplay::BuildStatusBar(lv_obj_t* parent) {
    auto lvgl_theme = static_cast<LvglTheme*>(current_theme_);
    auto icon_font = SafeFont(lvgl_theme->icon_font());

    lv_obj_t* bar = MakeTransparentBox(parent, LV_FLEX_FLOW_ROW);
    lv_obj_set_size(bar, LV_PCT(100), kStatusBarHeight);
    lv_obj_set_style_pad_left(bar, 6, 0);
    lv_obj_set_style_pad_right(bar, 6, 0);
    lv_obj_set_style_pad_column(bar, 12, 0);
    lv_obj_set_flex_align(bar, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);

    clock_label_ = lv_label_create(bar);
    StyleTileText(clock_label_, kColorInk);

    date_label_ = lv_label_create(bar);
    StyleTileText(date_label_, kColorDim);

    // Dos separadores elasticos dejan las pestañas centradas entre la fecha y
    // los iconos, sin calcular anchos.
    auto make_spacer = [bar]() {
        lv_obj_t* spacer = lv_obj_create(bar);
        lv_obj_set_style_bg_opa(spacer, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(spacer, 0, 0);
        lv_obj_set_height(spacer, 1);
        lv_obj_set_flex_grow(spacer, 1);
    };
    make_spacer();

    // Pestañas: un label con fondo cada una, un objeto por pestaña. Se tocan
    // como los botones (HitTest), no por LVGL.
    for (int view = 0; view < kViewCount; view++) {
        lv_obj_t* tab = lv_label_create(bar);
        lv_label_set_text(tab, kViewTabTextList[view]);
        lv_obj_set_style_pad_hor(tab, 16, 0);
        lv_obj_set_style_pad_ver(tab, 3, 0);
        lv_obj_set_style_radius(tab, 14, 0);
        lv_obj_set_style_bg_opa(tab, LV_OPA_COVER, 0);
        lv_obj_set_style_border_width(tab, 1, 0);
        lv_obj_set_style_border_color(tab, lv_color_hex(kColorTileLine), 0);
        tab_label_list_[view] = tab;
    }
    PaintTabs();

    make_spacer();

    // Los reusa la clase base: son los mismos objetos que actualiza
    // UpdateStatusBar con la señal de wifi y la bateria.
    lv_obj_t** const icon_slot_list[] = {&network_label_, &mute_label_, &battery_label_};
    for (lv_obj_t** slot : icon_slot_list) {
        *slot = lv_label_create(bar);
        lv_label_set_text(*slot, "");
        StyleTileText(*slot, kColorDim);
        if (icon_font != nullptr) {
            lv_obj_set_style_text_font(*slot, icon_font, 0);
        }
    }

    RefreshClockLabel();
}

void JarvisDashboardDisplay::PaintTabs() {
    for (int view = 0; view < kViewCount; view++) {
        lv_obj_t* tab = tab_label_list_[view];
        if (tab == nullptr) {
            continue;
        }
        const bool is_current = view == (int)current_view_;
        lv_obj_set_style_bg_color(tab, lv_color_hex(is_current ? kColorTurquoise : kColorTile),
                                  0);
        lv_obj_set_style_text_color(tab, lv_color_hex(is_current ? kColorScreen : kColorDim), 0);
    }
}

void JarvisDashboardDisplay::BuildOverviewView(lv_obj_t* parent) {
    overview_view_ = MakeTransparentBox(parent, LV_FLEX_FLOW_ROW);
    lv_obj_set_width(overview_view_, LV_PCT(100));
    lv_obj_set_flex_grow(overview_view_, 1);
    lv_obj_set_style_pad_column(overview_view_, kGap, 0);

    // A la izquierda, agenda y pendientes lado a lado y la franja de
    // conversacion abajo, con el ancho de las dos. Las tarjetas se quedan con
    // el alto que deja la franja (ver AgendaCapacity).
    lv_obj_t* main_area = MakeTransparentBox(overview_view_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_size(main_area,
                    ScaledWidth(kAgendaColumnWidth) + kGap + ScaledWidth(kPendingColumnWidth),
                    LV_PCT(100));
    lv_obj_set_style_pad_row(main_area, kGap, 0);

    lv_obj_t* card_row = MakeTransparentBox(main_area, LV_FLEX_FLOW_ROW);
    lv_obj_set_width(card_row, LV_PCT(100));
    lv_obj_set_flex_grow(card_row, 1);
    lv_obj_set_style_pad_column(card_row, kGap, 0);

    BuildAgendaColumn(card_row);
    BuildPendingColumn(card_row);
    BuildConversationStrip(main_area);
    BuildSideColumn(overview_view_);
}

void JarvisDashboardDisplay::BuildAgendaColumn(lv_obj_t* parent) {
    lv_obj_t* column = MakeTransparentBox(parent, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_size(column, ScaledWidth(kAgendaColumnWidth), LV_PCT(100));

    // El clima se fue a la columna de la derecha: la agenda tiene la columna
    // entera, menos la franja de conversacion. El cuerpo se estira hasta el
    // fondo de la tarjeta para poder medir cuantos eventos entran enteros.
    lv_obj_t* agenda = MakeTile(column, lv_color_hex(kColorTangerine), "AGENDA");
    lv_obj_set_flex_grow(agenda, 1);
    lv_obj_t* agenda_body = MakeTransparentBox(agenda, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_width(agenda_body, LV_PCT(100));
    lv_obj_set_flex_grow(agenda_body, 1);
    lv_obj_set_style_pad_row(agenda_body, 0, 0);
    agenda_body_ = agenda_body;

    // Agenda v2: un renglon por evento (icono + titulo + "· cuando") en vez
    // de dos. El titulo usa el ancho real de la columna (ver PaintAgendaRow):
    // antes el servidor lo cortaba a 22 caracteres y quedaba media columna
    // vacia.
    for (int slot = 0; slot < kAgendaSlotCount; slot++) {
        BuildAgendaRow(agenda_body, agenda_row_list_[slot]);
    }
}

void JarvisDashboardDisplay::BuildAgendaRow(lv_obj_t* parent, AgendaRowWidgets& widgets) {
    lv_obj_t* row = MakeTransparentBox(parent, LV_FLEX_FLOW_ROW);
    lv_obj_set_size(row, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_style_pad_ver(row, kAgendaRowPadVer, 0);
    lv_obj_set_style_pad_column(row, kAgendaRowGap, 0);
    lv_obj_set_style_border_side(row, LV_BORDER_SIDE_BOTTOM, 0);
    lv_obj_set_style_border_width(row, 1, 0);
    lv_obj_set_style_border_color(row, lv_color_hex(kColorTileLine), 0);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_add_flag(row, LV_OBJ_FLAG_HIDDEN);
    widgets.row = row;

    // El icono es un label con la fuente de iconos; la marca de color (para
    // las categorias sin glifo) es hija del icono, asi ocupa el mismo lugar y
    // los titulos quedan alineados.
    widgets.icon = lv_label_create(row);
    lv_obj_set_style_text_font(widgets.icon, IconFont(), 0);
    lv_obj_set_width(widgets.icon, kAgendaIconWidth);
    lv_obj_set_style_text_align(widgets.icon, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(widgets.icon, "");

    widgets.dot = lv_obj_create(widgets.icon);
    lv_obj_set_size(widgets.dot, kAgendaDotSize, kAgendaDotSize);
    lv_obj_set_style_radius(widgets.dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(widgets.dot, 0, 0);
    lv_obj_set_style_pad_all(widgets.dot, 0, 0);
    lv_obj_clear_flag(widgets.dot, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_center(widgets.dot);
    lv_obj_add_flag(widgets.dot, LV_OBJ_FLAG_HIDDEN);

    widgets.title = lv_label_create(row);
    lv_obj_set_width(widgets.title, 0);
    lv_label_set_long_mode(widgets.title, LV_LABEL_LONG_DOT);
    lv_label_set_text(widgets.title, "");
    StyleTileText(widgets.title, kColorInk);

    widgets.when = lv_label_create(row);
    lv_label_set_text(widgets.when, "");
    StyleTileText(widgets.when, kColorTangerine);
}

// Pinta un renglon de agenda. `row_width` es el ancho de contenido del
// renglon: el "· cuando" se ve siempre entero y el titulo se queda con lo que
// sobra, cortado con "..." solo si de verdad no entra.
void JarvisDashboardDisplay::PaintAgendaRow(AgendaRowWidgets& widgets, const AgendaEntry& entry,
                                            int row_width) {
    const int category = AgendaCategoryIndex(entry.icon);
    if (category != widgets.painted_icon) {
        widgets.painted_icon = category;
        const AgendaCategory& look = kAgendaCategoryList[category];
        lv_label_set_text(widgets.icon, look.glyph == nullptr ? "" : look.glyph);
        lv_obj_set_style_text_color(widgets.icon, lv_color_hex(look.color), 0);
        lv_obj_set_style_bg_color(widgets.dot, lv_color_hex(look.color), 0);
        SetHidden(widgets.dot, look.glyph != nullptr);
    }

    SetLabelText(widgets.title, entry.title.c_str());
    const std::string when = entry.when_label.empty() ? "" : "· " + entry.when_label;
    SetLabelText(widgets.when, when.c_str());

    const int when_width = TextWidth(widgets.when, when.c_str());
    const int gap_count = when.empty() ? 1 : 2;
    const int available = row_width - kAgendaIconWidth - gap_count * kAgendaRowGap - when_width;
    // +1: con el ancho exacto del texto el redondeo a veces ya pone "...".
    const int wanted = TextWidth(widgets.title, entry.title.c_str()) + 1;
    const int title_width = std::max(0, std::min(wanted, available));
    if (title_width != widgets.title_width) {
        widgets.title_width = title_width;
        lv_obj_set_width(widgets.title, title_width);
    }
}

void JarvisDashboardDisplay::BuildPendingColumn(lv_obj_t* parent) {
    lv_obj_t* column = MakeTransparentBox(parent, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_size(column, ScaledWidth(kPendingColumnWidth), LV_PCT(100));
    lv_obj_set_style_pad_row(column, kGap, 0);

    lv_obj_t* tile = MakeTile(column, lv_color_hex(kColorViolet), "PENDIENTES");
    lv_obj_set_flex_grow(tile, 1);

    // El contador va pegado al encabezado, alineado a la derecha.
    lv_obj_t* head = lv_obj_get_child(tile, 0);
    pending_title_label_ = lv_obj_get_child(head, 1);

    // Flechas "‹ PENDIENTES ›": alternan con la lista de compras cuando el
    // servidor manda las dos. Son glifos de la fuente de iconos (la de texto
    // no tiene ‹ ›); escondidas mientras haya una sola lista.
    auto make_arrow = [head](const char* glyph) {
        lv_obj_t* arrow = lv_label_create(head);
        lv_obj_set_style_text_font(arrow, IconFont(), 0);
        lv_label_set_text(arrow, glyph);
        StyleTileText(arrow, kColorViolet);
        lv_obj_add_flag(arrow, LV_OBJ_FLAG_HIDDEN);
        return arrow;
    };
    list_prev_arrow_ = make_arrow(MATERIAL_SYMBOLS_KEYBOARD_ARROW_LEFT);
    lv_obj_move_to_index(list_prev_arrow_, 1);  // entre el cuadradito y el rotulo
    list_next_arrow_ = make_arrow(MATERIAL_SYMBOLS_KEYBOARD_ARROW_RIGHT);

    lv_obj_t* spacer = lv_obj_create(head);
    lv_obj_set_style_bg_opa(spacer, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(spacer, 0, 0);
    lv_obj_set_height(spacer, 1);
    lv_obj_set_flex_grow(spacer, 1);
    pending_count_label_ = lv_label_create(head);
    lv_label_set_text(pending_count_label_, "");
    StyleTileText(pending_count_label_, kColorViolet);

    lv_obj_t* pending_body = MakeTransparentBox(tile, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_size(pending_body, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_style_pad_row(pending_body, 9, 0);

    for (int slot = 0; slot < kPendingSlotCount; slot++) {
        pending_row_list_[slot] = lv_label_create(pending_body);
        lv_obj_set_width(pending_row_list_[slot], LV_PCT(100));
        lv_label_set_long_mode(pending_row_list_[slot], LV_LABEL_LONG_DOT);
        lv_label_set_text(pending_row_list_[slot], "");
        StyleTileText(pending_row_list_[slot], kColorInk);
        lv_obj_add_flag(pending_row_list_[slot], LV_OBJ_FLAG_HIDDEN);
    }

    // El viaje vivia abajo de Einstein; ahora, abajo de los pendientes. Solo
    // aparece cuando el servidor tiene un destino.
    travel_tile_ = MakeTile(column, lv_color_hex(kColorGreen), nullptr);
    lv_obj_set_height(travel_tile_, LV_SIZE_CONTENT);
    travel_head_label_ = lv_label_create(travel_tile_);
    lv_obj_set_width(travel_head_label_, LV_PCT(100));
    lv_label_set_long_mode(travel_head_label_, LV_LABEL_LONG_DOT);
    lv_label_set_text(travel_head_label_, "");
    StyleTileText(travel_head_label_, kColorDim);
    travel_value_label_ = lv_label_create(travel_tile_);
    lv_label_set_text(travel_value_label_, "");
    StyleTileText(travel_value_label_, kColorInk);
    lv_obj_add_flag(travel_tile_, LV_OBJ_FLAG_HIDDEN);
}

void JarvisDashboardDisplay::BuildSideColumn(lv_obj_t* parent) {
    lv_obj_t* column = MakeTransparentBox(parent, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_height(column, LV_PCT(100));
    lv_obj_set_flex_grow(column, 1);
    lv_obj_set_style_pad_row(column, IsCompactScreen() ? 6 : kGap, 0);
    side_column_ = column;

    // De arriba hacia abajo, como en docs/vistas-tablero.md. El calendario se
    // queda con lo que sobre: la lista de eventos de hoy es lo primero que
    // cede si no hay alto (ver TodayEventCapacity).
    BuildCalendarTile(column);
    BuildWeatherTile(column);
#ifdef CONFIG_JARVIS_SCREEN_TALK_BUTTONS
    BuildTalkButtons(column);
#endif
}

void JarvisDashboardDisplay::BuildCalendarTile(lv_obj_t* parent) {
    const bool compact = IsCompactScreen();
    lv_obj_t* tile = MakeTile(parent, lv_color_hex(kColorSky), "CALENDARIO");
    lv_obj_set_flex_grow(tile, 1);
    lv_obj_set_style_pad_all(tile, compact ? 7 : 10, 0);
    lv_obj_set_style_pad_row(tile, 3, 0);
    // El rotulo del encabezado pasa a ser el mes ("OCTUBRE 2026").
    calendar_month_label_ = lv_obj_get_child(lv_obj_get_child(tile, 0), 1);

    lv_obj_t* grid = MakeTransparentBox(tile, LV_FLEX_FLOW_ROW);
    lv_obj_set_size(grid, LV_PCT(100), LV_SIZE_CONTENT);

    for (int column_index = 0; column_index < kWeekdayCount; column_index++) {
        lv_obj_t* column = lv_label_create(grid);
        lv_obj_set_flex_grow(column, 1);
        lv_obj_set_style_text_align(column, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_set_style_text_line_space(column, compact ? kCalendarLineSpaceCompact : 0, 0);
        lv_obj_clear_flag(column, LV_OBJ_FLAG_SCROLLABLE);
        // Los colores por dia (hoy, dias con eventos) van en el texto: solo
        // numeros, asi que el comando de color no puede chocar con el contenido.
        lv_label_set_recolor(column, true);
        StyleTileText(column, kColorInk);
        // Sin datos todavia: solo la inicial del dia y seis renglones vacios,
        // para que la grilla ya ocupe su alto definitivo desde el arranque.
        char text[48];
        snprintf(text, sizeof(text), "#%06X %s#\n\n\n\n\n\n", (unsigned)kColorDim,
                 kCalendarWeekdayInitialList[column_index]);
        lv_label_set_text(column, text);
        calendar_column_text_list_[column_index] = text;
        calendar_column_list_[column_index] = column;
    }

    // Recuadro de hoy: hijo de la columna que le toque, por encima del numero.
    // Solo borde (sin relleno) para no tapar el texto que queda debajo.
    calendar_today_marker_ = lv_obj_create(calendar_column_list_[0]);
    lv_obj_set_style_bg_opa(calendar_today_marker_, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_color(calendar_today_marker_, lv_color_hex(kColorTurquoise), 0);
    lv_obj_set_style_border_width(calendar_today_marker_, 2, 0);
    lv_obj_set_style_radius(calendar_today_marker_, 6, 0);
    lv_obj_set_style_pad_all(calendar_today_marker_, 0, 0);
    lv_obj_clear_flag(calendar_today_marker_, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(calendar_today_marker_, LV_OBJ_FLAG_HIDDEN);

    today_event_area_ = MakeTransparentBox(tile, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_width(today_event_area_, LV_PCT(100));
    lv_obj_set_flex_grow(today_event_area_, 1);
    for (int slot = 0; slot < kTodayEventSlotCount; slot++) {
        lv_obj_t* row = lv_label_create(today_event_area_);
        lv_obj_set_width(row, LV_PCT(100));
        lv_label_set_long_mode(row, LV_LABEL_LONG_DOT);
        lv_label_set_text(row, "");
        StyleTileText(row, kColorInk);
        lv_obj_add_flag(row, LV_OBJ_FLAG_HIDDEN);
        today_event_list_[slot] = row;
    }
}

void JarvisDashboardDisplay::BuildWeatherTile(lv_obj_t* parent) {
    const bool compact = IsCompactScreen();
    lv_obj_t* weather = MakeTile(parent, lv_color_hex(kColorSky), nullptr);
    lv_obj_set_height(weather, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(weather, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(weather, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_ver(weather, compact ? 4 : 8, 0);
    lv_obj_set_style_pad_column(weather, 12, 0);

    weather_temp_label_ = lv_label_create(weather);
    lv_obj_set_style_text_font(weather_temp_label_, BigFont(), 0);
    lv_label_set_text(weather_temp_label_, "--");
    StyleTileText(weather_temp_label_, kColorInk);

    lv_obj_t* meta = MakeTransparentBox(weather, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_height(meta, LV_SIZE_CONTENT);
    lv_obj_set_flex_grow(meta, 1);

    // Condicion y, al lado, el promedio del dolar blue. La condicion se estira
    // y se corta con puntos: el dolar es corto y se ve siempre entero.
    lv_obj_t* condition_row = MakeTransparentBox(meta, LV_FLEX_FLOW_ROW);
    lv_obj_set_size(condition_row, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_style_pad_column(condition_row, 8, 0);

    weather_cond_label_ = lv_label_create(condition_row);
    lv_obj_set_flex_grow(weather_cond_label_, 1);
    lv_label_set_long_mode(weather_cond_label_, LV_LABEL_LONG_DOT);
    lv_label_set_text(weather_cond_label_, "");
    StyleTileText(weather_cond_label_, kColorInk);

    weather_dollar_label_ = lv_label_create(condition_row);
    lv_label_set_text(weather_dollar_label_, "");
    StyleTileText(weather_dollar_label_, kColorGreen);
    lv_obj_add_flag(weather_dollar_label_, LV_OBJ_FLAG_HIDDEN);

    weather_detail_label_ = lv_label_create(meta);
    lv_obj_set_width(weather_detail_label_, LV_PCT(100));
    lv_label_set_long_mode(weather_detail_label_, LV_LABEL_LONG_DOT);
    lv_label_set_text(weather_detail_label_, "");
    StyleTileText(weather_detail_label_, kColorDim);
}

// La franja de conversacion es lo que antes decia Einstein: el estado del turno
// arriba y lo que oyo o dice Jarvis abajo. Va debajo de agenda y pendientes,
// con el ancho de las dos; la columna de la derecha ya no la lleva.
void JarvisDashboardDisplay::BuildConversationStrip(lv_obj_t* parent) {
    const bool compact = IsCompactScreen();
    lv_obj_t* tile = MakeTile(parent, lv_color_hex(kColorTurquoise), nullptr);
    lv_obj_set_height(tile, LV_SIZE_CONTENT);
    lv_obj_set_style_pad_ver(tile, compact ? 6 : 8, 0);
    lv_obj_set_style_pad_row(tile, 2, 0);
    conversation_strip_ = tile;

    // status_label_ y notification_label_ son de la clase base: LvglDisplay los
    // muestra y esconde entre si, y dereferencia UNO SIN CHEQUEAR NULL cuando
    // escribe en el otro (lvgl_display.cc:159 y :185). Si SetupUI no los crea,
    // la primera notificacion de wifi tira un LoadProhibited y la placa entra
    // en boot loop. Ocupan el mismo renglon: se ve uno u otro.
    status_label_ = lv_label_create(tile);
    lv_label_set_text(status_label_, Lang::Strings::STANDBY);
    lv_obj_set_width(status_label_, LV_PCT(100));
    lv_label_set_long_mode(status_label_, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_color(status_label_, accent_color_, 0);

    notification_label_ = lv_label_create(tile);
    lv_label_set_text(notification_label_, "");
    lv_obj_set_width(notification_label_, LV_PCT(100));
    lv_label_set_long_mode(notification_label_, LV_LABEL_LONG_DOT);
    StyleTileText(notification_label_, kColorInk);
    lv_obj_add_flag(notification_label_, LV_OBJ_FLAG_HIDDEN);

    // Alto fijo de kConversationTextLineCount renglones, con salto de linea
    // automatico y puntos suspensivos al final del ultimo: una respuesta larga
    // se corta prolija y no agranda la franja.
    conversation_say_label_ = lv_label_create(tile);
    lv_label_set_text(conversation_say_label_, "");
    lv_obj_set_width(conversation_say_label_, LV_PCT(100));
    lv_obj_set_height(conversation_say_label_,
                      kConversationTextLineCount * LineHeightOf(lv_screen_active()));
    lv_label_set_long_mode(conversation_say_label_, LV_LABEL_LONG_DOT);
    StyleTileText(conversation_say_label_, kColorInk);
}

lv_obj_t* JarvisDashboardDisplay::MakeTalkButton(lv_obj_t* parent, uint32_t accent,
                                                 const char* text, lv_obj_t** label_out) {
    lv_obj_t* button = lv_obj_create(parent);
    lv_obj_set_height(button, LV_PCT(100));
    lv_obj_set_flex_grow(button, 1);
    lv_obj_set_style_bg_color(button, lv_color_hex(kColorTile), 0);
    lv_obj_set_style_border_color(button, lv_color_hex(accent), 0);
    lv_obj_set_style_border_width(button, 2, 0);
    lv_obj_set_style_radius(button, 12, 0);
    lv_obj_set_style_pad_all(button, 0, 0);
    lv_obj_set_scrollbar_mode(button, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(button, LV_OBJ_FLAG_SCROLLABLE);

    // La fuente se hereda, como en todo el tablero (ver StyleTileText).
    lv_obj_t* label = lv_label_create(button);
    lv_label_set_text(label, text);
    StyleTileText(label, accent);
    lv_obj_center(label);
    *label_out = label;
    return button;
}

void JarvisDashboardDisplay::BuildTalkButtons(lv_obj_t* parent) {
    lv_obj_t* row = MakeTransparentBox(parent, LV_FLEX_FLOW_ROW);
    lv_obj_set_size(row, LV_PCT(100),
                    IsCompactScreen() ? kTalkButtonCompactHeight : kTalkButtonHeight);
    lv_obj_set_style_pad_column(row, kGap, 0);

    talk_button_ = MakeTalkButton(row, kColorTurquoise, "Hablar", &talk_button_label_);
    send_button_ = MakeTalkButton(row, kColorTangerine, "Enviar", &send_button_label_);
    // Arranca en reposo: Enviar apagado hasta que haya algo que enviar.
    lv_obj_set_style_opa(send_button_, LV_OPA_40, 0);
}

void JarvisDashboardDisplay::BuildHouseView(lv_obj_t* parent) {
    house_view_ = MakeTransparentBox(parent, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_width(house_view_, LV_PCT(100));
    lv_obj_set_flex_grow(house_view_, 1);
    lv_obj_set_style_pad_row(house_view_, kGap, 0);
    lv_obj_add_flag(house_view_, LV_OBJ_FLAG_HIDDEN);

    // Grilla fija de 4x3: cada mosaico tiene su celda aunque este escondido,
    // asi que mostrar uno mas no corre a los demas.
    lv_obj_t* grid = lv_obj_create(house_view_);
    lv_obj_set_width(grid, LV_PCT(100));
    lv_obj_set_flex_grow(grid, 1);
    lv_obj_set_style_bg_opa(grid, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(grid, 0, 0);
    lv_obj_set_style_radius(grid, 0, 0);
    lv_obj_set_style_pad_all(grid, 0, 0);
    lv_obj_set_style_pad_column(grid, kGap, 0);
    lv_obj_set_style_pad_row(grid, kGap, 0);
    lv_obj_set_grid_dsc_array(grid, kHomeGridColumnList, kHomeGridRowList);
    lv_obj_set_scrollbar_mode(grid, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(grid, LV_OBJ_FLAG_SCROLLABLE);

    for (int slot = 0; slot < kHomeTileSlotCount; slot++) {
        BuildHomeTile(grid, slot);
    }

    home_empty_label_ = lv_label_create(grid);
    lv_obj_add_flag(home_empty_label_, LV_OBJ_FLAG_IGNORE_LAYOUT);
    lv_obj_set_width(home_empty_label_, LV_PCT(80));
    lv_label_set_long_mode(home_empty_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(home_empty_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(home_empty_label_, "Etiquetá entidades con 'jarvis' en Home Assistant");
    StyleTileText(home_empty_label_, kColorDim);
    lv_obj_center(home_empty_label_);

    BuildDollarStrip(house_view_);
}

// Todas las piezas de todos los tipos, creadas una vez. Posiciones absolutas
// dentro del mosaico en vez de filas flex: cinco objetos por mosaico y no
// ocho, y nada se recalcula cuando cambia un texto.
void JarvisDashboardDisplay::BuildHomeTile(lv_obj_t* parent, int slot) {
    HomeTileWidgets& widgets = home_tile_widget_list_[slot];
    const int pad = IsCompactScreen() ? 8 : 10;

    lv_obj_t* tile = lv_obj_create(parent);
    lv_obj_set_grid_cell(tile, LV_GRID_ALIGN_STRETCH, slot % kHomeGridColumnCount, 1,
                         LV_GRID_ALIGN_STRETCH, slot / kHomeGridColumnCount, 1);
    lv_obj_set_style_bg_color(tile, lv_color_hex(kColorTile), 0);
    lv_obj_set_style_border_color(tile, lv_color_hex(kColorTileLine), 0);
    lv_obj_set_style_border_width(tile, 1, 0);
    lv_obj_set_style_radius(tile, 9, 0);
    lv_obj_set_style_pad_all(tile, pad, 0);
    lv_obj_set_scrollbar_mode(tile, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(tile, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(tile, LV_OBJ_FLAG_HIDDEN);
    widgets.tile = tile;

    widgets.name_label = lv_label_create(tile);
    lv_obj_set_width(widgets.name_label, LV_PCT(100));
    lv_label_set_long_mode(widgets.name_label, LV_LABEL_LONG_DOT);
    lv_label_set_text(widgets.name_label, "");
    StyleTileText(widgets.name_label, kColorDim);
    lv_obj_align(widgets.name_label, LV_ALIGN_TOP_LEFT, 0, 0);

    widgets.value_label = lv_label_create(tile);
    lv_obj_set_width(widgets.value_label, LV_PCT(100));
    lv_label_set_long_mode(widgets.value_label, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_align(widgets.value_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_font(widgets.value_label, BigFont(), 0);
    lv_label_set_text(widgets.value_label, "");
    StyleTileText(widgets.value_label, kColorInk);
    lv_obj_align(widgets.value_label, LV_ALIGN_CENTER, 0, 0);

    widgets.detail_label = lv_label_create(tile);
    lv_obj_set_width(widgets.detail_label, LV_PCT(100));
    lv_label_set_long_mode(widgets.detail_label, LV_LABEL_LONG_DOT);
    lv_label_set_text(widgets.detail_label, "");
    StyleTileText(widgets.detail_label, kColorDim);
    lv_obj_align(widgets.detail_label, LV_ALIGN_BOTTOM_LEFT, 0, 0);

    // Los botones - y + son labels con fondo: un objeto cada uno. Se crean
    // despues del valor para quedar por encima si algun texto largo llegara
    // hasta los costados.
    auto make_button = [tile](const char* text, lv_align_t align) {
        lv_obj_t* button = lv_label_create(tile);
        lv_obj_set_size(button, kClimateButtonSize, kClimateButtonSize);
        lv_obj_set_style_text_font(button, BigFont(), 0);
        lv_obj_set_style_text_align(button, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_set_style_bg_color(button, lv_color_hex(kColorTileLine), 0);
        lv_obj_set_style_bg_opa(button, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(button, 8, 0);
        lv_obj_set_style_pad_all(button, 0, 0);
        lv_label_set_text(button, text);
        StyleTileText(button, kColorInk);
        lv_obj_align(button, align, 0, 0);
        lv_obj_add_flag(button, LV_OBJ_FLAG_HIDDEN);
        return button;
    };
    widgets.minus_button = make_button("-", LV_ALIGN_LEFT_MID);
    widgets.plus_button = make_button("+", LV_ALIGN_RIGHT_MID);
}

void JarvisDashboardDisplay::BuildDollarStrip(lv_obj_t* parent) {
    const bool compact = IsCompactScreen();
    dollar_strip_ = MakeTile(parent, lv_color_hex(kColorGreen), nullptr);
    lv_obj_set_height(dollar_strip_, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(dollar_strip_, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(dollar_strip_, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_ver(dollar_strip_, compact ? 2 : 6, 0);
    lv_obj_set_style_pad_column(dollar_strip_, 12, 0);

    auto make_label = [this](const char* text, uint32_t color, bool big) {
        lv_obj_t* label = lv_label_create(dollar_strip_);
        if (big) {
            lv_obj_set_style_text_font(label, BigFont(), 0);
        }
        lv_label_set_text(label, text);
        StyleTileText(label, color);
        return label;
    };
    make_label("DÓLAR BLUE", kColorGreen, false);
    make_label("Compra", kColorDim, false);
    dollar_buy_label_ = make_label("--", kColorInk, true);
    make_label("Venta", kColorDim, false);
    dollar_sell_label_ = make_label("--", kColorInk, true);

    lv_obj_t* spacer = lv_obj_create(dollar_strip_);
    lv_obj_set_style_bg_opa(spacer, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(spacer, 0, 0);
    lv_obj_set_height(spacer, 1);
    lv_obj_set_flex_grow(spacer, 1);

    dollar_updated_label_ = make_label("", kColorDim, false);
    lv_obj_add_flag(dollar_strip_, LV_OBJ_FLAG_HIDDEN);
}

JarvisDashboardDisplay::TouchTarget JarvisDashboardDisplay::HitTest(int x, int y) {
    DisplayLockGuard lock(this);
    TouchTarget target;
    // Un recordatorio a pantalla completa tapa todo y se lleva el toque.
    if (reminder_overlay_ != nullptr && !lv_obj_has_flag(reminder_overlay_, LV_OBJ_FLAG_HIDDEN)) {
        return target;
    }

    // Agenda v2: el detalle y la vista de un dia se adueñan del toque. Nada de
    // lo de abajo (pestañas, botones, mosaicos) responde mientras esten
    // abiertos; deslizar tampoco (ShowAdjacentView). Un toque sobre nada da
    // kOverlayBlock y no kNone, para que no viaje como tap al servidor ni se
    // vuelva push-to-talk.
    if (!IsHidden(event_modal_)) {
        if (IsInside(event_close_button_, x, y, kOverlayButtonHitMargin) ||
            !IsInside(event_card_, x, y, 0)) {
            // Tocar afuera de la tarjeta tambien cierra, como en el celular.
            target.kind = TouchTargetKind::kModalClose;
        } else {
            target.kind = TouchTargetKind::kOverlayBlock;
        }
        return target;
    }
    if (!IsHidden(day_view_)) {
        target.kind = TouchTargetKind::kOverlayBlock;
        if (IsInside(day_cancel_button_, x, y, kOverlayButtonHitMargin)) {
            target.kind = TouchTargetKind::kDayCancel;
            return target;
        }
        for (int slot = 0; slot < kDayEntrySlotCount; slot++) {
            if (day_slot_entry_list_[slot] >= 0 && IsInside(day_row_list_[slot].row, x, y, 0)) {
                target.kind = TouchTargetKind::kDayRow;
                target.index = day_slot_entry_list_[slot];
                return target;
            }
        }
        return target;
    }

    // Las pestañas son chicas (el texto y poco más, en una barra de 34 px): con
    // 10 px de margen un dedo las erraba y el toque terminaba como tap común
    // (se oía el error de "sin servidor" y la vista no cambiaba). La zona de
    // cada una se estira a lo ancho y llega hasta el borde de arriba.
    // Si las zonas estiradas de dos pestañas se pisan, gana la más cercana.
    int best_distance = 1 << 30;
    for (int view = 0; view < kViewCount; view++) {
        lv_obj_t* tab = tab_label_list_[view];
        if (tab == nullptr) {
            continue;
        }
        lv_area_t area;
        lv_obj_get_coords(tab, &area);
        if (x >= area.x1 - kTabHitMargin && x <= area.x2 + kTabHitMargin && y >= 0 &&
            y <= area.y2 + kTabHitMarginBelow) {
            const int distance = abs(x - (area.x1 + area.x2) / 2);
            if (distance < best_distance) {
                best_distance = distance;
                target.kind = TouchTargetKind::kTab;
                target.index = view;
            }
        }
    }
    if (target.kind == TouchTargetKind::kTab) {
        return target;
    }

    if (current_view_ == View::kOverview) {
        if (IsInside(talk_button_, x, y, 0)) {
            target.kind = TouchTargetKind::kTalk;
        } else if (IsInside(send_button_, x, y, 0)) {
            target.kind = TouchTargetKind::kSend;
        }
        if (target.kind != TouchTargetKind::kNone) {
            return target;
        }
        // Flechas de Pendientes/Compras (solo visibles con las dos listas).
        if (IsInside(list_prev_arrow_, x, y, kListArrowHitMargin)) {
            target.kind = TouchTargetKind::kListSwitch;
            target.index = -1;
            return target;
        }
        if (IsInside(list_next_arrow_, x, y, kListArrowHitMargin)) {
            target.kind = TouchTargetKind::kListSwitch;
            target.index = 1;
            return target;
        }
        for (int slot = 0; slot < agenda_shown_count_; slot++) {
            if (IsInside(agenda_row_list_[slot].row, x, y, 0)) {
                target.kind = TouchTargetKind::kAgendaRow;
                target.index = slot;
                return target;
            }
        }
        // Un dia del mes: cada columna del calendario es un label con la
        // inicial y seis semanas, un renglon por semana.
        if (calendar_valid_) {
            for (int column_index = 0; column_index < kWeekdayCount; column_index++) {
                lv_obj_t* column = calendar_column_list_[column_index];
                if (!IsInside(column, x, y, 0)) {
                    continue;
                }
                lv_area_t area;
                lv_obj_get_coords(column, &area);
                const int pitch = std::max(
                    1, LineHeightOf(column) +
                           (int)lv_obj_get_style_text_line_space(column, LV_PART_MAIN));
                const int row = (y - area.y1) / pitch;  // 0 = la inicial del dia
                const int day = (row - 1) * kWeekdayCount + column_index -
                                calendar_first_weekday_ + 1;
                if (row >= 1 && row <= 6 && day >= 1 && day <= calendar_day_count_) {
                    target.kind = TouchTargetKind::kCalendarDay;
                    target.index = day;
                }
                break;
            }
        }
        return target;
    }

    for (int slot = 0; slot < home_tile_count_; slot++) {
        const HomeTile& tile = home_tile_list_[slot];
        const HomeTileWidgets& widgets = home_tile_widget_list_[slot];
        // Un mosaico no disponible no se toca: el toque sigue siendo un tap
        // comun (cortar a Jarvis si esta hablando, por ejemplo).
        if (!tile.available || IsHidden(widgets.tile)) {
            continue;
        }
        if (tile.kind == HomeTileKind::kClimate) {
            if (IsInside(widgets.minus_button, x, y, kClimateButtonHitMargin)) {
                target.kind = TouchTargetKind::kClimateDown;
                target.index = slot;
                return target;
            }
            if (IsInside(widgets.plus_button, x, y, kClimateButtonHitMargin)) {
                target.kind = TouchTargetKind::kClimateUp;
                target.index = slot;
                return target;
            }
        } else if (tile.kind == HomeTileKind::kToggle && IsInside(widgets.tile, x, y, 0)) {
            target.kind = TouchTargetKind::kTileToggle;
            target.index = slot;
            return target;
        }
    }
    return target;
}

bool JarvisDashboardDisplay::ApplyTileAction(const TouchTarget& target, std::string* entity_id,
                                             const char** action) {
    DisplayLockGuard lock(this);
    if (target.index < 0 || target.index >= home_tile_count_) {
        return false;
    }
    HomeTile& tile = home_tile_list_[target.index];
    if (!tile.available) {
        return false;
    }
    switch (target.kind) {
        case TouchTargetKind::kTileToggle:
            if (tile.kind != HomeTileKind::kToggle) {
                return false;
            }
            tile.is_on = !tile.is_on;
            *action = "toggle";
            break;
        case TouchTargetKind::kClimateDown:
        case TouchTargetKind::kClimateUp: {
            if (tile.kind != HomeTileKind::kClimate) {
                return false;
            }
            const bool going_up = target.kind == TouchTargetKind::kClimateUp;
            // Mismo paso que aplica el servidor (objetivo +- 0,5).
            if (tile.has_target) {
                tile.target_c += going_up ? 0.5f : -0.5f;
            }
            *action = going_up ? "climate_up" : "climate_down";
            break;
        }
        default:
            return false;
    }
    *entity_id = tile.entity_id;
    // Se pinta ya: el servidor empuja el tablero apenas Home Assistant
    // contesta, y ese tablero confirma o corrige lo que se ve ahora.
    PaintHomeTile(target.index);
    return true;
}

void JarvisDashboardDisplay::ApplyAgendaTouch(const TouchTarget& target) {
    DisplayLockGuard lock(this);
    switch (target.kind) {
        case TouchTargetKind::kAgendaRow:
            // El renglon se resolvio al apoyar el dedo; si entre tanto llego
            // una agenda mas corta, el toque ya no apunta a nada.
            if (IsHidden(day_view_) && target.index >= 0 &&
                target.index < agenda_shown_count_ &&
                target.index < (int)agenda_entry_list_.size()) {
                ShowEventModal(agenda_entry_list_[target.index]);
            }
            break;
        case TouchTargetKind::kDayRow:
            if (!IsHidden(day_view_) && target.index >= 0 &&
                target.index < (int)day_entry_list_.size()) {
                ShowEventModal(day_entry_list_[target.index]);
            }
            break;
        case TouchTargetKind::kModalClose:
            CloseEventModal();
            break;
        case TouchTargetKind::kDayCancel:
            CloseDayView();
            break;
        case TouchTargetKind::kListSwitch: {
            const TodoList& pending = todo_list_list_[(int)TodoListKind::kPending];
            const TodoList& shopping = todo_list_list_[(int)TodoListKind::kShopping];
            if (!pending.present || !shopping.present) {
                break;
            }
            // Son dos listas: cualquiera de las flechas pasa a la otra.
            active_todo_list_ = ShownTodoList() == TodoListKind::kPending
                                    ? TodoListKind::kShopping
                                    : TodoListKind::kPending;
            ESP_LOGI(TAG, "tarjeta del medio: %s",
                     active_todo_list_ == TodoListKind::kPending ? "pendientes" : "compras");
            PaintTodoCard();
            break;
        }
        default:
            break;
    }
}

bool JarvisDashboardDisplay::IsAgendaOverlayOpen() {
    DisplayLockGuard lock(this);
    return !IsHidden(event_modal_) || !IsHidden(day_view_);
}

JarvisDashboardDisplay::TodoListKind JarvisDashboardDisplay::ShownTodoList() {
    const TodoListKind other = active_todo_list_ == TodoListKind::kPending
                                   ? TodoListKind::kShopping
                                   : TodoListKind::kPending;
    if (!todo_list_list_[(int)active_todo_list_].present &&
        todo_list_list_[(int)other].present) {
        return other;
    }
    return active_todo_list_;
}

// La tarjeta del medio muestra la lista elegida (o la unica que vino). La
// eleccion no se pisa cuando una lista desaparece un rato: vuelve sola cuando
// la lista vuelve a venir.
void JarvisDashboardDisplay::PaintTodoCard() {
    const TodoListKind shown = ShownTodoList();
    const TodoList& list = todo_list_list_[(int)shown];
    const bool both = todo_list_list_[0].present && todo_list_list_[1].present;
    SetHidden(list_prev_arrow_, !both);
    SetHidden(list_next_arrow_, !both);

    const char* fallback_name = shown == TodoListKind::kPending ? "PENDIENTES" : "COMPRAS";
    const std::string heading = list.list_name.empty() ? fallback_name : UpperAscii(list.list_name);
    SetLabelText(pending_title_label_, heading.c_str());

    for (int slot = 0; slot < kPendingSlotCount; slot++) {
        const bool used = list.present && slot < (int)list.item_list.size();
        if (used) {
            // El punto va en el texto: un objeto menos por fila, y son cuatro.
            const std::string bulleted = "- " + list.item_list[slot];
            SetLabelText(pending_row_list_[slot], bulleted.c_str());
        }
        SetHidden(pending_row_list_[slot], !used);
    }
    char count_text[8];
    snprintf(count_text, sizeof(count_text), "%d", list.count);
    SetLabelText(pending_count_label_, list.present && list.has_count ? count_text : "");
}

// ---- Vista de un dia y detalle de un evento (Agenda v2) ---------------------

lv_obj_t* JarvisDashboardDisplay::MakeOverlayButton(lv_obj_t* parent, uint32_t accent,
                                                    const char* text) {
    lv_obj_t* button = lv_obj_create(parent);
    lv_obj_set_size(button, ScaledWidth(200), IsCompactScreen() ? 48 : 56);
    lv_obj_set_style_bg_color(button, lv_color_hex(kColorTile), 0);
    lv_obj_set_style_border_color(button, lv_color_hex(accent), 0);
    lv_obj_set_style_border_width(button, 2, 0);
    lv_obj_set_style_radius(button, 12, 0);
    lv_obj_set_style_pad_all(button, 0, 0);
    lv_obj_set_scrollbar_mode(button, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(button, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_t* label = lv_label_create(button);
    lv_label_set_text(label, text);
    StyleTileText(label, accent);
    lv_obj_center(label);
    return button;
}

// Pantalla completa, como el recordatorio: encabezado con la fecha, dos
// columnas de renglones (los mismos de Inicio) y Cancelar abajo.
void JarvisDashboardDisplay::BuildDayView(lv_obj_t* parent) {
    const bool compact = IsCompactScreen();
    day_view_ = lv_obj_create(parent);
    lv_obj_set_size(day_view_, LV_HOR_RES, LV_VER_RES);
    lv_obj_align(day_view_, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_set_style_bg_color(day_view_, lv_color_hex(kColorScreen), 0);
    lv_obj_set_style_bg_opa(day_view_, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(day_view_, lv_color_hex(kColorTangerine), 0);
    lv_obj_set_style_border_width(day_view_, 3, 0);
    lv_obj_set_style_radius(day_view_, 0, 0);
    lv_obj_set_style_pad_all(day_view_, compact ? 12 : 18, 0);
    lv_obj_set_style_pad_row(day_view_, compact ? 8 : 12, 0);
    lv_obj_set_flex_flow(day_view_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(day_view_, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);
    lv_obj_set_scrollbar_mode(day_view_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(day_view_, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t* head = MakeTransparentBox(day_view_, LV_FLEX_FLOW_ROW);
    lv_obj_set_size(head, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_style_pad_column(head, 12, 0);
    lv_obj_set_flex_align(head, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_t* tag = lv_label_create(head);
    lv_label_set_text(tag, "AGENDA");
    lv_obj_set_style_text_letter_space(tag, 3, 0);
    StyleTileText(tag, kColorTangerine);
    day_heading_label_ = lv_label_create(head);
    lv_obj_set_flex_grow(day_heading_label_, 1);
    lv_label_set_long_mode(day_heading_label_, LV_LABEL_LONG_DOT);
    lv_label_set_text(day_heading_label_, "");
    StyleTileText(day_heading_label_, kColorInk);

    day_list_area_ = MakeTransparentBox(day_view_, LV_FLEX_FLOW_ROW);
    lv_obj_set_width(day_list_area_, LV_PCT(100));
    lv_obj_set_flex_grow(day_list_area_, 1);
    lv_obj_set_style_pad_column(day_list_area_, 2 * kGap, 0);
    constexpr int kRowsPerColumn = kDayEntrySlotCount / kDayColumnCount;
    for (int column_index = 0; column_index < kDayColumnCount; column_index++) {
        lv_obj_t* column = MakeTransparentBox(day_list_area_, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_height(column, LV_PCT(100));
        lv_obj_set_flex_grow(column, 1);
        day_column_list_[column_index] = column;
        for (int row = 0; row < kRowsPerColumn; row++) {
            BuildAgendaRow(column, day_row_list_[column_index * kRowsPerColumn + row]);
        }
    }

    // "Cargando...", "No pude traer la agenda", "Sin eventos": en el medio
    // de la lista, fuera del flex.
    day_message_label_ = lv_label_create(day_list_area_);
    lv_obj_add_flag(day_message_label_, LV_OBJ_FLAG_IGNORE_LAYOUT);
    lv_label_set_text(day_message_label_, "");
    StyleTileText(day_message_label_, kColorDim);
    lv_obj_center(day_message_label_);

    day_cancel_button_ = MakeOverlayButton(day_view_, kColorTangerine, "Cancelar");
    lv_obj_add_flag(day_view_, LV_OBJ_FLAG_HIDDEN);
}

// Detalle: tarjeta centrada sobre el tablero oscurecido. Se crea despues de la
// vista de un dia para quedar por encima de ella.
void JarvisDashboardDisplay::BuildEventModal(lv_obj_t* parent) {
    const bool compact = IsCompactScreen();
    event_modal_ = lv_obj_create(parent);
    lv_obj_set_size(event_modal_, LV_HOR_RES, LV_VER_RES);
    lv_obj_align(event_modal_, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_set_style_bg_color(event_modal_, lv_color_hex(kColorScreen), 0);
    lv_obj_set_style_bg_opa(event_modal_, LV_OPA_80, 0);
    lv_obj_set_style_border_width(event_modal_, 0, 0);
    lv_obj_set_style_radius(event_modal_, 0, 0);
    lv_obj_set_style_pad_all(event_modal_, 0, 0);
    lv_obj_set_scrollbar_mode(event_modal_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(event_modal_, LV_OBJ_FLAG_SCROLLABLE);

    const int card_width = std::min((int)LV_HOR_RES - 80, ScaledWidth(600));
    const int pad = compact ? 16 : 22;
    constexpr int kBorder = 2;
    event_text_width_ = card_width - 2 * pad - 2 * kBorder;

    event_card_ = lv_obj_create(event_modal_);
    lv_obj_set_size(event_card_, card_width, LV_SIZE_CONTENT);
    lv_obj_set_style_max_height(event_card_, LV_VER_RES - 24, 0);
    lv_obj_set_style_bg_color(event_card_, lv_color_hex(kColorTile), 0);
    lv_obj_set_style_bg_opa(event_card_, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(event_card_, lv_color_hex(kColorTangerine), 0);
    lv_obj_set_style_border_width(event_card_, kBorder, 0);
    lv_obj_set_style_radius(event_card_, 12, 0);
    lv_obj_set_style_pad_all(event_card_, pad, 0);
    lv_obj_set_style_pad_row(event_card_, compact ? 6 : 9, 0);
    lv_obj_set_flex_flow(event_card_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scrollbar_mode(event_card_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(event_card_, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_center(event_card_);

    // Encabezado: icono de la categoria y su nombre.
    lv_obj_t* head = MakeTransparentBox(event_card_, LV_FLEX_FLOW_ROW);
    lv_obj_set_size(head, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_style_pad_column(head, 8, 0);
    lv_obj_set_flex_align(head, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    event_icon_label_ = lv_label_create(head);
    lv_obj_set_style_text_font(event_icon_label_, IconFont(), 0);
    lv_obj_set_width(event_icon_label_, kAgendaIconWidth);
    lv_obj_set_style_text_align(event_icon_label_, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(event_icon_label_, "");
    event_icon_dot_ = lv_obj_create(event_icon_label_);
    lv_obj_set_size(event_icon_dot_, kAgendaDotSize, kAgendaDotSize);
    lv_obj_set_style_radius(event_icon_dot_, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(event_icon_dot_, 0, 0);
    lv_obj_clear_flag(event_icon_dot_, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_center(event_icon_dot_);
    event_category_label_ = lv_label_create(head);
    lv_label_set_text(event_category_label_, "");
    lv_obj_set_style_text_letter_space(event_category_label_, 2, 0);
    StyleTileText(event_category_label_, kColorDim);

    // Titulo completo con la fuente grande (la de 30 px en flash, ver arriba).
    auto make_text = [this](uint32_t color, bool big) {
        lv_obj_t* label = lv_label_create(event_card_);
        if (big) {
            lv_obj_set_style_text_font(label, BigFont(), 0);
        }
        lv_obj_set_width(label, LV_PCT(100));
        lv_label_set_long_mode(label, LV_LABEL_LONG_DOT);
        lv_label_set_text(label, "");
        StyleTileText(label, color);
        return label;
    };
    event_title_label_ = make_text(kColorInk, true);
    event_when_label_ = make_text(kColorTangerine, false);
    event_location_label_ = make_text(kColorInk, false);
    event_description_label_ = make_text(kColorDim, false);

    // Abajo: el origen a la izquierda y Cerrar a la derecha, en un renglon.
    lv_obj_t* foot = MakeTransparentBox(event_card_, LV_FLEX_FLOW_ROW);
    lv_obj_set_size(foot, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_style_pad_top(foot, 4, 0);
    lv_obj_set_style_pad_column(foot, 12, 0);
    lv_obj_set_flex_align(foot, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    event_source_label_ = lv_label_create(foot);
    lv_obj_set_flex_grow(event_source_label_, 1);
    lv_label_set_long_mode(event_source_label_, LV_LABEL_LONG_DOT);
    lv_label_set_text(event_source_label_, "");
    StyleTileText(event_source_label_, kColorDim);
    event_close_button_ = MakeOverlayButton(foot, kColorTangerine, "Cerrar");
    lv_obj_set_width(event_close_button_, ScaledWidth(150));

    lv_obj_add_flag(event_modal_, LV_OBJ_FLAG_HIDDEN);
}

void JarvisDashboardDisplay::ShowEventModal(const AgendaEntry& entry) {
    if (event_modal_ == nullptr) {
        return;
    }
    const AgendaCategory& look = kAgendaCategoryList[AgendaCategoryIndex(entry.icon)];
    SetLabelText(event_icon_label_, look.glyph == nullptr ? "" : look.glyph);
    lv_obj_set_style_text_color(event_icon_label_, lv_color_hex(look.color), 0);
    lv_obj_set_style_bg_color(event_icon_dot_, lv_color_hex(look.color), 0);
    SetHidden(event_icon_dot_, look.glyph != nullptr);
    SetLabelText(event_category_label_, look.heading);

    const AgendaDetail& detail = entry.detail;
    const std::string& title =
        entry.has_detail && !detail.full_title.empty() ? detail.full_title : entry.title;
    SetClampedText(event_title_label_, title, event_text_width_, kEventTitleMaxLines);

    // "jueves 23 de octubre · 11:00 a 12:00"; sin detalle (servidor viejo),
    // el "cuando" corto de la agenda.
    std::string when;
    if (entry.has_detail) {
        when = detail.date_label;
        if (!detail.time_label.empty()) {
            when += (when.empty() ? "" : " · ") + detail.time_label;
        }
    }
    if (when.empty()) {
        when = entry.when_label;
    }
    SetClampedText(event_when_label_, when, event_text_width_, 1);
    SetClampedText(event_location_label_,
                   detail.location.empty() ? std::string() : "Lugar: " + detail.location,
                   event_text_width_, kEventLocationMaxLines);
    SetClampedText(event_description_label_, detail.description, event_text_width_,
                   kEventDescriptionMaxLines);
    SetLabelText(event_source_label_, detail.source_label.c_str());

    SetHidden(event_modal_, false);
    // Mismo motivo que el recordatorio: en direct_mode + full_refresh
    // mostrar un objeto no alcanza, hay que repintar la pantalla entera.
    lv_obj_invalidate(lv_screen_active());
    if (!entry.id.empty()) {
        ESP_LOGI(TAG, "detalle de evento: %s", entry.id.c_str());
    }
}

void JarvisDashboardDisplay::CloseEventModal() {
    if (IsHidden(event_modal_)) {
        return;
    }
    SetHidden(event_modal_, true);
    lv_obj_invalidate(lv_screen_active());
}

void JarvisDashboardDisplay::CloseDayView() {
    if (day_timeout_timer_ != nullptr) {
        esp_timer_stop(day_timeout_timer_);
    }
    day_view_state_ = DayViewState::kClosed;
    if (IsHidden(day_view_)) {
        return;
    }
    SetHidden(day_view_, true);
    lv_obj_invalidate(lv_screen_active());
}

void JarvisDashboardDisplay::CloseAgendaOverlays() {
    CloseEventModal();
    CloseDayView();
}

void JarvisDashboardDisplay::SetDayViewMessage(const char* message) {
    SetLabelText(day_message_label_, message);
    SetHidden(day_message_label_, message == nullptr || message[0] == '\0');
}

// Renglones por columna de la vista de un dia. La columna se midio en
// SetupUI (escondida conserva su tamaño); el alto del renglon sale de la
// fuente actual, que Assets::Apply puede cambiar despues del arranque.
int JarvisDashboardDisplay::DayRowCapacity() {
    if (day_column_list_[0] == nullptr) {
        return 0;
    }
    const int capacity = (int)lv_obj_get_content_height(day_column_list_[0]) /
                         std::max(1, AgendaRowHeight());
    return std::min(std::max(capacity, 0), (int)(kDayEntrySlotCount / kDayColumnCount));
}

bool JarvisDashboardDisplay::OpenDayView(int day, std::string* date) {
    DisplayLockGuard lock(this);
    if (day_view_ == nullptr || !calendar_valid_ || day < 1 || day > calendar_day_count_ ||
        !IsHidden(event_modal_)) {
        return false;
    }
    char date_text[40];
    snprintf(date_text, sizeof(date_text), "%04d-%02d-%02d", calendar_year_, calendar_month_,
             day);
    *date = date_text;
    day_view_date_ = date_text;

    // Fecha provisoria hasta que llegue la del servidor (mismo formato).
    char heading[64];
    snprintf(heading, sizeof(heading), "%s %d de %s",
             kWeekdayNameList[(calendar_first_weekday_ + day - 1) % kWeekdayCount], day,
             kMonthLowerNameList[(calendar_month_ - 1) % 12]);
    SetLabelText(day_heading_label_, heading);

    day_entry_list_.clear();
    day_shown_count_ = 0;
    for (int slot = 0; slot < kDayEntrySlotCount; slot++) {
        day_slot_entry_list_[slot] = -1;
        SetHidden(day_row_list_[slot].row, true);
    }
    // La fuente no tiene "…": tres puntos, como en el resto del tablero.
    SetDayViewMessage("Cargando...");
    day_view_state_ = DayViewState::kLoading;
    day_request_started_us_ = esp_timer_get_time();
    if (day_timeout_timer_ != nullptr) {
        esp_timer_stop(day_timeout_timer_);
        esp_timer_start_once(day_timeout_timer_, kDayRequestTimeoutMicroseconds);
    }

    SetHidden(day_view_, false);
    lv_obj_invalidate(lv_screen_active());
    ESP_LOGI(TAG, "vista del dia %s", date_text);
    return true;
}

void JarvisDashboardDisplay::OnDayTimeout() {
    DisplayLockGuard lock(this);
    // El temporizador de un pedido anterior pudo haber disparado justo antes
    // de reiniciarse: solo cuenta si este pedido ya cumplio sus 5 s.
    if (day_view_state_ != DayViewState::kLoading ||
        esp_timer_get_time() - day_request_started_us_ < kDayRequestTimeoutMicroseconds - 50000) {
        return;
    }
    day_view_state_ = DayViewState::kFailed;
    SetDayViewMessage("No pude traer la agenda");
    ESP_LOGW(TAG, "agenda_day %s: sin respuesta en 5 s", day_view_date_.c_str());
}

void JarvisDashboardDisplay::SetAgendaDay(const std::string& date, const std::string& date_label,
                                          const std::vector<AgendaEntry>& entry_list) {
    DisplayLockGuard lock(this);
    // Una respuesta tardia todavia sirve (corrige el "No pude traer"); una de
    // otro dia o con la vista cerrada, no.
    if (day_view_state_ == DayViewState::kClosed || date != day_view_date_) {
        ESP_LOGI(TAG, "agenda_day %s ignorada (vista: %s)", date.c_str(),
                 day_view_state_ == DayViewState::kClosed ? "cerrada" : day_view_date_.c_str());
        return;
    }
    if (day_timeout_timer_ != nullptr) {
        esp_timer_stop(day_timeout_timer_);
    }
    day_view_state_ = DayViewState::kLoaded;
    if (!date_label.empty()) {
        SetLabelText(day_heading_label_, date_label.c_str());
    }

    constexpr int kRowsPerColumn = kDayEntrySlotCount / kDayColumnCount;
    const int per_column = std::max(1, std::min(DayRowCapacity(), kRowsPerColumn));
    day_entry_list_.assign(entry_list.begin(),
                           entry_list.begin() + std::min((int)entry_list.size(),
                                                         (int)kDayEntrySlotCount));
    day_shown_count_ = std::min((int)day_entry_list_.size(), per_column * kDayColumnCount);
    for (int slot = 0; slot < kDayEntrySlotCount; slot++) {
        day_slot_entry_list_[slot] = -1;
    }
    // Primero se llena la columna de la izquierda, despues la de la derecha.
    for (int index = 0; index < day_shown_count_; index++) {
        const int slot = (index / per_column) * kRowsPerColumn + index % per_column;
        day_slot_entry_list_[slot] = index;
        PaintAgendaRow(day_row_list_[slot], day_entry_list_[index], day_row_width_);
    }
    for (int slot = 0; slot < kDayEntrySlotCount; slot++) {
        SetHidden(day_row_list_[slot].row, day_slot_entry_list_[slot] < 0);
    }
    SetDayViewMessage(day_entry_list_.empty() ? "Sin eventos" : "");
    ESP_LOGI(TAG, "agenda_day %s: %d eventos, se ven %d", date.c_str(),
             (int)entry_list.size(), day_shown_count_);
}

void JarvisDashboardDisplay::ShowView(View view) {
    DisplayLockGuard lock(this);
    if (overview_view_ == nullptr || house_view_ == nullptr || view == current_view_) {
        return;
    }
    current_view_ = view;
    SetHidden(overview_view_, view != View::kOverview);
    SetHidden(house_view_, view != View::kHouse);
    PaintTabs();
    // direct_mode + full_refresh: igual que con el recordatorio, cambiar de
    // vista tiene que repintar la pantalla entera.
    lv_obj_invalidate(lv_screen_active());
    ESP_LOGI(TAG, "vista %s", kViewTabTextList[(int)view]);
}

void JarvisDashboardDisplay::ShowAdjacentView(int step) {
    DisplayLockGuard lock(this);
    // Con un detalle o la vista de un dia abiertos, deslizar no cambia lo de
    // abajo: se cierran con su boton (o tocando afuera del detalle).
    if (!IsHidden(event_modal_) || !IsHidden(day_view_)) {
        ESP_LOGI(TAG, "deslizar ignorado: hay un overlay de agenda abierto");
        return;
    }
    int next = ((int)current_view_ + step) % kViewCount;
    if (next < 0) {
        next += kViewCount;
    }
    ShowView(static_cast<View>(next));
}

void JarvisDashboardDisplay::SetTalkButtonsListening(bool listening) {
    DisplayLockGuard lock(this);
    if (talk_button_ == nullptr || listening == talk_buttons_listening_) {
        return;
    }
    talk_buttons_listening_ = listening;
    if (listening) {
        // Hablar encendido: el microfono esta abierto (otro toque da mas tiempo).
        // El texto dice lo que pasa, no lo que hace el boton: asi se lee de un
        // vistazo que la placa esta escuchando.
        lv_obj_set_style_bg_color(talk_button_, lv_color_hex(kColorTurquoise), 0);
        lv_obj_set_style_text_color(talk_button_label_, lv_color_hex(kColorScreen), 0);
        lv_label_set_text(talk_button_label_, "Escuchando...");
        lv_obj_set_style_opa(send_button_, LV_OPA_COVER, 0);
    } else {
        lv_obj_set_style_bg_color(talk_button_, lv_color_hex(kColorTile), 0);
        lv_obj_set_style_text_color(talk_button_label_, lv_color_hex(kColorTurquoise), 0);
        lv_label_set_text(talk_button_label_, "Hablar");
        lv_obj_set_style_opa(send_button_, LV_OPA_40, 0);
    }
}

void JarvisDashboardDisplay::RefreshClockLabel() {
    if (clock_label_ == nullptr) {
        return;
    }
    time_t now = time(nullptr);
    struct tm local_time;
    localtime_r(&now, &local_time);

    char clock_text[8];
    snprintf(clock_text, sizeof(clock_text), "%02d:%02d", local_time.tm_hour,
             local_time.tm_min);
    SetLabelText(clock_label_, clock_text);

    if (date_label_ != nullptr) {
        char date_text[24];
        snprintf(date_text, sizeof(date_text), "%s %d %s",
                 kWeekdayAbbreviationList[local_time.tm_wday % 7], local_time.tm_mday,
                 kMonthAbbreviationList[local_time.tm_mon % 12]);
        SetLabelText(date_label_, date_text);
    }
}

void JarvisDashboardDisplay::SetupUI() {
    if (setup_ui_called_) {
        ESP_LOGW(TAG, "SetupUI() llamado dos veces, se ignora");
        return;
    }
    Display::SetupUI();
    DisplayLockGuard lock(this);
    const size_t internal_free_before = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);

    auto screen = lv_screen_active();
    auto lvgl_theme = static_cast<LvglTheme*>(current_theme_);
    {
        auto screen_font = SafeFont(lvgl_theme->text_font());
        if (screen_font != nullptr) {
            lv_obj_set_style_text_font(screen, screen_font, 0);
        }
    }
    lv_obj_set_style_text_color(screen, lv_color_hex(kColorInk), 0);
    lv_obj_set_style_bg_color(screen, lv_color_hex(kColorScreen), 0);

    container_ = lv_obj_create(screen);
    lv_obj_set_size(container_, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_style_bg_color(container_, lv_color_hex(kColorScreen), 0);
    lv_obj_set_style_border_width(container_, 0, 0);
    lv_obj_set_style_radius(container_, 0, 0);
    lv_obj_set_style_pad_all(container_, kOuterPad, 0);
    lv_obj_set_style_pad_row(container_, kGap, 0);
    lv_obj_set_flex_flow(container_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scrollbar_mode(container_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(container_, LV_OBJ_FLAG_SCROLLABLE);

    BuildStatusBar(container_);
    // Las dos vistas se arman al arrancar y se alternan con HIDDEN: cambiar de
    // vista no crea ni destruye nada.
    BuildOverviewView(container_);
    BuildHouseView(container_);

    // Aviso de bateria baja: lo muestra y esconde UpdateStatusBar por su cuenta.
    low_battery_popup_ = lv_obj_create(screen);
    lv_obj_set_scrollbar_mode(low_battery_popup_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_size(low_battery_popup_, LV_HOR_RES * 0.6, 64);
    lv_obj_align(low_battery_popup_, LV_ALIGN_BOTTOM_MID, 0, -12);
    lv_obj_set_style_bg_color(low_battery_popup_, lvgl_theme->low_battery_color(), 0);
    lv_obj_set_style_radius(low_battery_popup_, 9, 0);
    low_battery_label_ = lv_label_create(low_battery_popup_);
    lv_label_set_text(low_battery_label_, Lang::Strings::BATTERY_NEED_CHARGE);
    lv_obj_set_style_text_color(low_battery_label_, lv_color_white(), 0);
    lv_obj_center(low_battery_label_);
    lv_obj_add_flag(low_battery_popup_, LV_OBJ_FLAG_HIDDEN);

    // Agenda v2: vista de un dia y detalle de un evento, colgados de `screen`
    // como el recordatorio. El orden de creacion es el orden de apilado: el
    // detalle por encima de la vista del dia y el recordatorio (que ademas se
    // trae al frente al mostrarse) por encima de todo.
    BuildDayView(screen);
    BuildEventModal(screen);
    BuildReminderOverlay(screen);

    esp_timer_create_args_t day_timer_args = {};
    day_timer_args.callback = [](void* argument) {
        static_cast<JarvisDashboardDisplay*>(argument)->OnDayTimeout();
    };
    day_timer_args.arg = this;
    day_timer_args.name = "jarvis_agenda_day";
    if (esp_timer_create(&day_timer_args, &day_timeout_timer_) != ESP_OK) {
        day_timeout_timer_ = nullptr;
    }

    // El reloj corre con el RTC de la placa. Diez segundos alcanzan para que la
    // hora nunca se vea vieja y no despierta al procesador cada segundo.
    esp_timer_create_args_t clock_timer_args = {};
    clock_timer_args.callback = [](void* argument) {
        auto* self = static_cast<JarvisDashboardDisplay*>(argument);
        DisplayLockGuard timer_lock(self);
        self->RefreshClockLabel();
    };
    clock_timer_args.arg = this;
    clock_timer_args.name = "jarvis_clock";
    if (esp_timer_create(&clock_timer_args, &clock_timer_) == ESP_OK) {
        esp_timer_start_periodic(clock_timer_, kClockTickPeriodMicroseconds);
    }

    // Medicion de Casa: en uso normal arranca escondida, y un objeto escondido
    // no pasa por el layout. Se la muestra una vez, con los mosaicos visibles,
    // para que el log diga cuanto mide un mosaico en esta pantalla.
    lv_obj_add_flag(overview_view_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_remove_flag(house_view_, LV_OBJ_FLAG_HIDDEN);
    for (auto& widgets : home_tile_widget_list_) {
        lv_obj_remove_flag(widgets.tile, LV_OBJ_FLAG_HIDDEN);
    }
    lv_obj_update_layout(container_);
    const int tile_width = (int)lv_obj_get_width(home_tile_widget_list_[0].tile);
    const int tile_height = (int)lv_obj_get_height(home_tile_widget_list_[0].tile);
    for (auto& widgets : home_tile_widget_list_) {
        lv_obj_add_flag(widgets.tile, LV_OBJ_FLAG_HIDDEN);
    }
    lv_obj_add_flag(house_view_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_remove_flag(overview_view_, LV_OBJ_FLAG_HIDDEN);
    current_view_ = View::kOverview;
    PaintTabs();

    // Lo mismo con la vista de un dia y el detalle: se muestran una vez para
    // medir cuantos renglones entran por columna y cuanto mide la tarjeta
    // (con textos de prueba del largo maximo del contrato).
    lv_obj_remove_flag(day_view_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_remove_flag(day_row_list_[0].row, LV_OBJ_FLAG_HIDDEN);
    lv_obj_update_layout(day_view_);
    day_row_width_ = (int)lv_obj_get_content_width(day_row_list_[0].row);
    const int day_row_capacity = DayRowCapacity();
    const int day_list_height = (int)lv_obj_get_height(day_list_area_);
    lv_obj_add_flag(day_row_list_[0].row, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(day_view_, LV_OBJ_FLAG_HIDDEN);
    {
        AgendaEntry sample;
        sample.title = "Dentista";
        sample.when_label = "en 3 días";
        sample.has_detail = true;
        sample.detail.full_title = std::string(80, 'M');
        sample.detail.date_label = "miércoles 23 de septiembre";
        sample.detail.time_label = "11:00 a 12:00";
        sample.detail.location = std::string(60, 'M');
        sample.detail.description = std::string(200, 'm');
        sample.detail.source_label = "Recordatorio de Jarvis";
        ShowEventModal(sample);
    }
    lv_obj_update_layout(event_modal_);
    const int event_card_width = (int)lv_obj_get_width(event_card_);
    const int event_card_height = (int)lv_obj_get_height(event_card_);
    lv_obj_add_flag(event_modal_, LV_OBJ_FLAG_HIDDEN);

    // OJO: sin esto la pantalla queda NEGRA.
    //
    // El puerto de LVGL para este panel RGB corre con direct_mode + full_refresh
    // (ver RgbLcdDisplay). En ese modo se dibuja solo lo invalidado, y al salir
    // de SetupUI el layout del flex todavia no se calculo: los objetos miden
    // cero, no invalidan area, y no se dibuja nada nunca. Forzar el layout les
    // da tamano real, y el invalidate manda a repintar la pantalla entera una
    // primera vez.
    //
    // Verificado por A/B: los builds con esta llamada se ven, los que no la
    // tienen arrancan en negro con la placa perfectamente sana.
    lv_obj_update_layout(container_);
    lv_obj_invalidate(lv_screen_active());
    agenda_row_width_ = (int)lv_obj_get_content_width(agenda_body_);

    for (int view = 0; view < kViewCount; view++) {
        lv_area_t tab_area;
        lv_obj_get_coords(tab_label_list_[view], &tab_area);
        ESP_LOGI(TAG, "pestaña %s en (%d,%d)-(%d,%d)", kViewTabTextList[view], (int)tab_area.x1,
                 (int)tab_area.y1, (int)tab_area.x2, (int)tab_area.y2);
    }

    lv_obj_t* calendar_tile = lv_obj_get_parent(today_event_area_);
    lv_obj_t* agenda_tile = lv_obj_get_parent(agenda_body_);
    const size_t internal_free_after = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    ESP_LOGI(TAG,
             "tablero armado: %dx%d (container %dx%d) derecha %dx%d, calendario %dx%d, "
             "eventos de hoy %d de %d, agenda %dx%d con %d de %d eventos, "
             "conversacion %dx%d con %d de %d renglones, mosaico %dx%d, RAM interna %u -> %u",
             LV_HOR_RES, LV_VER_RES, (int)lv_obj_get_width(container_),
             (int)lv_obj_get_height(container_), (int)lv_obj_get_width(side_column_),
             (int)lv_obj_get_height(side_column_), (int)lv_obj_get_width(calendar_tile),
             (int)lv_obj_get_height(calendar_tile), TodayEventCapacity(), kTodayEventSlotCount,
             (int)lv_obj_get_width(agenda_tile), (int)lv_obj_get_height(agenda_tile),
             AgendaCapacity(), kAgendaSlotCount, (int)lv_obj_get_width(conversation_strip_),
             (int)lv_obj_get_height(conversation_strip_), ConversationLineCapacity(),
             kConversationTextLineCount, tile_width, tile_height, (unsigned)internal_free_before,
             (unsigned)internal_free_after);
    ESP_LOGI(TAG,
             "agenda v2: renglon %dpx de alto, agenda %dpx de ancho; vista del dia: lista "
             "de %dpx de alto, %d columnas de %d (de %d) renglones de %dpx; detalle %dx%d "
             "(maximo %d)",
             AgendaRowHeight(), agenda_row_width_, day_list_height, (int)kDayColumnCount,
             day_row_capacity, (int)(kDayEntrySlotCount / kDayColumnCount), day_row_width_,
             event_card_width, event_card_height, (int)LV_VER_RES - 24);
}

// LcdDisplay::SetTheme repinta la UI de chat entera y toca `emoji_label_`,
// `content_` y compania sin chequear null: como el tablero no crea nada de eso,
// heredarlo era un LoadProhibited garantizado apenas Assets::Apply cambia la
// fuente al arrancar (lcd_display.cc:1235).
//
// Ademas el tablero tiene paleta propia y fija: del tema solo le interesan las
// fuentes, no los colores.
void JarvisDashboardDisplay::SetTheme(Theme* theme) {
    DisplayLockGuard lock(this);
    auto lvgl_theme = static_cast<LvglTheme*>(theme);
    auto text_font = SafeFont(lvgl_theme->text_font());
    auto icon_font = SafeFont(lvgl_theme->icon_font());

    lv_obj_set_style_text_font(lv_screen_active(), text_font, 0);

    lv_obj_t* const icon_label_list[] = {network_label_, battery_label_, mute_label_};
    for (lv_obj_t* label : icon_label_list) {
        if (label != nullptr && icon_font != nullptr) {
            lv_obj_set_style_text_font(label, icon_font, 0);
        }
    }

    // El resto de los labels no fija fuente: hereda la de la pantalla, que ya
    // se actualizo arriba. Ver el comentario de StyleTileText.

    // Solo el bookkeeping de la base (guarda el tema y lo persiste), sin el
    // repintado de LcdDisplay.
    Display::SetTheme(theme);
}

void JarvisDashboardDisplay::ApplyWeather(const DashboardData& data) {
    if (weather_temp_label_ == nullptr || !data.weather_present) {
        return;
    }
    if (!data.has_weather) {
        SetLabelText(weather_temp_label_, "--");
        SetLabelText(weather_cond_label_, "");
        SetLabelText(weather_detail_label_, "");
        return;
    }
    char temperature_text[12];
    snprintf(temperature_text, sizeof(temperature_text), "%d°", data.temperature_c);
    SetLabelText(weather_temp_label_, temperature_text);
    lv_color_t temperature_color = lv_color_hex(WeatherColorFor(data.condition_code));
    if (!lv_color_eq(lv_obj_get_style_text_color(weather_temp_label_, LV_PART_MAIN),
                     temperature_color)) {
        lv_obj_set_style_text_color(weather_temp_label_, temperature_color, 0);
    }
    SetLabelText(weather_cond_label_, data.condition_label.c_str());

    // Segundo renglon: minima/maxima y humedad si las hay (clima de Home
    // Assistant); si no, el lugar, como antes.
    std::string detail;
    char part[32];
    if (data.has_min) {
        snprintf(part, sizeof(part), "Mín %d°", data.min_c);
        detail += part;
    }
    if (data.has_max) {
        snprintf(part, sizeof(part), "%sMáx %d°", detail.empty() ? "" : " · ", data.max_c);
        detail += part;
    }
    if (data.has_humidity) {
        snprintf(part, sizeof(part), "%sHum. %d%%", detail.empty() ? "" : " · ",
                 data.humidity_percent);
        detail += part;
    }
    if (detail.empty()) {
        detail = data.place_label;
    }
    SetLabelText(weather_detail_label_, detail.c_str());
}

// Cuantos eventos de hoy entran debajo de la grilla. Depende del alto que le
// dejaron las otras tarjetas, que no es el mismo en las dos pantallas: en la
// 4.3C entra uno, en la P4-7B los cuatro. Mostrar un renglon cortado a la mitad
// se ve roto, asi que los que no entran enteros se esconden.
int JarvisDashboardDisplay::TodayEventCapacity() {
    if (today_event_area_ == nullptr) {
        return 0;
    }
    const int line_height = std::max(1, LineHeightOf(today_event_area_));
    const int capacity = (int)lv_obj_get_content_height(today_event_area_) / line_height;
    return std::min(std::max(capacity, 0), (int)kTodayEventSlotCount);
}

// Mismo criterio para la agenda, que perdio alto con la franja de conversacion
// abajo: desde Agenda v2 cada evento es un solo renglon (con aire para el
// dedo) y los que no entran enteros se esconden.
int JarvisDashboardDisplay::AgendaCapacity() {
    if (agenda_body_ == nullptr) {
        return 0;
    }
    const int capacity =
        (int)lv_obj_get_content_height(agenda_body_) / std::max(1, AgendaRowHeight());
    return std::min(std::max(capacity, 0), (int)kAgendaSlotCount);
}

// Alto de un renglon de agenda: el mas alto de texto e icono, el aire de
// arriba y abajo y la raya.
int JarvisDashboardDisplay::AgendaRowHeight() {
    if (agenda_body_ == nullptr) {
        return kFallbackLineHeight;
    }
    const int line_height =
        std::max(LineHeightOf(agenda_body_), (int)lv_font_get_line_height(IconFont()));
    return line_height + 2 * kAgendaRowPadVer + 1;
}

// Renglones de texto que entran en la franja de conversacion (para el log).
int JarvisDashboardDisplay::ConversationLineCapacity() {
    if (conversation_say_label_ == nullptr) {
        return 0;
    }
    const int line_height = std::max(1, LineHeightOf(conversation_say_label_));
    return (int)lv_obj_get_content_height(conversation_say_label_) / line_height;
}

void JarvisDashboardDisplay::ApplyMonthCalendar(const DashboardData& data) {
    if (!data.month_calendar_present || calendar_column_list_[0] == nullptr) {
        return;
    }
    const bool valid = data.has_month_calendar && data.calendar_month >= 1 &&
                       data.calendar_month <= 12 && data.calendar_day_count >= 28 &&
                       data.calendar_day_count <= 31 && data.calendar_first_weekday >= 0 &&
                       data.calendar_first_weekday < kWeekdayCount;

    calendar_valid_ = valid;
    calendar_year_ = data.calendar_year;
    calendar_month_ = data.calendar_month;
    calendar_first_weekday_ = data.calendar_first_weekday;
    calendar_day_count_ = data.calendar_day_count;

    char heading[32] = "CALENDARIO";
    if (valid) {
        snprintf(heading, sizeof(heading), "%s %d", kMonthNameList[data.calendar_month - 1],
                 data.calendar_year);
    }
    SetLabelText(calendar_month_label_, heading);

    bool event_day_list[32] = {};
    for (int day : data.calendar_event_day_list) {
        if (day >= 1 && day <= 31) {
            event_day_list[day] = true;
        }
    }

    // Seis semanas siempre: la grilla mide lo mismo todos los meses y nada se
    // corre cuando un mes ocupa cinco.
    constexpr int kWeekRowCount = 6;
    int today_column = -1;
    int today_row = -1;
    for (int column_index = 0; column_index < kWeekdayCount; column_index++) {
        char text[192];
        int length = snprintf(text, sizeof(text), "#%06X %s#", (unsigned)kColorDim,
                              kCalendarWeekdayInitialList[column_index]);
        for (int week = 0; week < kWeekRowCount; week++) {
            const int day = week * kWeekdayCount + column_index - data.calendar_first_weekday + 1;
            const bool in_month = valid && day >= 1 && day <= data.calendar_day_count;
            const int remaining = (int)sizeof(text) - length;
            if (remaining <= 1) {
                break;
            }
            if (!in_month) {
                length += snprintf(text + length, remaining, "\n");
            } else if (day == data.calendar_today_day) {
                length += snprintf(text + length, remaining, "\n#%06X %d#",
                                   (unsigned)kColorTurquoise, day);
                today_column = column_index;
                today_row = week + 1;  // el renglon 0 es la inicial del dia
            } else if (event_day_list[day]) {
                length += snprintf(text + length, remaining, "\n#%06X %d#",
                                   (unsigned)kColorTangerine, day);
            } else {
                length += snprintf(text + length, remaining, "\n%d", day);
            }
        }
        if (calendar_column_text_list_[column_index] != text) {
            calendar_column_text_list_[column_index] = text;
            lv_label_set_text(calendar_column_list_[column_index], text);
        }
    }

    if (today_column < 0) {
        SetHidden(calendar_today_marker_, true);
    } else {
        lv_obj_t* column = calendar_column_list_[today_column];
        if (lv_obj_get_parent(calendar_today_marker_) != column) {
            lv_obj_set_parent(calendar_today_marker_, column);
        }
        // Cada renglon mide el alto de linea de la fuente mas el interlineado
        // (negativo en la pantalla compacta).
        const int pitch = LineHeightOf(column) +
                          (int)lv_obj_get_style_text_line_space(column, LV_PART_MAIN);
        if (pitch != calendar_row_pitch_ || today_row != calendar_marker_row_) {
            calendar_row_pitch_ = pitch;
            calendar_marker_row_ = today_row;
            lv_obj_set_size(calendar_today_marker_, LV_PCT(100), pitch);
            lv_obj_set_pos(calendar_today_marker_, 0, today_row * pitch);
        }
        SetHidden(calendar_today_marker_, false);
    }

    const int capacity = TodayEventCapacity();
    for (int slot = 0; slot < kTodayEventSlotCount; slot++) {
        const bool used = valid && slot < capacity &&
                          slot < (int)data.calendar_today_event_list.size();
        if (used) {
            const auto& event = data.calendar_today_event_list[slot];
            const std::string text = event.time_label + "  " + event.title;
            SetLabelText(today_event_list_[slot], text.c_str());
        }
        SetHidden(today_event_list_[slot], !used);
    }
}

void JarvisDashboardDisplay::ApplyHome(const DashboardData& data) {
    if (!data.home_present || home_empty_label_ == nullptr) {
        return;
    }
    home_tile_count_ = std::min((int)data.home_tile_list.size(), (int)kHomeTileSlotCount);
    for (int slot = 0; slot < kHomeTileSlotCount; slot++) {
        const bool used = slot < home_tile_count_;
        if (used) {
            // Lo que llega pisa cualquier cambio optimista: es la confirmacion
            // (o la correccion) de Home Assistant.
            home_tile_list_[slot] = data.home_tile_list[slot];
            PaintHomeTile(slot);
        }
        SetHidden(home_tile_widget_list_[slot].tile, !used);
    }
    SetHidden(home_empty_label_, home_tile_count_ > 0);

    SetHidden(dollar_strip_, !data.has_dollar_blue);
    if (data.has_dollar_blue) {
        SetLabelText(dollar_buy_label_, FormatPesos(data.dollar_buy).c_str());
        SetLabelText(dollar_sell_label_, FormatPesos(data.dollar_sell).c_str());
        SetLabelText(dollar_updated_label_, data.dollar_updated_label.c_str());
        // En Inicio, al lado del clima: el promedio de compra y venta.
        const std::string average =
            "Blue " + FormatPesos((data.dollar_buy + data.dollar_sell) / 2.0);
        SetLabelText(weather_dollar_label_, average.c_str());
    }
    SetHidden(weather_dollar_label_, !data.has_dollar_blue);
}

void JarvisDashboardDisplay::PaintHomeTile(int slot) {
    const HomeTile& tile = home_tile_list_[slot];
    HomeTileWidgets& widgets = home_tile_widget_list_[slot];
    if (widgets.tile == nullptr) {
        return;
    }

    int look = kTileLookNormal;
    if (!tile.available) {
        look = kTileLookUnavailable;
    } else if (tile.kind == HomeTileKind::kToggle && tile.is_on) {
        look = kTileLookOn;
    }
    if (look != widgets.painted_look) {
        widgets.painted_look = look;
        const bool is_on = look == kTileLookOn;
        lv_obj_set_style_bg_color(widgets.tile, lv_color_hex(is_on ? kColorTileOn : kColorTile),
                                  0);
        lv_obj_set_style_border_color(widgets.tile,
                                      lv_color_hex(is_on ? kColorAmber : kColorTileLine), 0);
        lv_obj_set_style_border_width(widgets.tile, is_on ? 2 : 1, 0);
        lv_obj_set_style_text_color(widgets.value_label, lv_color_hex(is_on ? kColorAmber : kColorInk),
                                    0);
        // Gris y apagado, pero legible: se tiene que ver QUE no esta disponible.
        lv_obj_set_style_opa(widgets.tile, look == kTileLookUnavailable ? LV_OPA_50 : LV_OPA_COVER,
                             0);
    }

    SetLabelText(widgets.name_label, tile.name.c_str());
    const bool is_climate = tile.kind == HomeTileKind::kClimate;
    SetHidden(widgets.minus_button, !is_climate || !tile.available);
    SetHidden(widgets.plus_button, !is_climate || !tile.available);

    if (!tile.available) {
        SetLabelText(widgets.value_label, "--");
        SetLabelText(widgets.detail_label, "No disponible");
        return;
    }

    switch (tile.kind) {
        case HomeTileKind::kToggle:
            SetLabelText(widgets.value_label, tile.is_on ? "Prendido" : "Apagado");
            SetLabelText(widgets.detail_label, tile.is_on ? "Tocá para apagar" : "Tocá para prender");
            break;
        case HomeTileKind::kSensor: {
            std::string value = tile.value;
            if (!tile.unit.empty()) {
                // Sin espacio antes de los grados y el porcentaje, como se escribe.
                const bool glued = tile.unit == "°C" || tile.unit == "°F" || tile.unit == "%";
                value += glued ? tile.unit : " " + tile.unit;
            }
            SetLabelText(widgets.value_label, value.c_str());
            SetLabelText(widgets.detail_label, "");
            break;
        }
        case HomeTileKind::kClimate: {
            const std::string target =
                tile.has_target ? FormatTenths(tile.target_c) + "°" : std::string("--");
            SetLabelText(widgets.value_label, target.c_str());
            std::string detail;
            if (tile.has_current) {
                detail = "Actual " + FormatTenths(tile.current_c) + "°";
            }
            if (!tile.hvac_mode.empty()) {
                detail += (detail.empty() ? "" : " · ");
                detail += HvacModeLabel(tile.hvac_mode);
            }
            SetLabelText(widgets.detail_label, detail.c_str());
            break;
        }
    }
}

void JarvisDashboardDisplay::SetDashboardData(const DashboardData& data) {
    DisplayLockGuard lock(this);

    ApplyWeather(data);

    if (data.agenda_present) {
        // Se guardan con su detalle: tocar un renglon abre el modal con esto.
        agenda_entry_list_ = data.agenda_list;
        agenda_shown_count_ = std::min(
            {AgendaCapacity(), (int)agenda_entry_list_.size(), (int)kAgendaSlotCount});
        for (int slot = 0; slot < kAgendaSlotCount; slot++) {
            const bool used = slot < agenda_shown_count_;
            if (used) {
                PaintAgendaRow(agenda_row_list_[slot], agenda_entry_list_[slot],
                               agenda_row_width_);
            }
            // Se muestran u ocultan, nunca se crean ni se destruyen.
            SetHidden(agenda_row_list_[slot].row, !used);
        }
    }

    // Tarjeta del medio. Con `pending` presente el mensaje es del servidor de
    // Jarvis, que manda `shopping` siempre que hay lista de compras: ahi que
    // falte SI quiere decir que no hay (y no se ofrece). Sin `pending` es el
    // otro emisor y las listas quedan como estaban.
    if (data.pending.present) {
        todo_list_list_[(int)TodoListKind::kPending] = data.pending;
        todo_list_list_[(int)TodoListKind::kShopping] = data.shopping;
        PaintTodoCard();
    } else if (data.shopping.present) {
        todo_list_list_[(int)TodoListKind::kShopping] = data.shopping;
        PaintTodoCard();
    }

    if (travel_tile_ != nullptr && data.travel_present) {
        if (data.has_travel) {
            char minutes_text[16];
            snprintf(minutes_text, sizeof(minutes_text), "%d min", data.travel_minutes);
            SetLabelText(travel_head_label_, data.travel_label.c_str());
            SetLabelText(travel_value_label_, minutes_text);
        }
        SetHidden(travel_tile_, !data.has_travel);
    }

    ApplyMonthCalendar(data);
    ApplyHome(data);
}

// El recordatorio se dibuja una sola vez, escondido, y despues solo se le
// cambia el texto. Mismo motivo que las filas del tablero: recrear objetos en
// cada aviso hace recalcular el arbol entero y la pantalla parpadea.
void JarvisDashboardDisplay::BuildReminderOverlay(lv_obj_t* parent) {
    reminder_overlay_ = lv_obj_create(parent);
    lv_obj_set_size(reminder_overlay_, LV_HOR_RES, LV_VER_RES);
    lv_obj_align(reminder_overlay_, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_set_style_bg_color(reminder_overlay_, lv_color_hex(kColorScreen), 0);
    lv_obj_set_style_bg_opa(reminder_overlay_, LV_OPA_COVER, 0);
    // El borde grueso es lo que lo separa de "otra pantalla del tablero": el
    // naranja ya es el color de agenda y recordatorios en el resto de la UI.
    lv_obj_set_style_border_color(reminder_overlay_, lv_color_hex(kColorTangerine), 0);
    lv_obj_set_style_border_width(reminder_overlay_, 6, 0);
    lv_obj_set_style_radius(reminder_overlay_, 0, 0);
    lv_obj_set_style_pad_all(reminder_overlay_, 40, 0);
    lv_obj_set_style_pad_row(reminder_overlay_, 22, 0);
    lv_obj_set_flex_flow(reminder_overlay_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(reminder_overlay_, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);
    lv_obj_set_scrollbar_mode(reminder_overlay_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(reminder_overlay_, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t* heading = lv_label_create(reminder_overlay_);
    lv_label_set_text(heading, "RECORDATORIO");
    lv_obj_set_style_text_letter_space(heading, 3, 0);
    StyleTileText(heading, kColorTangerine);

    reminder_message_label_ = lv_label_create(reminder_overlay_);
    lv_label_set_text(reminder_message_label_, "");
    lv_obj_set_width(reminder_message_label_, LV_PCT(100));
    lv_label_set_long_mode(reminder_message_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(reminder_message_label_, LV_TEXT_ALIGN_CENTER, 0);
    // Sin fuente propia a proposito: fijarla en el estilo local deja el label
    // apuntando a memoria liberada cuando Assets::Apply cambia la del tema.
    // La jerarquia la da el color y el espacio, no el tamano de letra.
    StyleTileText(reminder_message_label_, kColorInk);

    lv_obj_t* hint = lv_label_create(reminder_overlay_);
    lv_label_set_text(hint, "toca la pantalla para descartar");
    StyleTileText(hint, kColorDim);

    lv_obj_add_flag(reminder_overlay_, LV_OBJ_FLAG_HIDDEN);
}

void JarvisDashboardDisplay::ShowReminder(const char* message) {
    DisplayLockGuard lock(this);
    if (reminder_overlay_ == nullptr || reminder_message_label_ == nullptr) {
        return;
    }
    lv_label_set_text(reminder_message_label_, message == nullptr ? "" : message);
    lv_obj_remove_flag(reminder_overlay_, LV_OBJ_FLAG_HIDDEN);
    // El aviso de bateria tambien cuelga de `screen` y se creo despues; sin
    // esto podria quedar tapando el recordatorio.
    lv_obj_move_foreground(reminder_overlay_);
    // direct_mode + full_refresh: mostrar un objeto no alcanza, hay que pedir
    // el repintado de la pantalla entera o queda dibujado lo de antes. Es el
    // mismo motivo por el que SetupUI termina con un invalidate.
    lv_obj_invalidate(lv_screen_active());
}

void JarvisDashboardDisplay::DismissReminder() {
    DisplayLockGuard lock(this);
    if (reminder_overlay_ == nullptr) {
        return;
    }
    lv_obj_add_flag(reminder_overlay_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_invalidate(lv_screen_active());
}

// Toma el lock como todo lo demas que toca LVGL: se llama desde la main task
// (SendGesture) mientras la tarea de LVGL puede estar dibujando. El mutex del
// puerto es recursivo, asi que anidarlo con el de DismissReminder es seguro.
bool JarvisDashboardDisplay::IsReminderVisible() {
    DisplayLockGuard lock(this);
    return reminder_overlay_ != nullptr &&
           !lv_obj_has_flag(reminder_overlay_, LV_OBJ_FLAG_HIDDEN);
}

// En reposo UpdateStatusBar pone la hora en el estado cada 10 s. La hora ya
// esta en la barra de arriba: en la franja de conversacion se lee "En espera".
// Repetir el mismo texto no se aplica (repintaria toda la pantalla RGB).
void JarvisDashboardDisplay::SetStatus(const char* status) {
    if (status == nullptr) {
        return;
    }
    const bool is_clock_refresh = IsClockText(status);
    const char* shown = is_clock_refresh ? Lang::Strings::STANDBY : status;
    {
        DisplayLockGuard lock(this);
        if (status_label_ == nullptr) {
            // Antes de SetupUI: que la base loguee lo que corresponda.
        } else if (is_clock_refresh &&
                   (!IsHidden(notification_label_) ||
                    strcmp(lv_label_get_text(status_label_), shown) == 0)) {
            // El refresco de la hora no pisa un aviso que se esta mostrando
            // (se va solo a los 3 s) ni repinta el mismo "En espera". Se
            // anota como hecho para que la base vuelva a intentar en 10 s y
            // no en cada segundo.
            last_status_update_time_ = std::chrono::system_clock::now();
            return;
        }
        // Una conversacion vuelve a Inicio: la franja y los botones viven ahi.
        if (strcmp(shown, Lang::Strings::LISTENING) == 0 ||
            strcmp(shown, Lang::Strings::SPEAKING) == 0) {
            // Si el que empieza a hablar es el usuario, la franja de
            // conversacion tiene que verse: el detalle y la vista de un dia se
            // cierran. Si solo habla Jarvis (un anuncio), quedan abiertos.
            if (strcmp(shown, Lang::Strings::LISTENING) == 0) {
                CloseAgendaOverlays();
            }
            ShowView(View::kOverview);
        }
        showing_thinking_ = false;
    }
    JarvisDashboardBase::SetStatus(shown);
}

void JarvisDashboardDisplay::SetChatMessage(const char* role, const char* content) {
    (void)role;
    DisplayLockGuard lock(this);
    SetLabelText(conversation_say_label_, content);
}

// Sin Einstein, la unica emocion que se dibuja es "pensando": es el unico
// estado del turno que no tiene su propio SetStatus en Application.
void JarvisDashboardDisplay::SetEmotion(const char* emotion) {
    if (emotion == nullptr) {
        return;
    }
    DisplayLockGuard lock(this);
    const bool is_listening = strcmp(emotion, "listening") == 0 || strcmp(emotion, "curious") == 0;
    const bool is_thinking = strcmp(emotion, "thinking") == 0 ||
                             strcmp(emotion, "focused") == 0 ||
                             strcmp(emotion, "questioning") == 0;
    // Empezar a hablarle a Jarvis tambien descarta el recordatorio.
    //
    // Es la red de seguridad del overlay: sin esto la UNICA salida es el
    // touch, y si el panel falla la pantalla queda tomada para siempre sin
    // forma de recuperarla. Ademas es lo que corresponde: si estas hablandole,
    // ya lo viste.
    //
    // El anuncio del propio recordatorio no dispara esto: announcePcm manda
    // tts_start/tts_end/turn_end pero ningun mensaje de emocion, asi que el
    // aviso no se borra a si mismo mientras lo esta leyendo.
    if (is_listening) {
        DismissReminder();
    }

    if (is_thinking && !showing_thinking_) {
        // La version de la base, no la propia: la propia apaga el flag.
        JarvisDashboardBase::SetStatus(kThinkingStatusText);
        showing_thinking_ = true;
    } else if (!is_thinking && showing_thinking_) {
        // Termino de pensar sin cambiar de estado (por ejemplo, una respuesta
        // sin voz): vuelve el rotulo del estado en que quedo la placa.
        const char* status = Lang::Strings::STANDBY;
        switch (Application::GetInstance().GetDeviceState()) {
            case kDeviceStateListening: status = Lang::Strings::LISTENING; break;
            case kDeviceStateSpeaking: status = Lang::Strings::SPEAKING; break;
            case kDeviceStateConnecting: status = Lang::Strings::CONNECTING; break;
            default: break;
        }
        SetStatus(status);
    }
}

void JarvisDashboardDisplay::SetAccentColor(const char* color) {
    if (color == nullptr || color[0] != '#') {
        return;
    }
    DisplayLockGuard lock(this);
    lv_color_t parsed = LvglTheme::ParseColor(color);
    if (lv_color_eq(parsed, accent_color_)) {
        return;
    }
    accent_color_ = parsed;
    if (status_label_ != nullptr) {
        lv_obj_set_style_text_color(status_label_, accent_color_, 0);
    }
}
