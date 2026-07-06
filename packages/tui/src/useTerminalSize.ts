import { useEffect, useState } from "react"
import { useStdout } from "ink"

/**
 * Reactive terminal dimensions. Ink re-layouts on resize but does not re-run
 * component render functions, so anything computed from stdout.rows/columns
 * at render time (adaptive windows, collapsible detail lines) goes stale
 * until the next unrelated re-render. This hook subscribes to the stream's
 * resize event and turns it into React state.
 */
export function useTerminalSize(): { rows: number; columns: number } {
  const { stdout } = useStdout()
  const [size, setSize] = useState({
    rows: stdout?.rows ?? 24,
    columns: stdout?.columns ?? 80,
  })

  useEffect(() => {
    if (!stdout) return
    const onResize = () =>
      setSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 })
    onResize() // the stream may have resized between first render and mount
    stdout.on("resize", onResize)
    return () => {
      stdout.off("resize", onResize)
    }
  }, [stdout])

  return size
}
