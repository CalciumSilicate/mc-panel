import { createContext, useContext } from 'react'

export interface ConfirmOptions {
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  destructive?: boolean
}

export interface PromptOptions {
  title: string
  description?: string
  label?: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
}

export interface DialogApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  prompt: (opts: PromptOptions) => Promise<string | null>
}

export const DialogContext = createContext<DialogApi | null>(null)

export function useConfirm(): DialogApi['confirm'] {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useConfirm must be used within DialogProvider')
  return ctx.confirm
}

export function usePrompt(): DialogApi['prompt'] {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('usePrompt must be used within DialogProvider')
  return ctx.prompt
}
