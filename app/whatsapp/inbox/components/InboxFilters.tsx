'use client'

import { useState } from 'react'
import { Filter, X, ChevronDown } from 'lucide-react'

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

  function handleProviderChange(value: string) {
    setProvider(value)
    applyFilters({ provider: value, channel_id, preset, date_from, date_to })
  }

  function handleChannelChange(value: string) {
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
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900"
          aria-expanded={isOpen}
        >
          <Filter className="size-3.5" />
          Filtros
          {hasFilters && (
            <span className="inline-flex items-center justify-center size-4 rounded-full bg-green-500 text-white text-[10px] font-semibold">
              {activeCount}
            </span>
          )}
          <ChevronDown className={`size-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="ml-auto flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700"
          >
            <X className="size-3" /> Limpar filtros
          </button>
        )}
      </div>

      {isOpen && (
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 space-y-3">
          {/* Provedor */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Provedor</label>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded px-2 py-1.5 bg-white"
            >
              <option value="">Todos</option>
              <option value="META_CLOUD">Meta</option>
              <option value="EVOLUTION">Evolution</option>
              <option value="UAZAPI">UAZAPI</option>
            </select>
          </div>

          {/* Canal */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Canal</label>
            <select
              value={channel_id}
              onChange={(e) => handleChannelChange(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded px-2 py-1.5 bg-white"
            >
              <option value="">Todos os canais</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>{ch.name}</option>
              ))}
            </select>
          </div>

          {/* Presets */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Período</label>
            <div className="flex gap-2">
              <button
                onClick={() => handlePresetChange('last_7_days')}
                className={`text-xs px-2 py-1 rounded border transition-colors ${
                  preset === 'last_7_days'
                    ? 'border-green-500 bg-green-50 text-green-700'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                Últimos 7 dias
              </button>
              <button
                onClick={() => handlePresetChange('last_month')}
                className={`text-xs px-2 py-1 rounded border transition-colors ${
                  preset === 'last_month'
                    ? 'border-green-500 bg-green-50 text-green-700'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                Mês passado
              </button>
            </div>
          </div>

          {/* Período personalizado */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">De</label>
              <input
                type="date"
                value={date_from}
                onChange={(e) => handleDateFromChange(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded px-2 py-1.5"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Até</label>
              <input
                type="date"
                value={date_to}
                onChange={(e) => handleDateToChange(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded px-2 py-1.5"
              />
            </div>
          </div>
        </div>
      )}

      {hasFilters && !isOpen && (
        <div className="px-4 py-1.5 border-b border-gray-100 flex flex-wrap gap-1">
          {provider && (
            <span className="inline-flex items-center gap-1 text-[10px] bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5">
              {provider === 'META_CLOUD' ? 'Meta' : provider}
              <button onClick={() => handleProviderChange('')}><X className="size-2.5" /></button>
            </span>
          )}
          {channel_id && (
            <span className="inline-flex items-center gap-1 text-[10px] bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5">
              {channels.find((c) => c.id === channel_id)?.name ?? 'Canal'}
              <button onClick={() => handleChannelChange('')}><X className="size-2.5" /></button>
            </span>
          )}
          {preset && (
            <span className="inline-flex items-center gap-1 text-[10px] bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5">
              {preset === 'last_7_days' ? 'Últimos 7 dias' : 'Mês passado'}
              <button onClick={() => handlePresetChange(preset)}><X className="size-2.5" /></button>
            </span>
          )}
          {(date_from || date_to) && !preset && (
            <span className="inline-flex items-center gap-1 text-[10px] bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5">
              {date_from ?? '...'} → {date_to ?? '...'}
              <button onClick={() => { handleDateFromChange(''); setDateTo(''); applyFilters({ provider, channel_id, preset }) }}><X className="size-2.5" /></button>
            </span>
          )}
        </div>
      )}
    </div>
  )
}
