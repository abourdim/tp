// =====================================
// micro:bit BLE UART Command Monitor
// - No motor management
// - Logs to USB Serial
// - ACK every BLE received line
// - Shows arrows for direction commands
// =====================================

bluetooth.startUartService()

serial.redirectToUSB()
serial.writeLine("micro:bit BLE UART monitor started")

basic.showIcon(IconNames.Happy)

// --- Helpers ---
function ack(line: string) {
    // ACK back to web app (BLE)
    bluetooth.uartWriteString("ACK " + line + "\n")
}

function showDirectionArrow(dir: string, pressed: string) {
    // Only show arrow on "1" (pressed). On "0" show stop.
    if (pressed != "1") {
        basic.showIcon(IconNames.Square) // stop/neutral
        return
    }

    if (dir == "UP") basic.showArrow(ArrowNames.North)
    else if (dir == "DOWN") basic.showArrow(ArrowNames.South)
    else if (dir == "LEFT") basic.showArrow(ArrowNames.West)
    else if (dir == "RIGHT") basic.showArrow(ArrowNames.East)
    else basic.showIcon(IconNames.SmallSquare)
}

function handleLine(raw: string) {
    const line = raw.trim()
    if (line.length == 0) return

    // Log to USB Serial
    serial.writeLine("[BLE RX] " + line)

    // ACK everything received
    ack(line)

    // Parse simple command formats:
    // CMD UP 1
    // CMD LEFT 0
    // CMD STOP 1
    const parts = line.split(" ")
    if (parts.length >= 2 && parts[0] == "CMD") {
        const cmd = parts[1]

        if (cmd == "STOP") {
            basic.showIcon(IconNames.Square)
            serial.writeLine("[CMD] STOP")
            return
        }

        if (parts.length >= 3) {
            const val = parts[2] // "1" or "0"
            showDirectionArrow(cmd, val)
            serial.writeLine("[CMD] " + cmd + " " + val)
            return
        }
    }

    // For BTN / TXT / anything else:
    // show a small dot as "activity"
    led.toggle(2, 2)
}

// Read lines delimited by newline
bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    const line = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    handleLine(line)
})
