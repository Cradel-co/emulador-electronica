#pragma once

#include "esphome/components/remote_base/rc_switch_protocol.h"
#include "esphome/components/uart/uart.h"
#include "esphome/core/component.h"
#include "esphome/core/helpers.h"

#include <array>
#include <string>
#include <utility>
#include <vector>

#ifdef USE_ESP32
#include <driver/gpio.h>
#include <driver/rmt_tx.h>
#include <driver/rmt_rx.h>
#include <driver/rmt_encoder.h>
#include <esp_cpu.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#endif

namespace esphome {
namespace sim_bridge {

/** Levels of a watched output pin, kept to detect changes. */
struct WatchedPin {
  uint8_t pin;
  uint8_t level;
  bool has_level;
};

#ifdef USE_ESP32
/** One edge captured by the RF TX GPIO interrupt. */
struct RfEdge {
  uint32_t cycles;
  uint8_t level;
};
#endif

/**
 * Simulation bridge. Lives inside the emulated firmware and talks to the app
 * over a UART (UART1 in the simulation, forwarded by esp-emu over TCP).
 *
 * Strategies (section 7.2 of GUIA-IMPLEMENTACION.md), all verified on
 * esp-emu v0.44.0 + ESPHome 2026.9.0 (see EXPERIMENTOS-FASE0.md):
 *
 *  - outputs: polls the GPIO output registers (GPIO_OUT_REG / GPIO_OUT1_REG)
 *    every `poll_interval`; the user's code is not modified.
 *  - inputs: drives the pin as GPIO_MODE_INPUT_OUTPUT + gpio_set_level, so the
 *    pad reads back the driven level, exactly like a real pin being pulled.
 *  - RF in: generates the RCSwitch waveform on the receiver's pin from a
 *    dedicated FreeRTOS task, so remote_receiver decodes it as if it came
 *    from the air.
 *  - RF out: captures the edges of the transmitter's pin with a GPIO ISR and
 *    decodes them with ESPHome's own RCSwitch decoder.
 */
class SimBridge : public Component, public uart::UARTDevice {
 public:
  void set_poll_interval(uint32_t interval_ms) { this->poll_interval_ = interval_ms; }
  void set_verbose(bool verbose) { this->verbose_ = verbose; }
  void set_rf_protocol(uint8_t protocol) { this->rf_protocol_ = protocol; }
  void set_rf_repeat(uint8_t repeat) { this->rf_repeat_ = repeat; }
  void set_rf_rx_pin(int8_t pin) { this->rf_rx_pin_ = pin; }
  void set_rf_tx_pin(int8_t pin) { this->rf_tx_pin_ = pin; }
  void set_rf_rx_channel(int8_t channel) { this->rf_rx_channel_ = channel; }
  void set_rf_tx_channel(int8_t channel) { this->rf_tx_channel_ = channel; }
  void set_bridge_rf_tx_channel(int8_t channel) { this->bridge_rf_tx_channel_ = channel; }
  void set_bridge_rf_rx_channel(int8_t channel) { this->bridge_rf_rx_channel_ = channel; }
  /** Pin GPIO del canal RMT de captura (el loopback inyecta los símbolos). */
  void set_bridge_rf_rx_gpio(int8_t pin) { this->bridge_rf_rx_gpio_ = pin; }
  /**
   * Nivel de reposo de una entrada simulada (el que tiene el pin sin que nadie
   * lo toque). Sin esto, un pulsador con pull-up arrancaría "presionado".
   */
  void set_input_idle(uint8_t pin, uint8_t level) {
    if (pin < MAX_INPUT_PINS)
      this->input_idles_.push_back({pin, (uint8_t) (level ? 1 : 0)});
  }

  /** Máximo de pines con entrada simulada (0..63). */
  static constexpr size_t MAX_INPUT_PINS = 64;

  /**
   * Estado lógico de una entrada simulada, para el `binary_sensor` de
   * plataforma `template` que genera la app (estrategia de la sección 7.2,
   * la única que esp-emu respeta de punta a punta).
   */
  bool input_state(uint8_t pin) const {
    if (pin >= MAX_INPUT_PINS)
      return false;
    return this->input_levels_[pin] != 0;
  }

  /** Nivel eléctrico de la entrada (0/1), sin invertir por pull-up. */
  int raw_input_level(uint8_t pin) const {
    if (pin >= MAX_INPUT_PINS)
      return -1;
    return this->input_levels_[pin] ? 1 : 0;
  }

  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::DATA; }

 protected:
  void send_line_(const std::string &line);
  void send_error_(const std::string &code, const std::string &message);
  void process_line_(const std::string &line);
  void handle_hello_();
  void handle_watch_(int pin);
  void handle_in_(int pin, int level);
  void handle_rf_(const std::string &bits, int protocol);
  void init_rmt_();
  void poll_outputs_();
  bool read_output_level_(uint8_t pin) const;

#ifdef USE_ESP32
  void rf_task_();
  static void rf_task_entry_(void *arg);
  static void IRAM_ATTR rf_isr_(void *arg);
  void IRAM_ATTR on_rf_edge_(uint8_t level);
  void drain_rf_edges_();
  void decode_rf_timings_();
  void set_pin_input_output_(int8_t pin);
  void start_rf_capture_();
  void send_tx_(uint64_t code, uint8_t nbits, uint8_t protocol);
  void send_rf_rmt_(uint64_t code, uint8_t nbits);
  static bool IRAM_ATTR rf_rx_done_(rmt_channel_handle_t chan, const rmt_rx_done_event_data_t *data, void *ctx);
  void rf_rx_poll_();
#endif

  uint32_t poll_interval_{10};
  bool verbose_{false};
  bool injection_works_{true};  // ¿el pad refleja el nivel impuesto? (E2)
  std::vector<char> rx_buffer_;

  /** Niveles impuestos por la app con @IN, indexados por número de pin. */
  std::array<uint8_t, MAX_INPUT_PINS> input_levels_{};
  /** Pares (pin, nivel de reposo) declarados en el YAML de simulación. */
  std::vector<std::pair<uint8_t, uint8_t>> input_idles_;

  std::vector<WatchedPin> watched_pins_;
  uint32_t last_poll_{0};

  uint8_t rf_protocol_{1};
  uint8_t rf_repeat_{5};
  int8_t rf_rx_pin_{-1};
  int8_t rf_tx_pin_{-1};
  /** Canales RMT que usa el código del usuario (remote_transmitter/receiver). */
  int8_t rf_rx_channel_{-1};
  int8_t rf_tx_channel_{-1};
  /** Canales RMT propios del puente, los que se pasan a --rmt-loopback. */
  int8_t bridge_rf_tx_channel_{-1};
  int8_t bridge_rf_rx_channel_{-1};
  int8_t bridge_rf_rx_gpio_{-1};
  std::vector<int8_t> driven_pins_;

#ifdef USE_ESP32
  QueueHandle_t rf_queue_{nullptr};
  TaskHandle_t rf_task_handle_{nullptr};
  rmt_channel_handle_t rmt_tx_{nullptr};
  rmt_encoder_handle_t rmt_encoder_{nullptr};
  rmt_channel_handle_t rmt_rx_{nullptr};
  static constexpr size_t RF_EDGES = 512;
  RfEdge rf_edges_[RF_EDGES]{};
  volatile uint16_t rf_edge_head_{0};
  volatile uint16_t rf_edge_tail_{0};
  uint32_t cycles_per_us_{240};
  uint32_t last_edge_cycles_{0};
  uint8_t last_edge_level_{0};
  bool edge_primed_{false};
  std::vector<int32_t> rf_timings_;
  /** Buffer de símbolos para rmt_receive (debe ser estático/IRAM). */
  rmt_symbol_word_t rf_rx_symbols_[64]{};
  /** Última trama decodificada por la ISR de RMT (se consume en loop()). */
  std::string rf_rx_bits_;
  bool rf_rx_ready_{false};
#endif
};

}  // namespace sim_bridge
}  // namespace esphome
