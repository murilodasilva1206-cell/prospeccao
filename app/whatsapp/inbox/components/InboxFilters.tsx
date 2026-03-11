'use client'

import { useState } from 'react'
import { Filter, X, ChevronDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DatePicker } from './DatePicker'

export interface InboxFiltersValue {
  provider?: string
  channel_id?: string
  date_from?: string
  date_to?: string
  preset?: string
}

export interface InboxChannel {
  id: string
  name: string
  provider: string
}

interface InboxFiltersProps {
  channels: InboxChannel[]
  onFiltersChange: (filters: InboxFiltersValue) => void
}

export function InboxFilters({ channels, onFiltersChange }: InboxFiltersProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [channel_id, setChannelId] = useState('')
  const [preset, setPreset] = useState('')
  const [date_from, setDateFrom] = useState('')
  const [date_to, setDateTo] = useState('')

  const activeCount = [provider, channel_id, preset || (date_from || date_to)].filter(Boolean).length
  const hasFilters = activeCount > 0

  function applyFilters(f: InboxFiltersValue) {
    const clean: InboxFiltersValue = {}
    if (f.provider) clean.provider = f.provider
    if (f.channel_id) clean.channel_id = f.channel_id
    if (f.preset) {
      clean.preset = f.preset
    } else {
      if (f.date_from) clean.date_from = f.date_from
      if (f.date_to) clean.date_to = f.date_to
    }
    onFiltersChange(clean)
  }

  function onProviderChange(value: string) {
    setProvider(value)
    applyFilters({ provider: value, channel_id, preset, date_from, date_to })
  }

  function onChannelChange(value: string) {
    setChannelId(value)
    applyFilters({ provider, channel_id: value, preset, date_from, date_to })
  }

  function handlePresetChange(value: string) {
    const next = preset === value ? '' : value
    setPreset(next)
    if (next) { setDateFrom(''); setDateTo('') }
    applyFilters({ provider, channel_id, preset: next, date_from: '', date_to: '' })
  }

  function handleDateFromChange(value: string) {
    setDateFrom(value)
    setPreset('')
    applyFilters({ provider, channel_id, preset: '', date_from: value, date_to })
  }

  function handleDateToChange(value: string) {
    setDateTo(value)
    setPreset('')
    applyFilters({ provider, channel_id, preset: '', date_from, date_to: value })
  }

  function clearFilters() {
    setProvider('')
    setChannelId('')
    setPreset('')
    setDateFrom('')
    setDateTo('')
    onFiltersChange({})
  }

  return (
    <div>
      {/* Barra de controle */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          className="text-gray-600 hover:text-gray-900 font-normal"
        >
          <Filter className="size-3.5" />
          Filtros
          {hasFilters && (
            <Badge className="size-4 rounded-full p-0 text-[10px] flex items-center justify-center">
              {activeCount}
            </Badge>
          )}
          <ChevronDown className={`size-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </Button>
        {hasFilters && (
          <Button
            variant="ghost"
            size="xs"
            onClick={clearFilters}
            className="ml-auto text-gray-400 hover:text-gray-700"
          >
            <X className="size-3" /> Limpar filtros
          </Button>
        )}
      </div>

      {/* Painel de filtros */}
      {isOpen && (
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 space-y-3">
          {/* Provedor */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Provedor</label>
            <Select
              value={provider || '__all__'}
              onValueChange={(v) => onProviderChange(v === '__all__' ? '' : v)}
            >
              <SelectTrigger className="w-full h-8 text-sm">
                <SelectValue placeholder="Todos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todos</SelectItem>
                <SelectItem value="META_CLOUD">Meta</SelectItem>
                <SelectItem value="EVOLUTION">Evolution</SelectItem>
                <SelectItem value="UAZAPI">UAZAPI</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Canal */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Canal</label>
            <Select
              value={channel_id || '__all__'}
              onValueChange={(v) => onChannelChange(v === '__all__' ? '' : v)}
            >
              <SelectTrigger className="w-full h-8 text-sm">
                <SelectValue placeholder="Todos os canais" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todos os canais</SelectItem>
                {channels.map((ch) => (
                  <SelectItem key={ch.id} value={ch.id}>{ch.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Período — presets */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Período</label>
            <div className="flex gap-2">
              <Button
                variant={preset === 'last_7_days' ? 'default' : 'outline'}
                size="xs"
                type="button"
                onClick={() => handlePresetChange('last_7_days')}
                className={preset === 'last_7_days' ? 'border-green-500 bg-green-500 hover:bg-green-600' : ''}
              >
                Últimos 7 dias
              </Button>
              <Button
                variant={preset === 'last_month' ? 'default' : 'outline'}
                size="xs"
                type="button"
                onClick={() => handlePresetChange('last_month')}
                className={preset === 'last_month' ? 'border-green-500 bg-green-500 hover:bg-green-600' : ''}
              >
                Mês passado
              </Button>
            </div>
          </div>

          {/* Período personalizado — DatePicker */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">De</label>
              <DatePicker
                value={date_from}
                onChange={handleDateFromChange}
                placeholder="Selecionar"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Até</label>
              <DatePicker
                value={date_to}
                onChange={handleDateToChange}
                placeholder="Selecionar"
              />
            </div>
          </div>
        </div>
      )}

      {/* Chips de filtros ativos */}
      {hasFilters && !isOpen && (
        <div className="px-4 py-1.5 border-b border-gray-100 flex flex-wrap gap-1">
          {provider && (
            <Badge
              variant="outline"
              className="text-[10px] bg-green-50 text-green-700 border-green-200 rounded-full px-2 py-0.5"
            >
              {provider === 'META_CLOUD' ? 'Meta' : provider}
              <button onClick={() => onProviderChange('')} aria-label="Remover filtro provedor">
                <X className="size-2.5" />
              </button>
            </Badge>
          )}
          {channel_id && (
            <Badge
              variant="outline"
              className="text-[10px] bg-green-50 text-green-700 border-green-200 rounded-full px-2 py-0.5"
            >
              {channels.find((c) => c.id === channel_id)?.name ?? 'Canal'}
              <button onClick={() => onChannelChange('')} aria-label="Remover filtro canal">
                <X className="size-2.5" />
              </button>
            </Badge>
          )}
          {preset && (
            <Badge
              variant="outline"
              className="text-[10px] bg-green-50 text-green-700 border-green-200 rounded-full px-2 py-0.5"
            >
              {preset === 'last_7_days' ? 'Últimos 7 dias' : 'Mês passado'}
              <button onClick={() => handlePresetChange(preset)} aria-label="Remover filtro período">
                <X className="size-2.5" />
              </button>
            </Badge>
          )}
          {(date_from || date_to) && !preset && (
            <Badge
              variant="outline"
              className="text-[10px] bg-green-50 text-green-700 border-green-200 rounded-full px-2 py-0.5"
            >
              {date_from ?? '...'} → {date_to ?? '...'}
              <button
                onClick={() => { handleDateFromChange(''); setDateTo(''); applyFilters({ provider, channel_id, preset }) }}
                aria-label="Remover filtro período personalizado"
              >
                <X className="size-2.5" />
              </button>
            </Badge>
          )}
        </div>
      )}
    </div>
  )
}
