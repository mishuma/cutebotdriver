// ===== Cutebot + BLE UART Control (Per-wheel hex speeds + ms durations + GO using pause) =====
//
// 🧩 Command Protocol
// -------------------
// Format (each command starts & ends with ';'):
//   ;SEQ,OP,ARG1,ARG2;
//
// ARG1 (speed): hexadecimal 00..FF
//   - High nibble (0..F) = LEFT wheel speed
//   - Low  nibble (0..F) = RIGHT wheel speed
//   - Each nibble scaled 0..F → 0..100 internally
//
// ARG2 (duration): decimal milliseconds
//
// Opcodes
//   MV : forward   — per-wheel speeds from ARG1, runs for ARG2 ms
//   BK : backward  — per-wheel speeds (negated), runs ARG2 ms
//   TL : turn left — left negated, right positive, runs ARG2 ms
//   TR : turn right— left positive, right negated, runs ARG2 ms
//   SP : hard stop — ARG1=00, ARG2=00 (dummy args)
//   GO : like MV but uses per-wheel speeds & dynamic arrow; runs ARG2 ms via basic.pause()
//   HL : headlights (RGB/on-off)
//   BZ : buzzer (freq_hi, freq_lo, dur*10 ms)
//   EC : echo/no-op (ignored)
//
// 🔁 Responses
//   #TRK,<n>\n   — tracking telemetry at startup and after each move/stop
//   #ERROR,<t>\n — error on parse failure or unknown opcode
//
// Tracking state (#TRK):
//   0 = none, 1 = right only, 2 = left only, 3 = both active
//
// Notes
// - Only #TRK and #ERROR are sent back.
// - Movement arrows show during motion, then revert to "wait" icon.
// - GO now uses the same blocking timing as MV (no software timer).
// ---------------------------------------------------------------------------

bluetooth.startUartService()

const DELIM = ";" // command delimiter

// Cutebot line tracking sensors (active-low)
const TRACK_RIGHT = DigitalPin.P13
const TRACK_LEFT = DigitalPin.P14

// Parsed command structure
interface Cmd { s: number; o: string; a: number; b: number; c: number }

// ===========================================================
//  UI HELPERS
// ===========================================================

/** Shows a neutral "waiting" icon when idle. */
function showWait() { basic.showIcon(IconNames.SmallDiamond) }

/** Briefly shows a stop icon, then returns to waiting. */
function showStopBrief() { basic.showIcon(IconNames.No); basic.pause(150); showWait() }

// ===========================================================
//  TRACKING TELEMETRY
// ===========================================================

/** Reads both line sensors and encodes tracking state: 0 = none, 1 = right, 2 = left, 3 = both. */
function readTracking(): number {
    const r = pins.digitalReadPin(TRACK_RIGHT) == 0 ? 1 : 0
    const l = pins.digitalReadPin(TRACK_LEFT) == 0 ? 2 : 0
    return r | l
}

/** Sends #TRK telemetry string with current tracking state. */
function sendTracking() { bluetooth.uartWriteString("#TRK," + readTracking() + "\n") }

/** Sends an #ERROR message string. */
function sendError(msg: string) { bluetooth.uartWriteString("#ERROR," + msg + "\n") }

// ===========================================================
//  UTILITY FUNCTIONS
// ===========================================================

/** Parse 1–2 hex chars → 0..255. */
function parseHexByte(s: string): number {
    const t = (s || "").trim().toUpperCase()
    if (!t) return 0
    let v = 0
    for (let i = 0; i < t.length && i < 2; i++) {
        const c = t.charCodeAt(i)
        let d = -1
        if (c >= 48 && c <= 57) d = c - 48
        else if (c >= 65 && c <= 70) d = c - 55
        if (d < 0) break
        v = (v << 4) | d
    }
    return v & 0xFF
}

/** Removes control chars and extra delimiters, trims whitespace. */
function sanitize(raw: string): string {
    if (!raw) return ""
    let out = ""
    for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i)
        const ch = raw.charAt(i)
        if (code < 32) continue
        if (ch == ";") continue
        out += ch
    }
    return out.trim()
}

/**
 * Parse a line into Cmd structure:
 * ARG1 (speed) in hex, ARG2 (duration) in decimal.
 * e.g. ";01,MV,8C,1000;" → a = 0x8C, b = 1000
 */
function parseLine(line: string): Cmd {
    const clean = sanitize(line)
    if (!clean || clean.length < 2) return null
    let s = clean
    if (s.charAt(0) == ";") s = s.substr(1)

    const parts = s.split(",")
    if (parts.length < 2) return null

    let seqNum = 0
    if (parts[0]) {
        const tmp = parseInt(parts[0], 16)
        if (!isNaN(tmp)) seqNum = tmp & 0xFF
    }

    const op = (parts[1] || "").trim().toUpperCase()
    if (!op) return null

    const a = parts.length > 2 ? parseInt(parts[2].trim(), 16) & 0xFF : 0     // hex speed
    const b = parts.length > 3 ? parseInt(parts[3].trim(), 10) : 0           // decimal ms
    const c = parts.length > 4 ? parseInt(parts[4].trim(), 10) : 0

    return { s: seqNum, o: op, a: a, b: b, c: c }
}

/** Stops Cutebot immediately and shows stop briefly. */
function hardStop() {
    cuteBot.motors(0, 0)
    try { cuteBot.stopcar() } catch (e) { }
    showStopBrief()
}

/** Converts byte (00..FF) → left/right speeds (0..100). */
function splitSpeeds(byteVal: number): { l: number, r: number } {
    const leftNib = (byteVal >> 4) & 0xF
    const rightNib = byteVal & 0xF
    const scale = (n: number) => Math.idiv(n * 100, 15)
    return { l: scale(leftNib), r: scale(rightNib) }
}

/** Chooses an arrow icon for given wheel speeds. */
function arrowForSpeeds(left: number, right: number): ArrowNames {
    const TH = 10
    if (left >= 0 && right >= 0) {
        if (Math.abs(left - right) <= TH) return ArrowNames.South
        return left > right ? ArrowNames.West : ArrowNames.East
    }
    if (left <= 0 && right <= 0) {
        if (Math.abs(left - right) <= TH) return ArrowNames.North
        return left < right ? ArrowNames.West : ArrowNames.East
    }
    if (left > 0 && right == 0) return ArrowNames.West
    if (right > 0 && left == 0) return ArrowNames.East
    if (left < 0 && right == 0) return ArrowNames.West
    if (right < 0 && left == 0) return ArrowNames.East
    return ArrowNames.South
}

/** Drives Cutebot for given ms with left/right speeds, shows arrow then #TRK. */
function driveFor(left: number, right: number, ms: number, arrow: ArrowNames) {
    if (ms <= 0) { hardStop(); sendTracking(); return }
    basic.showArrow(arrow)
    cuteBot.motors(left, right)
    basic.pause(ms)
    hardStop()
    sendTracking()
}

// ===========================================================
//  COMMAND EXECUTION
// ===========================================================

/** Executes a single parsed command. */
function runNow(cmd: Cmd) {
    switch (cmd.o) {
        case "MV": {
            const sp = splitSpeeds(cmd.a)
            driveFor(sp.l, sp.r, cmd.b, ArrowNames.South)
            break
        }
        case "BK": {
            const sp = splitSpeeds(cmd.a)
            driveFor(-sp.l, -sp.r, cmd.b, ArrowNames.North)
            break
        }
        case "TL": {
            const sp = splitSpeeds(cmd.a)
            driveFor(-sp.l, sp.r, cmd.b, ArrowNames.East)
            break
        }
        case "TR": {
            const sp = splitSpeeds(cmd.a)
            driveFor(sp.l, -sp.r, cmd.b, ArrowNames.West)
            break
        }
        case "SP":
            hardStop()
            sendTracking()
            break

        // GO now behaves like MV but with dynamic arrow from wheel bias.
        case "GO": {
            const sp = splitSpeeds(cmd.a)
            if (cmd.b <= 0) { hardStop(); sendError("GO_INVALID_ARGS"); break }
            if (sp.l == 0 && sp.r == 0) { showWait(); break } // no motion requested
            const arrow = arrowForSpeeds(sp.l, sp.r)
            driveFor(sp.l, sp.r, cmd.b, arrow)
            break
        }

        case "HL": {
            let color: number
            if (cmd.b > 0 || cmd.c > 0)
                color = ((cmd.a & 0xFF) << 16) | ((cmd.b & 0xFF) << 8) | (cmd.c & 0xFF)
            else
                color = cmd.a ? 0xFFFFFF : 0x000000
            cuteBot.colorLight(cuteBot.RGBLights.ALL, color)
            break
        }

        case "BZ": {
            const freq = ((cmd.a & 0xFF) << 8) | (cmd.b & 0xFF)
            let dur = (cmd.c & 0xFF) * 10
            if (dur <= 0) dur = 100
            const f = Math.max(100, Math.min(5000, freq))
            music.playTone(f, dur)
            break
        }

        case "EC":
            break

        default:
            sendError("UNKNOWN_OP_" + cmd.o)
            return
    }
}

// ===========================================================
//  BLUETOOTH UART HANDLER
// ===========================================================

bluetooth.onUartDataReceived(DELIM, function () {
    const raw = bluetooth.uartReadUntil(DELIM) || ""
    if (raw.trim().length == 0) return

    const cmd = parseLine(raw)
    if (!cmd) { sendError("PARSE_FAIL"); return }
    runNow(cmd)
})

// ===========================================================
//  STARTUP
// ===========================================================

showWait()
sendTracking()