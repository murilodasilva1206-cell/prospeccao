"use client"

import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const MONTHS_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
]
const WEEKDAYS_PT = ['Do', 'Se', 'Te', 'Qu', 'Qu', 'Se', 'Sá']

interface CalendarProps {
  selected?: Date
  onSelect?: (date: Date) => void
  className?: string
}

export function Calendar({ selected, onSelect, className }: CalendarProps) {
  const today = new Date()
  const [viewYear, setViewYear] = React.useState(
    selected?.getFullYear() ?? today.getFullYear(),
  )
  const [viewMonth, setViewMonth] = React.useState(
    selected?.getMonth() ?? today.getMonth(),
  )

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1) }
    else setViewMonth((m) => m - 1)
  }

  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1) }
    else setViewMonth((m) => m + 1)
  }

  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay()
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
  const cells: Array<number | null> = [
    ...Array<null>(firstDayOfWeek).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  function isSelected(day: number) {
    return (
      !!selected &&
      selected.getFullYear() === viewYear &&
      selected.getMonth() === viewMonth &&
      selected.getDate() === day
    )
  }

  function isToday(day: number) {
    return (
      today.getFullYear() === viewYear &&
      today.getMonth() === viewMonth &&
      today.getDate() === day
    )
  }

  return (
    <div data-slot="calendar" className={cn("p-3 select-none", className)}>
      <div className="flex items-center justify-between mb-2">
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          onClick={prevMonth}
          aria-label="Mês anterior"
        >
          <ChevronLeftIcon />
        </Button>
        <span className="text-sm font-medium">
          {/* eslint-disable-next-line security/detect-object-injection */}
          {MONTHS_PT[viewMonth]} {viewYear}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          onClick={nextMonth}
          aria-label="Próximo mês"
        >
          <ChevronRightIcon />
        </Button>
      </div>

      <div className="grid grid-cols-7">
        {WEEKDAYS_PT.map((w, i) => (
          <div
            key={i}
            className="text-center text-[10px] font-medium text-muted-foreground pb-1"
          >
            {w}
          </div>
        ))}
        {cells.map((day, i) => (
          <div key={i} className="flex items-center justify-center py-0.5">
            {day !== null ? (
              <button
                type="button"
                onClick={() => onSelect?.(new Date(viewYear, viewMonth, day))}
                className={cn(
                  "size-8 text-sm rounded-full transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isSelected(day) &&
                    "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
                  isToday(day) &&
                    !isSelected(day) &&
                    "font-semibold text-primary",
                )}
              >
                {day}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}
