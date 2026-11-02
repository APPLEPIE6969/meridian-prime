'use client'

import { useEffect, useRef, useState } from 'react'
import { CandlestickSeries, ColorType, createChart, type UTCTimestamp } from 'lightweight-charts'

export interface ChartBar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export function SymbolChart({ bars, height = 440 }: { bars: ChartBar[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const chart = createChart(el, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b93a3',
        fontSize: 11,
      },
      grid: { vertLines: { color: '#161d27' }, horzLines: { color: '#161d27' } },
      timeScale: { timeVisible: true, borderColor: '#1d2530' },
      rightPriceScale: { borderColor: '#1d2530' },
      crosshair: { mode: 0 },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#2fbf71',
      downColor: '#ef5350',
      wickUpColor: '#2fbf71',
      wickDownColor: '#ef5350',
      borderVisible: false,
    })
    const seen = new Set<number>()
    const data = bars
      .map((b) => ({ time: Math.floor(b.t / 1000) as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }))
      .filter((d) => {
        if (seen.has(d.time)) return false
        seen.add(d.time)
        return true
      })
      .sort((a, b) => a.time - b.time)
    series.setData(data)
    chart.timeScale().fitContent()

    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth })
    })
    observer.observe(el)
    setReady(true)

    return () => {
      observer.disconnect()
      chart.remove()
      setReady(false)
    }
  }, [bars, height])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height, opacity: ready ? 1 : 0.4, transition: 'opacity 0.2s' }}
    />
  )
}
