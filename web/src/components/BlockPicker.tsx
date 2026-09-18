import { useMemo, useRef, useState } from 'react'
import { Box, Check, ChevronsUpDown } from 'lucide-react'
import blocks from '@/lib/blocks.json'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const byId = new Map(blocks.map((block) => [block.id, block]))
const COMMON = ['bedrock', 'stone', 'dirt', 'grass_block', 'sand', 'water', 'glass', 'air']
const ordered = [...blocks].sort((a, b) => {
  const rank = (id: string) => { const n = COMMON.indexOf(id.replace('minecraft:', '')); return n < 0 ? 100 : n }
  return rank(a.id) - rank(b.id)
})

function BlockIcon({ id }: { id: string }) {
  const n = byId.get(id)?.texture ?? -1
  return n < 0 ? <Box aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground" /> : <span aria-hidden className="h-6 w-6 shrink-0 [image-rendering:pixelated]" style={{ backgroundImage: 'url(/blocks/textures.png)', backgroundSize: '768px auto', backgroundPosition: `${-(n % 32) * 24}px ${-Math.floor(n / 32) * 24}px` }} />
}

export function BlockPicker({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const results = useMemo(() => ordered.filter((b) => `${b.id} ${b.name}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 80), [q])
  const custom = q.trim().toLowerCase()
  const customId = custom.includes(':') ? custom : `minecraft:${custom}`
  const allowCustom = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(customId) && !byId.has(customId)
  const select = (id: string) => { onChange(id); setOpen(false) }
  return <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) { setQ(''); setActive(0) } }}>
    <PopoverTrigger asChild><Button variant="outline" aria-label={label} role="combobox" aria-expanded={open} className="h-10 w-full min-w-0 justify-start gap-2 px-3 font-normal">
      <BlockIcon id={value} /><span className="min-w-0 truncate">{byId.get(value)?.name ?? value}</span><ChevronsUpDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </Button></PopoverTrigger>
    <PopoverContent align="start" className="w-[min(360px,calc(100vw-32px))] p-0" onOpenAutoFocus={(e) => { e.preventDefault(); requestAnimationFrame(() => list.current?.querySelector('input')?.focus()) }}>
      <div ref={list}>
        <div className="border-b p-2"><Input aria-label="搜索方块" placeholder="搜索方块名称 / ID" value={q} onChange={(e) => { setQ(e.target.value); setActive(0) }} onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const next = Math.max(0, Math.min(results.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1))); setActive(next); list.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' }) }
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); if (results[active]) select(results[active].id); else if (allowCustom) select(customId) }
        }} /></div>
        <div role="listbox" aria-label="方块" className="max-h-72 overflow-y-auto p-1">
          {results.map((b, i) => <button key={b.id} type="button" role="option" aria-selected={value === b.id} data-index={i} onClick={() => select(b.id)} onMouseEnter={() => setActive(i)} className={`flex w-full items-center gap-3 rounded px-2 py-2 text-left ${active === i ? 'bg-accent' : 'hover:bg-accent'}`}>
            <BlockIcon id={b.id} /><span className="min-w-0 flex-1"><span className="block text-sm">{b.name}</span><span className="block truncate font-mono text-xs text-muted-foreground">{b.id}</span></span>{value === b.id ? <Check className="h-4 w-4 text-primary" /> : null}
          </button>)}
          {allowCustom ? <button type="button" className="w-full rounded px-2 py-3 text-left text-sm hover:bg-accent" onClick={() => select(customId)}>使用 {customId}</button> : null}
          {!results.length && !allowCustom ? <p className="p-6 text-center text-sm text-muted-foreground">没有匹配的方块</p> : null}
        </div>
      </div>
    </PopoverContent>
  </Popover>
}
