import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  DialogContext,
  type ConfirmOptions,
  type PromptOptions,
} from '@/components/ui/dialog-context'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type State =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void }
  | null

/** 界面内的确认 / 输入对话框,替代浏览器原生 confirm / prompt。 */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(null)
  const [value, setValue] = useState('')

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setState({ kind: 'confirm', opts, resolve })),
    [],
  )
  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(opts.defaultValue ?? '')
        setState({ kind: 'prompt', opts, resolve })
      }),
    [],
  )

  const api = useMemo(() => ({ confirm, prompt }), [confirm, prompt])

  const finish = (result: boolean | string | null) => {
    setState((cur) => {
      if (cur) cur.resolve(result as never)
      return null
    })
  }

  const isPrompt = state?.kind === 'prompt'
  const opts = state?.opts
  const cancelValue: boolean | string | null = isPrompt ? null : false

  const submitPrompt = (e: FormEvent) => {
    e.preventDefault()
    finish(value)
  }

  return (
    <DialogContext.Provider value={api}>
      {children}
      <Dialog open={state !== null} onOpenChange={(o) => (!o ? finish(cancelValue) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{opts?.title}</DialogTitle>
            {opts?.description ? <DialogDescription>{opts.description}</DialogDescription> : null}
          </DialogHeader>

          {isPrompt ? (
            <form onSubmit={submitPrompt} className="grid gap-2 py-1">
              {(opts as PromptOptions).label ? <Label htmlFor="dlg-input">{(opts as PromptOptions).label}</Label> : null}
              <Input
                id="dlg-input"
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={(opts as PromptOptions).placeholder}
              />
            </form>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(cancelValue)}>
              {(opts as ConfirmOptions | undefined)?.cancelText ?? '取消'}
            </Button>
            <Button
              type="button"
              variant={!isPrompt && (opts as ConfirmOptions | undefined)?.destructive ? 'destructive' : 'default'}
              onClick={() => finish(isPrompt ? value : true)}
            >
              {opts?.confirmText ?? (isPrompt ? '确定' : '确认')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DialogContext.Provider>
  )
}
