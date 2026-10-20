#ifndef JARVIS_TOUCH_GESTURES_H
#define JARVIS_TOUCH_GESTURES_H

// Gestos del táctil para el tablero de Jarvis, compartidos por todas las placas.
//
// El touch se consulta directo desde una tarea propia: los gestos necesitan el
// trazo crudo del dedo, y es lo único que despierta la pantalla dormida
// (SendGesture / RunDashboardTouch -> NoteUserActivity). NO se registra el
// touch en LVGL: dos tareas leyendo el mismo controlador por I2C es pelearse
// por el bus para nada. Los blancos del tablero (botones, pestañas, mosaicos)
// se resuelven con JarvisDashboardDisplay::HitTest.
//
// Tap y doble tap siguen yendo al servidor como gesto; deslizar cambia de vista
// en la placa y ya no viaja (docs/vistas-tablero.md).
//
// Portado del board 1.85C de Apollo (CST816S). Las lecturas van por la API
// genérica esp_lcd_touch, así que sirve igual para el GT911 de las Waveshare.
//
// Uso, una vez creado el display:
//   JarvisTouchGestures::Start(touch_handle, display_);

#include "application.h"
#include "display.h"
#include "display/jarvis_dashboard_display.h"

#include <esp_lcd_touch.h>
#include <esp_log.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <cstdlib>

class JarvisTouchGestures {
public:
    static void Start(esp_lcd_touch_handle_t touch_handle, Display* display) {
        auto* self = new JarvisTouchGestures(touch_handle, display);
        xTaskCreate([](void* arg) { static_cast<JarvisTouchGestures*>(arg)->Run(); },
                    "touch_gesture", 4096, self, 4, nullptr);
    }

private:
    static constexpr const char* kTag = "JarvisTouch";
    static constexpr int kTapMaxTravelPx = 30;
    static constexpr int kSwipeMinTravelPx = 60;
    static constexpr uint32_t kTapMaxMs = 400;
    static constexpr uint32_t kDoubleTapWindowMs = 400;
    // Apenas por encima de kTapMaxMs: una pulsación recién pasa a ser
    // push-to-talk cuando ya es demasiado larga para ser un tap.
    static constexpr uint32_t kHoldToTalkMs = 450;
    static constexpr uint32_t kTouchPollMs = 20;
    static constexpr int kMaxTouchReadFailures = 25;
    // Con el táctil trabado se reintenta más despacio: no vale la pena ocupar el
    // bus I2C del codec 50 veces por segundo con un controlador que no contesta.
    static constexpr uint32_t kTouchRetryMs = 500;

    esp_lcd_touch_handle_t touch_handle_;
    Display* display_;

    JarvisTouchGestures(esp_lcd_touch_handle_t touch_handle, Display* display)
        : touch_handle_(touch_handle), display_(display) {}

    void Run() {
        bool was_pressed = false;
        int consecutive_read_failures = 0;
        int start_x = 0, start_y = 0, last_x = 0, last_y = 0;
        uint32_t press_started_ms = 0;
        uint32_t pending_tap_ms = 0;  // 0 = no hay tap esperando su ventana
        bool is_hold_talking = false;
        // Lo que habia bajo el dedo al empezar la pulsacion (boton, pestaña,
        // mosaico). Se decide al apoyar y se ejecuta al soltar.
        using TouchTarget = JarvisDashboardDisplay::TouchTarget;
        using TargetKind = JarvisDashboardDisplay::TouchTargetKind;
        TouchTarget press_target;
        auto* dashboard = dynamic_cast<JarvisDashboardDisplay*>(display_);

        while (true) {
            uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000);

            uint16_t x = 0, y = 0;
            uint8_t point_count = 0;
            if (esp_lcd_touch_read_data(touch_handle_) != ESP_OK) {
                // Antes, a las 25 fallas seguidas (medio segundo) la tarea se
                // borraba y el táctil quedaba muerto hasta reiniciar: en la P4 el
                // GT911 comparte el I2C con el codec y un tropezón corto alcanzaba
                // ("cambié a Casa y quedó trabado"). Ahora se espera más entre
                // intentos y se sigue probando para siempre; el log avisa una vez
                // al trabarse y otra al volver, sin ahogarse.
                if (++consecutive_read_failures == kMaxTouchReadFailures) {
                    ESP_LOGW(kTag, "Touch controller not answering, retrying every %d ms",
                             (int)kTouchRetryMs);
                }
                // Un hold en curso no puede quedar grabando sin dedo que lo suelte.
                if (is_hold_talking) {
                    is_hold_talking = false;
                    Application::GetInstance().StopListening();
                }
                was_pressed = false;
                press_target = TouchTarget{};
                vTaskDelay(pdMS_TO_TICKS(consecutive_read_failures >= kMaxTouchReadFailures
                                             ? kTouchRetryMs
                                             : kTouchPollMs));
                continue;
            }
            if (consecutive_read_failures >= kMaxTouchReadFailures) {
                ESP_LOGI(kTag, "Touch controller back after %d failed reads",
                         consecutive_read_failures);
            }
            consecutive_read_failures = 0;
            bool is_pressed =
                esp_lcd_touch_get_coordinates(touch_handle_, &x, &y, nullptr, &point_count, 1) &&
                point_count > 0;

            // Una pantalla de confirmación se adueña del touch: al soltar se
            // resuelve el botón en el acto (esperar la ventana de doble tap los
            // haría sentir rotos) y una pulsación ya no puede volverse
            // push-to-talk. Un hold que empezó antes termina por el camino normal.
            if (Application::GetInstance().IsConfirmActive() && !is_hold_talking) {
                pending_tap_ms = 0;
                if (is_pressed && !was_pressed) {
                    start_x = last_x = x;
                    start_y = last_y = y;
                    press_started_ms = now_ms;
                    press_target = TouchTarget{};
                } else if (is_pressed) {
                    last_x = x;
                    last_y = y;
                } else if (was_pressed) {
                    ESP_LOGI(kTag, "Confirm release at (%d,%d)", last_x, last_y);
                    Application::GetInstance().OnConfirmTouchRelease(last_x, last_y);
                }
                was_pressed = is_pressed;
                vTaskDelay(pdMS_TO_TICKS(kTouchPollMs));
                continue;
            }

            if (is_pressed && !was_pressed) {
                start_x = last_x = x;
                start_y = last_y = y;
                press_started_ms = now_ms;
                press_target = dashboard != nullptr ? dashboard->HitTest(x, y) : TouchTarget{};
                // Una línea por pulsación (no por sondeo): deja ver en el log si
                // las coordenadas del táctil coinciden con la pantalla.
                ESP_LOGI(kTag, "Press (%d,%d) target %d/%d", x, y, (int)press_target.kind,
                         press_target.index);
            } else if (is_pressed) {
                last_x = x;
                last_y = y;
                // Mantener apretado para hablar: graba cuando la pulsación ya es
                // muy larga para ser un tap, y sigue hasta que se levanta el
                // dedo. El dedo tiene que quedarse quieto, o esto secuestraría
                // un swipe lento. Sobre Enviar, una pestaña o un mosaico, un
                // hold sigue siendo eso: solo el fondo y Hablar graban.
                // Un evento de la agenda o un dia del calendario son "fondo"
                // para el hold: mantener habla, tocar abre. Dentro de un
                // overlay de agenda (detalle, vista de un dia) no se graba.
                const bool target_allows_hold = press_target.kind == TargetKind::kNone ||
                                                press_target.kind == TargetKind::kTalk ||
                                                press_target.kind == TargetKind::kAgendaRow ||
                                                press_target.kind == TargetKind::kCalendarDay;
                if (!is_hold_talking && target_allows_hold &&
                    now_ms - press_started_ms >= kHoldToTalkMs &&
                    abs(last_x - start_x) < kTapMaxTravelPx &&
                    abs(last_y - start_y) < kTapMaxTravelPx) {
                    is_hold_talking = true;
                    pending_tap_ms = 0;
                    auto& app = Application::GetInstance();
                    // Un hold sobre la pantalla apagada debería encenderla Y
                    // grabar, no solo encenderla.
                    app.NoteUserActivity();
                    app.StartListening();
                }
            } else if (was_pressed) {
                if (is_hold_talking) {
                    // Levantar el dedo es lo que envía el turno.
                    is_hold_talking = false;
                    Application::GetInstance().StopListening();
                    was_pressed = is_pressed;
                    vTaskDelay(pdMS_TO_TICKS(kTouchPollMs));
                    continue;
                }

                int dx = last_x - start_x;
                int dy = last_y - start_y;
                uint32_t held_ms = now_ms - press_started_ms;
                const TouchTarget target = press_target;
                press_target = TouchTarget{};

                // Deslizar cambia de vista en la placa: ya no viaja al servidor
                // (docs/vistas-tablero.md). Gana aunque el dedo haya arrancado
                // sobre un mosaico o un boton: en Casa casi todo es mosaico.
                if (abs(dx) >= kSwipeMinTravelPx && abs(dx) > abs(dy)) {
                    pending_tap_ms = 0;
                    if (dashboard != nullptr) {
                        // Dedo a la izquierda = la vista siguiente, como pasar
                        // una pagina.
                        const int step = dx < 0 ? 1 : -1;
                        ESP_LOGI(kTag, "Swipe %s: cambia de vista", dx < 0 ? "left" : "right");
                        Application::GetInstance().RunDashboardTouch(
                            [dashboard, step]() { dashboard->ShowAdjacentView(step); });
                    }
                    was_pressed = is_pressed;
                    vTaskDelay(pdMS_TO_TICKS(kTouchPollMs));
                    continue;
                }

                // Los blancos de la pantalla responden al soltar, sin esperar la
                // ventana de doble tap, y no llegan al servidor como gesto.
                if (target.kind != TargetKind::kNone) {
                    pending_tap_ms = 0;
                    HandleTarget(dashboard, target, abs(dx) < kTapMaxTravelPx &&
                                                        abs(dy) < kTapMaxTravelPx);
                    was_pressed = is_pressed;
                    vTaskDelay(pdMS_TO_TICKS(kTouchPollMs));
                    continue;
                }

                if (held_ms <= kTapMaxMs && abs(dx) < kTapMaxTravelPx &&
                    abs(dy) < kTapMaxTravelPx) {
                    if (pending_tap_ms != 0) {
                        pending_tap_ms = 0;
                        EmitGesture("double_tap");
                    } else {
                        // El tap simple se retiene: recién es un tap cuando la
                        // ventana de doble tap se cierra sin una segunda pulsación.
                        pending_tap_ms = now_ms;
                    }
                }
            }

            if (pending_tap_ms != 0 && now_ms - pending_tap_ms > kDoubleTapWindowMs) {
                pending_tap_ms = 0;
                EmitGesture("tap");
            }

            was_pressed = is_pressed;
            vTaskDelay(pdMS_TO_TICKS(kTouchPollMs));
        }
    }

    // `is_steady`: el dedo se quedo cerca de donde apoyo. Hablar y Enviar
    // responden igual que siempre (cualquier soltada); una pestaña o un mosaico
    // piden un toque limpio, porque un dedo que se arrastra por la grilla no
    // quiso prender una luz.
    static void HandleTarget(JarvisDashboardDisplay* dashboard,
                             const JarvisDashboardDisplay::TouchTarget& target, bool is_steady) {
        using TargetKind = JarvisDashboardDisplay::TouchTargetKind;
        auto& app = Application::GetInstance();
        switch (target.kind) {
            case TargetKind::kTalk:
                ESP_LOGI(kTag, "Talk button tap");
                app.TalkButtonTap();
                return;
            case TargetKind::kSend:
                ESP_LOGI(kTag, "Send button tap");
                app.TalkButtonSend();
                return;
            default:
                break;
        }
        if (!is_steady || dashboard == nullptr) {
            return;
        }
        switch (target.kind) {
            case TargetKind::kTab: {
                const auto view = static_cast<JarvisDashboardDisplay::View>(target.index);
                ESP_LOGI(kTag, "Tab %d", target.index);
                app.RunDashboardTouch([dashboard, view]() { dashboard->ShowView(view); });
                return;
            }
            case TargetKind::kTileToggle:
            case TargetKind::kClimateDown:
            case TargetKind::kClimateUp:
                // Mosaico de Casa: el estado se pinta en la tarea principal,
                // justo antes de mandar la accion, para que pantalla y mensaje
                // salgan del mismo mosaico aunque haya llegado un tablero nuevo
                // en el medio.
                ESP_LOGI(kTag, "Tile %d tap (kind %d)", target.index, (int)target.kind);
                app.RunDashboardTouch([dashboard, target]() {
                    std::string entity_id;
                    const char* action = nullptr;
                    if (dashboard->ApplyTileAction(target, &entity_id, &action)) {
                        Application::GetInstance().SendHaAction(entity_id, action);
                    }
                });
                return;
            case TargetKind::kCalendarDay: {
                // Abre la vista del dia en "Cargando..." y pide la agenda; si
                // no contesta en 5 s la vista lo dice sola.
                const int day = target.index;
                ESP_LOGI(kTag, "Calendar day %d", day);
                app.RunDashboardTouch([dashboard, day]() {
                    std::string date;
                    if (dashboard->OpenDayView(day, &date)) {
                        Application::GetInstance().SendAgendaDayRequest(date);
                    }
                });
                return;
            }
            case TargetKind::kAgendaRow:
            case TargetKind::kDayRow:
            case TargetKind::kModalClose:
            case TargetKind::kDayCancel:
            case TargetKind::kListSwitch:
                ESP_LOGI(kTag, "Agenda target %d/%d", (int)target.kind, target.index);
                app.RunDashboardTouch([dashboard, target]() { dashboard->ApplyAgendaTouch(target); });
                return;
            case TargetKind::kOverlayBlock:
                // Sobre un overlay pero sobre nada: no hace nada, pero cuenta
                // como actividad (despierta la pantalla si se habia dormido).
                app.RunDashboardTouch([]() {});
                return;
            default:
                return;
        }
    }

    static void EmitGesture(const char* gesture) {
        ESP_LOGI(kTag, "Touch gesture: %s", gesture);
        Application::GetInstance().SendGesture(gesture);
    }
};

#endif  // JARVIS_TOUCH_GESTURES_H
