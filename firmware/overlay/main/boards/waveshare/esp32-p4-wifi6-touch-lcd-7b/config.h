#ifndef _BOARD_CONFIG_H_
#define _BOARD_CONFIG_H_

// Waveshare ESP32-P4-WIFI6-Touch-LCD-7B (ESP32-P4 + ESP32-C6 para el WiFi).
// Pines y timings tomados de xiaozhi-esp32 v2.3.0
// (main/boards/waveshare/esp32-p4-wifi6-touch-lcd, variante 7B), que coinciden
// con el esquemático de Waveshare.

#include <driver/gpio.h>

#define AUDIO_INPUT_SAMPLE_RATE  24000
#define AUDIO_OUTPUT_SAMPLE_RATE 24000

// El ES7210 tiene un canal con la salida del parlante: con eso corre la
// cancelación de eco en la placa.
#define AUDIO_INPUT_REFERENCE    true

#define AUDIO_I2S_GPIO_MCLK GPIO_NUM_13
#define AUDIO_I2S_GPIO_WS   GPIO_NUM_10
#define AUDIO_I2S_GPIO_BCLK GPIO_NUM_12
#define AUDIO_I2S_GPIO_DIN  GPIO_NUM_11
#define AUDIO_I2S_GPIO_DOUT GPIO_NUM_9

#define AUDIO_CODEC_PA_PIN       GPIO_NUM_53
#define AUDIO_CODEC_I2C_SDA_PIN  GPIO_NUM_7
#define AUDIO_CODEC_I2C_SCL_PIN  GPIO_NUM_8
#define AUDIO_CODEC_ES8311_ADDR  ES8311_CODEC_DEFAULT_ADDR
#define AUDIO_CODEC_ES7210_ADDR  ES7210_CODEC_DEFAULT_ADDR

// En la cara de atrás: queda como alternativa al botón Hablar de la pantalla.
#define BOOT_BUTTON_GPIO        GPIO_NUM_35

#define DISPLAY_WIDTH  (1024)
#define DISPLAY_HEIGHT (600)
#define PIN_NUM_LCD_RST                 GPIO_NUM_33
#define DISPLAY_BACKLIGHT_PIN           GPIO_NUM_32
#define DISPLAY_BACKLIGHT_OUTPUT_INVERT true
// xiaozhi y ESPHome usan 900; los ejemplos de Waveshare, 1000. Si la imagen
// parpadea, probar el otro valor.
#define LCD_MIPI_DSI_LANE_BITRATE_MBPS (900)
#define LCD_MIPI_DSI_LANE_NUM          (2)

#define MIPI_DSI_PHY_PWR_LDO_CHAN       (3)
#define MIPI_DSI_PHY_PWR_LDO_VOLTAGE_MV (2500)

#define DISPLAY_SWAP_XY  false
#define DISPLAY_MIRROR_X false
#define DISPLAY_MIRROR_Y false

// El GT911 del 7B tiene los ejes al revés que el panel (girado 180°): sin el
// espejo, tocar la pestaña de arriba llegaba como un toque abajo y del lado
// contrario (medido en la placa: Casa en (600,21) llegaba como (424,579)).
// ESPHome también lo espeja. xiaozhi no lo notaba porque no toca nada fino.
#define TOUCH_MIRROR_X 1
#define TOUCH_MIRROR_Y 1

#define DISPLAY_OFFSET_X 0
#define DISPLAY_OFFSET_Y 0

#endif  // _BOARD_CONFIG_H_
