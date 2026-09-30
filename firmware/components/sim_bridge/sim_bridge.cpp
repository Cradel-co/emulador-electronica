#include "sim_bridge.h"

#include "esphome/core/hal.h"
#include "esphome/core/log.h"
#include "esphome/core/version.h"

#ifdef USE_ESP32
#include <esp_private/esp_clk.h>
#include <hal/gpio_ll.h>  // gpio_ll_get_level, GPIO_LL_GET_HW (IDF 5.5)
#include <soc/gpio_struct.h>
#include <soc/soc.h>
#include <soc/soc_caps.h>  // SOC_GPIO_PIN_COUNT: cuántos GPIO tiene el chip (S3 49, C6 31, C3 22)
#endif

#include <cinttypes>
#include <cstdlib>
#include <cstring>

namespace esphome {
namespace sim_bridge {

static const char *const TAG = "sim_bridge";

static const char *const RC_SWITCH_CHARS = "01";

// Pin más alto del chip: 48 en el S3, 21 en el C3, 30 en el C6.
#ifdef USE_ESP32
static constexpr int MAX_PIN = SOC_GPIO_PIN_COUNT - 1;
#else
static constexpr int MAX_PIN = 48;
#endif

// ---------------------------------------------------------------------------
// Envío
// ---------------------------------------------------------------------------

void SimBridge::send_line_(const std::string &line) {
  std::string out = line;
  out.push_back('\n');
  this->write_array((const uint8_t *) out.data(), out.size());
  if (this->verbose_) {
    ESP_LOGV(TAG, "-> %s", line.c_str());
  }
}

void SimBridge::send_error_(const std::string &code, const std::string &message) {
  this->send_line_("@ERR " + code + " " + message);
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

void SimBridge::setup() {
  // Niveles de reposo declarados en el YAML: el pin arranca como en la placa
  // real (un pulsador con pull-up, en reposo = 1).
  for (const auto &idle : this->input_idles_) {
    this->input_levels_[idle.first] = idle.second;
    ESP_LOGV(TAG, "GPIO%u en reposo = %u", (unsigned) idle.first, (unsigned) idle.second);
  }
  this->rx_buffer_.reserve(256);
#ifdef USE_ESP32
  // La trama que capturó la ISR de RMT se consume aquí, en el loop principal.
  if (this->rf_rx_ready_) {
    this->rf_rx_ready_ = false;
    if (this->rf_rx_bits_.size() >= 4) {
      this->send_tx_((uint64_t) strtoull(this->rf_rx_bits_.c_str(), nullptr, 2), (uint8_t) this->rf_rx_bits_.size(), 1);
    }
    this->rf_rx_poll_(); // se re-armar la recepción para la próxima trama
  }
#define RMT_TICKS_PER_US 1u
#define RF_PULSE_US 350u
#define RF_SYNC_LOW_US (31u * RF_PULSE_US)
#define RF_GAP_US (31u * RF_PULSE_US)
  this->init_rmt_();
  this->cycles_per_us_ = (uint32_t) (esp_clk_cpu_freq() / 1000000);  // MHz -> ciclos/us
  if (this->cycles_per_us_ == 0) {
    this->cycles_per_us_ = 240;
  }
  if (this->rf_rx_pin_ >= 0) {
    // INPUT_OUTPUT: el pin sigue siendo entrada para el código del usuario y
    // además podemos imponerle un nivel (estrategia de entradas, 7.2).
    // gpio_pin_mode no existe en IDF 5.5: se reconfigura con gpio_config.
    this->set_pin_input_output_(this->rf_rx_pin_);
    ESP_LOGI(TAG, "Inyección RF habilitada en GPIO%d", (int) this->rf_rx_pin_);
  }
  if (this->rf_tx_pin_ >= 0) {
    this->start_rf_capture_();
  }
  if (this->rf_rx_pin_ >= 0) {
    this->rf_queue_ = xQueueCreate(4, sizeof(std::string));
    if (this->rf_queue_ != nullptr) {
      this->rf_task_handle_ = nullptr;
      if (xTaskCreate(&SimBridge::rf_task_entry_, "sim_bridge_rf", 4096, this, 4, &this->rf_task_handle_) !=
          pdPASS) {
        ESP_LOGE(TAG, "No se pudo crear la tarea de RF");
        this->rf_task_handle_ = nullptr;
      }
    }
  }
#endif
  this->send_line_(std::string("@READY 1 ") + ESPHOME_VERSION + (this->injection_works_ ? "" : " noin"));
}

void SimBridge::dump_config() {
  ESP_LOGCONFIG(TAG,
                "Puente de simulación\n"
                "  Intervalo de sondeo: %" PRIu32 " ms\n"
                "  Pin de inyección RF: %d\n"
                "  Pin de captura RF: %d\n"
                "  Canal RMT del usuario (TX/RX): %d/%d\n"
                "  Canal RMT del puente (TX/RX): %d/%d\n"
                "  Protocolo RF: %u (x%u)\n"
                "  Pins vigilados: %u",
                this->poll_interval_, (int) this->rf_rx_pin_, (int) this->rf_tx_pin_, (int) this->rf_tx_channel_,
                (int) this->rf_rx_channel_, (int) this->bridge_rf_tx_channel_, (int) this->bridge_rf_rx_channel_,
                (unsigned) this->rf_protocol_, (unsigned) this->rf_repeat_, (unsigned) this->watched_pins_.size());
}

// ---------------------------------------------------------------------------
// Loop: lee la UART1 y sondea los pines de salida
// ---------------------------------------------------------------------------

void SimBridge::loop() {
  uint8_t byte;
  while (this->available()) {
    if (!this->read_byte(&byte)) {
      break;
    }
    if (byte == '\r') {
      continue;
    }
    if (byte == '\n') {
      std::string line(rx_buffer_.begin(), rx_buffer_.end());
      rx_buffer_.clear();
      if (!line.empty()) {
        this->process_line_(line);
      }
      continue;
    }
    if (rx_buffer_.size() < 255) {
      rx_buffer_.push_back((char) byte);
    } else {
      // Línea demasiado larga: se descarta para no crecer sin límite.
      this->send_error_("1", "linea demasiado larga");
      rx_buffer_.clear();
    }
  }

  const uint32_t now = millis();
  if (now - this->last_poll_ >= this->poll_interval_) {
    this->last_poll_ = now;
    this->poll_outputs_();
  }
#ifdef USE_ESP32
  this->drain_rf_edges_();
#endif
}

// ---------------------------------------------------------------------------
// Protocolo
// ---------------------------------------------------------------------------

void SimBridge::process_line_(const std::string &line) {
  if (this->verbose_) {
    ESP_LOGV(TAG, "<- %s", line.c_str());
  }
  if (line[0] != '@') {
    this->send_error_("2", "mensaje sin @");
    return;
  }
  // Tokenizado en el sitio (sin asignar): @TIPO arg arg ...
  size_t pos = 1;
  size_t end = line.find(' ');
  std::string tag = line.substr(pos, end == std::string::npos ? std::string::npos : end - pos);

  auto next_arg = [&](size_t &cursor) -> std::string {
    while (cursor < line.size() && line[cursor] == ' ') {
      cursor++;
    }
    size_t s = cursor;
    while (cursor < line.size() && line[cursor] != ' ') {
      cursor++;
    }
    return line.substr(s, cursor - s);
  };

  size_t cursor = end == std::string::npos ? line.size() : end;

  if (tag == "HELLO") {
    this->handle_hello_();
  } else if (tag == "WATCH") {
    this->handle_watch_(atoi(next_arg(cursor).c_str()));
  } else if (tag == "IN") {
    const int pin = atoi(next_arg(cursor).c_str());
    const std::string level = next_arg(cursor);
    this->handle_in_(pin, level == "1" ? 1 : (level == "0" ? 0 : -1));
  } else if (tag == "RF") {
    const std::string bits = next_arg(cursor);
    const int protocol = atoi(next_arg(cursor).c_str());
    this->handle_rf_(bits, protocol);
  } else if (tag == "PING") {
    const int n = atoi(next_arg(cursor).c_str());
    this->send_line_("@PONG " + to_string(n));
  } else {
    // Mensajes desconocidos se ignoran (compatibilidad futura, 7.1).
    ESP_LOGD(TAG, "Mensaje ignorado: %s", line.c_str());
  }
}


static void rmt_symbol(rmt_symbol_word_t *sym, uint32_t level0, uint32_t dur0, uint32_t level1, uint32_t dur1) {
  sym->level0 = level0;
  sym->duration0 = dur0;
  sym->level1 = level1;
  sym->duration1 = dur1;
}

/**
 * Canales RMT del puente (7.3). Se crean solo si el YAML los declara; la app
 * es la que pasa los pares a `esp-emu --rmt-loopback` para conectarlos con los
 * canales del remote_transmitter / remote_receiver del usuario.
 *
 * En el ESP32-S3 hay 8 canales: 0-3 son de TX y 4-7 de RX. El transmisor del
 * usuario toma el 0 y el receptor el 4, así que el puente usa 1 (TX) y 5 (RX).
 */
void SimBridge::init_rmt_() {
  if (this->bridge_rf_tx_channel_ < 0 && this->bridge_rf_rx_channel_ < 0) {
    return;
  }
  if (this->bridge_rf_tx_channel_ >= 0) {
    rmt_tx_channel_config_t tx;
    memset(&tx, 0, sizeof(tx));
    tx.clk_src = RMT_CLK_SRC_DEFAULT;
    tx.resolution_hz = 1000000;  // 1 tick = 1 us
    tx.gpio_num = gpio_num_t(this->bridge_rf_tx_channel_);  // el pin no importa: manda el loopback
    tx.mem_block_symbols = 48;  // máximo por canal en el S3
    tx.trans_queue_depth = 1;
    tx.intr_priority = 0;
    if (rmt_new_tx_channel(&tx, &this->rmt_tx_) != ESP_OK) {
      ESP_LOGW(TAG, "No se pudo crear el canal RMT TX del puente");
      this->rmt_tx_ = nullptr;
    } else {
      // Copy encoder: los símbolos ya están armados en send_rf_rmt_ (pulso alto +
      // bajo por bit), así que el encoder solo los copia al canal.
      rmt_copy_encoder_config_t enc;
      memset(&enc, 0, sizeof(enc));
      if (rmt_new_copy_encoder(&enc, &this->rmt_encoder_) != ESP_OK) {
        ESP_LOGW(TAG, "No se pudo crear el encoder RMT del puente");
        this->rmt_encoder_ = nullptr;
      } else {
        rmt_enable(this->rmt_tx_);
        ESP_LOGI(TAG, "Canal RMT TX del puente en el canal %d", (int) this->bridge_rf_tx_channel_);
      }
    }
  }
  if (this->bridge_rf_rx_channel_ >= 0) {
    rmt_rx_channel_config_t rx;
    memset(&rx, 0, sizeof(rx));
    rx.clk_src = RMT_CLK_SRC_DEFAULT;
    rx.resolution_hz = 1000000;
    rx.gpio_num = gpio_num_t(this->bridge_rf_rx_gpio_ >= 0 ? this->bridge_rf_rx_gpio_ : this->bridge_rf_rx_channel_);
    rx.mem_block_symbols = 48;
    rx.intr_priority = 0;
    if (rmt_new_rx_channel(&rx, &this->rmt_rx_) != ESP_OK) {
      ESP_LOGW(TAG, "No se pudo crear el canal RMT RX del puente");
      this->rmt_rx_ = nullptr;
      return;
    }
    rmt_rx_event_callbacks_t cbs = {on_recv_done: &SimBridge::rf_rx_done_};
    rmt_rx_register_event_callbacks(this->rmt_rx_, &cbs, this);
    rmt_enable(this->rmt_rx_);
    ESP_LOGI(TAG, "Canal RMT RX del puente en el canal %d", (int) this->bridge_rf_rx_channel_);
    this->rf_rx_poll_();
  }
}

void SimBridge::handle_hello_() {
  this->send_line_(std::string("@READY 1 ") + ESPHOME_VERSION + (this->injection_works_ ? "" : " noin"));
}

void SimBridge::handle_watch_(int pin) {
  if (pin < 0 || pin > MAX_PIN) {
    this->send_error_("3", ("pin invalido " + to_string(pin)).c_str());
    return;
  }
  for (auto &w : this->watched_pins_) {
    if (w.pin == pin) {
      // Reenviar el nivel actual hace la app idempotente ante resets.
      this->send_line_("@OUT " + to_string(pin) + " " + to_string((int) this->read_output_level_(pin)));
      return;
    }
  }
  WatchedPin w;
  w.pin = (uint8_t) pin;
  w.level = this->read_output_level_(w.pin) ? 1 : 0;
  w.has_level = true;
  this->watched_pins_.push_back(w);
  this->send_line_("@OUT " + to_string(pin) + " " + to_string((int) w.level));
}

void SimBridge::handle_in_(int pin, int level) {
  if (level < 0) {
    this->send_error_("4", "nivel invalido");
    return;
  }
  if (pin < 0 || pin > MAX_PIN) {
    this->send_error_("3", ("pin invalido " + to_string(pin)).c_str());
    return;
  }
  // 1) Estado publicado: es lo que lee el `binary_sensor: platform: template`
  //    que genera la app. Funciona siempre, sin depender del pad (7.2).
  this->input_levels_[(uint8_t) pin] = (uint8_t) (level ? 1 : 0);
  ESP_LOGV(TAG, "GPIO%d <- %d (estado publicado)", pin, level);

  // 2) Se intenta además reflejar el nivel en el pad, para los pines que el
  //    usuario lee con gpio/dallas. En esp-emu el pad sí devuelve lo impuesto,
  //    pero la lógica interna de entrada no ve el cambio (medido en el
  //    laboratorio), así que esto queda como diagnóstico.
#ifdef USE_ESP32
  bool known = false;
  for (auto p : this->driven_pins_) {
    if (p == pin) {
      known = true;
      break;
    }
  }
  if (!known) {
    this->set_pin_input_output_(pin);
    this->driven_pins_.push_back((int8_t) pin);
  }
  gpio_set_level(gpio_num_t(pin), (uint8_t) level);
  const int readback = gpio_get_level(gpio_num_t(pin));
  if (readback != level) {
    this->injection_works_ = false;
    ESP_LOGW(TAG, "GPIO%d: se impuso %d pero la entrada lee %d (sin realimentacion del pad)", pin, (int) level,
             readback);
  }
#else
  this->send_error_("5", "inyeccion de entradas no soportada en esta plataforma");
#endif
}

void SimBridge::handle_rf_(const std::string &bits, int protocol) {
  if (bits.empty() || bits.size() > 64) {
    this->send_error_("6", "codigo rf invalido");
    return;
  }
  for (char c : bits) {
    if (c != '0' && c != '1') {
      this->send_error_("6", "el codigo rf solo admite 0 y 1");
      return;
    }
  }
#ifdef USE_ESP32
  uint64_t code = strtoull(bits.c_str(), nullptr, 2);
  uint8_t nbits = (uint8_t) bits.size();
  if (this->verbose_) {
    ESP_LOGI(TAG, "Inyectando RF %s (protocolo %d)", bits.c_str(), protocol);
  }
  if (this->rmt_tx_ != nullptr && this->bridge_rf_tx_channel_ >= 0) {
    // Plan principal (7.3): el puente transmite por su propio canal RMT y la
    // app lo conecta al canal del remote_receiver con --rmt-loopback.
    this->send_rf_rmt_(code, nbits);
    return;
  }
  if (this->rf_queue_ == nullptr || this->rf_rx_pin_ < 0) {
    this->send_error_("7", "rf_rx_pin no configurado");
    return;
  }
  std::string payload = bits + " " + to_string(protocol) + " " + to_string((unsigned long long) code) + " " +
                        to_string((int) nbits);
  if (xQueueSend(this->rf_queue_, &payload, 0) != pdTRUE) {
    this->send_error_("8", "cola de rf llena");
  }
#else
  this->send_error_("5", "inyeccion rf no soportada en esta plataforma");
#endif
}

#ifdef USE_ESP32
// ---------------------------------------------------------------------------
// Sondeo de salidas. En IDF 5.5 ya no existen los macros GPIO_OUT_REG /
// GPIO_OUT1_REG: el nivel de salida se lee del gpio_dev_t (hw->out para los
// pines 0-31, hw->out1 para los >= 32), igual que hace gpio_ll_set_level.
// ---------------------------------------------------------------------------
bool SimBridge::read_output_level_(uint8_t pin) const {
  auto *hw = GPIO_LL_GET_HW(0);
  if (pin >= SOC_GPIO_PIN_COUNT) {
    return false;
  }
  if (pin < 32) {
    // En el S3 `out` es un uint32_t; en C3/C6 es una unión (`.val`). Se lee la palabra
    // entera para que compile igual en todos los chips.
    const uint32_t out = *reinterpret_cast<const volatile uint32_t *>(&hw->out);
    return (out >> pin) & 1;
  }
#if SOC_GPIO_PIN_COUNT > 32
  return ((uint32_t) hw->out1.data >> (pin - 32)) & 1;
#else
  return false;  // C3 (22 GPIO) y C6 (31 GPIO): no hay OUT1.
#endif
}
#else
bool SimBridge::read_output_level_(uint8_t pin) const {
  return digitalRead(pin);
}
#endif

void SimBridge::poll_outputs_() {
  for (auto &w : this->watched_pins_) {
    const bool level = this->read_output_level_(w.pin);
    if (!w.has_level || level != w.level) {
      w.level = level ? 1 : 0;
      w.has_level = true;
      this->send_line_("@OUT " + to_string((int) w.pin) + " " + to_string((int) w.level));
    }
  }
}

#ifdef USE_ESP32

// ---------------------------------------------------------------------------
// Inyección de RF: se hace en una tarea aparte para no bloquear loop()
// ---------------------------------------------------------------------------

void SimBridge::rf_task_entry_(void *arg) {
  static_cast<SimBridge *>(arg)->rf_task_();
  vTaskDelete(nullptr);
}

void SimBridge::rf_task_() {
  std::string payload;
  while (true) {
    if (xQueueReceive(this->rf_queue_, &payload, portMAX_DELAY) != pdTRUE) {
      continue;
    }
    // Formato: "<bits> <protocolo> <code> <nbits>"
    const size_t sp1 = payload.find(' ');
    const size_t sp2 = payload.find(' ', sp1 + 1);
    const size_t sp3 = payload.find(' ', sp2 + 1);
    if (sp1 == std::string::npos || sp2 == std::string::npos || sp3 == std::string::npos) {
      continue;
    }
    const uint8_t protocol = (uint8_t) atoi(payload.substr(sp1 + 1, sp2 - sp1 - 1).c_str());
    const uint64_t code = strtoull(payload.substr(sp2 + 1, sp3 - sp2 - 1).c_str(), nullptr, 10);
    const uint8_t nbits = (uint8_t) atoi(payload.substr(sp3 + 1).c_str());

    const auto &proto = remote_base::RC_SWITCH_PROTOCOLS[protocol & 0x07];
    remote_base::RemoteTransmitData data;
    data.reserve(2 + nbits * 2);
    proto.transmit(&data, code, nbits);
    const std::vector<int32_t> &timings = data.get_data();

    for (uint8_t rep = 0; rep < this->rf_repeat_; rep++) {
      for (int32_t t : timings) {
        const bool high = t > 0;
        const uint32_t us = (uint32_t) (t > 0 ? t : -t);
        gpio_set_level(gpio_num_t(this->rf_rx_pin_), high ? 1 : 0);
        // Espera precisa en ciclos: esp_rom_delay_us no se sostiene en el
        // emulador, el bucle de ciclos sí.
        const uint32_t target = esp_cpu_get_cycle_count() + us * this->cycles_per_us_;
        while ((int32_t) (esp_cpu_get_cycle_count() - target) < 0) {
        }
      }
      // Separación entre repeticiones (como un control real).
      gpio_set_level(gpio_num_t(this->rf_rx_pin_), 0);
      const uint32_t target = esp_cpu_get_cycle_count() + 12000u * this->cycles_per_us_;
      while ((int32_t) (esp_cpu_get_cycle_count() - target) < 0) {
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Captura de RF: ISR de GPIO + decodificación con el decodificador de ESPHome
// ---------------------------------------------------------------------------

void SimBridge::rf_isr_(void *arg) {
  auto *self = static_cast<SimBridge *>(arg);
  self->on_rf_edge_((uint8_t) gpio_ll_get_level(GPIO_LL_GET_HW(0), (uint32_t) self->rf_tx_pin_));
}

void IRAM_ATTR SimBridge::on_rf_edge_(uint8_t level) {
  const uint32_t cycles = esp_cpu_get_cycle_count();
  const uint16_t next = (uint16_t) ((this->rf_edge_head_ + 1) % RF_EDGES);
  if (next == this->rf_edge_tail_) {
    return;  // buffer lleno: se descarta el flanco
  }
  this->rf_edges_[this->rf_edge_head_].cycles = cycles;
  this->rf_edges_[this->rf_edge_head_].level = level;
  this->rf_edge_head_ = next;
}

void SimBridge::set_pin_input_output_(int8_t pin) {
  gpio_config_t conf = {};
  conf.pin_bit_mask = 1ULL << pin;
  conf.mode = GPIO_MODE_INPUT_OUTPUT;
  // Sin pullup: en el emulador el pullup interno gana y la lectura de entrada
  // queda en 1 pase lo que se imponga. Al soltar el pullup, la entrada refleja
  // el nivel de salida del pad (como en el silicio real con la pad
  // bidireccional).
  conf.pull_up_en = GPIO_PULLUP_DISABLE;
  conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
  conf.intr_type = GPIO_INTR_DISABLE;
  gpio_config(&conf);
}

void SimBridge::start_rf_capture_() {
  gpio_config_t conf = {};
  conf.pin_bit_mask = 1ULL << this->rf_tx_pin_;
  conf.mode = GPIO_MODE_INPUT;
  conf.pull_up_en = GPIO_PULLUP_ENABLE;
  conf.intr_type = GPIO_INTR_ANYEDGE;
  if (gpio_config(&conf) != ESP_OK) {
    ESP_LOGW(TAG, "No se pudo configurar GPIO%d para la captura de RF", (int) this->rf_tx_pin_);
    this->rf_tx_pin_ = -1;
    return;
  }
  if (gpio_install_isr_service(0) != ESP_OK) {
    ESP_LOGW(TAG, "No se pudo instalar el servicio de ISR; sin captura de RF");
  }
  if (gpio_isr_handler_add(gpio_num_t(this->rf_tx_pin_), &SimBridge::rf_isr_, this) != ESP_OK) {
    ESP_LOGW(TAG, "No se pudo registrar la ISR de RF; sin captura de RF");
    this->rf_tx_pin_ = -1;
    return;
  }
  ESP_LOGI(TAG, "Captura RF habilitada en GPIO%d", (int) this->rf_tx_pin_);
}

void SimBridge::drain_rf_edges_() {
  while (this->rf_edge_tail_ != this->rf_edge_head_) {
    const RfEdge edge = this->rf_edges_[this->rf_edge_tail_];
    this->rf_edge_tail_ = (uint16_t) ((this->rf_edge_tail_ + 1) % RF_EDGES);
    const bool edge_was_high = this->edge_primed_ && this->last_edge_level_;

    if (!this->edge_primed_) {
      this->last_edge_cycles_ = edge.cycles;
      this->last_edge_level_ = edge.level;
      this->edge_primed_ = true;
      continue;
    }
    // El pulso que termina en este flanco tenía el nivel del flanco anterior.
    const int32_t delta = (int32_t) (edge.cycles - this->last_edge_cycles_);
    this->last_edge_cycles_ = edge.cycles;
    this->last_edge_level_ = edge.level;
    if (delta <= 0) {
      continue;
    }
    const int32_t us = delta / (int32_t) this->cycles_per_us_;
    if (us <= 0) {
      continue;
    }
    if (this->rf_timings_.size() >= 512) {
      this->rf_timings_.clear();
    }
    this->rf_timings_.push_back(edge_was_high ? us : -us);
    // Un espacio largo (>4 ms) marca el fin de una trama.
    if (!edge_was_high && us > 4000) {
      this->decode_rf_timings_();
      this->rf_timings_.clear();
    }
  }
}

void SimBridge::decode_rf_timings_() {
  if (this->rf_timings_.size() < 8) {
    return;
  }
  const auto &proto = remote_base::RC_SWITCH_PROTOCOLS[this->rf_protocol_ & 0x07];
  remote_base::RemoteReceiveData data(this->rf_timings_, 30, remote_base::TOLERANCE_MODE_PERCENTAGE);
  uint64_t code = 0;
  uint8_t nbits = 0;
  proto.decode(data, &code, &nbits);
  if (nbits < 4) {
    return;
  }
  this->send_tx_(code, nbits, this->rf_protocol_);
}

void SimBridge::send_tx_(uint64_t code, uint8_t nbits, uint8_t protocol) {
  std::string bits;
  bits.reserve(nbits);
  for (int8_t i = (int8_t) nbits - 1; i >= 0; i--) {
    bits.push_back((code >> i) & 1 ? '1' : '0');
  }
  this->send_line_("@TX " + bits + " " + to_string((int) protocol));
}


// ---------------------------------------------------------------------------
// RF por RMT (plan principal, 7.3)
//
// El puente transmite y recibe por sus propios canales RMT. La app conecta
// esos canales con los del usuario pasando pares a `esp-emu --rmt-loopback`:
//
//   <canal TX del puente>:<canal RX del usuario>   (inyección)
//   <canal TX del usuario>:<canal RX del puente>   (captura)
//
// Tiempos de RCSwitch protocolo 1 con pulso base de 350 us (sección 7.3):
//   bit 0 = 1 alto + 3 bajos; bit 1 = 3 altos + 1 bajo;
//   sincronía = 1 alto + 31 bajos; el código se repite 5 veces.
// Con resolution_hz = 1 MHz, 1 tick = 1 us.
// ---------------------------------------------------------------------------

void SimBridge::send_rf_rmt_(uint64_t code, uint8_t nbits) {
  if (this->rmt_tx_ == nullptr || this->rmt_encoder_ == nullptr) {
    this->send_error_("9", "canal rmt del puente no inicializado");
    return;
  }
  // El canal RMT del S3 tiene 48 símbolos de memoria: no entran las 5
  // repeticiones de una trama RCSwitch (130 símbolos). Se transmite una
  // repetición por transacción, esperando a que termine cada una.
  rmt_symbol_word_t syms[26]; // sync + 24 bits + hueco
  rmt_symbol_word_t sym;
  rmt_symbol(&sym, 1, RF_PULSE_US, 0, RF_SYNC_LOW_US);
  syms[0] = sym;
  for (int8_t i = (int8_t) nbits - 1; i >= 0; i--) {
    const bool bit = ((code >> i) & 1) != 0;
    rmt_symbol(&sym, 1, bit ? 3u * RF_PULSE_US : RF_PULSE_US, 0, bit ? RF_PULSE_US : 3u * RF_PULSE_US);
    syms[1 + (nbits - 1 - i)] = sym;
  }
  rmt_symbol(&sym, 0, 0, 0, RF_GAP_US);
  syms[1 + nbits] = sym;

  rmt_transmit_config_t cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.flags.eot_level = 0;
  for (uint8_t rep = 0; rep < this->rf_repeat_; rep++) {
    esp_err_t err = rmt_transmit(this->rmt_tx_, this->rmt_encoder_, syms, (2 + nbits) * sizeof(rmt_symbol_word_t), &cfg);
    if (err != ESP_OK) {
      ESP_LOGW(TAG, "rmt_transmit fallo: %s", esp_err_to_name(err));
      return;
    }
    rmt_tx_wait_all_done(this->rmt_tx_, 1000);
  }
}

void SimBridge::rf_rx_poll_() {
  if (this->rmt_rx_ == nullptr) return;
  rmt_receive_config_t cfg;
  memset(&cfg, 0, sizeof(cfg));
  // El filtro se calcula con el reloj APB (80 MHz), no con la resolución
  // del canal: con 100 us el valor de registro supera el máximo (255).
  cfg.signal_range_min_ns = 1000;  // ignora glitches < 1 us
  cfg.signal_range_max_ns = 14000000; // un nivel > 14 ms cierra el mensaje
  esp_err_t err = rmt_receive(this->rmt_rx_, this->rf_rx_symbols_, sizeof(this->rf_rx_symbols_), &cfg);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "rmt_receive fallo: %s", esp_err_to_name(err));
  }
}

bool IRAM_ATTR SimBridge::rf_rx_done_(rmt_channel_handle_t chan, const rmt_rx_done_event_data_t *data, void *ctx) {
  auto *self = static_cast<SimBridge *>(ctx);
  self->rf_rx_bits_.clear();
  for (size_t i = 0; i < data->num_symbols; i++) {
    const rmt_symbol_word_t &sym = data->received_symbols[i];
    const uint32_t d0 = sym.duration0;
    const uint32_t d1 = sym.duration1;
    if (sym.level0 == 0 && d0 > 8000) break; // hueco: fin del mensaje
    if (sym.level0 == 1 && d0 < 800 && d1 > 8000) continue; // sincronía
    if (sym.level1 == 1 && d0 < 800) self->rf_rx_bits_.push_back('0');
    else if (sym.level0 == 1 && d0 > 800) self->rf_rx_bits_.push_back('1');
  }
  self->rf_rx_ready_ = true;
  return false;
}

#endif  // USE_ESP32

}  // namespace sim_bridge
}  // namespace esphome
