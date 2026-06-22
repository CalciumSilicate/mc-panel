/**
 * 极简 ANSI SGR 解析器 —— 把带颜色转义码的终端行拆成可着色的片段。
 * MCDR 控制台主要用前景色(30-37 / 90-97)、加粗(1)、变暗(2)、重置(0),覆盖这些即可。
 * 不识别的码忽略,文本照常输出。
 */

const FG_COLORS: Record<number, string> = {
  30: '#6b7280', 31: '#f87171', 32: '#4ade80', 33: '#fbbf24',
  34: '#60a5fa', 35: '#e879f9', 36: '#22d3ee', 37: '#d4d4d8',
  90: '#9ca3af', 91: '#fca5a5', 92: '#86efac', 93: '#fde047',
  94: '#93c5fd', 95: '#f0abfc', 96: '#67e8f9', 97: '#f4f4f5',
}

export interface AnsiSegment {
  text: string
  color?: string
  bold: boolean
  dim: boolean
}

interface AnsiState {
  color?: string
  bold: boolean
  dim: boolean
}

// SGR 序列:ESC(0x1b) [ 参数 m。用 fromCharCode 拼出 ESC,避免源码里出现控制字符。
const ESC = String.fromCharCode(27)
const SGR_RE = new RegExp(ESC + '\\[([0-9;]*)m', 'g')

function applyCodes(state: AnsiState, raw: string): void {
  const codes = raw === '' ? [0] : raw.split(';').map((n) => Number.parseInt(n, 10) || 0)
  for (const code of codes) {
    if (code === 0) {
      state.color = undefined
      state.bold = false
      state.dim = false
    } else if (code === 1) {
      state.bold = true
    } else if (code === 2) {
      state.dim = true
    } else if (code === 22) {
      state.bold = false
      state.dim = false
    } else if (code === 39) {
      state.color = undefined
    } else if (FG_COLORS[code]) {
      state.color = FG_COLORS[code]
    }
  }
}

export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  const state: AnsiState = { bold: false, dim: false }
  let last = 0
  let match: RegExpExecArray | null
  SGR_RE.lastIndex = 0
  while ((match = SGR_RE.exec(input)) !== null) {
    if (match.index > last) {
      segments.push({ text: input.slice(last, match.index), ...state })
    }
    applyCodes(state, match[1])
    last = SGR_RE.lastIndex
  }
  if (last < input.length) {
    segments.push({ text: input.slice(last), ...state })
  }
  return segments.length > 0 ? segments : [{ text: input, bold: false, dim: false }]
}
