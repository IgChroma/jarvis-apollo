#include "apollo_protocol.h"
#include <cmath>
#include "display/jarvis_dashboard_display.h"
#include "application.h"
#include "board.h"
#include "settings.h"
#include "system_info.h"

#include <esp_log.h>
#include <esp_timer.h>
#include <cJSON.h>
#include <cstring>
#include <ctime>
#include "assets/lang_config.h"
#include "assets/sound_variants.h"

#define TAG "Apollo"

// Apollo advertises the sample rate on every tts_start; this is only the value
// used before the first one arrives.
#define APOLLO_DEFAULT_TTS_SAMPLE_RATE 24000
#define APOLLO_UPLINK_SAMPLE_RATE 16000
#define APOLLO_FRAME_DURATION_MS 60

namespace {

// Apollo's six states are mapped onto the emote engine's vocabulary, avoiding
// "neutral" and "idle": both are configured loop=false upstream, so they play
// once and freeze. An idle desk agent would sit on a still frame, which reads
// as a crash rather than as calm.
const char* MapApolloEmotion(const char* apollo_emotion) {
    if (strcmp(apollo_emotion, "curious") == 0) {
        // Not "shocked": that asset is the wide-eyed panic face and reads as an
        // error. "winking" is neutral.eaf with loop=true, so the eyes keep
        // blinking attentively while the listen icon does the signaling.
        return "winking";
    }
    if (strcmp(apollo_emotion, "focused") == 0) {
        return "thinking";
    }
    if (strcmp(apollo_emotion, "questioning") == 0) {
        return "confused";
    }
    if (strcmp(apollo_emotion, "talking") == 0) {
        return "happy";
    }
    if (strcmp(apollo_emotion, "calm") == 0) {
        return "sleepy";
    }
    // "neutral" is the resting face: a single blink that the application
    // replays on a cadence, rather than a loop that never stops blinking.
    return "neutral";
}

uint32_t NowMilliseconds() { return (uint32_t)(esp_timer_get_time() / 1000); }

constexpr uint32_t kDefaultConfirmTimeoutMs = 30000;
constexpr uint32_t kMinConfirmTimeoutMs = 3000;
constexpr uint32_t kMaxConfirmTimeoutMs = 45000;
constexpr int64_t kEarliestPlausibleEpochMs = 1609459200000;  // 2021-01-01

// expiresAt is epoch milliseconds, so it only means something once SNTP has
// set the clock. Before that (or against a skewed server) the remainder is
// garbage, and the server's default window is the honest fallback.
uint32_t ConfirmTimeoutFromExpiry(int64_t expires_at_ms) {
    const int64_t now_epoch_ms = (int64_t)time(nullptr) * 1000;
    if (expires_at_ms <= 0 || now_epoch_ms < kEarliestPlausibleEpochMs) {
        return kDefaultConfirmTimeoutMs;
    }
    const int64_t remaining_ms = expires_at_ms - now_epoch_ms;
    if (remaining_ms < (int64_t)kMinConfirmTimeoutMs ||
        remaining_ms > (int64_t)kMaxConfirmTimeoutMs) {
        return kDefaultConfirmTimeoutMs;
    }
    return (uint32_t)remaining_ms;
}

// The wire carries logical effect names so the server can re-purpose sounds
// without a flash; only this table knows which flash asset each name means.
std::string_view MapEffectNameToSound(const char* effect_name) {
    if (strcmp(effect_name, "ding") == 0) {
        return Lang::Sounds::OGG_SUCCESS;
    }
    if (strcmp(effect_name, "chime") == 0) {
        return Lang::Sounds::OGG_POPUP;
    }
    if (strcmp(effect_name, "error") == 0) {
        return Lang::Sounds::OGG_EXCLAMATION;
    }
    if (strcmp(effect_name, "low_battery") == 0) {
        return Lang::Sounds::OGG_LOW_BATTERY;
    }
    return {};
}

// Las fuentes Noto "basic" de la placa no traen el "…" (U+2026) ni la raya
// (U+2014), y el servidor los usa: corta los textos largos con "…" y un sensor
// no disponible vale "—". Sin esto se dibujaban como un hueco.
std::string DisplayText(const char* text) {
    std::string result = text == nullptr ? "" : text;
    struct Replacement {
        const char* from;
        const char* to;
    };
    static const Replacement kReplacementList[] = {
        {"â¦", "..."},  // …
        {"â", "-"},    // —
    };
    for (const auto& replacement : kReplacementList) {
        size_t position = 0;
        const size_t from_length = strlen(replacement.from);
        while ((position = result.find(replacement.from, position)) != std::string::npos) {
            result.replace(position, from_length, replacement.to);
            position += strlen(replacement.to);
        }
    }
    return result;
}

}  // namespace

ApolloProtocol::ApolloProtocol() {}

ApolloProtocol::~ApolloProtocol() {}

bool ApolloProtocol::Start() {
    // Like the websocket protocol, only connect when a session actually starts.
    return true;
}

std::string ApolloProtocol::BuildConnectionUrl(const std::string& base_url,
                                               const std::string& device_id,
                                               const std::string& token) const {
    std::string url = base_url;
    while (!url.empty() && url.back() == '/') {
        url.pop_back();
    }
    // The `agents` SDK routes on /agents/<kebab-cased class>/<instance name>,
    // and authenticates from a token query parameter rather than a header.
    url += "/agents/apollo/";
    url += device_id;
    url += "?token=";
    url += token;
    return url;
}

bool ApolloProtocol::SendText(const std::string& text) {
    if (websocket_ == nullptr || !websocket_->IsConnected()) {
        return false;
    }
    if (!websocket_->Send(text)) {
        ESP_LOGE(TAG, "Failed to send text: %s", text.c_str());
        SetError(Lang::Strings::SERVER_ERROR);
        return false;
    }
    return true;
}

void ApolloProtocol::SendMcpMessage(const std::string& payload) {
    // The inherited frame carries xiaozhi's empty session_id and no ts; Apollo's
    // dialect wants {"type","payload","ts"} like every other event.
    cJSON* payload_json = cJSON_Parse(payload.c_str());
    if (payload_json == nullptr) {
        ESP_LOGE(TAG, "Dropping unparseable MCP payload");
        return;
    }
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "mcp");
    cJSON_AddItemToObject(root, "payload", payload_json);
    cJSON_AddNumberToObject(root, "ts", NowMilliseconds());
    auto serialized = cJSON_PrintUnformatted(root);
    std::string message(serialized);
    cJSON_free(serialized);
    cJSON_Delete(root);
    SendText(message);
}

void ApolloProtocol::SendReminderSeen() {
    SendEvent("reminder_seen");
}

bool ApolloProtocol::SendEvent(const char* type) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", type);
    cJSON_AddNumberToObject(root, "ts", NowMilliseconds());
    auto serialized = cJSON_PrintUnformatted(root);
    std::string message(serialized);
    cJSON_free(serialized);
    cJSON_Delete(root);
    return SendText(message);
}

bool ApolloProtocol::SendAudio(std::unique_ptr<AudioStreamPacket> packet) {
    if (websocket_ == nullptr || !websocket_->IsConnected()) {
        return false;
    }
    // Raw PCM, no framing: the server concatenates the binary frames of an
    // utterance and wraps them in a RIFF header before transcription.
    bool sent =
        websocket_->Send((const char*)packet->payload.data(), packet->payload.size(), true);
    if (sent) {
        turn_audio_bytes_ += packet->payload.size();
    }
    return sent;
}

void ApolloProtocol::SendStartListening(ListeningMode mode) {
    // Apollo distinguishes a held button from a wake word, and resets its audio
    // buffer on either.
    turn_audio_bytes_ = 0;
    listen_started_by_hold_ = mode == kListeningModeManualStop;
    SendEvent(listen_started_by_hold_ ? "hold_start" : "wake");
}

void ApolloProtocol::SendStopListening() {
    // The server transcribes whatever arrived before this event, so knowing how
    // much actually went out is the difference between "the mic is deaf" and
    // "the audio never left the device".
    ESP_LOGI(TAG, "Turn audio sent: %u bytes (%.2f s)", (unsigned)turn_audio_bytes_,
             turn_audio_bytes_ / 32000.0f);
    SendEvent(listen_started_by_hold_ ? "hold_end" : "audio_end");
}

void ApolloProtocol::SendListenCancel() {
    ESP_LOGI(TAG, "Listen cancelled, %u bytes discarded", (unsigned)turn_audio_bytes_);
    SendEvent("listen_cancel");
}

void ApolloProtocol::SendWakeWordDetected(const std::string& wake_word) {
    // Apollo has no voice-print step, so the wake word itself carries no extra
    // information beyond "start listening", which SendStartListening covers.
    (void)wake_word;
}

void ApolloProtocol::SendGesture(const std::string& gesture) {
    if (websocket_ == nullptr || !websocket_->IsConnected()) {
        return;
    }

    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "gesture");
    cJSON_AddStringToObject(root, "gesture", gesture.c_str());
    if (gesture.rfind("swipe", 0) == 0) {
        // A swipe cycles the speech mode. The cue plays now, on the
        // gesture, rather than on the server's ui_state echo: feedback
        // that waits for a round trip feels broken on a slow link.
        Application::GetInstance().PlaySound(Lang::SoundVariants::ModeSwitch());
    }
    cJSON_AddNumberToObject(root, "ts", NowMilliseconds());

    auto serialized = cJSON_PrintUnformatted(root);
    std::string message(serialized);
    cJSON_free(serialized);
    cJSON_Delete(root);

    ESP_LOGI(TAG, "Gesture '%s' -> %s", gesture.c_str(), message.c_str());
    SendText(message);
}

// Toque en un mosaico de la vista Casa (docs/vistas-tablero.md). El servidor
// llama a Home Assistant y empuja el tablero enseguida con el estado nuevo.
void ApolloProtocol::SendHaAction(const std::string& entity_id, const char* action) {
    if (websocket_ == nullptr || !websocket_->IsConnected()) {
        return;
    }

    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "ha_action");
    cJSON_AddStringToObject(root, "entityId", entity_id.c_str());
    cJSON_AddStringToObject(root, "action", action);
    cJSON_AddNumberToObject(root, "ts", NowMilliseconds());

    auto serialized = cJSON_PrintUnformatted(root);
    std::string message(serialized);
    cJSON_free(serialized);
    cJSON_Delete(root);

    ESP_LOGI(TAG, "Home Assistant -> %s", message.c_str());
    SendText(message);
}

void ApolloProtocol::SendConfirm(bool ok) {
    if (websocket_ == nullptr || !websocket_->IsConnected()) {
        return;
    }

    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "confirm");
    cJSON_AddBoolToObject(root, "ok", ok);
    cJSON_AddNumberToObject(root, "ts", NowMilliseconds());

    auto serialized = cJSON_PrintUnformatted(root);
    std::string message(serialized);
    cJSON_free(serialized);
    cJSON_Delete(root);

    ESP_LOGI(TAG, "Confirm -> %s", message.c_str());
    SendText(message);
}

void ApolloProtocol::SendTelemetry(const DeviceTelemetry& telemetry) {
    if (websocket_ == nullptr || !websocket_->IsConnected()) {
        return;
    }

    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "telemetry");
    if (telemetry.battery_valid) {
        cJSON_AddNumberToObject(root, "battery", telemetry.battery_level);
    }
    if (telemetry.charging_valid) {
        cJSON_AddBoolToObject(root, "charging", telemetry.charging);
    }
    cJSON_AddNumberToObject(root, "volume", telemetry.volume);
    cJSON_AddNumberToObject(root, "wifiRssi", telemetry.wifi_rssi);
    if (telemetry.firmware_version != nullptr) {
        cJSON_AddStringToObject(root, "firmwareVersion", telemetry.firmware_version);
    }
    cJSON_AddNumberToObject(root, "ts", NowMilliseconds());

    auto serialized = cJSON_PrintUnformatted(root);
    std::string message(serialized);
    cJSON_free(serialized);
    cJSON_Delete(root);

    SendText(message);
}

void ApolloProtocol::SendPlaybackAck(uint32_t played_milliseconds) {
    if (websocket_ == nullptr || !websocket_->IsConnected() || tts_sequence_ < 0) {
        return;
    }

    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "playback_ack");
    cJSON_AddNumberToObject(root, "sequence", tts_sequence_);
    cJSON_AddNumberToObject(root, "playedMilliseconds", played_milliseconds);
    cJSON_AddNumberToObject(root, "ts", NowMilliseconds());

    auto serialized = cJSON_PrintUnformatted(root);
    std::string message(serialized);
    cJSON_free(serialized);
    cJSON_Delete(root);

    SendText(message);
}

void ApolloProtocol::SendAbortSpeaking(AbortReason reason) {
    (void)reason;
    // Tell the server to stop streaming, then drop what is already queued here:
    // without the first the audio keeps arriving, without the second the device
    // keeps playing what it already has.
    SendEvent("abort");
    FinishTtsRun();
}

bool ApolloProtocol::IsAudioChannelOpened() const {
    return websocket_ != nullptr && websocket_->IsConnected() && !error_occurred_ && !IsTimeout();
}

void ApolloProtocol::CloseAudioChannel(bool send_goodbye) {
    (void)send_goodbye;
    tts_run_active_ = false;
    tts_expected_bytes_ = 0;
    tts_received_bytes_ = 0;
    websocket_.reset();
}

void ApolloProtocol::EmitTranslatedJson(cJSON* root) {
    if (on_incoming_json_ != nullptr) {
        on_incoming_json_(root);
    }
    cJSON_Delete(root);
}

void ApolloProtocol::EmitTtsState(const char* state, const char* text) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "tts");
    cJSON_AddStringToObject(root, "state", state);
    if (text != nullptr) {
        cJSON_AddStringToObject(root, "text", text);
    }
    EmitTranslatedJson(root);
}

void ApolloProtocol::EmitEmotion(const char* emotion) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "llm");
    cJSON_AddStringToObject(root, "emotion", emotion);
    cJSON_AddStringToObject(root, "text", "");
    EmitTranslatedJson(root);
}

void ApolloProtocol::EmitAccentColor(const char* color) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "accent");
    cJSON_AddStringToObject(root, "color", color);
    EmitTranslatedJson(root);
}

void ApolloProtocol::EmitArcProgress(int64_t started_at_ms, int64_t ends_at_ms) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "arc");
    cJSON_AddNumberToObject(root, "startedAtMs", (double)started_at_ms);
    cJSON_AddNumberToObject(root, "endsAtMs", (double)ends_at_ms);
    EmitTranslatedJson(root);
}

void ApolloProtocol::EmitArcClear() {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "arc");
    EmitTranslatedJson(root);
}

void ApolloProtocol::EmitAlert(const char* status, const char* message, const char* emotion) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "alert");
    cJSON_AddStringToObject(root, "status", status);
    cJSON_AddStringToObject(root, "message", message);
    cJSON_AddStringToObject(root, "emotion", emotion);
    EmitTranslatedJson(root);
}

// Un recordatorio se lleva la pantalla entera y se queda hasta que lo toquen.
//
// El camino viejo (EmitAlert -> Application::Alert -> SetChatMessage) sigue
// vivo como respaldo y no es un adorno: con el motor de caras el tablero no
// existe, y ahi el globito del Einstein es la unica superficie que hay. Sin
// este fallback un recordatorio se perderia entero en esa configuracion.
void ApolloProtocol::HandleReminder(const char* message) {
    auto display = Board::GetInstance().GetDisplay();
    auto dashboard = dynamic_cast<JarvisDashboardDisplay*>(display);
    if (dashboard == nullptr) {
        ESP_LOGI(TAG, "recordatorio sin tablero: se muestra como alerta");
        EmitAlert("Recordatorio", message, "neutral");
        return;
    }
    ESP_LOGI(TAG, "recordatorio a pantalla completa: %s", message);
    dashboard->ShowReminder(message);
}

// El servidor manda el tablero entero ya recortado: aca solo se traduce el JSON
// a la estructura del display. Toda tarjeta es opcional — la que no tiene dato
// no viaja, y el tablero la esconde en vez de mostrarla vacia.
void ApolloProtocol::HandleDashboard(const cJSON* root) {
    auto display = Board::GetInstance().GetDisplay();
    auto dashboard = dynamic_cast<JarvisDashboardDisplay*>(display);
    if (dashboard == nullptr) {
        // Con el motor de caras el tablero no existe. Se loguea igual: un
        // dynamic_cast que falla en silencio deja la pantalla vacia sin ninguna
        // pista de por que, y eso ya costo varias vueltas de diagnostico.
        ESP_LOGW(TAG, "dashboard: el display no es JarvisDashboardDisplay, se ignora");
        return;
    }

    JarvisDashboardDisplay::DashboardData data;

    auto weather = cJSON_GetObjectItem(root, "weather");
    data.weather_present = cJSON_IsObject(weather);
    if (data.weather_present) {
        auto temperature = cJSON_GetObjectItem(weather, "temperatureC");
        auto condition = cJSON_GetObjectItem(weather, "conditionLabel");
        auto place = cJSON_GetObjectItem(weather, "locationLabel");
        if (cJSON_IsNumber(temperature) && cJSON_IsString(condition)) {
            data.has_weather = true;
            // El servidor manda el valor crudo: redondear es decision de la
            // pantalla. lround y no truncar, para que 8.6 sea 9 y no 8.
            data.temperature_c = (int)lround(temperature->valuedouble);
            data.condition_label = DisplayText(condition->valuestring);
            if (cJSON_IsString(place)) {
                data.place_label = DisplayText(place->valuestring);
            }
            // Solo vienen con el clima de Home Assistant (open-meteo no los
            // tiene): cada uno se dibuja si esta.
            auto condition_code = cJSON_GetObjectItem(weather, "conditionCode");
            auto min_c = cJSON_GetObjectItem(weather, "minC");
            auto max_c = cJSON_GetObjectItem(weather, "maxC");
            auto humidity = cJSON_GetObjectItem(weather, "humidityPercent");
            if (cJSON_IsString(condition_code)) {
                data.condition_code = condition_code->valuestring;
            }
            if (cJSON_IsNumber(min_c)) {
                data.has_min = true;
                data.min_c = (int)lround(min_c->valuedouble);
            }
            if (cJSON_IsNumber(max_c)) {
                data.has_max = true;
                data.max_c = (int)lround(max_c->valuedouble);
            }
            if (cJSON_IsNumber(humidity)) {
                data.has_humidity = true;
                data.humidity_percent = (int)lround(humidity->valuedouble);
            }
        }
    }

    auto agenda_list = cJSON_GetObjectItem(root, "agendaList");
    data.agenda_present = cJSON_IsArray(agenda_list);
    if (data.agenda_present) {
        cJSON* entry = nullptr;
        cJSON_ArrayForEach(entry, agenda_list) {
            auto title = cJSON_GetObjectItem(entry, "title");
            auto when_label = cJSON_GetObjectItem(entry, "whenLabel");
            if (cJSON_IsString(title) && cJSON_IsString(when_label)) {
                data.agenda_list.push_back(
                    {DisplayText(title->valuestring), DisplayText(when_label->valuestring)});
            }
        }
    }

    // `pending` ausente significa "este emisor no sabe de pendientes", no
    // "no hay pendientes": la tarjeta se deja como esta.
    auto pending = cJSON_GetObjectItem(root, "pending");
    data.pending_present = cJSON_IsObject(pending);
    if (data.pending_present) {
        auto count = cJSON_GetObjectItem(pending, "count");
        auto item_list = cJSON_GetObjectItem(pending, "itemList");
        if (cJSON_IsNumber(count)) {
            data.has_pending = true;
            data.pending_count = count->valueint;
        }
        if (cJSON_IsArray(item_list)) {
            cJSON* item = nullptr;
            cJSON_ArrayForEach(item, item_list) {
                if (cJSON_IsString(item)) {
                    data.pending_item_list.push_back(DisplayText(item->valuestring));
                }
            }
        }
    }

    auto travel = cJSON_GetObjectItem(root, "travel");
    data.travel_present = cJSON_IsObject(travel);
    if (data.travel_present) {
        auto label = cJSON_GetObjectItem(travel, "label");
        auto minutes = cJSON_GetObjectItem(travel, "minutes");
        if (cJSON_IsString(label) && cJSON_IsNumber(minutes)) {
            data.has_travel = true;
            data.travel_label = DisplayText(label->valuestring);
            data.travel_minutes = minutes->valueint;
        }
    }

    // Calendario del mes (vista Inicio). Ausente = "este emisor no lo sabe";
    // presente pero mal formado = se dibuja vacio.
    auto month_calendar = cJSON_GetObjectItem(root, "monthCalendar");
    data.month_calendar_present = cJSON_IsObject(month_calendar);
    if (data.month_calendar_present) {
        auto year = cJSON_GetObjectItem(month_calendar, "year");
        auto month = cJSON_GetObjectItem(month_calendar, "month");
        auto today_day = cJSON_GetObjectItem(month_calendar, "todayDay");
        auto first_weekday = cJSON_GetObjectItem(month_calendar, "firstWeekday");
        auto day_count = cJSON_GetObjectItem(month_calendar, "dayCount");
        if (cJSON_IsNumber(year) && cJSON_IsNumber(month) && cJSON_IsNumber(today_day) &&
            cJSON_IsNumber(first_weekday) && cJSON_IsNumber(day_count)) {
            data.has_month_calendar = true;
            data.calendar_year = year->valueint;
            data.calendar_month = month->valueint;
            data.calendar_today_day = today_day->valueint;
            data.calendar_first_weekday = first_weekday->valueint;
            data.calendar_day_count = day_count->valueint;
        }
        auto event_day_list = cJSON_GetObjectItem(month_calendar, "eventDayList");
        if (cJSON_IsArray(event_day_list)) {
            cJSON* day = nullptr;
            cJSON_ArrayForEach(day, event_day_list) {
                if (cJSON_IsNumber(day)) {
                    data.calendar_event_day_list.push_back(day->valueint);
                }
            }
        }
        auto today_event_list = cJSON_GetObjectItem(month_calendar, "todayEventList");
        if (cJSON_IsArray(today_event_list)) {
            cJSON* event = nullptr;
            cJSON_ArrayForEach(event, today_event_list) {
                auto time_label = cJSON_GetObjectItem(event, "timeLabel");
                auto title = cJSON_GetObjectItem(event, "title");
                if (cJSON_IsString(time_label) && cJSON_IsString(title)) {
                    data.calendar_today_event_list.push_back(
                        {DisplayText(time_label->valuestring), DisplayText(title->valuestring)});
                }
            }
        }
    }

    // Vista Casa. `home` presente con la lista vacia SI es "no hay mosaicos":
    // la pantalla muestra como etiquetarlos en Home Assistant.
    auto home = cJSON_GetObjectItem(root, "home");
    data.home_present = cJSON_IsObject(home);
    if (data.home_present) {
        auto tile_list = cJSON_GetObjectItem(home, "tileList");
        if (cJSON_IsArray(tile_list)) {
            cJSON* entry = nullptr;
            cJSON_ArrayForEach(entry, tile_list) {
                auto entity_id = cJSON_GetObjectItem(entry, "entityId");
                auto name = cJSON_GetObjectItem(entry, "name");
                auto kind = cJSON_GetObjectItem(entry, "kind");
                if (!cJSON_IsString(entity_id) || !cJSON_IsString(name) || !cJSON_IsString(kind)) {
                    continue;
                }
                JarvisDashboardDisplay::HomeTile tile;
                tile.entity_id = entity_id->valuestring;
                tile.name = DisplayText(name->valuestring);
                // Sin la clave se asume disponible: el esquema la exige, y un
                // mosaico gris por un campo faltante confunde mas que ayuda.
                auto available = cJSON_GetObjectItem(entry, "available");
                tile.available = !cJSON_IsBool(available) || cJSON_IsTrue(available);
                if (strcmp(kind->valuestring, "toggle") == 0) {
                    tile.kind = JarvisDashboardDisplay::HomeTileKind::kToggle;
                    tile.is_on = cJSON_IsTrue(cJSON_GetObjectItem(entry, "isOn"));
                } else if (strcmp(kind->valuestring, "sensor") == 0) {
                    tile.kind = JarvisDashboardDisplay::HomeTileKind::kSensor;
                    auto value = cJSON_GetObjectItem(entry, "value");
                    auto unit = cJSON_GetObjectItem(entry, "unit");
                    tile.value = cJSON_IsString(value) ? DisplayText(value->valuestring) : "--";
                    if (cJSON_IsString(unit)) {
                        tile.unit = DisplayText(unit->valuestring);
                    }
                } else if (strcmp(kind->valuestring, "climate") == 0) {
                    tile.kind = JarvisDashboardDisplay::HomeTileKind::kClimate;
                    auto current = cJSON_GetObjectItem(entry, "currentC");
                    auto target = cJSON_GetObjectItem(entry, "targetC");
                    auto hvac_mode = cJSON_GetObjectItem(entry, "hvacMode");
                    tile.has_current = cJSON_IsNumber(current);
                    tile.current_c = tile.has_current ? (float)current->valuedouble : 0;
                    tile.has_target = cJSON_IsNumber(target);
                    tile.target_c = tile.has_target ? (float)target->valuedouble : 0;
                    if (cJSON_IsString(hvac_mode)) {
                        tile.hvac_mode = hvac_mode->valuestring;
                    }
                } else {
                    // Un tipo que este firmware no conoce no se dibuja a medias.
                    continue;
                }
                data.home_tile_list.push_back(std::move(tile));
            }
        }
        auto dollar_blue = cJSON_GetObjectItem(home, "dollarBlue");
        if (cJSON_IsObject(dollar_blue)) {
            auto buy = cJSON_GetObjectItem(dollar_blue, "buy");
            auto sell = cJSON_GetObjectItem(dollar_blue, "sell");
            auto updated_label = cJSON_GetObjectItem(dollar_blue, "updatedLabel");
            if (cJSON_IsNumber(buy) && cJSON_IsNumber(sell)) {
                data.has_dollar_blue = true;
                data.dollar_buy = buy->valuedouble;
                data.dollar_sell = sell->valuedouble;
                if (cJSON_IsString(updated_label)) {
                    data.dollar_updated_label = DisplayText(updated_label->valuestring);
                }
            }
        }
    }

    ESP_LOGI(TAG, "dashboard: clima=%d agenda=%d(%d) pend=%d(%d de %d) viaje=%d mes=%d casa=%d(%d)",
             (int)data.weather_present, (int)data.agenda_present,
             (int)data.agenda_list.size(), (int)data.pending_present,
             (int)data.pending_item_list.size(), data.pending_count,
             (int)data.travel_present, (int)data.month_calendar_present,
             (int)data.home_present, (int)data.home_tile_list.size());
    dashboard->SetDashboardData(data);
}

void ApolloProtocol::HandleUiState(const cJSON* root) {
    // Any state but "confirm" means the turn moved on, so a confirm screen
    // still up is stale. Not keyed off tts_start: the summary's own TTS
    // follows the confirm_request immediately and would kill the screen the
    // moment it appeared, while the turn's closing ui_state carries "confirm".
    auto state = cJSON_GetObjectItem(root, "state");
    if (cJSON_IsString(state) && strcmp(state->valuestring, "confirm") != 0) {
        Application::GetInstance().DismissConfirm();
    }

    // `mood` (el animo de la respuesta) lo usaba la cara de Einstein, que ya no
    // esta en el tablero: se ignora.

    auto emotion = cJSON_GetObjectItem(root, "emotion");
    if (cJSON_IsString(emotion)) {
        EmitEmotion(MapApolloEmotion(emotion->valuestring));
    }

    // The speech mode is signaled by the accent ring color alone, so it has to
    // ride along on every ui_state, not only on an explicit mode change.
    auto accent = cJSON_GetObjectItem(root, "accentColor");
    if (cJSON_IsString(accent)) {
        EmitAccentColor(accent->valuestring);
    }

    // Apollo's caption is whatever the agent is saying or thinking about, which
    // is what xiaozhi renders from a sentence_start.
    auto caption = cJSON_GetObjectItem(root, "caption");
    if (cJSON_IsString(caption) && strlen(caption->valuestring) > 0) {
        EmitTtsState("sentence_start", caption->valuestring);
    }

    if (timer_arc_ends_at_ms_ > (int64_t)time(nullptr) * 1000) {
        return;
    }
    auto focus_ends_at = cJSON_GetObjectItem(root, "focusEndsAt");
    auto focus_started_at = cJSON_GetObjectItem(root, "focusStartedAt");
    if (cJSON_IsNumber(focus_ends_at) && cJSON_IsNumber(focus_started_at)) {
        EmitArcProgress((int64_t)focus_started_at->valuedouble * 1000,
                        (int64_t)focus_ends_at->valuedouble * 1000);
    } else {
        // No focus window on this push: whatever focus arc is showing is over.
        EmitArcClear();
    }
}

void ApolloProtocol::HandleTimer(const cJSON* root) {
    auto ends_at = cJSON_GetObjectItem(root, "endsAt");
    auto duration = cJSON_GetObjectItem(root, "durationSeconds");
    if (cJSON_IsNumber(ends_at) && cJSON_IsNumber(duration)) {
        const int64_t ends_at_ms = (int64_t)ends_at->valuedouble * 1000;
        timer_arc_ends_at_ms_ = ends_at_ms;
        EmitArcProgress(ends_at_ms - (int64_t)duration->valuedouble * 1000, ends_at_ms);
    } else {
        timer_arc_ends_at_ms_ = 0;
        EmitArcClear();
    }
}

void ApolloProtocol::HandleTtsStart(const cJSON* root) {
    auto bytes = cJSON_GetObjectItem(root, "bytes");
    auto sequence = cJSON_GetObjectItem(root, "sequence");
    auto sample_rate = cJSON_GetObjectItem(root, "sampleRate");
    auto format = cJSON_GetObjectItem(root, "format");

    if (cJSON_IsString(format) && strcmp(format->valuestring, "pcm") != 0) {
        // Nothing on the device can decode mp3, so a non-pcm run would only
        // produce noise. Refuse it loudly instead.
        ESP_LOGE(TAG, "Unsupported tts format '%s', expected pcm", format->valuestring);
        SetError(Lang::Strings::SERVER_ERROR);
        return;
    }

    server_sample_rate_ =
        cJSON_IsNumber(sample_rate) ? sample_rate->valueint : APOLLO_DEFAULT_TTS_SAMPLE_RATE;
    server_frame_duration_ = APOLLO_FRAME_DURATION_MS;
    tts_expected_bytes_ = cJSON_IsNumber(bytes) ? (uint32_t)bytes->valuedouble : 0;
    tts_received_bytes_ = 0;
    tts_sequence_ = cJSON_IsNumber(sequence) ? sequence->valueint : -1;
    // No byte total means streaming synthesis: the run stays open until the
    // server's tts_end. A total of zero is still an empty run.
    tts_run_active_ = tts_expected_bytes_ > 0 || bytes == nullptr;

    ESP_LOGI(TAG, "TTS run starting: %lu bytes at %d Hz (seq %ld)",
             (unsigned long)tts_expected_bytes_, server_sample_rate_, (long)tts_sequence_);
    EmitTtsState("start", nullptr);

    if (!tts_run_active_) {
        // An empty run still has to be closed or Application would sit in the
        // speaking state forever.
        EmitTtsState("stop", nullptr);
    }
}

void ApolloProtocol::FinishTtsRun() {
    if (!tts_run_active_) {
        return;
    }
    tts_run_active_ = false;
    tts_expected_bytes_ = 0;
    tts_received_bytes_ = 0;
    EmitTtsState("stop", nullptr);
}

void ApolloProtocol::HandleIncomingAudio(const char* data, size_t len) {
    if (on_incoming_audio_ == nullptr) {
        return;
    }

    auto payload = (const uint8_t*)data;
    on_incoming_audio_(std::make_unique<AudioStreamPacket>(
        AudioStreamPacket{.sample_rate = server_sample_rate_,
                          .frame_duration = server_frame_duration_,
                          .timestamp = 0,
                          .payload = std::vector<uint8_t>(payload, payload + len),
                          .pcm = true}));

    if (!tts_run_active_) {
        return;
    }
    tts_received_bytes_ += len;
    if (tts_expected_bytes_ > 0 && tts_received_bytes_ >= tts_expected_bytes_) {
        FinishTtsRun();
    }
}

void ApolloProtocol::HandleIncomingJson(const char* data, size_t len) {
    auto root = cJSON_ParseWithLength(data, len);
    if (root == nullptr) {
        ESP_LOGE(TAG, "Failed to parse message: %s", std::string(data, len).c_str());
        return;
    }

    auto type = cJSON_GetObjectItem(root, "type");
    if (!cJSON_IsString(type)) {
        cJSON_Delete(root);
        return;
    }

    if (strcmp(type->valuestring, "ui_state") == 0) {
        HandleUiState(root);
    } else if (strcmp(type->valuestring, "dashboard") == 0) {
        HandleDashboard(root);
    } else if (strcmp(type->valuestring, "tts_start") == 0) {
        HandleTtsStart(root);
    } else if (strcmp(type->valuestring, "tts_end") == 0) {
        FinishTtsRun();
    } else if (strcmp(type->valuestring, "tts_aborted") == 0) {
        // The byte total promised by tts_start will never arrive, so close the
        // run explicitly or the device waits for speech that stopped coming.
        ESP_LOGI(TAG, "Server acknowledged abort");
        FinishTtsRun();
    } else if (strcmp(type->valuestring, "timer") == 0) {
        HandleTimer(root);
    } else if (strcmp(type->valuestring, "turn_end") == 0) {
        auto expects_reply = cJSON_GetObjectItem(root, "expectsReply");
        Application::GetInstance().OnTurnEnd(cJSON_IsTrue(expects_reply));
    } else if (strcmp(type->valuestring, "error") == 0) {
        auto message = cJSON_GetObjectItem(root, "message");
        EmitAlert("Error", cJSON_IsString(message) ? message->valuestring : "Error", "sad");
    } else if (strcmp(type->valuestring, "reminder") == 0) {
        auto message = cJSON_GetObjectItem(root, "message");
        if (cJSON_IsString(message)) {
            HandleReminder(message->valuestring);
        }
    } else if (strcmp(type->valuestring, "background_result") == 0) {
        auto summary = cJSON_GetObjectItem(root, "summary");
        if (cJSON_IsString(summary)) {
            EmitAlert("Listo", summary->valuestring, "happy");
        }
    } else if (strcmp(type->valuestring, "confirm_request") == 0) {
        auto summary = cJSON_GetObjectItem(root, "summary");
        auto expires_at = cJSON_GetObjectItem(root, "expiresAt");
        if (cJSON_IsString(summary)) {
            const uint32_t timeout_ms = ConfirmTimeoutFromExpiry(
                cJSON_IsNumber(expires_at) ? (int64_t)expires_at->valuedouble : 0);
            // ShowConfirm schedules its own work onto the main task, which is
            // what makes it callable from this websocket task.
            Application::GetInstance().ShowConfirm(summary->valuestring, timeout_ms);
        }
    } else if (strcmp(type->valuestring, "confirm_close") == 0) {
        // The window ended somewhere else: resolved from the dashboard,
        // expired server-side, or lost. The screen has nothing left to answer.
        Application::GetInstance().DismissConfirm();
    } else if (strcmp(type->valuestring, "play_effect") == 0) {
        auto name = cJSON_GetObjectItem(root, "name");
        if (cJSON_IsString(name)) {
            auto sound = MapEffectNameToSound(name->valuestring);
            if (sound.empty()) {
                ESP_LOGW(TAG, "Unknown effect: %s", name->valuestring);
            } else {
                // This runs on the websocket task; playback goes through the
                // main task, which owns the audio service.
                Application::GetInstance().Schedule(
                    [sound]() { Application::GetInstance().PlaySound(sound); });
            }
        }
    } else if (strcmp(type->valuestring, "mcp") == 0) {
        // Handed to Application's dispatcher whole: it unwraps `payload` and
        // routes it into the embedded McpServer. Not EmitTranslatedJson — that
        // would delete root, which this function already does below.
        if (on_incoming_json_ != nullptr) {
            on_incoming_json_(root);
        }
    } else {
        // `dashboard` has no UI yet, and the agents SDK injects its own
        // cf_agent_state / cf_agent_mcp_servers traffic that is not part of
        // Apollo's protocol at all. Both are ignored on purpose.
        ESP_LOGD(TAG, "Ignoring message type: %s", type->valuestring);
    }

    cJSON_Delete(root);
}

bool ApolloProtocol::OpenAudioChannel() {
    // NVS wins so a provisioned device can be repointed without a rebuild, but
    // the build-time values keep the common case flash-and-go. Provisioning NVS
    // rewrites the whole partition, which would take the wifi credentials with
    // it, so defaults are the friendlier path here.
    Settings settings("apollo", false);
    std::string base_url = settings.GetString("url", CONFIG_APOLLO_URL);
    std::string token = settings.GetString("token", CONFIG_APOLLO_TOKEN);
    std::string device_id = settings.GetString("device_id", CONFIG_APOLLO_DEVICE_ID);

    if (base_url.empty()) {
        ESP_LOGE(TAG, "No Apollo url configured in NVS namespace 'apollo'");
        SetError(Lang::Strings::SERVER_NOT_FOUND);
        return false;
    }
    if (device_id.empty()) {
        device_id = SystemInfo::GetMacAddress();
    }

    error_occurred_ = false;
    tts_run_active_ = false;
    tts_expected_bytes_ = 0;
    tts_received_bytes_ = 0;
    server_sample_rate_ = APOLLO_DEFAULT_TTS_SAMPLE_RATE;
    server_frame_duration_ = APOLLO_FRAME_DURATION_MS;

    auto network = Board::GetInstance().GetNetwork();
    websocket_ = network->CreateWebSocket(1);
    if (websocket_ == nullptr) {
        ESP_LOGE(TAG, "Failed to create websocket");
        return false;
    }

    websocket_->OnData([this](const char* data, size_t len, bool binary) {
        if (binary) {
            HandleIncomingAudio(data, len);
        } else {
            HandleIncomingJson(data, len);
        }
        last_incoming_time_ = std::chrono::steady_clock::now();
    });

    websocket_->OnDisconnected([this]() {
        ESP_LOGI(TAG, "Apollo websocket disconnected");
        if (on_audio_channel_closed_ != nullptr) {
            on_audio_channel_closed_();
        }
    });

    // El reloj de inactividad arranca al conectar. Sin esto arrastra el valor de
    // la sesión anterior (o el de fábrica): IsTimeout() puede dar verdadero
    // apenas se abre el canal, y entonces IsAudioChannelOpened() lo declara
    // cerrado aunque acabe de conectarse — o al revés, tapar una conexión que
    // ya está muerta. Con el reinicio, la ventana de 120s cuenta desde acá.
    last_incoming_time_ = std::chrono::steady_clock::now();

    auto url = BuildConnectionUrl(base_url, device_id, token);
    ESP_LOGI(TAG, "Connecting to Apollo as device '%s'", device_id.c_str());
    if (!websocket_->Connect(url.c_str())) {
        ESP_LOGE(TAG, "Failed to connect, code=%d", websocket_->GetLastError());
        SetError(Lang::Strings::SERVER_NOT_CONNECTED);
        return false;
    }

    // Apollo answers a hello with a ui_state push rather than a hello of its
    // own, so there is no handshake to wait for: the channel is usable as soon
    // as the socket is up.
    cJSON* hello = cJSON_CreateObject();
    cJSON_AddStringToObject(hello, "type", "hello");
    cJSON_AddStringToObject(hello, "deviceId", device_id.c_str());
    cJSON_AddNumberToObject(hello, "ts", NowMilliseconds());
    // Lo que sabe hacer este firmware. "reminder_seen": avisa cuando se descarta
    // un recordatorio; con eso el servidor manda por WhatsApp los que nadie vio.
    cJSON* features = cJSON_AddArrayToObject(hello, "features");
    cJSON_AddItemToArray(features, cJSON_CreateString("reminder_seen"));
    cJSON_AddItemToArray(features, cJSON_CreateString("mood"));
    auto serialized = cJSON_PrintUnformatted(hello);
    std::string hello_message(serialized);
    cJSON_free(serialized);
    cJSON_Delete(hello);

    if (!SendText(hello_message)) {
        return false;
    }

    if (on_audio_channel_opened_ != nullptr) {
        on_audio_channel_opened_();
    }
    return true;
}
