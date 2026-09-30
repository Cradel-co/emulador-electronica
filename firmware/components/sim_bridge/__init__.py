"""Componente `sim_bridge`: puente entre el firmware simulado y la app web.

Solo se agrega en la compilación de simulación (main.sim.yaml); el YAML que
el usuario flashea en la placa real nunca lo incluye.

Habla por UART1 con el protocolo de texto de la sección 7.1 de
GUIA-IMPLEMENTACION.md:

    app -> firmware   @HELLO @WATCH @IN @RF @PING
    firmware -> app   @READY @OUT @TX @PONG @ERR
"""

import esphome.codegen as cg
import esphome.config_validation as cv

from esphome.components import uart
from esphome.const import CONF_ID
from esphome.core import CORE

DEPENDENCIES = ["uart"]
# remote_base aporta RC_SWITCH_PROTOCOLS: los tiempos y el decodificador de
# RCSwitch que usa remote_receiver/remote_transmitter, para que el puente
# genere y lea exactamente las mismas ondas que el código del usuario.
AUTO_LOAD = ["remote_base"]
MULTI_CONF = False

CONF_POLL_INTERVAL = "poll_interval"
CONF_RF_RX_CHANNEL = "rf_rx_channel"
CONF_RF_TX_CHANNEL = "rf_tx_channel"
CONF_BRIDGE_RF_TX_CHANNEL = "bridge_rf_tx_channel"
CONF_BRIDGE_RF_RX_CHANNEL = "bridge_rf_rx_channel"
CONF_BRIDGE_RF_RX_GPIO = "bridge_rf_rx_gpio"
CONF_RF_RX_PIN = "rf_rx_pin"
CONF_RF_TX_PIN = "rf_tx_pin"
CONF_RF_PROTOCOL = "rf_protocol"
CONF_RF_REPEAT = "rf_repeat"
CONF_INPUTS = "inputs"
CONF_VERBOSE = "verbose"

# Pines reservados: de arranque (strapping), de la consola UART0 o del USB nativo.
RESERVED_PINS = (0, 3, 19, 20, 43, 44, 45, 46, 47, 48)


def _validate_rf_pin(value):
    """Pin que el puente *adjunta*, no que reserva.

    Se valida como número plano a propósito: el mismo pin ya lo declara
    remote_receiver / remote_transmitter en el YAML del usuario y ESPHome
    rechaza que un pin esté declarado en dos lugares. Como el puente lo
    maneja con gpio_* directamente, no necesita pasar por el registro de
    pines de ESPHome.
    """
    value = cv.int_range(min=0, max=48)(value)
    if value in RESERVED_PINS:
        raise cv.Invalid(
            f"GPIO{value} está reservado (arranque, consola UART0 o USB nativo). "
            "Elegí otro pin para el puente."
        )
    return value


def _validate_channel(value):
    """Canal RMT del puente (plan principal de RF, sección 7.3).

    Solo se declara el número: el pin GPIO lo declara remote_receiver /
    remote_transmitter en el YAML del usuario y ESPHome no admite el mismo pin
    en dos lugares. Los canales se le pasan a `esp-emu --rmt-loopback` para
    que la TX del puente aparezca en la RX del receptor.
    """
    return cv.int_range(min=0, max=7)(value)


sim_bridge_ns = cg.esphome_ns.namespace("sim_bridge")
SimBridge = sim_bridge_ns.class_(
    "SimBridge",
    cg.Component,
    uart.UARTDevice,
)

CONFIG_SCHEMA = (
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(SimBridge),
            cv.Optional(CONF_POLL_INTERVAL, default="10ms"): cv.positive_time_period_milliseconds,
            cv.Optional(CONF_RF_RX_CHANNEL): _validate_channel,
            cv.Optional(CONF_RF_TX_CHANNEL): _validate_channel,
            cv.Optional(CONF_BRIDGE_RF_TX_CHANNEL): _validate_channel,
            cv.Optional(CONF_BRIDGE_RF_RX_CHANNEL): _validate_channel,
            cv.Optional(CONF_BRIDGE_RF_RX_GPIO): cv.int_range(min=0, max=48),
            cv.Optional(CONF_RF_RX_PIN): _validate_rf_pin,
            cv.Optional(CONF_RF_TX_PIN): _validate_rf_pin,
            cv.Optional(CONF_RF_PROTOCOL, default=1): cv.int_range(min=0, max=8),
            cv.Optional(CONF_RF_REPEAT, default=5): cv.positive_int,
            # Entradas que la app simula: pin + nivel de reposo (el del pin sin
            # que nadie lo toque; con pull-up suele ser 1).
            cv.Optional(CONF_INPUTS): cv.ensure_list(
                cv.Schema(
                    {
                        cv.Required("pin"): cv.int_range(min=0, max=48),
                        cv.Required("idle"): cv.int_range(min=0, max=1),
                    }
                )
            ),
            cv.Optional(CONF_VERBOSE, default=False): cv.boolean,
        }
    )
    .extend(uart.UART_DEVICE_SCHEMA)
    .extend(cv.COMPONENT_SCHEMA)
)


def _pin_number(config, key):
    return config.get(key)


async def to_code(config):
    if CORE.is_esp32:
        # sim_bridge.h incluye driver/rmt_tx.h (RF por RMT). ESPHome 2026.x excluye el
        # driver RMT del build salvo que lo pida alguien (remote_receiver lo hace así);
        # sin esto, en un proyecto sin remote_* (p. ej. en un ESP32-C3) no compila.
        from esphome.components import esp32

        if hasattr(esp32, "include_builtin_idf_component"):
            esp32.include_builtin_idf_component("esp_driver_rmt")

    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    await uart.register_uart_device(var, config)

    cg.add(var.set_poll_interval(config[CONF_POLL_INTERVAL].total_milliseconds))
    cg.add(var.set_verbose(config[CONF_VERBOSE]))
    cg.add(var.set_rf_protocol(config[CONF_RF_PROTOCOL]))
    cg.add(var.set_rf_repeat(config[CONF_RF_REPEAT]))

    for entrada in config.get(CONF_INPUTS, []):
        cg.add(var.set_input_idle(entrada["pin"], entrada["idle"]))

    for key, setter in (
        (CONF_RF_RX_CHANNEL, var.set_rf_rx_channel),
        (CONF_RF_TX_CHANNEL, var.set_rf_tx_channel),
        (CONF_BRIDGE_RF_TX_CHANNEL, var.set_bridge_rf_tx_channel),
        (CONF_BRIDGE_RF_RX_CHANNEL, var.set_bridge_rf_rx_channel),
        (CONF_BRIDGE_RF_RX_GPIO, var.set_bridge_rf_rx_gpio),
        (CONF_RF_RX_PIN, var.set_rf_rx_pin),
        (CONF_RF_TX_PIN, var.set_rf_tx_pin),
    ):
        number = _pin_number(config, key)
        if number is not None:
            cg.add(setter(number))
    return var
