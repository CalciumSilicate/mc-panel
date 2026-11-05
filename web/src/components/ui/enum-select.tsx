import { Children, Fragment, isValidElement, useState, type ReactNode, type SelectHTMLAttributes } from 'react'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'

interface Props extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'defaultValue' | 'multiple'> {
  value?: string | number
  defaultValue?: string | number
  onValueChange?: (value: string) => void
}
interface Choice { value: string; label: ReactNode; disabled: boolean; group?: string }
/** Short enumerations, including an empty value. Searchable lists should use Combobox. */
export function EnumSelect({ children, value, defaultValue, onValueChange, className, id, name, disabled, required, title, style, tabIndex, 'aria-label': label, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy }: Props) {
  const [internal, setInternal] = useState(String(defaultValue ?? ''))
  const choices: Choice[] = []
  const collect = (nodes: ReactNode, group?: string, groupDisabled = false) => Children.forEach(nodes, node => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean; label?: string }>(node)) return
    if (node.type === Fragment) collect(node.props.children, group, groupDisabled)
    else if (node.type === 'optgroup') collect(node.props.children, node.props.label, Boolean(node.props.disabled))
    else if (node.type === 'option') choices.push({ value: String(node.props.value ?? node.props.children ?? ''), label: node.props.children, disabled: groupDisabled || Boolean(node.props.disabled), group })
  })
  collect(children)
  const current = String(value ?? internal)
  const selected = choices.findIndex(option => option.value === current)
  const groups = [...new Set(choices.map(option => option.group))]
  return <>
    {name && <input type="hidden" name={name} value={current} disabled={disabled} />}
    <Select disabled={disabled} required={required} value={selected < 0 || required && current === '' ? '' : String(selected)} onValueChange={encoded => {
    const next = choices[Number(encoded)]?.value
    if (next === undefined) return
    setInternal(next)
    onValueChange?.(next)
  }}>
    <SelectTrigger id={id} className={className} title={title} style={style} tabIndex={tabIndex} aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy}><SelectValue placeholder={choices.find(choice => choice.value === '')?.label || '请选择'} /></SelectTrigger>
    <SelectContent>{groups.map((group, index) => <SelectGroup key={group ?? index}>
      {group && <SelectLabel>{group}</SelectLabel>}
      {choices.map((option, i) => option.group === group && <SelectItem key={i} value={String(i)} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectGroup>)}</SelectContent>
  </Select></>
}
