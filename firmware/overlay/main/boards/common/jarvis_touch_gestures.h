#ifndef JARVIS_TOUCH_GESTURES_H
#define JARVIS_TOUCH_GESTURES_H

// Gestos del táctil para el tablero de Jarvis, compartidos por todas las placas.
//
// El touch se consulta directo desde una tarea propia: los gestos necesitan el
// trazo crudo del dedo, y es lo único que despierta la pantalla dormida
// (SendGesture -> NoteUserActivity). NO se registra el touch en LVGL: dos
// tareas leyendo el mismo controlador por I2C es pelearse por el bus para nada.
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
        // Boton de la pantalla bajo el dedo al empezar la pulsacion.
        using TalkButton = JarvisDashboardDisplay::TalkButton;
        TalkButton press_button = TalkButton::kNone;
        auto* dashboard = dynamic_cast<JarvisDashboardDisplay*>(display_);

        while (true) {
            uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000);

            uint16_t x = 0, y = 0;
            uint8_t point_count = 0;
            if (esp_lcd_touch_read_data(touch_handle_) != ESP_OK) {
                // Un controlador que nunca contesta loguearía un error por
                // sondeo, para siempre. Mejor rendirse que ahogar el log.
                if (++consecutive_read_failures >= kMaxTouchReadFailures) {
                    ESP_LOGE(kTag, "Touch controller unresponsive, stopping gesture task");
                    vTaskDelete(nullptr);
                    return;
                }
                vTaskDelay(pdMS_TO_TICKS(kTouchPollMs));
                continue;
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
                press_button = dashboard != nullptr ? dashboard->HitTestTalkButtons(x, y)
                                                    : TalkButton::kNone;
            } else if (is_pressed) {
                last_x = x;
                last_y = y;
                // Mantener apretado para hablar: graba cuando la pulsación ya es
                // muy larga para ser un tap, y sigue hasta que se levanta el
                // dedo. El dedo tiene que quedarse quieto, o esto secuestraría
                // un swipe lento. Sobre Enviar un hold sigue siendo Enviar.
                if (!is_hold_talking && press_button != TalkButton::kSend &&
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

                // Los botones responden al soltar, sin esperar la ventana de
                // doble tap, y no llegan al servidor como gesto.
                if (press_button != TalkButton::kNone) {
                    pending_tap_ms = 0;
                    if (press_button == TalkButton::kTalk) {
                        ESP_LOGI(kTag, "Talk button tap");
                        Application::GetInstance().TalkButtonTap();
                    } else {
                        ESP_LOGI(kTag, "Send button tap");
                        Application::GetInstance().TalkButtonSend();
                    }
                    press_button = TalkButton::kNone;
                    was_pressed = is_pressed;
                    vTaskDelay(pdMS_TO_TICKS(kTouchPollMs));
                    continue;
                }

                int dx = last_x - start_x;
                int dy = last_y - start_y;
                uint32_t held_ms = now_ms - press_started_ms;

                if (abs(dx) >= kSwipeMinTravelPx && abs(dx) > abs(dy)) {
                    pending_tap_ms = 0;
                    EmitGesture(dx > 0 ? "swipe_right" : "swipe_left");
                } else if (held_ms <= kTapMaxMs && abs(dx) < kTapMaxTravelPx &&
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

    static void EmitGesture(const char* gesture) {
        ESP_LOGI(kTag, "Touch gesture: %s", gesture);
        Application::GetInstance().SendGesture(gesture);
    }
};

#endif  // JARVIS_TOUCH_GESTURES_H
