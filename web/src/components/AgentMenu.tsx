import { useEffect, useRef, useState } from "react"

export interface AgentMenuItem {
  icon: string
  label: string
  onClick: () => void
  /** Shows a ✓ on the right — for state toggles (default, parallel). */
  checked?: boolean
  disabled?: boolean
  /** Destructive styling (red), e.g. Kick. */
  danger?: boolean
  /** Draw a divider above this item. */
  separatorBefore?: boolean
}

/** A compact "⋯" overflow menu for an agent card. The dropdown is positioned
 *  with `position: fixed` (anchored to the button) so it is never clipped by the
 *  roster's scroll container. Closes on outside-click, scroll, resize, or after
 *  an item is chosen. */
export function AgentMenu({ items }: { items: AgentMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    // capture:true so the roster list's own scroll also closes the menu.
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
    }
  }, [open])

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) })
    setOpen(true)
  }

  return (
    <div className="agent-menu" ref={wrapRef}>
      <button
        ref={btnRef}
        className="agent-menu-btn"
        title="Agent actions"
        aria-label="Agent actions"
        aria-haspopup="menu"
        onClick={toggle}
      >
        ⋯
      </button>
      {open && (
        <div className="agent-menu-dropdown" role="menu" style={{ top: pos.top, right: pos.right }}>
          {items.map((it, i) => (
            <div key={i}>
              {it.separatorBefore && <div className="agent-menu-sep" />}
              <button
                className={`agent-menu-item${it.danger ? " danger" : ""}`}
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  it.onClick()
                  setOpen(false)
                }}
              >
                <span className="agent-menu-icon">{it.icon}</span>
                <span className="agent-menu-label">{it.label}</span>
                {it.checked && <span className="agent-menu-check">✓</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
